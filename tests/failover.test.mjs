// 併用（Gemini が使えないときに ChatGPT へ切り替える、またはその逆）と、ChatGPT の速さ優先の自動テスト。
// 実際の通信は発生しない（Google も OpenAI も偽物に差し替える）。  実行: node tests/failover.test.mjs
import assert from 'node:assert/strict';
import {
  makeEnv, createRunner, echoTranslate, echoTranslateText, openaiTextEvents, EXT_PAGE, CONTENT_SCRIPT,
} from './helpers.mjs';

const { test, summary } = createRunner();

const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const chatgptAuth = () => ({
  accessToken: 'AT-1', refreshToken: 'RT-1', idToken: '', expiresAt: Date.now() + 3600 * 1000,
  scopes: ['openid', PLAN_SCOPE], clientId: 'oaiapp_test', email: 'user@example.com', savedAt: Date.now(),
});

const DAILY_429 = {
  status: 429,
  json: { error: { code: 429, message: 'Quota exceeded', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } },
};
const geminiOk = ({ userText }) => echoTranslate(userText);
const chatgptOk = ({ init }) => {
  const body = JSON.parse(init.body);
  const input = (body.input.find((m) => m.role === 'user') || {}).content || '';
  return { sse: openaiTextEvents(echoTranslateText(input)) };
};
const CHATGPT_LIMIT = { sse: [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }] };

function setup({ gemini = geminiOk, openai = chatgptOk, ...settings } = {}) {
  return makeEnv({
    settings: {
      provider: 'gemini', apiKey: 'test-key', model: 'g-a', fallbackModel: 'g-b',
      crossFallback: true, chatgptAuth: chatgptAuth(), chatgptModel: 'gpt-test-luna', ...settings,
    },
    responder: (call) => gemini(call),
    openaiResponder: (call) => openai(call),
  });
}
const translate = (env, extra = {}, sender = CONTENT_SCRIPT) =>
  env.send({ type: 'translate', texts: ['Hello', 'World'], noCache: true, ...extra }, sender);

// ---------------------------------------------------------------- 併用

await test('Gemini の 1 日の上限（主・予備とも）に達したら、ChatGPT に切り替えて翻訳する', async () => {
  const env = setup({ gemini: () => DAILY_429 });
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.results), ['訳:Hello', '訳:World']);
  assert.equal(r.meta.provider, 'chatgpt');
  assert.equal(r.meta.primaryProvider, 'gemini');
  assert.equal(r.meta.fellBack, true);
  assert.equal(r.meta.model, 'gpt-test-luna');
  assert.deepEqual(Array.from(r.meta.tried), ['g-a', 'g-b', 'gpt-test-luna']);
  assert.equal(env.calls.length, 2, 'Gemini は主・予備の 2 回だけ');
  assert.equal(env.openaiCalls.length, 1);
});

await test('上限に達したモデルは、しばらく試さない（2 回目は Gemini を呼ばず、すぐ ChatGPT）。記録は一時領域だけ', async () => {
  const env = setup({ gemini: () => DAILY_429 });
  await translate(env);
  const callsAfterFirst = env.calls.length;
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.equal(r.meta.provider, 'chatgpt');
  assert.equal(env.calls.length, callsAfterFirst, '2 回目は Gemini を呼ばない');
  assert.deepEqual(Array.from(r.meta.tried), ['gpt-test-luna']);
  assert.ok(env.sessionStore.cooldown['gemini:g-a'] > Date.now());
  assert.equal(env.store.cooldown, undefined, 'ディスク側には残さない');
});

await test('記録の期限が過ぎたら、Gemini を再び試す（自動で戻る）', async () => {
  const env = setup();
  env.sessionStore.cooldown = { 'gemini:g-a': Date.now() - 1000, 'gemini:g-b': Date.now() - 1000 };
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.equal(r.meta.provider, 'gemini');
  assert.equal(r.meta.fellBack, false);
  assert.equal(env.openaiCalls.length, 0);
});

await test('記録が有効なときは、Gemini を飛ばして ChatGPT へ。併用がオフなら、記録を無視して Gemini を試す', async () => {
  const until = Date.now() + 10 * 60 * 1000;
  const on = setup();
  on.sessionStore.cooldown = { 'gemini:g-a': until, 'gemini:g-b': until };
  const r1 = await translate(on);
  assert.equal(r1.meta.provider, 'chatgpt');
  assert.equal(on.calls.length, 0);

  const off = setup({ crossFallback: false });
  off.sessionStore.cooldown = { 'gemini:g-a': until, 'gemini:g-b': until };
  const r2 = await translate(off);
  assert.equal(r2.ok, true);
  assert.equal(r2.meta.provider, 'gemini', '他に使える AI がないので、記録を無視して試す');
});

await test('併用がオフなら、ChatGPT には送らない（これまでどおり）', async () => {
  const env = setup({ crossFallback: false, gemini: () => DAILY_429 });
  const r = await translate(env);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'quota');
  assert.equal(env.openaiCalls.length, 0);
});

await test('主が ChatGPT、切り替え先が Gemini の順にもできる', async () => {
  const env = setup({ provider: 'chatgpt', openai: () => CHATGPT_LIMIT });
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.equal(r.meta.provider, 'gemini');
  assert.equal(r.meta.primaryProvider, 'chatgpt');
  assert.equal(r.meta.fellBack, true);
  assert.ok(env.sessionStore.cooldown['chatgpt:gpt-test-luna'] > Date.now());
});

