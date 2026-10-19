// 実際の Chromium 系ブラウザで、右下の枠（バッジ）と選択範囲のパネルに「使ったモデル」が出ることを確かめる。
// 確認用ページに content.js を埋め込み、chrome.* を偽物に差し替える（拡張機能の読み込みや、外部への通信はしない）。
// 枠は Shadow DOM（closed）の中にあるため、確認用ページの中だけ、open に差し替えて中身を読む。
//
// 実行: node tests/badge-check.mjs "<ブラウザの exe のパス>"
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserPath = process.argv[2];
if (!browserPath) {
  console.error('使い方: node tests/badge-check.mjs "<ブラウザの exe のパス>"');
  process.exit(2);
}
const contentJs = readFileSync(path.join(here, '..', 'extension', 'content.js'), 'utf8');
if (contentJs.includes('</script>')) throw new Error('content.js に </script> が含まれています');

const work = mkdtempSync(path.join(os.tmpdir(), 'ja-badge-check-'));
const pageFile = path.join(work, 'page.html');
// 1 回に送る量の上限（約 4,500 文字）を超えるよう、長めの段落を並べて、複数の依頼に分かれるようにする
const paragraphs = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1}: ${'The quick brown fox jumps over the lazy dog. '.repeat(14)}</p>`).join('\n');
writeFileSync(pageFile, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Badge check</title></head>
<body>
<h1>Badge check</h1>
${paragraphs}
<script>
  const real = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const s = real.call(this, { ...init, mode: 'open' }); window.__shadow = s; return s; };
  const scenario = new URLSearchParams(location.search).get('s');
  const metas = {
    single: [{ provider: 'gemini', model: 'gemini-3.5-flash-lite', cached: 0 }],
    fallback: [{ provider: 'gemini', model: 'gemini-3.5-flash-lite', cached: 0 }, { provider: 'chatgpt', model: 'gpt-demo-luna', cached: 0 }],
    cached: [{ provider: 'gemini', model: '', cached: 5 }],
    selection: [{ provider: 'chatgpt', model: 'gpt-demo-luna', cached: 0 }],
  }[scenario] || [];
  let n = 0;
  window.__listener = null;
  window.chrome = { runtime: {
    onMessage: { addListener(fn) { window.__listener = fn; } },
    sendMessage: async (msg) => {
      await new Promise((r) => setTimeout(r, 40));
      const meta = metas[Math.min(n, metas.length - 1)];
      n += 1;
      return { ok: true, results: msg.texts.map((t) => '訳:' + t), meta };
    },
  } };
</script>
<script>
${contentJs}
</script>
</body></html>`);

const profile = mkdtempSync(path.join(os.tmpdir(), 'ja-badge-profile-'));
const child = spawn(
  browserPath,
  ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);
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
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  setTimeout(() => pending.delete(id) && reject(new Error(`タイムアウト: ${method}`)), 30000);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(fn, { timeoutMs = 8000, everyMs = 100 } = {}) {
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

async function openScenario(scenario) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Page.enable', {}, sessionId);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 5000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp('Page.navigate', { url: `${pathToFileURL(pageFile).href}?s=${scenario}` }, sessionId);
  await waitFor(() => evaluate(sessionId, `typeof window.__listener === 'function'`));
  return { targetId, sessionId };
}

const badge = (s) => evaluate(s, `(() => {
  const el = window.__shadow?.querySelector('.badge');
  if (!el) return null;
  return { main: el.querySelector('.msg > div')?.textContent || '', detail: el.querySelector('.detail')?.textContent || '' };
})()`);

async function main() {
  const version = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${version.product}\n`);

  // 1. 1 つのモデルで翻訳した
  let t = await openScenario('single');
  await evaluate(t.sessionId, `window.__listener({ type: 'toggle-page' })`);
  let b = await waitFor(async () => {
    const x = await badge(t.sessionId);
    return x && x.main.includes('翻訳済み') && x.detail ? x : null;
  });
  check('右下の枠に、使ったモデル（提供元 / モデル名）が出る', b?.detail === 'モデル: Gemini / gemini-3.5-flash-lite', JSON.stringify(b));
  const replaced = await evaluate(t.sessionId, `document.querySelector('p').textContent.startsWith('訳:')`);
  check('（確認）ページの文章が訳文に置き換わっている', replaced === true);

  // 2. 併用で、途中から別の AI に切り替わった
  t = await openScenario('fallback');
  await evaluate(t.sessionId, `window.__listener({ type: 'toggle-page' })`);
  b = await waitFor(async () => {
    const x = await badge(t.sessionId);
    return x && x.main.includes('翻訳済み') && x.detail.includes('ChatGPT') ? x : null;
  });
  check('併用で切り替わったときは、使ったモデルがすべて並ぶ',
    b?.detail === 'モデル: Gemini / gemini-3.5-flash-lite、ChatGPT / gpt-demo-luna', JSON.stringify(b));

  // 3. すべて保存済みの翻訳（モデルが分からない）
  t = await openScenario('cached');
  await evaluate(t.sessionId, `window.__listener({ type: 'toggle-page' })`);
  b = await waitFor(async () => {
    const x = await badge(t.sessionId);
    return x && x.main.includes('翻訳済み') && x.detail ? x : null;
  });
  check('保存済みの翻訳だけのときは、その旨を表示する', b?.detail === '保存済みの翻訳を再利用', JSON.stringify(b));

  // 4. 「原文に戻す」で枠が消える
  await evaluate(t.sessionId, `window.__listener({ type: 'toggle-page' })`);
  const gone = await waitFor(async () => (await badge(t.sessionId)) === null);
  check('「原文に戻す」（もう一度操作）で、枠が消える', !!gone);

  // 5. 選択範囲の翻訳のパネル
  t = await openScenario('selection');
  await evaluate(t.sessionId, `window.__listener({ type: 'translate-selection', text: 'Hello world' })`);
  const panel = await waitFor(async () => {
    const x = await evaluate(t.sessionId, `(() => {
      const el = window.__shadow?.querySelector('.panel');
      if (!el) return null;
      return { body: el.querySelector('.body')?.textContent || '', model: el.querySelector('.model')?.textContent || '' };
    })()`);
    return x && x.body.startsWith('訳:') && x.model ? x : null;
  });
  check('選択範囲の翻訳のパネルにも、使ったモデルが出る', panel?.model === 'ChatGPT / gpt-demo-luna' && panel.body === '訳:Hello world', JSON.stringify(panel));
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
  for (const dir of [profile, work]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 無視 */ }
  }
}

const ng = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - ng} / ${results.length} 件成功`);
process.exit(failed || ng ? 1 : 0);
