// ChatGPT のプラン（Sign in with ChatGPT）での翻訳の自動テスト。OpenAI は偽物に差し替える（実際の通信は発生しない）。
// 実行: node tests/chatgpt.test.mjs
import assert from 'node:assert/strict';
import {
  makeEnv, createRunner, echoTranslateText, openaiTextEvents, EXT_PAGE, CONTENT_SCRIPT, OTHER_EXTENSION,
} from './helpers.mjs';

const { test, summary } = createRunner();

const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
const form = (init) => Object.fromEntries(new URLSearchParams(String(init.body)));
const authUrlParams = (env) => new URL(env.tabsCreated[0].url).searchParams;

const seededAuth = (over = {}) => ({
  accessToken: 'AT-OLD',
  refreshToken: 'RT-OLD',
  idToken: '',
  expiresAt: Date.now() + 3600 * 1000,
  scopes: ['openid', PLAN_SCOPE],
  clientId: 'oaiapp_test',
  email: 'user@example.com',
  savedAt: Date.now(),
  ...over,
});

// 偽の OpenAI。token / models / responses を、テストごとに差し替えられる
function fakeOpenai(handlers = {}) {
  const log = { token: [], models: 0, responses: [] };
  const responder = async ({ url, init }) => {
    if (url.endsWith('/oauth/token')) {
      const f = form(init);
      log.token.push(f);
      if (handlers.token) return handlers.token(f, log);
      return {
        json: {
          access_token: `AT-${log.token.length}`,
          refresh_token: `RT-${log.token.length}`,
          id_token: jwt({ nonce: handlers.nonce, email: 'user@example.com' }),
          expires_in: 3600,
          scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
        },
      };
    }
    if (url.endsWith('/models')) {
      log.models += 1;
      return handlers.models
        ? handlers.models()
        : { json: { models: [
          { slug: 'gpt-test-sol', display_name: 'Sol', visibility: 'list' },
          { slug: 'gpt-test-luna', display_name: 'Luna', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
        ] } };
    }
    if (url.endsWith('/responses')) {
      const body = JSON.parse(init.body);
      log.responses.push({ body, auth: init.headers.authorization, url });
      if (handlers.responses) return handlers.responses(body, log, init);
      const userText = (body.input.find((m) => m.role === 'user') || {}).content || '';
      return { sse: openaiTextEvents(echoTranslateText(userText)) };
    }
    throw new Error(`想定していない OpenAI のアドレス: ${url}`);
  };
  return { responder, log };
}

function signedInEnv(handlers, settings = {}) {
  const { responder, log } = fakeOpenai(handlers);
  const env = makeEnv({
    settings: { provider: 'chatgpt', apiKey: '', chatgptModel: 'gpt-test-luna', chatgptAuth: seededAuth(), ...settings },
    responder: () => { throw new Error('Gemini を呼んではいけない'); },
    openaiResponder: responder,
  });
  return { env, log };
}

// ---------------------------------------------------------------- サインイン

await test('サインインを始めると、公式の仕様どおりの認可の画面を開く（PKCE・state・nonce・ホスト ID）', async () => {
  const { responder } = fakeOpenai();
  const env = makeEnv({ settings: { apiKey: '' }, responder: () => {}, openaiResponder: responder });
  const r = await env.send({ type: 'chatgpt-sign-in' }, EXT_PAGE);
  assert.equal(r.ok, true);
  assert.equal(r.status.pending, true);
  assert.equal(env.tabsCreated.length, 1);

  const url = new URL(env.tabsCreated[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://auth.openai.com/api/accounts/authorize');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.ok(p.get('code_challenge').length >= 40);
  assert.ok(p.get('state').length >= 40 && p.get('nonce').length >= 40);
  assert.match(p.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.ok(p.get('scope').split(' ').includes(PLAN_SCOPE));
  assert.equal(p.get('client_id'), 'dynamic_agent_client');
  assert.ok(p.get('agent_name_hint'));
  // 検証子（verifier）は URL に載せない
  assert.ok(!env.tabsCreated[0].url.includes(env.sessionStore.chatgptPending.verifier));
});

await test('戻り先を検知すると、code をトークンに交換してサインイン完了。タブを閉じ、モデルを自動で選ぶ', async () => {
  const state = { nonce: '' };
  const { responder, log } = fakeOpenai({ get nonce() { return state.nonce; } });
  const env = makeEnv({ settings: { apiKey: '' }, responder: () => {}, openaiResponder: responder });
  await env.send({ type: 'chatgpt-sign-in' }, EXT_PAGE);
  const p = authUrlParams(env);
  state.nonce = p.get('nonce');

  const handled = await env.fireCallback(`http://127.0.0.1:1455/auth/callback?code=CODE123&state=${p.get('state')}&client_id=oaiapp_new`);
  assert.equal(handled, true);

  // 交換の依頼: PKCE の検証子・redirect_uri・client_id
  assert.equal(log.token.length, 1);
  assert.equal(log.token[0].grant_type, 'authorization_code');
  assert.equal(log.token[0].code, 'CODE123');
  assert.equal(log.token[0].client_id, 'oaiapp_new');
  assert.equal(log.token[0].redirect_uri, 'http://127.0.0.1:1455/auth/callback');
  assert.ok(log.token[0].code_verifier.length >= 40);

  const st = (await env.send({ type: 'chatgpt-status' }, EXT_PAGE)).status;
  assert.equal(st.signedIn, true);
  assert.equal(st.hasPlanScope, true);
  assert.equal(st.email, 'user@example.com');
  assert.equal(st.pending, false);
  assert.ok(env.tabsRemoved.length >= 1, 'ログインのタブを閉じる');
  // モデル一覧を取得し、翻訳向きの小さいモデル（luna）を既定にする。非表示のモデルは入れない
  assert.deepEqual(Array.from(env.store.chatgptModelList), ['gpt-test-sol', 'gpt-test-luna']);
  assert.equal(env.store.chatgptModel, 'gpt-test-luna');
  assert.equal(env.store.chatgptReg.clientId, 'oaiapp_new');
});

await test('state が一致しない戻り先は無視し、待ち受けを続ける', async () => {
  const { responder, log } = fakeOpenai();
  const env = makeEnv({ settings: { apiKey: '' }, responder: () => {}, openaiResponder: responder });
  await env.send({ type: 'chatgpt-sign-in' }, EXT_PAGE);
  await env.fireCallback('http://127.0.0.1:1455/auth/callback?code=EVIL&state=wrong-state&client_id=oaiapp_x');
  assert.equal(log.token.length, 0, 'トークン交換をしない');
  const st = (await env.send({ type: 'chatgpt-status' }, EXT_PAGE)).status;
  assert.equal(st.signedIn, false);
  assert.equal(st.pending, true);
});

await test('戻り先と無関係な URL は、リスナーの対象外（フィルターは、戻り先の 1 つだけ）', async () => {
  const { responder } = fakeOpenai();
  const env = makeEnv({ settings: { apiKey: '' }, responder: () => {}, openaiResponder: responder });
  const filter = env.webRequestFilter();
  assert.deepEqual(Array.from(filter.urls), ['http://127.0.0.1:1455/auth/callback*']);
  assert.deepEqual(Array.from(filter.types), ['main_frame']);
  assert.equal(await env.fireCallback('http://127.0.0.1:1455/other?code=x'), false);
});

await test('ID トークンの nonce が一致しない応答は受け付けない（なりすまし対策）', async () => {
  const { responder } = fakeOpenai({ nonce: 'attacker-nonce' });
  const env = makeEnv({ settings: { apiKey: '' }, responder: () => {}, openaiResponder: responder });
  await env.send({ type: 'chatgpt-sign-in' }, EXT_PAGE);
  const p = authUrlParams(env);
  await env.fireCallback(`http://127.0.0.1:1455/auth/callback?code=C&state=${p.get('state')}&client_id=oaiapp_x`);
  const st = (await env.send({ type: 'chatgpt-status' }, EXT_PAGE)).status;
  assert.equal(st.signedIn, false);
  assert.match(st.last.message, /nonce/);
});

await test('利用枠の権限（chatgpt.tokens.use.direct）が付与されなければ、サインインとして扱わない', async () => {
  const state = { nonce: '' };
  const { responder } = fakeOpenai({
    token: () => ({ json: {
      access_token: 'AT', refresh_token: 'RT', id_token: jwt({ nonce: state.nonce, email: 'u@example.com' }),
      expires_in: 3600, scope: 'openid profile email',
    } }),
  });
  const env = makeEnv({ settings: { apiKey: '' }, responder: () => {}, openaiResponder: responder });
  await env.send({ type: 'chatgpt-sign-in' }, EXT_PAGE);
  const p = authUrlParams(env);
  state.nonce = p.get('nonce');
  await env.fireCallback(`http://127.0.0.1:1455/auth/callback?code=C&state=${p.get('state')}&client_id=oaiapp_x`);
  const st = (await env.send({ type: 'chatgpt-status' }, EXT_PAGE)).status;
  assert.equal(st.signedIn, false);
  assert.match(st.last.message, /権限/);
});

// ---------------------------------------------------------------- 翻訳

await test('ChatGPT のプランで翻訳する（Responses API・Bearer・store:false・stream:true・instructions）', async () => {
  const { env, log } = signedInEnv();
  const r = await env.send({ type: 'translate', texts: ['Hello', 'World'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.results), ['訳:Hello', '訳:World']);
  assert.equal(r.meta.provider, 'chatgpt');
  assert.equal(r.meta.model, 'gpt-test-luna');
  assert.deepEqual({ ...r.meta.tokens }, { prompt: 10, output: 5, thoughts: 0 });

  assert.equal(log.responses.length, 1);
  const call = log.responses[0];
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.auth, 'Bearer AT-OLD');
  assert.equal(call.body.store, false);
  assert.equal(call.body.stream, true);
  assert.equal(call.body.model, 'gpt-test-luna');
  assert.ok(call.body.instructions.includes('<<<番号>>>'));
  assert.equal(call.body.input[0].role, 'user');
  assert.ok(call.body.input[0].content.includes('<<<1>>>'));
});

await test('Gemini ではなく ChatGPT を選んでいるときは、Gemini の APIキーが無くても翻訳できる', async () => {
  const { env } = signedInEnv(undefined, { apiKey: '' });
  const r = await env.send({ type: 'translate', texts: ['Hi'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(env.calls.length, 0, 'Gemini には送らない');
});

await test('サインインしていないときは、通信せずに案内を返す（kind: nokey）', async () => {
  const { responder, log } = fakeOpenai();
  const env = makeEnv({ settings: { provider: 'chatgpt', apiKey: '', chatgptModel: 'gpt-test-luna' }, responder: () => {}, openaiResponder: responder });
  const r = await env.send({ type: 'translate', texts: ['Hi'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'nokey');
  assert.match(r.error, /ChatGPT/);
  assert.equal(log.responses.length + log.token.length, 0);
});

await test('アクセストークンの期限が近いときは、更新してから使う。同時に 2 件でも、更新は 1 回だけ', async () => {
  const { env, log } = signedInEnv(undefined, { chatgptAuth: seededAuth({ expiresAt: Date.now() + 20 * 1000 }) });
  const [a, b] = await Promise.all([
    env.send({ type: 'translate', texts: ['One'], noCache: true }, CONTENT_SCRIPT),
    env.send({ type: 'translate', texts: ['Two'], noCache: true }, CONTENT_SCRIPT),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(log.token.length, 1, '更新の依頼は 1 回');
  assert.equal(log.token[0].grant_type, 'refresh_token');
  assert.equal(log.token[0].refresh_token, 'RT-OLD');
  assert.ok(log.responses.every((c) => c.auth === 'Bearer AT-1'), '更新後のトークンで送る');
  assert.equal(env.store.chatgptAuth.refreshToken, 'RT-1', '新しいリフレッシュトークンに入れ替える');
});

await test('401（トークン無効）のときは、1 回だけ更新して、やり直す', async () => {
  let n = 0;
  const { env, log } = signedInEnv({
    responses: (body, l) => {
      n += 1;
      if (n === 1) return { status: 401, json: { error: { message: 'invalid token', code: 'invalid_token' } } };
      const t = body.input[0].content;
      return { sse: openaiTextEvents(echoTranslateText(t)) };
    },
  });
  const r = await env.send({ type: 'translate', texts: ['Retry me'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(r.results[0], '訳:Retry me');
  assert.equal(log.token.length, 1);
  assert.equal(log.responses.length, 2);
  assert.equal(log.responses[1].auth, 'Bearer AT-1');
});

await test('利用枠の上限（subscription_sharing_usage_limit_exceeded）は、分かる言葉で返し、予備モデルも試す', async () => {
  const { env, log } = signedInEnv(
    {
      responses: () => ({ sse: [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }] }),
    },
    { chatgptFallbackModel: 'gpt-test-sol' },
  );
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'quota');
  assert.match(r.error, /利用枠/);
  assert.deepEqual(Array.from(r.meta.tried), ['gpt-test-luna', 'gpt-test-sol']);
  assert.equal(log.responses.length, 2);
});

await test('instructions を受け付けない場合は、developer メッセージとして送り直す', async () => {
  const { env, log } = signedInEnv({
    responses: (body) => {
      if ('instructions' in body) return { status: 400, json: { error: { message: 'Unsupported parameter: instructions', code: 'unsupported_parameter' } } };
      const t = body.input.find((m) => m.role === 'user').content;
      return { sse: openaiTextEvents(echoTranslateText(t)) };
    },
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(r.results[0], '訳:Hello');
  assert.equal(log.responses[1].body.input[0].role, 'developer');
  assert.ok(log.responses[1].body.input[0].content.includes('<<<番号>>>'));
});

await test('応答が、本文なしで途切れたときは、待ってから再試行する', async () => {
  let n = 0;
  const { env, log } = signedInEnv({
    responses: (body) => {
      n += 1;
      if (n === 1) return { sse: [{ type: 'response.created' }] };
      return { sse: openaiTextEvents(echoTranslateText(body.input[0].content)) };
    },
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(r.results[0], '訳:Hello');
  assert.equal(log.responses.length, 2);
});

await test('「保存しておく」を切り替えた直後でも、サインインは消えない。次の更新で、新しい保存先へ移る', async () => {
  const { env } = signedInEnv(undefined, { rememberKey: false, chatgptAuth: seededAuth({ expiresAt: Date.now() + 5000 }) });
  // 設定は「忘れる」だが、トークンはまだ storage.local にある
  assert.equal((await env.send({ type: 'chatgpt-status' }, EXT_PAGE)).status.signedIn, true);
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(env.store.chatgptAuth, undefined, 'ディスク側には残さない');
  assert.equal(env.sessionStore.chatgptAuth.refreshToken, 'RT-1');
});

await test('5xx は、待ってから再試行する', async () => {
  let n = 0;
  const { env } = signedInEnv({
    responses: (body) => {
      n += 1;
      if (n === 1) return { status: 503, json: { error: { message: 'overloaded' } } };
      return { sse: openaiTextEvents(echoTranslateText(body.input[0].content)) };
    },
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(r.meta.waitedMs, 1500);
  assert.equal(r.meta.requests, 2);
});

await test('応答が返らないときは、タイムアウトで待つのをやめる（kind: timeout）', async () => {
  const { env } = signedInEnv({ responses: () => ({ hang: true }) });
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
});

// ---------------------------------------------------------------- 安全性

await test('[安全] トークンは Authorization ヘッダーでだけ送り、エラー文・URL には出さない', async () => {
  const { env, log } = signedInEnv({
    responses: () => ({ status: 500, text: JSON.stringify({ error: { message: 'internal error while handling AT-OLD token' } }) }),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes('AT-OLD'), r.error);
  assert.ok(log.responses.every((c) => !c.url.includes('AT-OLD')));
  for (const c of env.openaiCalls) assert.ok(!c.url.includes('AT-OLD') && !c.url.includes('RT-OLD'));
});

await test('[安全] ChatGPT の操作（サインイン・サインアウト・状態）は、設定画面だけが呼べる', async () => {
  const { env } = signedInEnv();
  for (const type of ['chatgpt-sign-in', 'chatgpt-cancel', 'chatgpt-sign-out', 'chatgpt-status']) {
    assert.equal(await env.send({ type }, CONTENT_SCRIPT), undefined, `${type}（ページのスクリプト）`);
    assert.equal(await env.send({ type }, OTHER_EXTENSION), undefined, `${type}（他の拡張機能）`);
  }
  assert.equal(env.tabsCreated.length, 0);
});

await test('[安全] 「ブラウザを閉じたら忘れる」モードでは、トークンをディスク側（storage.local）に書かない', async () => {
  const state = { nonce: '' };
  const { responder } = fakeOpenai({ get nonce() { return state.nonce; } });
  const env = makeEnv({ settings: { apiKey: '', rememberKey: false }, responder: () => {}, openaiResponder: responder });
  await env.send({ type: 'chatgpt-sign-in' }, EXT_PAGE);
  const p = authUrlParams(env);
  state.nonce = p.get('nonce');
  await env.fireCallback(`http://127.0.0.1:1455/auth/callback?code=C&state=${p.get('state')}&client_id=oaiapp_x`);
  assert.equal(env.store.chatgptAuth, undefined, 'storage.local にトークンがない');
  assert.equal(typeof env.sessionStore.chatgptAuth.accessToken, 'string', 'storage.session にある');
});

await test('サインアウトすると、トークンを消す（ホスト ID だけ残す）', async () => {
  const { env } = signedInEnv(undefined, { chatgptReg: { hostId: 'urn:uuid:keep', clientId: 'oaiapp_test', email: 'u@example.com' } });
  const r = await env.send({ type: 'chatgpt-sign-out' }, EXT_PAGE);
  assert.equal(r.ok, true);
  assert.equal(r.status.signedIn, false);
  assert.equal(env.store.chatgptAuth, undefined);
  assert.deepEqual({ ...env.store.chatgptReg }, { hostId: 'urn:uuid:keep' });
});

// ---------------------------------------------------------------- モデル一覧・診断

await test('モデル一覧: アカウントが使える、表示用（visibility: list）のモデルだけを返す', async () => {
  const { env } = signedInEnv();
  const r = await env.send({ type: 'list-models' }, EXT_PAGE);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.models, (m) => m.id), ['gpt-test-sol', 'gpt-test-luna']);
});

await test('応答速度の診断: ChatGPT のモデルにも、同時に短い依頼を送る', async () => {
  const { env, log } = signedInEnv();
  const r = await env.send({ type: 'probe', models: ['gpt-test-luna', 'gpt-test-sol'] }, EXT_PAGE);
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.results, (x) => [x.model, x.label]), [
    ['gpt-test-luna', 'short'], ['gpt-test-sol', 'short'], ['gpt-test-luna', 'same'],
  ]);
  assert.ok(r.results.every((x) => x.ok));
  assert.equal(log.responses.length, 3);
});

await test('モデルが未選択のときは、通信せずに案内を返す', async () => {
  const { env, log } = signedInEnv(undefined, { chatgptModel: '' });
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'model');
  assert.equal(log.responses.length, 0);
});

await test('Gemini を選んでいるときは、これまでどおり Gemini に送る（ChatGPT には送らない）', async () => {
  const env = makeEnv({
    settings: { provider: 'gemini', chatgptAuth: seededAuth() },
    responder: ({ userText }) => ({
      json: { candidates: [{ content: { parts: [{ text: echoTranslateText(userText) }] } }] },
    }),
    openaiResponder: () => { throw new Error('OpenAI を呼んではいけない'); },
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'], noCache: true }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(r.meta.provider, 'gemini');
  assert.equal(env.openaiCalls.length, 0);
});

summary();