await test('主の準備ができていない（APIキーなし）とき、併用なら、そのまま ChatGPT を使う', async () => {
  const env = setup({ apiKey: '' });
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.equal(r.meta.provider, 'chatgpt');
  assert.equal(env.calls.length, 0);
});

await test('どちらの準備もできていないときは、案内を返す（通信しない）', async () => {
  const env = setup({ apiKey: '', chatgptAuth: undefined });
  const r = await translate(env);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'nokey');
  assert.equal(env.calls.length + env.openaiCalls.length, 0);
});

await test('両方が使えないときは、両方の理由を返す', async () => {
  const env = setup({ gemini: () => DAILY_429, openai: () => CHATGPT_LIMIT });
  const r = await translate(env);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'quota');
  assert.match(r.error, /Gemini: /);
  assert.match(r.error, /ChatGPT: /);
  assert.equal(r.meta.fellBack, true);
});

await test('APIキーが無効でも（別の会社なら通る可能性があるので）ChatGPT に切り替える', async () => {
  const env = setup({ gemini: () => ({ status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.' } } }) });
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.equal(r.meta.provider, 'chatgpt');
  assert.equal(env.calls.length, 1, 'キー無効は、予備モデルも試さずに切り替える');
});

await test('依頼そのものの不具合（other）では、切り替えない', async () => {
  const env = setup({ gemini: () => ({ status: 400, json: { error: { message: 'bad request' } } }) });
  const r = await translate(env);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'other');
  assert.equal(env.openaiCalls.length, 0);
});

await test('切り替え先の ChatGPT のモデルが未選択でも、取得済みの一覧から翻訳向きのものを選ぶ', async () => {
  const env = setup({
    gemini: () => DAILY_429, chatgptModel: '', chatgptModelList: ['gpt-test-sol', 'gpt-test-luna'],
  });
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.equal(r.meta.model, 'gpt-test-luna');
});

await test('「接続テスト」用の only は、設定画面だけが指定できる（ページからは無視され、併用が働く）', async () => {
  const env = setup({ gemini: () => DAILY_429 });
  const fromOptions = await translate(env, { only: 'gemini' }, EXT_PAGE);
  assert.equal(fromOptions.ok, false, '設定画面からは、Gemini だけで試す');
  assert.equal(env.openaiCalls.length, 0);

  const fromPage = await translate(env, { only: 'gemini' }, CONTENT_SCRIPT);
  assert.equal(fromPage.ok, true, 'ページ側の指定は無視される');
  assert.equal(fromPage.meta.provider, 'chatgpt');
});

await test('結果の内訳（attempts）に、提供元が付く', async () => {
  const env = setup({ gemini: () => DAILY_429 });
  const r = await translate(env);
  assert.deepEqual(Array.from(r.meta.attempts, (a) => a.provider), ['gemini', 'gemini', 'chatgpt']);
});

// ---------------------------------------------------------------- ChatGPT の速さ優先

const bodiesOf = (env) => env.openaiCalls.filter((c) => c.url.endsWith('/responses')).map((c) => JSON.parse(c.init.body));

await test('速さ優先（既定）: 思考の量を少なめ（reasoning.effort: low）にして送る', async () => {
  const env = setup({ provider: 'chatgpt', crossFallback: false });
  const r = await translate(env);
  assert.equal(r.ok, true);
  assert.deepEqual({ ...bodiesOf(env)[0].reasoning }, { effort: 'low' });
});

await test('速さ優先をオフにすると、思考の指定を付けない', async () => {
  const env = setup({ provider: 'chatgpt', crossFallback: false, chatgptFast: false });
  await translate(env);
  assert.equal('reasoning' in bodiesOf(env)[0], false);
});

await test('思考の指定を OpenAI が受け付けなければ、外して送り直し、そのモデルでは次回から外して送る', async () => {
  const env = setup({
    provider: 'chatgpt',
    crossFallback: false,
    openai: (call) => {
      const body = JSON.parse(call.init.body);
      if ('reasoning' in body) return { status: 400, json: { error: { message: "Unsupported parameter: 'reasoning.effort'", code: 'unsupported_parameter' } } };
      return chatgptOk(call);
    },
  });
  const r1 = await translate(env);
  assert.equal(r1.ok, true);
  assert.deepEqual(bodiesOf(env).map((b) => 'reasoning' in b), [true, false]);
  assert.equal(env.sessionStore.chatgptCaps['gpt-test-luna'], 1);

  const r2 = await translate(env);
  assert.equal(r2.ok, true);
  assert.deepEqual(bodiesOf(env).map((b) => 'reasoning' in b), [true, false, false], '2 回目は、最初から外して送る');
});

await test('文脈（参考情報）は、ChatGPT への依頼にも同じ形で添える', async () => {
  const env = setup({ provider: 'chatgpt', crossFallback: false });
  const r = await translate(env, { context: { title: 'Page title', heading: 'Setup' } });
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.results), ['訳:Hello', '訳:World']);
  const input = bodiesOf(env)[0].input[0].content;
  assert.match(input, /^【参考情報/);
  assert.ok(input.includes('直前の見出し: Setup'));
  assert.ok(input.endsWith('<<<1>>>\nHello\n<<<2>>>\nWorld'));
});

await test('ChatGPT の内訳に、応答の頭・最初の文字までの時間が記録される', async () => {
  const env = setup({ provider: 'chatgpt', crossFallback: false });
  const r = await translate(env);
  const a = r.meta.attempts[0];
  assert.equal(a.provider, 'chatgpt');
  assert.equal(typeof a.headersMs, 'number');
  assert.equal(typeof a.firstTokenMs, 'number');
});

summary();
