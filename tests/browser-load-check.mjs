// 実際の Chromium 系ブラウザ（Brave / Chrome / Edge）に拡張機能を読み込み、安全装置が実機で効いているか確認する。
// 一時的なプロファイルで headless 起動するため、普段使いのブラウザの設定・拡張機能・APIキーには触れません。
//
// 実行: node tests/browser-load-check.mjs "<ブラウザの exe のパス>"
//   例: node tests/browser-load-check.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
//
// 注意: 動作確認用に「偽の APIキー」を Google に送信します（無効なキーなので 400 で拒否されます）。
//       また、OpenAI へは認証なしの GET を 2 回だけ送ります（通信の許可の確認のため。秘密情報・本文は送りません）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserPath = process.argv[2];
const extDir = path.resolve(process.argv[3] || path.join(here, '..', 'extension'));
if (!browserPath) {
  console.error('使い方: node tests/browser-load-check.mjs "<ブラウザの exe のパス>" [extension フォルダ]');
  process.exit(2);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'ja-translate-check-'));
const child = spawn(
  browserPath,
  [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok' : 'NG'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function main() {
  const version = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${version.product}\n拡張機能: ${extDir}\n`);

  // 1. 読み込み（manifest・CSP が受理されるか）
  let extId;
  try {
    ({ id: extId } = await cdp('Extensions.loadUnpacked', { path: extDir }));
    check('拡張機能を読み込めた（manifest と CSP が受理された）', !!extId, `ID: ${extId}`);
  } catch (e) {
    check('拡張機能を読み込めた（manifest と CSP が受理された）', false, e.message);
    return;
  }

  // 2. 設定画面を開く
  const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  // 設定画面の読み込み（保存領域の読み出し・部品の組み立て）が終わるまで、最大 10 秒待つ
  let ui;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    ui = await evaluate(sessionId, `({
      title: document.title,
      models: document.getElementById('model')?.options.length,
      hasConsent: !!document.getElementById('acknowledged'),
      version: chrome.runtime.getManifest().version,
    })`);
    if (ui.models > 0 && ui.hasConsent) break;
  }
  check('設定画面が開き、部品が揃っている', ui.title.includes('設定') && ui.models > 0 && ui.hasConsent, JSON.stringify(ui));

  // 2b. ライト／ダークは、利用者の設定に合わせて切り替わること（強制ではない）
  const lum = (rgb) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : -1;
  };
  const readColors = () => evaluate(sessionId, `(() => {
    const cs = getComputedStyle(document.body);
    return { dark: matchMedia('(prefers-color-scheme: dark)').matches, bg: cs.backgroundColor, text: cs.color };
  })()`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId);
  await sleep(200);
  const darkColors = await readColors();
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await sleep(200);
  const lightColors = await readColors();
  check('設定画面は、利用者のダーク／ライトの設定に合わせて切り替わる（強制しない）',
    darkColors.dark === true && lum(darkColors.bg) < 100 && lum(darkColors.text) > 150 &&
    lightColors.dark === false && lum(lightColors.bg) > 200 && lum(lightColors.text) < 100,
    `ダーク設定: 背景 ${darkColors.bg} / ライト設定: 背景 ${lightColors.bg}`);

  // 3. 画面からの外部通信は CSP で止まるか
  const csp = await evaluate(sessionId, `(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
    const outcome = {};
    try { await fetch('https://example.com/', { mode: 'no-cors' }); outcome.external = 'allowed'; }
    catch { outcome.external = 'blocked'; }
    const s = document.createElement('script');
    s.textContent = 'window.__pwned = 1';
    document.body.append(s);
    outcome.inlineScriptRan = window.__pwned === 1;
    await new Promise((r) => setTimeout(r, 200));
    outcome.violations = violations;
    return outcome;
  })()`);
  check('設定画面から、許可した宛先以外（example.com など）への通信は、CSP によって遮断される',
    csp.external === 'blocked' && csp.violations.includes('connect-src'), JSON.stringify(csp));
  check('設定画面にスクリプトを差し込んでも実行されない', csp.inlineScriptRan === false && csp.violations.includes('script-src-elem'), JSON.stringify(csp.violations));

  // 3b. OpenAI（ChatGPT のプラン用）への通信は、CSP で許可されている。認証なしの GET を送るだけで、秘密情報・本文は送らない。
  //     （オフラインでも、CSP が止めたのか通信できなかったのかを区別できるよう、違反イベントの有無で判定する）
  const openai = await evaluate(sessionId, `(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.blockedURI));
    const out = {};
    for (const url of ['https://api.openai.com/v1/models', 'https://auth.openai.com/']) {
      try { out[url] = (await fetch(url)).status; } catch { out[url] = 'error'; }
    }
    await new Promise((r) => setTimeout(r, 200));
    out.violations = violations;
    return out;
  })()`);
  check('OpenAI（api / auth）への通信は、CSP で許可されている（CSP の違反が起きない）',
    openai.violations.length === 0, JSON.stringify(openai));

  // 4. キー未設定のときの挙動（裏方との通信が実際に成立する）
  const nokey = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'translate', texts: ['hello'] })`);
  check('キー未設定では翻訳を実行せず、案内を返す（裏方が起動し応答した）', nokey?.ok === false && nokey.kind === 'nokey', JSON.stringify(nokey));

  // 4b. 設定画面だけが呼べる機能が、実際の設定画面（タブとして開かれる）から呼べること。
  //     呼び出し元の確認を厳しくしすぎて、本物の設定画面を弾く不具合を防ぐための検査。
  const listModels = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'list-models' })`);
  check('設定画面から「モデル一覧」を呼べる（キー未設定なら、案内が返る）',
    listModels?.ok === false && listModels.kind === 'nokey', JSON.stringify(listModels));
  const clearCache = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'clear-cache' })`);
  check('設定画面から「キャッシュ削除」を呼べる', clearCache?.ok === true, JSON.stringify(clearCache));
  const cgStatus = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'chatgpt-status' })`);
  check('設定画面から「ChatGPT のサインイン状態」を呼べる（未サインイン）',
    cgStatus?.ok === true && cgStatus.status.signedIn === false && cgStatus.status.pending === false, JSON.stringify(cgStatus));

  // 5. 裏方（サービスワーカー）の通信も CSP で制限されているか
  const { targetInfos } = await cdp('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (sw) {
    const { sessionId: swSession } = await cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await cdp('Runtime.enable', {}, swSession);
    const swCsp = await evaluate(swSession, `(async () => {
      try { await fetch('https://example.com/', { mode: 'no-cors' }); return 'allowed'; } catch { return 'blocked'; }
    })()`);
    check('裏方（サービスワーカー）から、許可した宛先以外への通信も遮断される', swCsp === 'blocked', `結果: ${swCsp}`);
  } else {
    check('裏方（サービスワーカー）の通信制限を確認', false, 'サービスワーカーが見つかりませんでした');
  }

  // 6. キー保管モード（実際の storage で確認）
  // 偽のキー（秘密情報の検出ツールに誤検知されないよう、実行時に組み立てる）
  const fake = ['dummy', 'key', 'for', 'load', 'check', '0000000'].join('-');
  const storage = await evaluate(sessionId, `(async () => {
    const $ = (id) => document.getElementById(id);
    $('apiKey').value = ${JSON.stringify(fake)};
    $('rememberKey').checked = false;
    $('acknowledged').checked = true;
    $('save').click();
    await new Promise((r) => setTimeout(r, 400));
    const local = await chrome.storage.local.get(['apiKey', 'rememberKey', 'acknowledged']);
    const session = await chrome.storage.session.get('apiKey');
    return { localKey: local.apiKey, rememberKey: local.rememberKey, ack: local.acknowledged, sessionKey: session.apiKey };
  })()`);
  check('「忘れる」モードでは、キーがディスク側の保存領域に書かれない',
    storage.localKey === '' && storage.sessionKey === fake && storage.rememberKey === false && storage.ack === true,
    `local.apiKey=${JSON.stringify(storage.localKey)} / session に保持=${storage.sessionKey === fake}`);

  // 7. 実際に Google へ送る（偽キー → 拒否されるのが正常）。経路と CSP の許可を確認する。
  // 3 回測り、拡張機能の裏方から Google までの往復時間（認証エラーが返るまで）を見る。
  const samples = [];
  let real;
  for (let i = 0; i < 3; i++) {
    real = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'translate', noCache: true, texts: ['hello'] })`);
    if (real?.meta) samples.push(real.meta);
  }
  const reached = real?.kind === 'auth' || real?.kind === 'network';
  const timing = samples.length
    ? `Google までの往復（認証エラーが返るまで）: ${samples.map((m) => `${m.totalMs}ms`).join(' / ')}（待機 ${samples.map((m) => m.waitedMs).join('/')}ms、依頼 ${samples.map((m) => m.requests).join('/')} 回）`
    : '';
  check('Gemini への通信は許可されている（偽キーは Google に拒否されるのが正常）',
    reached && !JSON.stringify(real).includes(fake),
    real?.kind === 'network' ? 'ネットワークに接続できなかったため、通信経路の確認はできませんでした' : `kind=${real?.kind} / ${real?.error}\n        ${timing}`);

  // 7b. 応答速度の診断（偽キーなので、全件が認証エラーになるのが正常。画面 → 裏方 → Google の経路を確認する）
  const probe = await evaluate(sessionId, `(async () => {
    document.getElementById('probe').click();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const t = document.getElementById('status').textContent;
      if (t.includes('診断結果') || t.includes('診断に失敗')) return t;
    }
    return document.getElementById('status').textContent;
  })()`);
  check('設定画面の「応答速度を診断」が動作する（偽キーでは、全件が認証エラーになるのが正常）',
    probe.includes('診断結果') && probe.includes('失敗') && !probe.includes(fake),
    probe.split('\n').slice(0, 4).join(' | '));

  // 8. キーの削除
  const deleted = await evaluate(sessionId, `(async () => {
    document.getElementById('deleteKey').click();
    await new Promise((r) => setTimeout(r, 300));
    const local = await chrome.storage.local.get('apiKey');
    const session = await chrome.storage.session.get('apiKey');
    return { local: local.apiKey, session: session.apiKey };
  })()`);
  check('「APIキーを削除」で、両方の保存領域からキーが消える', !deleted.local && !deleted.session, JSON.stringify(deleted));
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
