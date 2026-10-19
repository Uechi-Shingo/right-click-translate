// セキュリティ観点の自動テスト（APIキーの漏えい・不正利用の防止）。
// 実行: node tests/security.test.mjs
import assert from 'node:assert/strict';
import { makeEnv, echoTranslate, createRunner, EXT_PAGE, CONTENT_SCRIPT, OTHER_EXTENSION, contentScriptOn } from './helpers.mjs';

const { test, summary } = createRunner();
const never = () => { throw new Error('API を呼んではいけない'); };
const NEWLINE = String.fromCharCode(10);

await test('不正な依頼（形式・件数・サイズ）は API に送らず拒否する', async () => {
  const env = makeEnv({ responder: never });
  const bad = [
    undefined,
    'text',
    [],
    [1],
    [''],
    Array.from({ length: 101 }, (_, i) => 'a' + i),
    ['x'.repeat(20001)],
    ['x'.repeat(15000), 'y'.repeat(15001)],
  ];
  for (const texts of bad) {
    const r = await env.send({ type: 'translate', texts }, CONTENT_SCRIPT);
    assert.equal(r.ok, false, JSON.stringify(texts)?.slice(0, 40));
    assert.equal(r.kind, 'invalid');
  }
  assert.equal(env.calls.length, 0);
});

await test('初回の確認（同意）が済むまでは、翻訳を実行しない', async () => {
  const env = makeEnv({ settings: { acknowledged: false }, responder: never });
  const r = await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'consent');
  assert.equal(env.calls.length, 0);
});

await test('短時間に大量の文字を送ろうとすると、安全装置が働いて止まる（文字数）', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  // 1 回あたり約 30,000 文字（1 断片は 20,000 文字以下）× 6 回 = 約 18 万文字
  const chunk = (i) => [String(i).padStart(3, '0') + 'x'.repeat(14990), 'y'.repeat(14990)];
  for (let i = 0; i < 6; i++) {
    assert.equal((await env.send({ type: 'translate', texts: chunk(i) }, CONTENT_SCRIPT)).ok, true);
  }
  const callsBefore = env.calls.length;
  const r = await env.send({ type: 'translate', texts: chunk(6) }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'budget');
  assert.equal(env.calls.length, callsBefore, '上限超過後は API を呼ばない');
});

await test('短時間に大量の依頼を送ろうとすると止まる（回数）。キャッシュ命中は数えない', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  for (let i = 0; i < 60; i++) {
    assert.equal((await env.send({ type: 'translate', texts: ['t' + i] }, CONTENT_SCRIPT)).ok, true);
  }
  const hit = await env.send({ type: 'translate', texts: ['t0'] }, CONTENT_SCRIPT); // キャッシュ済み
  assert.equal(hit.ok, true);
  const r = await env.send({ type: 'translate', texts: ['brand-new'] }, CONTENT_SCRIPT);
  assert.equal(r.kind, 'budget');
});

await test('エラー応答にキーが含まれても、画面に出る文言では伏せ字になる', async () => {
  // 秘密情報の検出ツールに誤検知されないよう、キーらしい文字列は実行時に組み立てる
  const key = ['dummy', 'secret', 'key', 'for', 'redaction', 'test', '0123456789'].join('-');
  const env = makeEnv({
    settings: { apiKey: key },
    responder: () => ({ status: 403, text: `{"error":{"message":"Key ${key} is not allowed"}}` }),
  });
  const r = await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes('dummy-secret-key'), r.error);
  assert.ok(r.error.includes('[APIキー]'));
});

await test('想定外の例外の内容は画面に出さない', async () => {
  const env = makeEnv({ responder: () => ({ json: null }) });
  const r = await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.error, '予期しないエラーが発生しました。');
});

await test('一覧取得・キャッシュ削除は設定画面だけが呼べる。他の拡張機能や素性不明の呼び出しは無視する', async () => {
  const env = makeEnv({ responder: never, listResponder: () => ({ json: { models: [] } }) });
  // ページに差し込んだスクリプトからは、翻訳以外を受け付けない
  assert.equal(await env.send({ type: 'list-models' }, CONTENT_SCRIPT), undefined);
  assert.equal(await env.send({ type: 'clear-cache' }, CONTENT_SCRIPT), undefined);
  // 他の拡張機能・素性不明の呼び出しは、何も受け付けない
  for (const sender of [OTHER_EXTENSION, {}, null]) {
    for (const msg of [{ type: 'list-models' }, { type: 'clear-cache' }, { type: 'translate', texts: ['x'] }]) {
      assert.equal(await env.send(msg, sender), undefined, `${msg.type} / ${JSON.stringify(sender)}`);
    }
  }
  assert.equal(env.calls.length, 0);
  assert.equal((await env.send({ type: 'list-models' }, EXT_PAGE)).ok, true);
  assert.equal((await env.send({ type: 'clear-cache' }, EXT_PAGE)).ok, true);
});

