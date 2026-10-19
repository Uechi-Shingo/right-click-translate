// 翻訳結果の取り込みの「正確さ」の検証。
// 「完璧に応答するモデル」を仮定し、さまざまな文字列（改行・記号・コードの囲み・絵文字・長文 など）を
// ランダムに組み合わせて送り、拡張機能側で、欠け・ずれ・書き換わりが起きないかを確かめる。
// 実行: node tests/roundtrip.test.mjs
import assert from 'node:assert/strict';
import { makeEnv, createRunner, CONTENT_SCRIPT } from './helpers.mjs';

const { test, summary } = createRunner();

// 乱数（再現できるよう、種を固定）
let seed = 20261014;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const NL = String.fromCharCode(10);
const FENCE = '`'.repeat(3);
const FRAGMENTS = [
  'Hello world', 'こんにちは、世界', 'Line one' + NL + 'line two', 'col1\tcol2', 'emoji 😀 and 🇯🇵', 'تحية', '1 < 2 > 0 && a || b',
  '`inline code`', FENCE + 'js' + NL + 'const x = 1;' + NL + FENCE, '<<<>>>', '<<<abc>>>', '<div class="a">html-like</div>',
  '"quotes" and \'apostrophes\'', 'C:\\path\\to\\file', '- list item', '# heading', '100%', 'x'.repeat(300), 'a'.repeat(1500),
  'Tom & Jerry', '$1,000.00', '2026-10-14', 'e.g. foo/bar', '「かぎ括弧」', '…', '—',
];

const segment = () => {
  const n = 1 + Math.floor(rnd() * 3);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? pick([' ', NL, ', ']) : '') + pick(FRAGMENTS);
  return s.trim();
};

// 「完璧なモデル」: 受け取った断片の順番を保ち、各断片を「訳:」付きで、指定の形式で返す
function perfectModel(segments) {
  return segments.map((t, i) => `<<<${i + 1}>>>${NL}訳:${t}`).join(NL);
}

await test('ランダムな 300 通りの組み合わせで、断片の欠け・ずれ・書き換わりがない', async () => {
  const failures = [];
  for (let round = 0; round < 300; round++) {
    const count = 1 + Math.floor(rnd() * 25);
    const segments = Array.from({ length: count }, (_, i) => `[${round}-${i}] ` + segment());
    const env = makeEnv({
      responder: () => ({ json: { candidates: [{ content: { parts: [{ text: perfectModel(segments) }] } }] } }),
    });
    const r = await env.send({ type: 'translate', texts: segments, noCache: true }, CONTENT_SCRIPT);
    if (!r.ok) {
      failures.push({ round, why: `エラー: ${r.error}` });
      continue;
    }
    segments.forEach((s, i) => {
      if (r.results[i] !== '訳:' + s) failures.push({ round, index: i, expected: '訳:' + s.slice(0, 60), actual: String(r.results[i]).slice(0, 60) });
    });
  }
  assert.deepEqual(failures.slice(0, 3), [], `不一致 ${failures.length} 件（先頭 3 件を表示）`);
});

await test('モデルが全体をコードの囲み（```）で包んでも、中身を正しく取り出す', async () => {
  const segments = ['Alpha', 'Beta ' + FENCE + ' with fence inside', 'Gamma'];
  const wrapped = FENCE + NL + perfectModel(segments) + NL + FENCE;
  const env = makeEnv({ responder: () => ({ json: { candidates: [{ content: { parts: [{ text: wrapped }] } }] } }) });
  const r = await env.send({ type: 'translate', texts: segments, noCache: true }, CONTENT_SCRIPT);
  assert.deepEqual(Array.from(r.results), segments.map((s) => '訳:' + s));
});

await test('訳文が「改行 + ```」で終わるとき、その囲みを勝手に削らない', async () => {
  const segments = ['Run this:' + NL + FENCE];
  const env = makeEnv({
    responder: () => ({ json: { candidates: [{ content: { parts: [{ text: perfectModel(segments) }] } }] } }),
  });
  const r = await env.send({ type: 'translate', texts: segments, noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.results[0], '訳:' + segments[0]);
});

summary();
