// 拡張機能自身の処理時間（Google の応答時間を除く）と、ページ内処理の負荷・正確さを、実ブラウザで測る。
// API は偽の応答に差し替えるため、APIキーは不要で、Google への通信も発生しません。
//
// 実行: node tests/perf-check.mjs "<ブラウザの exe のパス>"
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserPath = process.argv[2];
const extDir = path.resolve(here, '..', 'extension');
if (!browserPath) {
  console.error('使い方: node tests/perf-check.mjs "<ブラウザの exe のパス>"');
  process.exit(2);
}

// ---- 偽の「Web ページ」（content.js を埋め込んだ確認用ページ）を作る
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ja-translate-perf-'));
const harness = path.join(tmp, 'harness.html');
execFileSync(process.execPath, [path.join(here, 'build-harness.mjs'), harness]);

const profile = path.join(tmp, 'profile');
const child = spawn(
  browserPath,
  [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ],
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
    setTimeout(() => pending.delete(id) && reject(new Error('timeout ' + method)), 180000);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function attach(url) {
  const { targetId } = await cdp('Target.createTarget', { url });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  return sessionId;
}

const fmt = (s) => `平均 ${s.mean.toFixed(1)} ms / 中央値 ${s.p50.toFixed(1)} ms / 95% ${s.p95.toFixed(1)} ms / 最大 ${s.max.toFixed(1)} ms`;

// ---- 裏方（background.js）の処理時間を測る。ブラウザ内で実行されるコード。
const BACKGROUND_BENCH = `(async () => {
  // Google への通信を、即座に返る偽の応答に差し替える（番号付きの断片を、そのまま「訳:」付きで返す）
  globalThis.fetch = async (url, init) => {
    const text = JSON.parse(init.body).contents[0].parts[0].text;
    const out = text.split('\\n').map((l) => (l.startsWith('<<<') && l.endsWith('>>>') ? l : '訳:' + l)).join('\\n');
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: out }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200 });
  };
  const resetBudget = () => chrome.storage.session.set({ usageLog: [] });
  const seg = (prefix, n, len) => Array.from({ length: n }, (_, i) => prefix + '-' + i + ' ' + 'word '.repeat(Math.ceil(len / 5)).slice(0, len));
  const summarize = (times) => {
    const t = [...times].sort((a, b) => a - b);
    const mean = t.reduce((s, x) => s + x, 0) / t.length;
    return { n: t.length, mean, p50: t[Math.floor(t.length / 2)], p95: t[Math.min(t.length - 1, Math.floor(t.length * 0.95))], max: t[t.length - 1] };
  };
  async function bench(n, makeTexts, opts) {
    const times = [];
    for (let i = 0; i < n; i++) {
      await resetBudget();
      const texts = makeTexts(i);
      const s = performance.now();
      const r = await translateTexts(texts, opts);
      times.push(performance.now() - s);
      if (!r.results.every(Boolean)) throw new Error('翻訳結果が欠けています');
    }
    return summarize(times);
  }
  const R = {};
  await chrome.storage.session.set({ usageLog: [] });
  R.single_noCache = await bench(40, (i) => seg('a' + i, 1, 60), { noCache: true });
  R.chunk80_noCache = await bench(20, (i) => seg('b' + i, 80, 50), { noCache: true });

  cacheMem = new Map();
  R.chunk80_cacheEmpty = await bench(20, (i) => seg('c' + i, 80, 50), { scope: 'example.com' });

  // キャッシュを上限（3,000 件・各 100 文字）まで埋めた状態
  cacheMem = new Map();
  for (let i = 0; i < 3000; i++) cacheMem.set('example.com\\nfill-' + i, '訳:' + 'x'.repeat(100));
  R.chunk80_cacheFull = await bench(20, (i) => seg('d' + i, 80, 50), { scope: 'example.com' });

  // 保存領域への書き込み単体（キャッシュ 3,000 件）
  const wt = [];
  for (let i = 0; i < 15; i++) {
    const s = performance.now();
    await chrome.storage.local.set({ translationCache: [...cacheMem] });
    wt.push(performance.now() - s);
  }
  R.storageWrite_3000 = summarize(wt);

  // キャッシュ命中のみ（Google への依頼なし）
  const hit = seg('hit', 80, 50);
  await translateTexts(hit, { scope: 'example.com' });
  const ht = [];
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    await translateTexts(hit, { scope: 'example.com' });
    ht.push(performance.now() - s);
  }
  R.chunk80_allCached = summarize(ht);

  // 2 件を同時に（ページ翻訳の実際の動き: 同時 2 件）
  const pt = [];
  for (let i = 0; i < 15; i++) {
    await resetBudget();
    const s = performance.now();
    await Promise.all([
      translateTexts(seg('p' + i + 'x', 80, 50), { scope: 'example.com' }),
      translateTexts(seg('p' + i + 'y', 80, 50), { scope: 'example.com' }),
    ]);
    pt.push(performance.now() - s);
  }
  R.chunk80_parallel2 = summarize(pt);

  cacheMem = new Map();
  await chrome.storage.local.remove('translationCache');
  return R;
})()`;

// ---- ページ内（content.js）の負荷と正確さを測る。ブラウザ内で実行されるコード。
const buildPageBench = (paragraphs) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mount = document.getElementById('mount');
  mount.textContent = '';
  const run = (window.__run = (window.__run || 0) + 1); // ページ内キャッシュ（同じ文の再利用）に当たらないよう、実行ごとに文を変える
  // 文字を極小（1px）にして、すべての段落を「画面の近く」に収める（最悪の状況: 全部を一度に翻訳対象にする）
  const frag = document.createDocumentFragment();
  for (let i = 0; i < ${paragraphs}; i++) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:1px;line-height:1px;margin:0;padding:0';
    p.innerHTML = 'Paragraph R' + run + '-' + i + ' has <b>bold</b> text and a <a href="#x">link number ' + i + '</a>, plus &amp; entities &lt;tag&gt;.<br>Second line ' + i + '.';
    frag.append(p);
  }
  mount.append(frag);
  document.documentElement.style.scrollBehavior = 'auto';
  mount.scrollIntoView({ block: 'start' }); // 画面の近くに来たものだけが翻訳対象になるため、領域まで移動する
  await wait(200);
  const before = document.body.innerHTML;
  const nodeCount = (() => { const w = document.createTreeWalker(mount, NodeFilter.SHOW_TEXT); let n = 0; while (w.nextNode()) n++; return n; })();

  // 並べ替え（文書順）単体のコスト
  const nodes = []; { const w = document.createTreeWalker(mount, NodeFilter.SHOW_TEXT); while (w.nextNode()) nodes.push(w.currentNode); }
  const sortStart = performance.now();
  [...nodes].sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const sortMs = performance.now() - sortStart;

  // 長い処理（メインスレッドが 50ms 以上止まる処理）を記録する
  const longTasks = [];
  const po = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
  try { po.observe({ type: 'longtask', buffered: true }); } catch (e) { /* 未対応なら記録しない */ }

  window.__sent.length = 0;
  const t0 = performance.now();
  window.__listener({ type: 'toggle-page' });
  // すべて訳されるまで待つ
  let translatedAll = false;
  for (let i = 0; i < 400; i++) {
    await wait(25);
    const w = document.createTreeWalker(mount, NodeFilter.SHOW_TEXT);
    let untranslated = 0;
    while (w.nextNode()) if (!w.currentNode.nodeValue.includes('訳:') && w.currentNode.nodeValue.trim().length > 1) untranslated++;
    if (untranslated === 0) { translatedAll = true; break; }
  }
  const translateMs = performance.now() - t0;
  const requests = window.__sent.length;
  po.disconnect();

  // 元に戻す → 完全に元の HTML と一致するか
  const r0 = performance.now();
  window.__listener({ type: 'toggle-page' });
  await wait(50);
  const restoreMs = performance.now() - r0;
  const restoredExactly = document.body.innerHTML === before;

  return {
    paragraphs: ${paragraphs}, textNodes: nodeCount, translatedAll, requests,
    translateMs, sortMs, restoreMs, restoredExactly,
    longTasks: longTasks.length, longestTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
  };
})()`;

// ---- ページ内の堅牢性: 極端な文字列・弾かれた依頼があっても、他の文章は訳されること（ブラウザ内で実行）
const ROBUSTNESS_BENCH = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mount = document.getElementById('mount');
  mount.textContent = '';
  document.documentElement.style.scrollBehavior = 'auto';
  const mk = (text) => {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:1px;line-height:1px;margin:0';
    p.textContent = text;
    mount.append(p);
    return p;
  };
  const normal1 = mk('Normal paragraph one for robustness check.');
  const huge = mk('Huge text node. ' + 'lorem ipsum '.repeat(2500)); // 約 30,000 文字
  const normal2 = mk('Normal paragraph two for robustness check.');
  const poisoned = mk('POISON paragraph that the background will reject.');
  const normal3 = mk('Normal paragraph three for robustness check.');
  const hugeBefore = huge.textContent;

  // 偽の裏方: 「POISON」を含む依頼だけ、検査で弾かれた（invalid）ことにする
  const original = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (msg) => {
    window.__sent.push(msg.texts);
    if (msg.texts.some((t) => t.includes('POISON'))) return { ok: false, kind: 'invalid', error: '翻訳の依頼の形式が不正です。' };
    return { ok: true, results: msg.texts.map((t) => '訳:' + t) };
  };
  mount.scrollIntoView({ block: 'start' });
  await wait(200);
  window.__sent.length = 0;
  window.__listener({ type: 'toggle-page' });
  await wait(1200);
  const result = {
    normalTranslated: [normal1, normal2, normal3].map((p) => p.textContent.includes('訳:')),
    hugeUntouched: huge.textContent === hugeBefore,
    hugeWasSent: window.__sent.flat().some((t) => t.startsWith('Huge text node')),
    poisonedUntouched: !poisoned.textContent.includes('訳:'),
  };
  window.__listener({ type: 'toggle-page' });
  chrome.runtime.sendMessage = original;
  return result;
})()`;

