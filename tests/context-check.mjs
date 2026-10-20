// 実際の Chromium 系ブラウザで、content.js の「依頼のまとめ方（区切り位置）」と「文脈（参考情報）」を確かめる。
// 確認用ページに content.js を埋め込み、chrome.* を偽物に差し替える（拡張機能の読み込みや、外部への通信はしない）。
//
// 確かめること:
//   ・段落の途中で区切らない（同じ段落の断片は、同じ依頼に入る）
//   ・見出しは、直後の本文と同じ依頼に入る
//   ・すべての断片が、文書順に、1 回ずつ送られる（欠け・重複がない）
//   ・文脈（タイトル・直前の見出し・直前の文章）が、原文で添えられる（すでに訳した部分も、訳す前の文字）
//   ・入力欄・コードなど、翻訳しない部分の文字は、文脈にも含まれない
//
// 実行: node tests/context-check.mjs "<ブラウザの exe のパス>"
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserPath = process.argv[2];
if (!browserPath) {
  console.error('使い方: node tests/context-check.mjs "<ブラウザの exe のパス>"');
  process.exit(2);
}
const contentJs = readFileSync(path.join(here, '..', 'extension', 'content.js'), 'utf8');
if (contentJs.includes('</script>')) throw new Error('content.js に </script> が含まれています');

// ---------------------------------------------------------------- 確認用ページ

const STUB = `
  window.__msgs = [];
  window.__listener = null;
  window.chrome = { runtime: {
    onMessage: { addListener(fn) { window.__listener = fn; } },
    sendMessage: async (msg) => {
      window.__msgs.push({ texts: msg.texts, context: msg.context || null });
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, results: msg.texts.map((t) => '訳:' + t) };
    },
  } };`;

