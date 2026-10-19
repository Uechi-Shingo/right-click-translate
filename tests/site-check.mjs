// 実際の Web サイトで、ページ翻訳が「どこまで効くか」を調べる（互換性の確認）。
// 翻訳は偽の応答（「訳:」を付けるだけ）に差し替えるため、APIキーは不要で、Google への通信も発生しません。
// 対象のサイトには、通常の閲覧と同じ読み取りアクセスだけを行います。
//
// 実行: node tests/site-check.mjs "<ブラウザの exe のパス>" <URL> [<URL> ...]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [browserPath, ...urls] = process.argv.slice(2);
if (!browserPath || !urls.length) {
  console.error('使い方: node tests/site-check.mjs "<ブラウザの exe のパス>" <URL> [<URL> ...]');
  process.exit(2);
}
const contentJs = readFileSync(path.join(here, '..', 'extension', 'content.js'), 'utf8');

const profile = mkdtempSync(path.join(os.tmpdir(), 'ja-translate-site-'));
const child = spawn(
  browserPath,
  ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--lang=en-US', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);

let nextId = 1;
const pending = new Map();
let buf = '';
child.stdio[4].on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!raw) continue;
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    setTimeout(() => pending.delete(id) && reject(new Error('timeout ' + method)), 120000);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// ページ内に入れる「偽の chrome」。翻訳は「訳:」を付けるだけ。
const STUB = `
  window.__sent = [];
  window.__listener = null;
  window.chrome = {
    runtime: {
      onMessage: { addListener(fn) { window.__listener = fn; } },
      sendMessage: async (msg) => {
        window.__sent.push(msg.texts.length);
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, results: msg.texts.map((t) => '訳:' + t) };
      },
    },
  };
`;

