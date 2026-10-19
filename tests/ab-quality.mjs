// 翻訳の質を、「旧方式」と「新方式」で、実際の Gemini を使って比べる（A/B 比較）。
//
//   旧方式: 依頼を、文字数・断片数だけで区切る。文脈（タイトル・見出し・直前の文章）は添えない。
//   新方式: 依頼を段落の境目で区切り、見出しは直後の本文と同じ依頼に入れる。文脈を、訳さない参考情報として添える。
//
// 同じページから、同じ断片を、同じモデルに、同じ指示（拡張機能と同じもの）で訳させ、結果を比べます。
//   1. 自動で数えられるもの: 番号の欠け（取りこぼし）の数、依頼回数、応答時間、出力のトークン数
//   2. 段落ごとの比較: 両方の訳を、順番を伏せて（A/B をランダムに入れ替えて）AI に見せ、どちらが良いかを判定させる
//      （判定も AI なので、完全ではありません。結果の JSON / Markdown に、原文と両方の訳を残すので、目でも確認してください）
//
// 実行（PowerShell）。APIキーは画面に表示されず、このウィンドウの中だけに置かれます:
//   $s = Read-Host "APIキー" -AsSecureString
//   $env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', $s).Password
//   node tests/ab-quality.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" `
//     https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html `
//     https://aws.amazon.com/about-aws/whats-new/recent/
//   Remove-Item Env:GEMINI_API_KEY                    # 終わったらキーを消す
//
// オプション:
//   --model <名前>        訳すモデル（既定: gemini-3.5-flash-lite）
//   --judge <名前>        判定に使うモデル（既定: --model と同じ。より強いモデルを指定すると、判定が安定します）
//   --limit-chars <数>    1 ページあたり、訳す文字数の上限（既定: 9000。無料枠の節約のため）
//   --judge-max <数>      判定する段落の数の上限（全ページ合計。既定: 24）
//   --out <フォルダ>      結果の出力先（既定: tests/ab-result）
//   --selftest            偽の Gemini（この PC の中だけ）で、ツール自体が動くかを確かめる（キー不要・通信なし）
//
// 注意: 無料枠を使います（既定の設定で、1 ページあたり 5〜8 回ほどの翻訳の依頼と、全体で最大 24 回の判定。依頼の間隔を空けるため、数分かかります）。
//       キーは画面にも結果にも出力しません。--selftest の結果（新方式の全勝）は、偽のエンジンによるもので、質の比較ではありません。
//       対象のページには、通常の閲覧と同じ読み取りアクセスだけを行います。ページの文章は、Google に送信されます。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeEnv } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 引数

const argv = process.argv.slice(2);
const flags = { model: 'gemini-3.5-flash-lite', judge: '', 'limit-chars': '9000', 'judge-max': '24', out: path.join(here, 'ab-result') };
const positional = [];
let selftest = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--selftest') selftest = true;
  else if (a.startsWith('--') && a.slice(2) in flags) flags[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) { console.error(`不明なオプション: ${a}`); process.exit(2); }
  else positional.push(a);
}
const [browserPath, ...urlArgs] = positional;
if (!browserPath || (!selftest && !urlArgs.length)) {
  console.error('使い方: node tests/ab-quality.mjs "<ブラウザの exe のパス>" <URL> [<URL> ...] [--model M] [--judge M] [--limit-chars N] [--judge-max N] [--out DIR]\n        node tests/ab-quality.mjs "<ブラウザの exe のパス>" --selftest');
  process.exit(2);
}
const MODEL = flags.model;
const JUDGE = flags.judge || MODEL;
const LIMIT_CHARS = Number(flags['limit-chars']);
const JUDGE_MAX = Number(flags['judge-max']);
let OUT = path.resolve(flags.out);