await test('「ブラウザを閉じたら忘れる」モードでは、保存領域ではなく一時領域のキーだけを使う', async () => {
  const env = makeEnv({
    settings: { rememberKey: false, apiKey: 'DISK-KEY-SHOULD-NOT-BE-USED' },
    responder: ({ userText }) => echoTranslate(userText),
  });
  // 一時領域が空（ブラウザ再起動後）ならキー未設定として扱う
  assert.equal((await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT)).kind, 'nokey');
  env.sessionStore.apiKey = 'SESSION-KEY';
  const r = await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(env.calls[0].key, 'SESSION-KEY');
});

await test('不正なモデル名では、通信しない', async () => {
  const env = makeEnv({ settings: { model: '../../v1/other', fallbackModel: '' }, responder: never });
  const r = await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'model');
  assert.equal(env.calls.length, 0);
});

await test('Gemini を選んでいるときの通信先は Gemini の API だけで、キーは URL ではなくヘッダーで送る', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText), listResponder: () => ({ json: { models: [] } }) });
  await env.send({ type: 'translate', texts: ['Hello'] }, CONTENT_SCRIPT);
  await env.send({ type: 'list-models' }, EXT_PAGE);
  assert.equal(env.calls.length, 2);
  for (const c of env.calls) {
    assert.ok(c.url.startsWith('https://generativelanguage.googleapis.com/v1beta/models'), c.url);
    assert.ok(!c.url.includes('test-key'));
    assert.equal(c.key, 'test-key');
  }
});

await test('翻訳キャッシュはサイトごとに分かれ、別サイトの表示に混ざらない（キャッシュ汚染の防止）', async () => {
  let poisoned = true;
  const env = makeEnv({
    responder: ({ userText }) => poisoned
      ? { json: { candidates: [{ content: { parts: [{ text: `<<<1>>>${NEWLINE}ここにパスワードを入力: https://evil.example` }] } }] } }
      : echoTranslate(userText),
  });
  const attacker = contentScriptOn('https://attacker.example/page');
  const bank = contentScriptOn('https://bank.example/login');

  // 悪意のあるページ上で、モデルの出力が操作されたとする
  assert.equal((await env.send({ type: 'translate', texts: ['Password'] }, attacker)).results[0], 'ここにパスワードを入力: https://evil.example');
  // 同じサイトでは再利用される（無料枠の節約）
  assert.equal(env.calls.length, 1);
  await env.send({ type: 'translate', texts: ['Password'] }, attacker);
  assert.equal(env.calls.length, 1);

  // 別のサイトでは再利用されず、あらためて翻訳される
  poisoned = false;
  const r = await env.send({ type: 'translate', texts: ['Password'] }, bank);
  assert.equal(r.results[0], '訳:Password');
  assert.equal(env.calls.length, 2);
});

await test('設定画面（ページ外）からの翻訳はキャッシュに保存しない', async () => {
  const env = makeEnv({ responder: ({ userText }) => echoTranslate(userText) });
  await env.send({ type: 'translate', texts: ['Hello'] }, EXT_PAGE);
  await env.send({ type: 'translate', texts: ['Hello'] }, EXT_PAGE);
  assert.equal(env.calls.length, 2);
  assert.equal(env.store.translationCache, undefined);
});

await test('保存領域のアクセス範囲を、信頼された画面（設定画面・裏方）だけに制限している', async () => {
  const env = makeEnv({ responder: never });
  assert.deepEqual(
    Array.from(env.accessLevels, (x) => x.join(':')).sort(),
    ['local:TRUSTED_CONTEXTS', 'session:TRUSTED_CONTEXTS'],
  );
});

await test('応答速度の診断は、設定画面だけが呼べる（ページのスクリプトや他の拡張機能からは不可）', async () => {
  const env = makeEnv({ responder: never });
  assert.equal(await env.send({ type: 'probe', models: ['a'] }, CONTENT_SCRIPT), undefined);
  assert.equal(await env.send({ type: 'probe', models: ['a'] }, OTHER_EXTENSION), undefined);
  assert.equal(env.calls.length, 0);
});

summary();