let exitCode = 0;
try {
  const v = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${v.product}\n`);

  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: extDir });
  const options = await attach(`chrome-extension://${extId}/options.html`);
  await sleep(500);
  await evaluate(options, `chrome.storage.local.set({ apiKey: 'dummy-key-for-perf-check', acknowledged: true, rememberKey: true, useCache: true })`);
  // 裏方を起動させる（実在しないキーでの 1 回の呼び出し。結果は使わない）
  await evaluate(options, `chrome.runtime.sendMessage({ type: 'translate', noCache: true, texts: ['wake up'] })`);
  const { targetInfos } = await cdp('Target.getTargets');
  const swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (!swTarget) throw new Error('サービスワーカーが見つかりません');
  const { sessionId: sw } = await cdp('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  await cdp('Runtime.enable', {}, sw);

  console.log('■ 裏方（background.js）の処理時間（Google への通信は偽の応答で、待ち時間 0）');
  const R = await evaluate(sw, BACKGROUND_BENCH);
  const rows = [
    ['single_noCache', '1 断片・キャッシュなし'],
    ['chunk80_noCache', '80 断片（通常のページ 1 回分）・キャッシュなし'],
    ['chunk80_cacheEmpty', '80 断片・キャッシュ有効（空）'],
    ['chunk80_cacheFull', '80 断片・キャッシュ有効（3,000 件が満杯）'],
    ['chunk80_allCached', '80 断片・すべてキャッシュ命中（API なし）'],
    ['chunk80_parallel2', '80 断片 × 2 件を同時に'],
    ['storageWrite_3000', '保存領域への書き込み単体（キャッシュ 3,000 件）'],
  ];
  for (const [key, label] of rows) console.log(`  ${label}\n      ${fmt(R[key])}`);

  console.log('\n■ ページ内（content.js）: 一度に全部を翻訳対象にする最悪ケース');
  const page = await attach(pathToFileURL(harness).href);
  await sleep(800);
  for (const n of [300, 800]) {
    const P = await evaluate(page, buildPageBench(n));
    console.log(`  ${P.paragraphs} 段落（文字ノード ${P.textNodes} 個）`);
    console.log(`      全部が訳されるまで ${P.translateMs.toFixed(0)} ms（依頼 ${P.requests} 回、完了=${P.translatedAll}）`);
    console.log(`      うち、文書順の並べ替え単体 ${P.sortMs.toFixed(0)} ms ／ 長い処理（50ms 超）${P.longTasks} 回・最長 ${P.longestTaskMs.toFixed(0)} ms`);
    console.log(`      元に戻す ${P.restoreMs.toFixed(0)} ms ／ 元の HTML と完全一致: ${P.restoredExactly ? '一致' : '不一致'}`);
    if (!P.translatedAll || !P.restoredExactly) exitCode = 1;
  }

  console.log('\n■ ページ内の堅牢性（極端に長い文字ノード・検査で弾かれた依頼があっても、他の文章は訳される）');
  const rb = await evaluate(page, ROBUSTNESS_BENCH);
  const okRb = rb.normalTranslated.every(Boolean) && rb.hugeUntouched && !rb.hugeWasSent && rb.poisonedUntouched;
  console.log(`  通常の段落 3 つ: ${rb.normalTranslated.every(Boolean) ? 'すべて翻訳された' : '翻訳されなかったものがある'}`);
  console.log(`  約 30,000 文字の巨大なノード: ${rb.hugeUntouched && !rb.hugeWasSent ? '対象外（送信せず、そのまま）' : '問題あり'}`);
  console.log(`  検査で弾かれた依頼の段落: ${rb.poisonedUntouched ? 'その部分だけ飛ばし、全体は継続' : '問題あり'}`);
  console.log(`  結果: ${okRb ? '合格' : '不合格'}`);
  if (!okRb) exitCode = 1;
} catch (e) {
  exitCode = 1;
  console.error('\n実行中にエラー:', e.message);
} finally {
  try { await cdp('Browser.close'); } catch { /* 終了処理 */ }
  await sleep(500);
  child.kill();
  await sleep(500);
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 無視 */ }
}
process.exit(exitCode);