const contentJs = readFileSync(path.join(here, '..', 'extension', 'content.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 拡張機能と同じ指示・形式（background.js から取り出す）

const bg = makeEnv({ responder: () => { throw new Error('通信しません'); } });
const buildTranslateRequest = bg.evalIn('buildTranslateRequest');
const parseSegments = bg.evalIn('parseSegments');

// ---------------------------------------------------------------- Gemini

let BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
let KEY = process.env.GEMINI_API_KEY || '';
let minIntervalMs = 4200; // 無料枠の「1 分あたりの回数」を超えないための間隔
let lastCall = 0;
let apiCalls = 0;

async function gemini(model, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCall + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    apiCalls++;
    const startedAt = Date.now();
    let res;
    let text;
    try {
      res = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (e) {
      if (attempt === 3) throw new Error(`通信に失敗しました: ${e.message}`);
      await sleep(3000);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (/PerDay/i.test(text)) throw new Error('1 日の無料枠を使い切りました。時間を置くか、別のモデルを指定してください。');
      const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(text);
      await sleep(Math.min(60000, (m ? Number(m[1]) : 8) * 1000 + 500));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.split(KEY).join('[キー]').slice(0, 240)}`);
    const data = JSON.parse(text);
    return { data, ms: Date.now() - startedAt };
  }
  throw new Error('混雑のため、依頼が通りませんでした。時間を置いて、もう一度お試しください。');
}

const textOf = (data) => (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');

// 1 回の翻訳の依頼。{ segments, ms, outTokens }
async function translate(texts, context) {
  const { body } = buildTranslateRequest(texts, context);
  const { data, ms } = await gemini(MODEL, body);
  return { segments: parseSegments(textOf(data), texts.length), ms, outTokens: data.usageMetadata?.candidatesTokenCount || 0 };
}

// ---------------------------------------------------------------- ページから、新方式の依頼と、断片ごとの情報を集める

const STUB = `
  window.__msgs = [];
  window.__listener = null;
  window.chrome = { runtime: {
    onMessage: { addListener(fn) { window.__listener = fn; } },
    sendMessage: async (msg) => {
      window.__msgs.push({ texts: msg.texts, context: msg.context || null });
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, results: msg.texts.map((t) => '訳:' + t) };
    },
  } };`;

// 断片（原文）ごとに、属する段落の番号・前後の空白（ページの表示を再現するため）を調べる。訳す前に呼ぶ。
const NODE_INFO = `(() => {
  const BLOCK = new Set(['P','LI','H1','H2','H3','H4','H5','H6','TD','TH','DT','DD','BLOCKQUOTE','FIGCAPTION','CAPTION','SUMMARY','DIV','SECTION','ARTICLE','ASIDE','HEADER','FOOTER','NAV','MAIN','FORM','FIELDSET','LEGEND','UL','OL','DL','TR','TABLE','PRE','BODY']);
  const ids = new Map();
  const info = {};
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const core = n.nodeValue.trim();
    if (!core || info[core]) continue;
    let el = n.parentElement;
    while (el && !BLOCK.has(el.tagName)) el = el.parentElement;
    el = el || document.body;
    if (!ids.has(el)) ids.set(el, ids.size);
    info[core] = { block: ids.get(el), lead: n.nodeValue.slice(0, n.nodeValue.length - n.nodeValue.trimStart().length), trail: n.nodeValue.slice(n.nodeValue.trimEnd().length) };
  }
  return info;
})()`;

let browser = null;
function startBrowser() {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'ja-ab-'));
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
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    setTimeout(() => pending.delete(id) && reject(new Error(`タイムアウト: ${method}`)), 120000);
  });
  const evaluate = async (sessionId, expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  browser = {
    cdp, evaluate,
    async close() {
      try { await cdp('Browser.close'); } catch { /* 終了処理 */ }
      await sleep(400);
      child.kill();
      await sleep(400);
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 無視 */ }
    },
  };
}

async function capturePage(url) {
  const { cdp, evaluate } = browser;
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Page.enable', {}, sessionId);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp('Network.enable', {}, sessionId);
  const ua = (await cdp('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
  await cdp('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en;q=0.9' }, sessionId);
  await cdp('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await evaluate(sessionId, 'document.readyState')) === 'complete') break; } catch { /* 遷移中 */ }
  }
  await sleep(3000); // JavaScript による描画を待つ
  const height = Math.min(30000, await evaluate(sessionId, 'document.documentElement.scrollHeight'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height, deviceScaleFactor: 1, mobile: false }, sessionId); // 全体を、一度に訳す対象にする
  await sleep(500);
  const info = await evaluate(sessionId, NODE_INFO);
  await evaluate(sessionId, STUB);
  await evaluate(sessionId, contentJs);
  await evaluate(sessionId, `window.__listener({ type: 'toggle-page' }); true`);
  let last = -1;
  let since = Date.now();
  for (let i = 0; i < 120; i++) { // 依頼の数が、しばらく増えなくなるまで待つ
    const n = await evaluate(sessionId, 'window.__msgs.length');
    if (n !== last) { last = n; since = Date.now(); } else if (n > 0 && Date.now() - since > 1500) break;
    await sleep(200);
  }
  const requests = await evaluate(sessionId, 'window.__msgs');
  const title = await evaluate(sessionId, 'document.title');
  await cdp('Target.closeTarget', { targetId });
  return { requests, info, title };
}

// ---------------------------------------------------------------- 旧方式の区切り（文字数 4,500・断片数 80 だけ）

function oldChunking(texts) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  texts.forEach((t, i) => {
    if (cur.length && (chars + t.length > 4500 || cur.length >= 80)) { chunks.push(cur); cur = []; chars = 0; }
    cur.push(i);
    chars += t.length;
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------- 判定

let seed = 12345; // 判定の A/B の入れ替えを、毎回同じにする
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

async function judge(source, a, b) {
  const prompt = [
    '次は、英語の Web ページの 1 つの段落です（リンクや太字で複数の断片に分かれていたものを、順につなげたもの）。日本語訳が 2 つあります。',
    'どちらが、原文の意味を正確に伝え、日本語として自然で読みやすいかを判定してください。',
    '- 製品名・コード・URL・数値・固有名詞が原文のまま残っていることは、正しいです。',
    '- 意味の誤り・訳抜け・不自然な言い回し・文のつながりの不具合（断片の境目での重複や欠け）を重く見てください。',
    '- 差がほとんどなければ tie にしてください。',
    '',
    `【原文】\n${source}`,
    '',
    `【訳 A】\n${a}`,
    '',
    `【訳 B】\n${b}`,
    '',
    '出力は、次の JSON だけにしてください: {"winner": "A" または "B" または "tie", "reason": "短い理由（日本語）"}',
  ].join('\n');
  const { data } = await gemini(JUDGE, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 512 },
  });
  const out = JSON.parse(textOf(data).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!['A', 'B', 'tie'].includes(out.winner)) throw new Error('判定の形式が不正です');
  return { winner: out.winner, reason: String(out.reason || '').slice(0, 300) };
}

// ---------------------------------------------------------------- 本体

async function evaluatePage(url) {
  console.log(`\n■ ${url}`);
  const { requests, info, title } = await capturePage(url);
  // 新方式の依頼を、文字数の上限まで（依頼の区切りで）取り出す
  const newReqs = [];
  let chars = 0;
  for (const r of requests) {
    const n = r.texts.reduce((s, t) => s + t.length, 0);
    if (newReqs.length && chars + n > LIMIT_CHARS) break;
    newReqs.push(r);
    chars += n;
  }
  const flat = newReqs.flatMap((r) => r.texts);
  if (!flat.length) { console.log('  訳す文字が見つかりませんでした'); return null; }
  const oldChunks = oldChunking(flat);
  console.log(`  タイトル: ${title.slice(0, 60)}\n  対象: ${flat.length} 断片・${chars} 文字 ／ 依頼: 新方式 ${newReqs.length} 回・旧方式 ${oldChunks.length} 回`);

  const trNew = new Array(flat.length).fill(null);
  const trOld = new Array(flat.length).fill(null);
  const stat = { new: { ms: 0, tokens: 0 }, old: { ms: 0, tokens: 0 } };

  let offset = 0;
  for (let i = 0; i < newReqs.length; i++) {
    const r = newReqs[i];
    process.stdout.write(`  新方式 ${i + 1}/${newReqs.length}\r`);
    const out = await translate(r.texts, r.context || undefined);
    out.segments.forEach((s, k) => { trNew[offset + k] = s; });
    stat.new.ms += out.ms;
    stat.new.tokens += out.outTokens;
    offset += r.texts.length;
  }
  for (let i = 0; i < oldChunks.length; i++) {
    const idxs = oldChunks[i];
    process.stdout.write(`  旧方式 ${i + 1}/${oldChunks.length}\r`);
    const out = await translate(idxs.map((k) => flat[k])); // 文脈なし
    out.segments.forEach((s, k) => { trOld[idxs[k]] = s; });
    stat.old.ms += out.ms;
    stat.old.tokens += out.outTokens;
  }

  const missing = (arr) => arr.filter((x) => !x).length;
  console.log(`  番号の欠け（取りこぼし）: 新方式 ${missing(trNew)} 個 ／ 旧方式 ${missing(trOld)} 個`);
  console.log(`  応答時間の合計: 新方式 ${(stat.new.ms / 1000).toFixed(1)} 秒 ／ 旧方式 ${(stat.old.ms / 1000).toFixed(1)} 秒（依頼 1 回あたり ${(stat.new.ms / 1000 / newReqs.length).toFixed(1)} 秒 / ${(stat.old.ms / 1000 / oldChunks.length).toFixed(1)} 秒）`);
  console.log(`  出力トークン: 新方式 ${stat.new.tokens} ／ 旧方式 ${stat.old.tokens}`);

  // 段落（複数の断片からなるもの）に分ける
  const blockOf = (i) => info[flat[i]]?.block ?? -1;
  const oldChunkOf = new Map();
  oldChunks.forEach((idxs, ci) => idxs.forEach((k) => oldChunkOf.set(k, ci)));
  const newChunkOf = new Map();
  let o = 0;
  newReqs.forEach((r, ci) => { r.texts.forEach((_, k) => newChunkOf.set(o + k, ci)); o += r.texts.length; });

  const units = [];
  for (let i = 0; i < flat.length;) {
    let j = i;
    while (j + 1 < flat.length && blockOf(j + 1) === blockOf(i) && blockOf(i) >= 0) j++;
    if (j > i) {
      const idx = Array.from({ length: j - i + 1 }, (_, k) => i + k);
      if (idx.every((k) => trNew[k] && trOld[k])) {
        const join = (arr) => collapse(idx.map((k) => `${info[flat[k]]?.lead ?? ''}${arr[k]}${info[flat[k]]?.trail ?? ''}`).join(''));
        units.push({
          url,
          source: collapse(idx.map((k) => `${info[flat[k]]?.lead ?? ''}${flat[k]}${info[flat[k]]?.trail ?? ''}`).join('')),
          old: join(trOld),
          new: join(trNew),
          splitInOld: new Set(idx.map((k) => oldChunkOf.get(k))).size > 1,
          splitInNew: new Set(idx.map((k) => newChunkOf.get(k))).size > 1,
          fragments: idx.length,
        });
      }
    }
    i = j + 1;
  }
  console.log(`  複数の断片からなる段落: ${units.length} 個（旧方式で、依頼をまたいで分かれたもの: ${units.filter((u) => u.splitInOld).length} 個 ／ 新方式: ${units.filter((u) => u.splitInNew).length} 個）`);
  return {
    url, units, flatCount: flat.length, requests: { new: newReqs.length, old: oldChunks.length },
    missing: { new: missing(trNew), old: missing(trOld) }, stat,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  startBrowser();
  const pages = [];
  try {
    for (const url of urlArgs) {
      try { const p = await evaluatePage(url); if (p) pages.push(p); } catch (e) { console.log(`  失敗: ${e.message}`); }
    }
  } finally {
    await browser.close();
  }

  // 判定する段落: 旧方式で分かれたものを優先し、残りは断片の多い順
  const all = pages.flatMap((p) => p.units);
  const pick = [
    ...all.filter((u) => u.splitInOld),
    ...all.filter((u) => !u.splitInOld).sort((a, b) => b.fragments - a.fragments),
  ].slice(0, JUDGE_MAX);

  console.log(`\n判定: ${pick.length} 段落（${JUDGE} が、順番を伏せて、どちらが良いかを判定します）`);
  const verdicts = [];
  for (let i = 0; i < pick.length; i++) {
    const u = pick[i];
    process.stdout.write(`  判定 ${i + 1}/${pick.length}\r`);
    const newIsA = rand() < 0.5;
    try {
      const v = await judge(u.source, newIsA ? u.new : u.old, newIsA ? u.old : u.new);
      const winner = v.winner === 'tie' ? 'tie' : (v.winner === 'A') === newIsA ? 'new' : 'old';
      verdicts.push({ ...u, winner, reason: v.reason, newWasA: newIsA });
    } catch (e) {
      verdicts.push({ ...u, winner: 'error', reason: e.message });
    }
  }

  const count = (list, w) => list.filter((v) => v.winner === w).length;
  const summarize = (label, list) => {
    const n = count(list, 'new');
    const o = count(list, 'old');
    const t = count(list, 'tie');
    const valid = n + o + t;
    return `  ${label}: 新方式が良い ${n} ／ 旧方式が良い ${o} ／ 差なし ${t}（判定できなかった ${count(list, 'error')}）${valid ? ` → 新方式の勝ち越し ${n - o >= 0 ? '+' : ''}${n - o}` : ''}`;
  };
  console.log('\n==== 結果 ====');
  for (const p of pages) {
    console.log(`${p.url}\n  依頼: 新方式 ${p.requests.new} 回 ／ 旧方式 ${p.requests.old} 回 ・ 番号の欠け: 新方式 ${p.missing.new} ／ 旧方式 ${p.missing.old} ・ 応答時間(1 回あたり): ${(p.stat.new.ms / 1000 / p.requests.new).toFixed(1)} 秒 / ${(p.stat.old.ms / 1000 / p.requests.old).toFixed(1)} 秒`);
  }
  console.log(summarize('全体', verdicts));
  console.log(summarize('旧方式で、依頼をまたいで分かれた段落', verdicts.filter((v) => v.splitInOld)));
  console.log(summarize('それ以外の段落', verdicts.filter((v) => !v.splitInOld)));
  console.log(`  （API への依頼 ${apiCalls} 回）`);

  writeFileSync(path.join(OUT, 'ab-result.json'), JSON.stringify({ model: MODEL, judge: JUDGE, pages: pages.map(({ units, ...rest }) => rest), verdicts }, null, 2));
  const md = [
    '# 翻訳の質の A/B 比較（旧方式 vs 新方式）', '',
    `訳したモデル: ${MODEL} ／ 判定したモデル: ${JUDGE}`, '',
    ...verdicts.flatMap((v, i) => [
      `## ${i + 1}. ${v.winner === 'new' ? '新方式が良い' : v.winner === 'old' ? '旧方式が良い' : v.winner === 'tie' ? '差なし' : '判定できず'}${v.splitInOld ? '（旧方式で、依頼をまたいで分かれた段落）' : ''}`,
      `- ページ: ${v.url}`, `- 断片の数: ${v.fragments}`, `- 判定の理由: ${v.reason}`, '',
      `**原文**\n\n> ${v.source}\n`, `**旧方式の訳**\n\n> ${v.old}\n`, `**新方式の訳**\n\n> ${v.new}\n`,
    ]),
  ].join('\n');
  writeFileSync(path.join(OUT, 'ab-result.md'), md);
  console.log(`\n詳細（原文と両方の訳・判定の理由）: ${path.join(OUT, 'ab-result.md')}`);
  return { pages, verdicts };
}

