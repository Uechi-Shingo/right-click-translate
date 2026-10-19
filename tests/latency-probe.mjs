// Gemini API の応答時間を、ブラウザ・拡張機能を介さずに測る（原因の切り分け用）。
//
// 目的: 「遅いのは Google 側か、手前の経路（ブラウザ・ネットワーク）か」「どのモデルなら速いか」を確かめる。
//
// 実行（PowerShell）。APIキーは画面に表示されず、このウィンドウの中だけに置かれます:
//   $s = Read-Host "APIキー" -AsSecureString
//   $env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new('', $s).Password
//   node tests/latency-probe.mjs                     # 既定のモデルを測る
//   node tests/latency-probe.mjs gemini-3.1-flash-lite gemini-3.6-flash   # モデルを指定
//   Remove-Item Env:GEMINI_API_KEY                    # 終わったらキーを消す
//
// 注意: 各モデルに数回の依頼を送ります（無料枠を少し使います）。キーは画面に出力しません。

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('環境変数 GEMINI_API_KEY がありません。ファイル先頭の「実行」の手順を参照してください。');
  process.exit(2);
}

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const TIMEOUT_MS = 150000;

const sec = (ms) => `${(ms / 1000).toFixed(1)} 秒`;

function serverTime(headers) {
  const h = headers.get('server-timing');
  const m = h && /dur=(\d+(?:\.\d+)?)/.exec(h);
  return m ? Number(m[1]) : null;
}

async function call(model, { stream }) {
  const url = `${BASE}${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const headersAt = Date.now() - started;
  let firstChunkAt = null;
  let text = '';
  if (stream && res.body) {
    for await (const chunk of res.body) {
      if (firstChunkAt === null) firstChunkAt = Date.now() - started;
      text += Buffer.from(chunk).toString('utf8');
    }
  } else {
    text = await res.text();
  }
  const total = Date.now() - started;
  let usage = {};
  try {
    const last = stream ? text.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5) : text;
    usage = JSON.parse(last || '{}').usageMetadata || {};
  } catch { /* 解釈できなければ、トークン数は表示しない */ }
  return { status: res.status, headersAt, firstChunkAt, total, serverMs: serverTime(res.headers), usage };
}

function show(label, r) {
  const parts = [
    `HTTP ${r.status}`,
    `全体 ${sec(r.total)}`,
    `応答の頭が届くまで ${sec(r.headersAt)}`,
    r.firstChunkAt != null ? `最初のデータ ${sec(r.firstChunkAt)}` : null,
    r.serverMs != null ? `Google サーバー処理 ${sec(r.serverMs)}` : 'Server-Timing なし',
    r.usage.thoughtsTokenCount != null ? `思考 ${r.usage.thoughtsTokenCount} トークン` : null,
  ].filter(Boolean);
  console.log(`    ${label}: ${parts.join(' ／ ')}`);
}

console.log(`測定開始（上限 ${TIMEOUT_MS / 1000} 秒 / 依頼）\n`);
for (const model of models) {
  console.log(`■ ${model}`);
  for (const [label, opts] of [['通常（1 回目）', { stream: false }], ['通常（2 回目）', { stream: false }], ['ストリーミング', { stream: true }]]) {
    try {
      show(label, await call(model, opts));
    } catch (e) {
      console.log(`    ${label}: 失敗（${e.name === 'TimeoutError' ? `${TIMEOUT_MS / 1000} 秒以内に応答なし` : e.message}）`);
    }
  }
  console.log('');
}
console.log('読み方:');
console.log('  - 「Google サーバー処理」が「全体」に近い → Google のサーバー内で待たされている（混雑など）。拡張機能・ブラウザは無関係。');
console.log('  - 「Google サーバー処理」が短いのに「全体」が長い → Google の手前（ネットワーク・回線・セキュリティソフト等）の問題。');
console.log('  - モデルによって大きく違う → 速いモデルを主モデルにする。');
