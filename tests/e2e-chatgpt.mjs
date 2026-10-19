// 実際の Chromium 系ブラウザ（Brave / Chrome / Edge）で、「ChatGPT のプランでサインインして翻訳する」一連の流れを確かめる。
// 一時的なプロファイルで headless 起動するため、普段使いのブラウザの設定・拡張機能・サインインには触れません。
//
// OpenAI への通信（サインインのトークン・モデル一覧・翻訳）だけは、裏方の中で偽物に差し替えます。本物の OpenAI には送りません。
// 本物のブラウザで確かめるのは、次の部分です:
//   ・設定画面の操作（提供元の切り替え・サインイン・サインアウト・接続テスト）
//   ・戻り先（http://127.0.0.1:1455/auth/callback）への移動を、webRequest が検知して、サインインが完了すること
//   ・保存先の切り替え（ディスク ⇔ 一時領域）、サインアウトでの消去
//
// 実行: node tests/e2e-chatgpt.mjs "<ブラウザの exe のパス>" [extension フォルダ]
//   例: node tests/e2e-chatgpt.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
// 注意: ポート 1455 を、他のアプリ（Codex など）が使っていない状態で実行してください（戻り先の移動を受け取らないため）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserPath = process.argv[2];
const extDir = path.resolve(process.argv[3] || path.join(here, '..', 'extension'));
if (!browserPath) {
  console.error('使い方: node tests/e2e-chatgpt.mjs "<ブラウザの exe のパス>" [extension フォルダ]');
  process.exit(2);
}

// ポート 1455 が空いていること（本物のアプリに、テスト用の code を渡してしまわないため）
await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', (e) => {
    console.error(`ポート 1455 が使用中です（${e.code}）。Codex などを終了してから、もう一度実行してください。`);
    process.exit(2);
  });
  probe.listen(1455, '127.0.0.1', () => probe.close(resolve));
});

const profile = mkdtempSync(path.join(os.tmpdir(), 'ja-translate-e2e-'));
const child = spawn(
  browserPath,
  ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);