// ---------------------------------------------------------------- 自己テスト（偽の Gemini。キー不要・外部への通信なし）

async function runSelftest() {
  // 偽の Gemini: 参考情報（文脈）が付いた依頼の訳には「+」を付けて、新旧の違いが分かるようにする。判定は、「+」の付いた方を勝たせる。
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body);
      const prompt = json.contents[0].parts[0].text;
      let out;
      if (json.generationConfig?.responseMimeType === 'application/json') {
        const a = /【訳 A】\n([\s\S]*?)\n\n【訳 B】/.exec(prompt)[1];
        const b = /【訳 B】\n([\s\S]*?)\n\n出力は/.exec(prompt)[1];
        out = JSON.stringify({ winner: a.includes('訳+:') ? 'A' : b.includes('訳+:') ? 'B' : 'tie', reason: '（自己テスト）' });
      } else {
        const mark = prompt.includes('【参考情報') ? '訳+:' : '訳:';
        out = prompt.replace(/<<<(\d+)>>>\n([\s\S]*?)(?=\n<<<\d+>>>|$)/g, (_, n, t) => `<<<${n}>>>\n${mark}${t}`).replace(/^[\s\S]*?(?=<<<1>>>)/, '');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }], usageMetadata: { candidatesTokenCount: 10 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}/v1beta/models`;
  KEY = 'selftest-key';
  minIntervalMs = 0;

  // 確認用ページ: 見出し 2 つと、断片に分かれた段落 4 つ（旧方式だと、最後の段落の途中で区切られる）
  const work = mkdtempSync(path.join(os.tmpdir(), 'ja-ab-selftest-'));
  const piece = (tag, k) => `${tag}-${String(k).padStart(2, '0')} ${'word '.repeat(19).trim()}`;
  const para = (tag) => `<p>${Array.from({ length: 12 }, (_, k) => `<b>${piece(tag, k + 1)}</b> `).join('')}</p>`;
  const file = path.join(work, 'page.html');
  writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Selftest page</title></head><body>
<h1>Guide</h1><h2>Section One</h2>${para('P1')}${para('P2')}${para('P3')}<h2>Section Two</h2>${para('P4')}</body></html>`);
  urlArgs.push(pathToFileURL(file).href);
  OUT = path.join(work, 'out');
  try {
    const { pages, verdicts } = await main();
    const ok = pages.length === 1 && pages[0].requests.old >= 1 && verdicts.length > 0 &&
      verdicts.every((v) => v.winner === 'new') && pages[0].missing.new === 0 && pages[0].missing.old === 0;
    console.log(ok ? '\n自己テスト: 成功（新旧の依頼づくり・翻訳・判定・集計が動作しました）' : '\n自己テスト: 失敗');
    return ok;
  } finally {
    server.close();
    try { rmSync(work, { recursive: true, force: true }); } catch { /* 無視 */ }
  }
}

if (selftest) {
  const ok = await runSelftest().catch((e) => { console.error(e); return false; });
  process.exit(ok ? 0 : 1);
} else {
  if (!KEY) {
    console.error('環境変数 GEMINI_API_KEY がありません。ファイル先頭の「実行」の手順を参照してください。');
    process.exit(2);
  }
  console.log(`モデル: ${MODEL} ／ 判定: ${JUDGE} ／ 1 ページあたり 約 ${LIMIT_CHARS} 文字まで`);
  await main();
}
