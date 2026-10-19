// background.js のロジック（分割・再試行・予備モデル・キャッシュ）を、chrome と fetch を差し替えて検証する。
// 実行: node tests/background.test.mjs
import assert from 'node:assert/strict';
import { makeEnv, echoTranslate, createRunner, CONTENT_SCRIPT } from './helpers.mjs';

const { test, summary } = createRunner();

await test('複数断片をまとめて 1 リクエストで翻訳し、順序どおりに返す', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  const r = await env.send({ type: 'translate', texts: ['Hello', 'World\nline2', 'Third'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, ['訳:Hello', '訳:World\nline2', '訳:Third']);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].key, 'test-key');
  assert.ok(!env.calls[0].url.includes('test-key'), 'APIキーを URL に載せない');
});

await test('キャッシュ済みの断片は API に送らない', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  await env.send({ type: 'translate', texts: ['Hello', 'World'] }, CONTENT_SCRIPT);
  const r = await env.send({ type: 'translate', texts: ['World', 'New'] }, CONTENT_SCRIPT);
  assert.deepEqual(r.results, ['訳:World', '訳:New']);
  assert.equal(env.calls.length, 2);
  assert.ok(!env.calls[1].userText.includes('World'));
});

await test('1日の上限 (429 PerDay) では予備モデルに切り替える', async () => {
  const env = makeEnv({
    settings: { model: 'primary', fallbackModel: 'backup' },
    responder: ({ model, userText }) => model === 'primary'
      ? { status: 429, text: '{"error":{"message":"quota","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}' }
      : echoTranslate(userText),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, ['訳:Hello']);
  assert.deepEqual(env.calls.map((c) => c.model), ['primary', 'backup']);
});

await test('分あたりの上限 (429 retryDelay) は待って同じモデルで再試行する', async () => {
  const env = makeEnv({
    responder: ({ call, userText }) => call === 1
      ? { status: 429, text: '{"error":{"details":[{"retryDelay":"3s"}]}}' }
      : echoTranslate(userText),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[0].model, env.calls[1].model);
});

await test('APIキー無効は予備モデルを試さず、分かりやすいエラーを返す', async () => {
  const env = makeEnv({
    settings: { fallbackModel: 'backup' },
    responder: () => ({ status: 400, text: '{"error":{"message":"API key not valid. Please pass a valid API key."}}' }),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'auth');
  assert.match(r.error, /APIキーが無効/);
  assert.equal(env.calls.length, 1);
});

await test('APIキー未設定のときは API を呼ばずにエラーを返す', async () => {
  const env = makeEnv({ settings: { apiKey: '' }, responder: () => { throw new Error('呼ばれてはいけない'); } });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'nokey');
  assert.equal(env.calls.length, 0);
});

await test('番号が欠けた断片だけをやり直す', async () => {
  const env = makeEnv({
    responder: ({ call, userText }) => call === 1
      ? { json: { candidates: [{ content: { parts: [{ text: '<<<1>>>\n訳:A\n<<<3>>>\n訳:C' }] } }] } }
      : echoTranslate(userText),
  });
  const r = await env.send({ type: 'translate', texts: ['A', 'B', 'C'] });
  assert.deepEqual(r.results, ['訳:A', '訳:B', '訳:C']);
  assert.equal(env.calls.length, 2);
  assert.ok(env.calls[1].userText.includes('B') && !env.calls[1].userText.includes('A'));
});

await test('コードフェンスで囲まれた出力・単一断片の番号なし出力も解釈する', async () => {
  const fenced = makeEnv({ responder: () => ({ json: { candidates: [{ content: { parts: [{ text: '```\n<<<1>>>\n訳:A\n<<<2>>>\n訳:B\n```' }] } }] } }) });
  assert.deepEqual((await fenced.send({ type: 'translate', texts: ['A', 'B'] })).results, ['訳:A', '訳:B']);

  const plain = makeEnv({ responder: () => ({ json: { candidates: [{ content: { parts: [{ text: 'こんにちは' }] } }] } }) });
  assert.deepEqual((await plain.send({ type: 'translate', texts: ['Hello'] })).results, ['こんにちは']);
});

await test('安全フィルターで全体がブロックされたら半分ずつに分けて救う', async () => {
  const env = makeEnv({
    responder: ({ userText }) => userText.includes('BAD')
      ? { json: { promptFeedback: { blockReason: 'SAFETY' } } }
      : echoTranslate(userText),
  });
  const r = await env.send({ type: 'translate', texts: ['ok1', 'BAD', 'ok2', 'ok3'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, ['訳:ok1', null, '訳:ok2', '訳:ok3']);
});

await test('thought パートは訳文に混ぜない', async () => {
  const env = makeEnv({
    responder: () => ({ json: { candidates: [{ content: { parts: [{ thought: true, text: 'thinking...' }, { text: '<<<1>>>\n訳:A' }] } }] } }),
  });
  assert.deepEqual((await env.send({ type: 'translate', texts: ['A'] })).results, ['訳:A']);
});

const m = (name, methods = ['generateContent'], displayName = name) => ({ name: `models/${name}`, displayName, supportedGenerationMethods: methods });

await test('モデル一覧: 翻訳に使える Gemini だけを新しい順に並べる', async () => {
  const env = makeEnv({
    responder: () => { throw new Error('呼ばれてはいけない'); },
    listResponder: () => ({
      json: {
        models: [
          m('gemini-2.5-flash'),
          m('gemini-3.5-flash-lite'),
          m('gemini-3.8-flash'),
          m('gemini-3.8-pro'),
          m('gemini-3.6-flash'),
          m('gemini-2.5-flash-lite'),
          m('gemini-3.1-flash-lite-preview'),
          // 除外されるもの
          m('gemini-2.5-flash-preview-tts'),
          m('gemini-3.1-flash-image'),
          m('gemini-embedding-001', ['embedContent']),
          m('gemini-flash-latest'),
          m('gemini-2.0-flash-001'),
          m('gemini-2.5-flash-lite-preview-06-17'),
          m('gemini-2.5-flash-native-audio-latest'),
          m('gemini-3.5-flash', ['countTokens']),
          m('gemma-3-27b-it'),
          m('gemini-1.5-flash'),
        ],
      },
    }),
  });
  const r = await env.send({ type: 'list-models' });
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.models, (x) => x.id), [
    'gemini-3.8-flash',
    'gemini-3.8-pro',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ]);
  assert.equal(env.calls[0].key, 'test-key');
  assert.ok(!env.calls[0].url.includes('test-key'), 'APIキーを URL に載せない');
});

await test('モデル一覧: 複数ページを取得する / キー無効なら分かりやすいエラー', async () => {
  const paged = makeEnv({
    responder: () => { throw new Error('呼ばれてはいけない'); },
    listResponder: ({ url }) => url.includes('pageToken=p2')
      ? { json: { models: [m('gemini-3.6-flash')] } }
      : { json: { models: [m('gemini-3.8-flash')], nextPageToken: 'p2' } },
  });
  const r1 = await paged.send({ type: 'list-models' });
  assert.deepEqual(Array.from(r1.models, (x) => x.id), ['gemini-3.8-flash', 'gemini-3.6-flash']);

  const bad = makeEnv({
    responder: () => { throw new Error('呼ばれてはいけない'); },
    listResponder: () => ({ status: 400, text: '{"error":{"message":"API key not valid."}}' }),
  });
  const r2 = await bad.send({ type: 'list-models' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /APIキーが無効/);

  const nokey = makeEnv({ settings: { apiKey: '' }, responder: () => {}, listResponder: () => { throw new Error('呼ばれてはいけない'); } });
  assert.equal((await nokey.send({ type: 'list-models' })).kind, 'nokey');
});

await test('所要時間の内訳（meta）を返す: 依頼回数・成功したモデル・待機時間', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.equal(r.meta.requests, 1);
  assert.equal(r.meta.waitedMs, 0);
  assert.equal(r.meta.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(Array.from(r.meta.tried), ['gemini-3.5-flash-lite']);
  assert.ok(Number.isFinite(r.meta.totalMs) && Number.isFinite(r.meta.apiMs));
});

await test('429 の再試行では、Google が示した待ち時間だけ待つ（倍々にしない）', async () => {
  // retryDelay 3s → 待機は 3.5 秒。2 回続けて 429 でも、2 回目の待機は 7 秒ではなく 3.5 秒。
  const env = makeEnv({
    responder: ({ call, userText }) => call <= 2
      ? { status: 429, text: '{"error":{"details":[{"retryDelay":"3s"}]}}' }
      : echoTranslate(userText),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.equal(r.meta.requests, 3);
  assert.equal(r.meta.waitedMs, 3500 * 2);
});

await test('5xx の再試行は、回数に応じて待機を延ばす', async () => {
  const env = makeEnv({
    responder: ({ call, userText }) => call <= 2 ? { status: 503, text: '{}' } : echoTranslate(userText),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.equal(r.meta.waitedMs, 1500 + 3000);
});

await test('失敗したときも、内訳（meta）と試したモデルを返す', async () => {
  const env = makeEnv({
    settings: { model: 'primary', fallbackModel: 'backup' },
    responder: () => ({ status: 429, text: '{"error":{"details":[{"quotaId":"PerDay"}]}}' }),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, false);
  assert.deepEqual(Array.from(r.meta.tried), ['primary', 'backup']);
  assert.equal(r.meta.requests, 2);
  assert.equal(r.meta.model, '');
});

await test('Google の応答が遅いときは、待つのをやめて予備モデルに切り替える（タイムアウト）', async () => {
  const env = makeEnv({
    settings: { model: 'slow-model', fallbackModel: 'fast-model' },
    responder: ({ model, userText }) => model === 'slow-model' ? { hang: true } : echoTranslate(userText),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, ['訳:Hello']);
  assert.deepEqual(env.calls.map((c) => c.model), ['slow-model', 'fast-model']);
  assert.deepEqual(Array.from(r.meta.attempts, (a) => [a.model, a.status]), [['slow-model', 'timeout'], ['fast-model', 200]]);
  assert.equal(r.meta.model, 'fast-model');
});

await test('すべてのモデルが遅いときは、分かりやすいエラー（timeout）を返す', async () => {
  const env = makeEnv({
    settings: { model: 'a', fallbackModel: 'b' },
    responder: () => ({ hang: true }),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
  assert.match(r.error, /待つのをやめました/);
  assert.equal(r.meta.requests, 2);
});

await test('依頼ごとの結果と、トークン数（入力・出力・思考）を meta に記録する', async () => {
  const env = makeEnv({
    responder: ({ userText }) => {
      const base = echoTranslate(userText);
      base.json.usageMetadata = { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 1500 };
      return base;
    },
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.meta.tokens }, { prompt: 120, output: 30, thoughts: 1500 });
  assert.deepEqual(Array.from(r.meta.attempts, (a) => a.status), [200]);
  assert.ok(Number.isFinite(r.meta.attempts[0].ms));
});

await test('Server-Timing ヘッダーから、Google のサーバー処理時間と、応答の頭が届くまでの時間を記録する', async () => {
  const env = makeEnv({
    responder: ({ userText }) => ({ ...echoTranslate(userText), headers: { 'server-timing': 'gfet4t7; dur=79450' } }),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] });
  assert.equal(r.ok, true);
  assert.equal(r.meta.attempts[0].serverMs, 79450);
  assert.ok(Number.isFinite(r.meta.attempts[0].headersMs));
});

await test('Server-Timing ヘッダーがない・複数ある場合も壊れない', async () => {
  const none = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  assert.equal((await none.send({ type: 'translate', texts: ['Hello'] })).meta.attempts[0].serverMs, null);

  const many = makeEnv({
    responder: ({ userText }) => ({ ...echoTranslate(userText), headers: { 'server-timing': 'a; dur=10, gfet4t7; dur=1013.5' } }),
  });
  assert.equal((await many.send({ type: 'translate', texts: ['Hello'] })).meta.attempts[0].serverMs, 1013.5);
});

await test('応答速度の診断: モデルごとの短い依頼と、翻訳依頼と同じ内容を同時に測る', async () => {
  const env = makeEnv({
    settings: { model: 'a' },
    responder: ({ model, userText }) => model === 'slow'
      ? { ...echoTranslate(userText), headers: { 'server-timing': 'gfet4t7; dur=70000' } }
      : echoTranslate(userText),
  });
  const r = await env.send({ type: 'probe', models: ['a', 'slow', 'b'] });
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.results, (x) => [x.model, x.label]), [['a', 'short'], ['slow', 'short'], ['b', 'short'], ['a', 'same']]);
  assert.ok(r.results.every((x) => x.ok));
  assert.equal(r.results[1].serverMs, 70000);
  assert.equal(env.calls.length, 4);
  // 「同じ内容」の依頼は、実際の翻訳依頼と同じ形式（番号付き）で送られる
  assert.ok(env.calls[3].userText.includes('<<<1>>>'));
  assert.ok(!env.calls[0].userText.includes('<<<'));
});

await test('応答速度の診断: 不正なモデル名は除き、対象は 4 つまでに絞る。失敗したモデルは理由を返す', async () => {
  const env = makeEnv({
    settings: { model: 'm1' },
    responder: ({ model, userText }) => model === 'm2' ? { status: 404, text: '{}' } : echoTranslate(userText),
  });
  const r = await env.send({ type: 'probe', models: ['m1', 'm2', '../../bad', 'm3', 'm4', 'm5', 'm6'] });
  assert.equal(r.ok, true);
  const shorts = r.results.filter((x) => x.label === 'short');
  assert.deepEqual(Array.from(shorts, (x) => x.model), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(shorts[1].ok, false);
  assert.match(shorts[1].error, /見つかりません/);
});

// ---------------------------------------------------------------- 文脈（参考情報）

await test('文脈（タイトル・直前の見出し・直前の文章）は、訳さない参考情報として、断片の前に添える', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  const context = { title: 'Page title', heading: 'Setup', before: 'Install the tool first.' };
  const r = await env.send({ type: 'translate', texts: ['Hello', 'World'], context }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, ['訳:Hello', '訳:World'], '参考情報は、訳文に混ざらない');
  const sent = env.calls[0].userText;
  assert.match(sent, /^【参考情報/);
  assert.ok(sent.includes('ページのタイトル: Page title'));
  assert.ok(sent.includes('直前の見出し: Setup'));
  assert.ok(sent.includes('直前の文章: Install the tool first.'));
  assert.ok(sent.indexOf('【翻訳する断片') > sent.indexOf('直前の文章'), '参考情報のあとに、翻訳する断片');
  assert.ok(sent.endsWith('<<<1>>>\nHello\n<<<2>>>\nWorld'));
});

await test('文脈がないときは、これまでと同じ形（断片だけ）で送る', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT);
  assert.equal(env.calls[0].userText, '<<<1>>>\nHello');
});

await test('文脈は検査される: 文字列だけ・長さ制限・番号の区切りの除去・知らない項目は捨てる', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  const context = {
    title: `T${'x'.repeat(500)}`, heading: 'A <<<9>>> B\n\n  C', before: 123, evil: 'INJECTED-FIELD',
  };
  const r = await env.send({ type: 'translate', texts: ['Hello'], context }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  const sent = env.calls[0].userText;
  const title = /ページのタイトル: (.*)/.exec(sent)[1];
  assert.equal(title.length, 200, 'タイトルは 200 文字まで');
  assert.ok(sent.includes('直前の見出し: A 9 B C'), '区切り（<<<）を除き、空白を整える');
  assert.ok(!sent.includes('直前の文章'), '文字列でない項目は捨てる');
  assert.ok(!sent.includes('INJECTED-FIELD'), '知らない項目は捨てる');
  assert.equal((sent.match(/<<<\d+>>>/g) || []).length, 1, '文脈に混ざった区切りは、断片の番号と区別がつかなくならない');

  for (const bad of ['text', 42, ['a'], null, true]) {
    const e2 = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
    const r2 = await e2.send({ type: 'translate', texts: ['Hello'], context: bad }, CONTENT_SCRIPT);
    assert.equal(r2.ok, true);
    assert.equal(e2.calls[0].userText, '<<<1>>>\nHello', `形が違う文脈は無視する: ${JSON.stringify(bad)}`);
  }
});

await test('文脈の文字数も、使用量（API に送る文字数）として数える', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  await env.send({ type: 'translate', texts: ['Hello'], context: { title: 'abcde', heading: 'fgh' } }, CONTENT_SCRIPT);
  const log = env.sessionStore.usageLog;
  assert.equal(log[log.length - 1][1], 'Hello'.length + 'abcde'.length + 'fgh'.length);
});

await test('システム指示に、「参考情報は訳さない」ルールがある', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(src, /参考情報は訳さず、出力にも含めないでください/);
});

summary();