const SCROLL_AND_WAIT = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  document.documentElement.style.scrollBehavior = 'auto';
  let steps = 0;
  for (let i = 0; i < 80; i++) {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    await wait(300);
    steps++;
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 5) break;
  }
  await wait(1500);
  const pageHeight = document.documentElement.scrollHeight;
  window.scrollTo(0, 0);
  return { steps, pageHeight, requests: window.__sent.length };
})()`;

const STATS = `(() => {
  const hasLetters = (s) => /[A-Za-z]{2,}/.test(s);
  const walk = (root, fn) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fn(n);
  };
  const isVisible = (el) => {
    try { return el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: false }) && el.getClientRects().length > 0; }
    catch (e) { return el.getClientRects().length > 0; }
  };
  const sig = (el) => {
    const a = el.closest('[id],[class]') || el;
    return a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.classList && a.classList[0] ? '.' + a.classList[0] : '');
  };
  const out = {
    total: 0, translated: 0,
    untranslated: { hidden: 0, noTranslateAttr: 0, visibleOther: 0 },
    visibleSamples: [], visibleBySig: {},
    code: { total: 0, translated: 0 },
    shadowRoots: 0, shadowTextNodes: 0, iframes: 0, iframeSrcs: [],
  };
  walk(document.body, (n) => {
    const el = n.parentElement;
    const t = n.nodeValue.trim();
    if (!el || !hasLetters(t)) return;
    if (el.closest('script,style,noscript,template')) return;
    const translated = n.nodeValue.includes('訳:');
    if (el.closest('code,pre,kbd,samp')) { out.code.total++; if (translated) out.code.translated++; return; }
    out.total++;
    if (translated) { out.translated++; return; }
    if (el.closest('[translate="no"],.notranslate')) { out.untranslated.noTranslateAttr++; return; }
    if (!isVisible(el)) { out.untranslated.hidden++; return; }
    out.untranslated.visibleOther++;
    const k = sig(el);
    out.visibleBySig[k] = (out.visibleBySig[k] || 0) + 1;
    if (out.visibleSamples.length < 12) out.visibleSamples.push(t.slice(0, 60) + '  [' + k + ']');
  });
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        out.shadowRoots++;
        walk(el.shadowRoot, (n) => { if (hasLetters(n.nodeValue)) out.shadowTextNodes++; });
        visit(el.shadowRoot);
      }
    }
  };
  visit(document);
  const frames = [...document.querySelectorAll('iframe')];
  out.iframes = frames.length;
  out.iframeSrcs = frames.slice(0, 4).map((f) => (f.src || '(src なし)').slice(0, 70));
  out.visibleBySig = Object.entries(out.visibleBySig).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return out;
})()`;

let exitCode = 0;
try {
  const v = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${v.product}（ヘッドレス・英語環境）\n`);

  for (const url of urls) {
    console.log(`■ ${url}`);
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Page.enable', {}, sessionId);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp('Network.enable', {}, sessionId);
    await cdp('Network.setUserAgentOverride', { userAgent: (await cdp('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome'), acceptLanguage: 'en-US,en;q=0.9' }, sessionId);
    await cdp('Page.navigate', { url }, sessionId);

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        if ((await evaluate(sessionId, 'document.readyState')) === 'complete') { ready = true; break; }
      } catch { /* 遷移中 */ }
    }
    await sleep(4000); // 動的な表示（JavaScript による描画）を待つ
    if (!ready) console.log('  （読み込みが完了しませんでした。取得できた範囲で測定します）');

    const info = await evaluate(sessionId, '({ title: document.title.slice(0, 70), url: location.href.slice(0, 90), lang: document.documentElement.lang })');
    console.log(`  タイトル: ${info.title}\n  実際の URL: ${info.url}（lang=${info.lang || '未指定'}）`);

    await evaluate(sessionId, STUB);
    await evaluate(sessionId, contentJs);
    await evaluate(sessionId, `window.__listener({ type: 'toggle-page' }); true`);
    await sleep(800);
    const scroll = await evaluate(sessionId, SCROLL_AND_WAIT);
    const s = await evaluate(sessionId, STATS);

    const shown = s.translated + s.untranslated.visibleOther;
    const pct = shown ? Math.round((s.translated / shown) * 100) : 0;
    console.log(`  ページの長さ: ${scroll.pageHeight}px ／ スクロール ${scroll.steps} 回 ／ 翻訳の依頼 ${scroll.requests} 回`);
    console.log(`  本文の文字ノード（コード除く）: ${s.total} 個`);
    console.log(`    ├ 翻訳された: ${s.translated} 個`);
    console.log(`    ├ 画面に見えない（非表示）ため対象外: ${s.untranslated.hidden} 個`);
    console.log(`    ├ 「翻訳しない」指定（translate=no / notranslate）: ${s.untranslated.noTranslateAttr} 個`);
    console.log(`    └ 見えているのに翻訳されていない: ${s.untranslated.visibleOther} 個`);
    console.log(`  → 見えている本文のうち、翻訳された割合: ${pct}%`);
    console.log(`  コード部分（code / pre）: ${s.code.total} 個、うち翻訳された ${s.code.translated} 個（0 が正しい）`);
    console.log(`  Shadow DOM: ${s.shadowRoots} 個（中の文字ノード ${s.shadowTextNodes}）／ iframe: ${s.iframes} 個`);
    if (s.iframes) console.log(`    iframe の例: ${s.iframeSrcs.join(' , ')}`);
    if (s.visibleSamples.length) {
      console.log('  見えているのに翻訳されていない本文の例:');
      for (const x of s.visibleSamples) console.log(`    - ${x}`);
      console.log(`  内訳（要素の種類）: ${s.visibleBySig.map(([k, n]) => `${k} ×${n}`).join(' ／ ')}`);
    }
    console.log('');
    await cdp('Target.closeTarget', { targetId });
  }
} catch (e) {
  exitCode = 1;
  console.error('\n実行中にエラー:', e.message);
} finally {
  try { await cdp('Browser.close'); } catch { /* 終了処理 */ }
  await sleep(500);
  child.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 無視 */ }
}
process.exit(exitCode);