// ---- CDP over pipe（メッセージは NUL 区切りの JSON）
let nextId = 1;
const pending = new Map();
let buffer = '';
child.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`タイムアウト: ${method}`));
    }, 30000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(fn, { timeoutMs = 10000, everyMs = 150 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return v;
    await sleep(everyMs);
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok' : 'NG'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

// 裏方（サービスワーカー）の中で動かす。OpenAI への通信だけを偽物にし、サインイン画面を開く操作を記録する。
// ※ 関数の中身は、裏方の中で実行される（この関数の外の変数は使えない）。
function installStub() {
  globalThis.__log = [];
  globalThis.__authUrl = '';
  globalThis.__tokenCount = 0;
  const realCreate = chrome.tabs.create.bind(chrome.tabs);
  // 本物のサインイン画面は開かず、空のタブを開く（タブ ID を持つ「サインイン画面」の代わり）
  chrome.tabs.create = async (opts) => {
    globalThis.__authUrl = opts.url;
    return realCreate({ url: 'about:blank' });
  };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const b64u = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const realFetch = globalThis.fetch;
  globalThis.__geminiLog = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    // Gemini: 併用の検証用に、「1 日の上限に達した」応答を返す（本物の Google には送らない）
    if (u.startsWith('https://generativelanguage.googleapis.com/') && init.method === 'POST') {
      globalThis.__geminiLog.push(u);
      return json({ error: { code: 429, message: 'Quota exceeded', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }, 429);
    }
    if (!u.startsWith('https://auth.openai.com/') && !u.startsWith('https://api.openai.com/')) return realFetch(url, init);
    const headers = init.headers || {};
    globalThis.__log.push({ url: u, method: init.method || 'GET', auth: headers.authorization || '', body: String(init.body || '') });
    if (u.endsWith('/oauth/token')) {
      globalThis.__tokenCount += 1;
      const nonce = new URL(globalThis.__authUrl).searchParams.get('nonce');
      return json({
        access_token: `AT-${globalThis.__tokenCount}`,
        refresh_token: `RT-${globalThis.__tokenCount}`,
        id_token: `h.${b64u({ nonce, email: 'e2e@example.com' })}.s`,
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      });
    }
    if (u.endsWith('/models')) {
      return json({ models: [
        { slug: 'gpt-e2e-sol', display_name: 'Sol', visibility: 'list' },
        { slug: 'gpt-e2e-luna', display_name: 'Luna', visibility: 'list' },
        { slug: 'gpt-e2e-hidden', display_name: 'Hidden', visibility: 'hide' },
      ] });
    }
    if (u.endsWith('/responses')) {
      const body = JSON.parse(init.body);
      const input = body.input.find((m) => m.role === 'user').content;
      const out = input.replace(/<<<(\d+)>>>\n([\s\S]*?)(?=\n<<<\d+>>>|$)/g, (_, n, t) => `<<<${n}>>>\n訳:${t}`);
      const events = [
        { type: 'response.output_text.delta', delta: out },
        { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 7 } } },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    return json({ error: { message: 'unexpected' } }, 404);
  };
  return true;
}

async function main() {
  const version = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${version.product}\n拡張機能: ${extDir}\n`);

  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: extDir });
  check('拡張機能を読み込めた', !!extId, `ID: ${extId}`);

  // 設定画面
  const { targetId: optionsTarget } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const { sessionId: ui } = await cdp('Target.attachToTarget', { targetId: optionsTarget, flatten: true });
  await cdp('Runtime.enable', {}, ui);
  await waitFor(() => evaluate(ui, `document.getElementById('model')?.options.length > 0`));

  // 裏方
  const { targetInfos: infos0 } = await cdp('Target.getTargets');
  const swInfo = infos0.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (!swInfo) {
    check('裏方（サービスワーカー）が見つかった', false);
    return;
  }
  const { sessionId: sw } = await cdp('Target.attachToTarget', { targetId: swInfo.targetId, flatten: true });
  await cdp('Runtime.enable', {}, sw);
  await evaluate(sw, `(${installStub.toString()})()`);

  const pageTargets = async () => (await cdp('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').map((t) => t.targetId);
  const state = () => evaluate(ui, `document.getElementById('chatgptState').textContent`);
  const get = (expr) => evaluate(ui, expr);

  // 1. 提供元を ChatGPT に切り替える（画面の出し分け）
  const switched = await get(`(() => {
    document.getElementById('acknowledged').checked = true;
    document.getElementById('providerChatgpt').click();
    return {
      gemini: !document.getElementById('geminiSection').hidden,
      chatgpt: !document.getElementById('chatgptSection').hidden,
      signIn: !document.getElementById('chatgptSignIn').hidden,
      signOut: !document.getElementById('chatgptSignOut').hidden,
      state: document.getElementById('chatgptState').textContent,
    };
  })()`);
  check('「ChatGPT のプラン」を選ぶと、サインインの欄が出て、Gemini の欄が隠れる',
    switched.chatgpt && !switched.gemini && switched.signIn && !switched.signOut && switched.state.includes('未サインイン'),
    JSON.stringify(switched));

  // 2. サインインを始める → 認可の画面（偽: 空のタブ）が開く
  const before = await pageTargets();
  await get(`document.getElementById('chatgptSignIn').click()`);
  const authUrl = await waitFor(() => evaluate(sw, `globalThis.__authUrl`));
  const u = new URL(authUrl || 'about:blank');
  const p = u.searchParams;
  check('サインインを押すと、公式の仕様どおりの認可の画面を開く',
    u.origin === 'https://auth.openai.com' && u.pathname === '/api/accounts/authorize' &&
    p.get('redirect_uri') === 'http://127.0.0.1:1455/auth/callback' && p.get('code_challenge_method') === 'S256' &&
    p.get('scope')?.split(' ').includes('chatgpt.tokens.use.direct') && /^urn:uuid:/.test(p.get('ext_agent_host_id') || ''),
    `${u.origin}${u.pathname}`);
  const waiting = await waitFor(async () => (await state()).includes('サインイン待ち'));
  check('画面が「サインイン待ち」になる（中止ボタンが出る）',
    !!waiting && (await get(`!document.getElementById('chatgptCancel').hidden`)), await state());

  // 3. 戻り先へ移動する → webRequest が検知して、サインインが完了する
  const after = await pageTargets();
  const signInTab = after.find((t) => !before.includes(t));
  check('サインイン画面のタブが開かれた', !!signInTab);
  const { sessionId: tabSession } = await cdp('Target.attachToTarget', { targetId: signInTab, flatten: true });
  const callback = `http://127.0.0.1:1455/auth/callback?code=E2E-CODE&state=${encodeURIComponent(p.get('state'))}&client_id=oaiapp_e2e`;
  try { await cdp('Page.navigate', { url: callback }, tabSession); } catch { /* 移動の最中に、拡張機能がタブを閉じる */ }
  const signedIn = await waitFor(async () => (await state()).includes('サインイン済み'), { timeoutMs: 15000 });
  check('戻り先への移動を検知して、サインインが完了する（画面に反映される）', !!signedIn && (await state()).includes('e2e@example.com'), await state());

  const closed = await waitFor(async () => !(await pageTargets()).includes(signInTab));
  check('サインインのタブは、拡張機能が閉じる（「接続できません」の画面を残さない）', !!closed);

  const exchange = await evaluate(sw, `globalThis.__log.find((e) => e.url.endsWith('/oauth/token'))?.body || ''`);
  const ex = new URLSearchParams(exchange);
  check('トークンの交換は、PKCE の検証子と戻り先つきで、1 回だけ行われる',
    ex.get('grant_type') === 'authorization_code' && ex.get('code') === 'E2E-CODE' && ex.get('client_id') === 'oaiapp_e2e' &&
    (ex.get('code_verifier') || '').length >= 40 && ex.get('redirect_uri') === 'http://127.0.0.1:1455/auth/callback' &&
    (await evaluate(sw, `globalThis.__tokenCount`)) === 1);

  const models = await waitFor(() => get(`document.getElementById('model').value === 'gpt-e2e-luna'`));
  const optionValues = await get(`Array.from(document.getElementById('model').options, (o) => o.value)`);
  check('使えるモデルの一覧を取得し、軽量なモデルを自動で選ぶ（非表示のモデルは出ない）',
    !!models && optionValues.includes('gpt-e2e-sol') && !optionValues.includes('gpt-e2e-hidden'), optionValues.join(', '));

  // 4. 翻訳する（設定画面からの接続テスト用の経路と、ページからの経路の両方）
  const tr = await get(`chrome.runtime.sendMessage({ type: 'translate', noCache: true, texts: ['Hello', 'World'] })`);
  check('ChatGPT のプランで翻訳できる（提供元・モデルが結果に付く）',
    tr?.ok === true && tr.results[0] === '訳:Hello' && tr.results[1] === '訳:World' && tr.meta.provider === 'chatgpt' && tr.meta.model === 'gpt-e2e-luna',
    JSON.stringify(tr?.ok ? tr.meta.model : tr));
  const responses = await evaluate(sw, `globalThis.__log.filter((e) => e.url.endsWith('/responses'))`);
  const leaked = await evaluate(sw, `globalThis.__log.some((e) => /AT-|RT-/.test(e.url))`);
  check('トークンは Authorization ヘッダーでだけ送り、URL には出ない',
    responses.length >= 1 && responses.every((r) => r.auth === 'Bearer AT-1') && leaked === false);

  await get(`document.getElementById('test').click()`);
  const testText = await waitFor(async () => {
    const t = await get(`document.getElementById('status').textContent`);
    return t.includes('成功しました') || t.includes('失敗しました') ? t : '';
  }, { timeoutMs: 15000 });
  check('設定画面の「接続テスト」が ChatGPT で成功し、内訳に ChatGPT と表示される',
    testText.includes('成功しました') && testText.includes('ChatGPT の応答待ち'), testText.split('\n').slice(0, 3).join(' | '));

  // 5. 保存先の切り替え（「保存しておく」をオフにすると、ディスク側からトークンが消える）
  const where = async () => evaluate(ui, `(async () => ({
    local: !!(await chrome.storage.local.get('chatgptAuth')).chatgptAuth,
    session: !!(await chrome.storage.session.get('chatgptAuth')).chatgptAuth,
  }))()`);
  const w1 = await where();
  await get(`(() => { document.getElementById('rememberKey').checked = false; document.getElementById('save').click(); })()`);
  const w2 = await waitFor(async () => {
    const w = await where();
    return w.session && !w.local ? w : null;
  });
  check('「保存しておく」をオフにして保存すると、サインイン情報がディスク側から一時領域へ移る',
    w1.local && !w1.session && !!w2 && (await state()).includes('サインイン済み'), `切り替え前 ${JSON.stringify(w1)} → 後 ${JSON.stringify(w2)}`);
  const tr2 = await get(`chrome.runtime.sendMessage({ type: 'translate', noCache: true, texts: ['Again'] })`);
  check('保存先を切り替えたあとも、続けて翻訳できる', tr2?.ok === true && tr2.results[0] === '訳:Again', JSON.stringify(tr2?.ok));

  // 5b. サインイン済みでの「サインインし直す」は、保存した client_id を使う（登録をやり直さない）。中止しても、サインインは残る
  const beforeRe = await pageTargets();
  await get(`document.getElementById('chatgptSignIn').click()`);
  await waitFor(() => get(`!document.getElementById('chatgptCancel').hidden`));
  const pRe = new URL(await evaluate(sw, `globalThis.__authUrl`)).searchParams;
  check('サインインし直すときは、保存した client_id を使い、新しい登録を作らない',
    pRe.get('client_id') === 'oaiapp_e2e' && !pRe.has('agent_name_hint'), `client_id=${pRe.get('client_id')}`);
  await get(`document.getElementById('chatgptCancel').click()`);
  await waitFor(() => get(`document.getElementById('chatgptCancel').hidden`));
  const reTab = (await pageTargets()).find((t) => !beforeRe.includes(t));
  const stillSignedIn = (await state()).includes('サインイン済み') && (await where()).session;
  check('サインインし直しを中止しても、いまのサインインは残る', stillSignedIn && !(await pageTargets()).includes(reTab));

  // 6. サインアウト
  await get(`document.getElementById('chatgptSignOut').click()`);
  const out = await waitFor(async () => (await state()).includes('未サインイン'));
  const w3 = await where();
  const tr3 = await get(`chrome.runtime.sendMessage({ type: 'translate', noCache: true, texts: ['Bye'] })`);
  check('サインアウトすると、トークンが消え、翻訳は案内を返す（kind: nokey）',
    !!out && !w3.local && !w3.session && tr3?.ok === false && tr3.kind === 'nokey', JSON.stringify({ w3, kind: tr3?.kind }));

  // 7. state が違う戻り先は無視され、「中止」で待ち受けが終わる
  const before2 = await pageTargets();
  await get(`document.getElementById('chatgptSignIn').click()`);
  await waitFor(async () => (await state()).includes('サインイン待ち'));
  const p2 = new URL(await evaluate(sw, `globalThis.__authUrl`)).searchParams;
  check('サインアウト後のサインインは、新しく登録し直す（保存した client_id は、サインアウトで消えている）',
    p2.get('client_id') === 'dynamic_agent_client' && p2.has('agent_name_hint'), `client_id=${p2.get('client_id')}`);
  const tab2 = (await pageTargets()).find((t) => !before2.includes(t));
  const { sessionId: tabSession2 } = await cdp('Target.attachToTarget', { targetId: tab2, flatten: true });
  try {
    await cdp('Page.navigate', { url: 'http://127.0.0.1:1455/auth/callback?code=EVIL&state=not-my-state&client_id=oaiapp_evil' }, tabSession2);
  } catch { /* 無視されるので、タブは閉じられない */ }
  await sleep(1500);
  const stillWaiting = (await state()).includes('サインイン待ち');
  const tokensAfterEvil = await evaluate(sw, `globalThis.__tokenCount`);
  check('state が一致しない戻り先は無視される（トークン交換をせず、待ち受けを続ける）', stillWaiting && tokensAfterEvil === 1, await state());

  await get(`document.getElementById('chatgptCancel').click()`);
  const cancelled = await waitFor(async () => (await state()).includes('未サインイン'));
  const tabGone = await waitFor(async () => !(await pageTargets()).includes(tab2));
  check('「サインインを中止」で、待ち受けが終わり、タブも閉じる', !!cancelled && !!tabGone, await state());

  // 8. Gemini に戻せる
  const back = await get(`(() => {
    document.getElementById('providerGemini').click();
    return { gemini: !document.getElementById('geminiSection').hidden, chatgpt: !document.getElementById('chatgptSection').hidden,
      key: !document.getElementById('deleteKey').hidden };
  })()`);
  check('「Gemini API」に戻すと、APIキーの欄が戻る', back.gemini && !back.chatgpt && back.key, JSON.stringify(back));

  // 9. 併用: Gemini が 1 日の上限に達したら、ChatGPT に切り替える。上限に達したモデルは、しばらく試さない。
  //    もう一度サインインする（サインアウト済みのため）。画面操作は 1〜3 と同じなので、ここでは保存領域に直接入れる。
  await get(`(async () => {
    const dummy = ['dummy', 'gemini', 'key', 'for', 'e2e'].join('-');
    await chrome.storage.local.set({
      provider: 'gemini', apiKey: dummy, rememberKey: true, acknowledged: true, model: 'g-main', fallbackModel: 'g-backup',
      crossFallback: true, chatgptModel: 'gpt-e2e-luna',
      chatgptAuth: { accessToken: 'AT-9', refreshToken: 'RT-9', idToken: '', expiresAt: Date.now() + 3600000,
        scopes: ['openid', 'chatgpt.tokens.use.direct'], clientId: 'oaiapp_e2e', email: 'e2e@example.com', savedAt: Date.now() },
    });
    await chrome.storage.session.remove(['cooldown', 'chatgptAuth']);
  })()`);
  const fo1 = await get(`chrome.runtime.sendMessage({ type: 'translate', noCache: true, texts: ['Quota one'] })`);
  const geminiCalls1 = await evaluate(sw, `globalThis.__geminiLog.length`);
  check('併用: Gemini が 1 日の上限（429）に達したら、ChatGPT に切り替えて翻訳する（主・予備の 2 回だけ Gemini に問い合わせる）',
    fo1?.ok === true && fo1.results[0] === '訳:Quota one' && fo1.meta.provider === 'chatgpt' && fo1.meta.fellBack === true && geminiCalls1 === 2,
    JSON.stringify({ ok: fo1?.ok, provider: fo1?.meta?.provider, tried: fo1?.meta?.tried, geminiCalls: geminiCalls1 }));
  const fo2 = await get(`chrome.runtime.sendMessage({ type: 'translate', noCache: true, texts: ['Quota two'] })`);
  const geminiCalls2 = await evaluate(sw, `globalThis.__geminiLog.length`);
  const cool = await get(`(async () => Object.keys((await chrome.storage.session.get('cooldown')).cooldown || {}).sort())()`);
  const coolLocal = await get(`(async () => (await chrome.storage.local.get('cooldown')).cooldown === undefined)()`);
  check('併用: 上限に達したモデルは、しばらく試さない（2 回目は Gemini に問い合わせない）。記録は一時領域だけ',
    fo2?.ok === true && fo2.meta.provider === 'chatgpt' && geminiCalls2 === 2 &&
    JSON.stringify(cool) === JSON.stringify(['gemini:g-backup', 'gemini:g-main']) && coolLocal === true,
    JSON.stringify({ geminiCalls2, cool, coolLocal }));
  const onlyGemini = await get(`chrome.runtime.sendMessage({ type: 'translate', noCache: true, only: 'gemini', texts: ['Only'] })`);
  check('併用がオンでも、設定画面の「接続テスト」は 1 つの AI だけで確かめる（切り替え先に隠れない）',
    onlyGemini?.ok === false && onlyGemini.kind === 'quota', JSON.stringify({ ok: onlyGemini?.ok, kind: onlyGemini?.kind }));
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error('\n実行中にエラー:', e.message);
} finally {
  try { await cdp('Browser.close'); } catch { /* 終了処理 */ }
  await sleep(500);
  child.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 一時フォルダの削除に失敗しても無視 */ }
}

const ng = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - ng} / ${results.length} 件成功`);
process.exit(failed || ng ? 1 : 0);