const work = mkdtempSync(path.join(os.tmpdir(), 'ja-context-check-'));
const pageUrl = (name, title, body, css = '') => {
  const file = path.join(work, `${name}.html`);
  writeFileSync(file, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px/1.5 sans-serif;margin:16px}${css}</style></head>
<body>
${body}
<script>${STUB}</script>
<script>
${contentJs}
</script>
</body></html>`);
  return pathToFileURL(file).href;
};

// 1 つの段落（約 1,200 文字）を、12 個の太字（<b>）の断片（約 100 文字ずつ）に分けたもの。段落の中で文が分かれた状態を表す。
// ※ ページのタイトル（<title>）も翻訳の対象で、最初の断片として送られる。
const pieces = (tag, n = 12) => Array.from({ length: n }, (_, k) => `${tag}-${String(k + 1).padStart(2, '0')} ${'word '.repeat(19).trim()}`);
const paragraph = (tag, n = 12) => `<p>${pieces(tag, n).map((t) => `<b>${t}</b> `).join('')}</p>`;
const words = (head, length) => `${head} ${'alpha beta gamma '.repeat(Math.ceil(length / 17))}`.slice(0, length).trim();

// A: 見出し 2 つ・段落 4 つ（合計 約 4,850 文字）。旧方式なら、最後の段落の途中（文字数の上限）で区切られる。
const A = {
  url: pageUrl('a', 'Doc title', [
    '<h1>Guide</h1>', '<h2>Section One</h2>', paragraph('P1'), paragraph('P2'), paragraph('P3'), '<h2>Section Two</h2>', paragraph('P4'),
  ].join('\n')),
  expected: ['Doc title', 'Guide', 'Section One', ...pieces('P1'), ...pieces('P2'), ...pieces('P3'), 'Section Two', ...pieces('P4')],
};

// F: 長い段落のあとに見出しがあり、その次の段落で上限を超える。見出しが、前の依頼の末尾に残らないこと。
const bigText = words('BIG-ONE', 4480);
const smallText = words('SMALL-TWO', 500);
const F = {
  url: pageUrl('f', 'F title', `<p>${bigText}</p>\n<h2>Heading X</h2>\n<p>${smallText}</p>`),
  expected: ['F title', bigText, 'Heading X', smallText],
};

// C: 入力欄・コードなど、翻訳しない部分が、直前にある。文脈に、その文字が入らないこと。
const longText = words('LONG-BEFORE', 4480);
const C = {
  url: pageUrl('c', 'C title', [
    `<p>${longText}</p>`,
    '<pre>SECRET-CODE-IN-PRE</pre>',
    '<div contenteditable="true">SECRET-EDITABLE</div>',
    '<textarea>SECRET-TEXTAREA</textarea>',
    '<h2>Next</h2>',
    '<p>Target paragraph here.</p>',
  ].join('\n')),
  expected: ['C title', longText, 'Next', 'Target paragraph here.'],
};

// B: 縦に長いページ。最初に見える範囲を訳したあと、下にスクロールして続きを訳す。直前の段落は、すでに訳した（日本語になった）もの。
const B = {
  url: pageUrl(
    'b', 'Doc title B',
    Array.from({ length: 40 }, (_, i) => `<p>${words(`Paragraph ${i + 1}:`, 250)}</p>`).join('\n'),
    'p{margin:0;height:130px;overflow:hidden}',
  ),
};

// ---------------------------------------------------------------- ブラウザの操作

const profile = mkdtempSync(path.join(os.tmpdir(), 'ja-context-profile-'));
// CI（GitHub Actions）など、追加のオプションが要る環境用（例: BROWSER_FLAGS="--no-sandbox"）
const extraFlags = (process.env.BROWSER_FLAGS || '').split(/\s+/).filter(Boolean);
const child = spawn(
  browserPath,
  ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...extraFlags, 'about:blank'],
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

// 送られた依頼の数が、しばらく増えなくなるまで待つ
async function settle(sessionId, quietMs = 1000, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let last = -1;
  let since = Date.now();
  while (Date.now() < until) {
    const n = await evaluate(sessionId, 'window.__msgs.length');
    if (n !== last) { last = n; since = Date.now(); }
    else if (n > 0 && Date.now() - since >= quietMs) break;
    await sleep(150);
  }
}

async function run(url, { height = 900, scroll = false } = {}) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Page.enable', {}, sessionId);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 60; i++) {
    if (await evaluate(sessionId, `typeof window.__listener === 'function'`).catch(() => false)) break;
    await sleep(100);
  }
  await evaluate(sessionId, `window.__listener({ type: 'toggle-page' }); true`);
  await settle(sessionId);
  const firstPhase = await evaluate(sessionId, 'window.__msgs.length');
  if (scroll) {
    await evaluate(sessionId, `document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.documentElement.scrollHeight); true`);
    await sleep(1500);
    await settle(sessionId, 1200);
  }
  const msgs = await evaluate(sessionId, 'window.__msgs');
  await cdp('Target.closeTarget', { targetId });
  return { msgs, firstPhase };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok' : 'NG'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}
const requestsOf = (msgs, predicate) => msgs.map((m, i) => (m.texts.some(predicate) ? i : -1)).filter((i) => i >= 0);

async function main() {
  const version = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${version.product}\n`);

  // ---- A: 段落の途中で区切らない・見出しは直後の本文と同じ依頼・欠け重複がない・文脈
  let { msgs } = await run(A.url);
  const flat = msgs.flatMap((m) => m.texts);
  check('すべての断片が、文書順に、1 回ずつ送られる（欠け・重複がない）', JSON.stringify(flat) === JSON.stringify(A.expected), `${flat.length} 個 / 期待 ${A.expected.length} 個`);
  const sizes = msgs.map((m) => m.texts.length);
  check('依頼は 2 回に分かれる', msgs.length === 2, `断片数: ${sizes.join(' / ')}`);
  const paragraphsSplit = ['P1', 'P2', 'P3', 'P4'].filter((p) => requestsOf(msgs, (t) => t.startsWith(`${p}-`)).length > 1);
  check('同じ段落の断片は、同じ依頼に入る（段落の途中で区切らない）', paragraphsSplit.length === 0, paragraphsSplit.length ? `分かれた段落: ${paragraphsSplit.join(', ')}` : '');
  const headingReq = requestsOf(msgs, (t) => t === 'Section Two');
  const bodyReq = requestsOf(msgs, (t) => t.startsWith('P4-01'));
  check('見出し（Section Two）は、直後の本文と同じ依頼に入る', headingReq.length === 1 && headingReq[0] === bodyReq[0], `見出し: ${headingReq} / 本文: ${bodyReq}`);

  const c1 = msgs[0].context;
  check('最初の依頼の文脈は、ページのタイトルだけ（前に見出し・文章がない）', c1 && c1.title === 'Doc title' && !c1.heading && !c1.before, JSON.stringify(c1));
  const c2 = msgs[1].context;
  const p3Tail = pieces('P3').join(' ').replace(/\s+/g, ' ').slice(-300);
  check('2 つ目の依頼の文脈: タイトル・直前の見出し・直前の文章（段落の終わりの 300 文字）が、原文で入る',
    c2 && c2.title === 'Doc title' && c2.heading === 'Section One' && c2.before === p3Tail, JSON.stringify(c2)?.slice(0, 260));
  check('文脈の各項目は、長さの上限（200・200・300 文字）に収まる',
    msgs.every((m) => !m.context || ((m.context.title || '').length <= 200 && (m.context.heading || '').length <= 200 && (m.context.before || '').length <= 300)));

  // ---- F: 見出しが、前の依頼の末尾に残らない
  ({ msgs } = await run(F.url));
  const fFlat = msgs.flatMap((m) => m.texts);
  check('（F）すべての断片が、文書順に、1 回ずつ送られる', JSON.stringify(fFlat) === JSON.stringify(F.expected));
  check('（F）長い段落のあとの見出しは、次の本文と同じ依頼に回る（前の依頼の末尾に残らない）',
    msgs.length === 2 && msgs[0].texts.length === 2 && msgs[1].texts[0] === 'Heading X' && msgs[1].texts[1] === smallText,
    msgs.map((m) => m.texts.map((t) => t.slice(0, 9))).join(' | '));

  // ---- C: 翻訳しない部分は、文脈にも含まれない
  ({ msgs } = await run(C.url));
  const cFlat = msgs.flatMap((m) => m.texts);
  check('（C）すべての断片が、文書順に、1 回ずつ送られる（入力欄・コードは、送られない）', JSON.stringify(cFlat) === JSON.stringify(C.expected), `${cFlat.length} 個`);
  const everything = JSON.stringify(msgs);
  check('（C）入力欄・コード・編集可能な部分の文字は、依頼にも文脈にも含まれない', !everything.includes('SECRET'));
  const cc = msgs[msgs.length - 1].context;
  check('（C）直前の文章は、翻訳しない部分を飛ばして、その手前の段落から取る',
    msgs.length === 2 && cc && cc.before === longText.slice(-300), JSON.stringify(cc)?.slice(0, 200));

  // ---- B: すでに訳した部分も、文脈には原文（訳す前の文字）で入る。タイトルも原文
  const runB = await run(B.url, { height: 800, scroll: true });
  msgs = runB.msgs;
  const bFirst = runB.firstPhase;
  const later = msgs.slice(bFirst);
  const withBefore = later.filter((m) => m.context?.before);
  check('（B）スクロールして続きを訳すとき、直前の段落（すでに訳した部分）は、原文で文脈に入る',
    later.length > 0 && withBefore.length === later.length && withBefore.every((m) => /^Paragraph \d+:/.test(m.context.before) && !m.context.before.includes('訳:')),
    `最初の範囲 ${bFirst} 回 / 続き ${later.length} 回 / 例: ${JSON.stringify(later[0]?.context?.before)?.slice(0, 60)}`);
  check('（B）タイトルは、すべての依頼で原文のまま（ページのタイトルが訳されたあとも）', msgs.every((m) => m.context?.title === 'Doc title B'));
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
