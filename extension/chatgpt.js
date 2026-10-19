'use strict';

// ChatGPT のプラン（Plus / Pro など）の利用枠で翻訳する提供元。
// OpenAI の「Sign in with ChatGPT」（トークン共有）を使う。仕様の出典: developers.openai.com/siwc/token-sharing-open-source
//
// 公式の手順は、ローカルのプログラムが 127.0.0.1 で待ち受けて、戻り先を受け取る形。
// 拡張機能は待ち受けを持てないので、戻り先への移動を webRequest で「検知」して、code を取り出す（background.js）。
//
// 注意: 公式ドキュメントは、ブラウザ拡張機能での利用には触れていません（許可も禁止も書かれていません）。
// 実際の OpenAI で動作することは確認していますが、仕様の変更で動かなくなる可能性があります。
//
// background.js から importScripts で読み込まれる（クラシックスクリプト）。TranslateError・sleep・MAX_RETRIES は background.js のもの。
const ChatGPT = (() => {
  const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
  const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
  const API_BASE = 'https://api.openai.com/v1';
  const RESOURCE = 'https://api.openai.com/v1';
  // 初回の登録から、同じ形（スキーム・ホスト・パス）を使い続ける必要がある。
  const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
  const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
  // 承認画面に表示される名前。文字数・文字種の仕様が不明なため、無難な英数字にしている。
  const APP_NAME = 'Right Click Translate';
  const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
  const REFRESH_MARGIN_MS = 60 * 1000; // 有効期限の 1 分前になったら、更新する

  const L = chrome.storage.local;
  const S = chrome.storage.session;

  const fail = (message, kind, extra) => Object.assign(new TranslateError(message, kind), extra || {});

  // ---------------------------------------------------------------- 小道具

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomB64url = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const sha256b64url = async (text) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

  function jwtPayload(jwt) {
    try {
      const part = String(jwt).split('.')[1];
      const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch {
      return null;
    }
  }

  // トークンは、APIキーと同じ扱い（「保存しておく」なら storage.local、そうでなければ storage.session）。
  async function secretArea() {
    const { rememberKey } = await L.get({ rememberKey: true });
    return rememberKey ? L : S;
  }

  // ---------------------------------------------------------------- サインイン（認可の依頼・戻り先の解析）

  // 認可の画面の URL と、あとで照合する値（state・nonce・PKCE の検証子）を作る。
  async function createAuthRequest({ clientId = '', hostId, email = '' }) {
    const verifier = randomB64url(32);
    const state = randomB64url(32);
    const nonce = randomB64url(32);
    const params = new URLSearchParams({
      client_id: clientId || 'dynamic_agent_client', // 初回だけ。発行された client_id を保存して、以後はそれを使う
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: await sha256b64url(verifier),
      ext_agent_host_id: hostId,
    });
    if (!clientId) params.set('agent_name_hint', APP_NAME);
    if (email) params.set('login_hint', email);
    return { url: `${AUTHORIZE_URL}?${params}`, state, nonce, verifier, usedClientId: clientId || null };
  }

  function isCallbackUrl(u) {
    return (
      typeof u === 'string' &&
      u.startsWith(REDIRECT_URI) &&
      (u.length === REDIRECT_URI.length || '?#'.includes(u[REDIRECT_URI.length]))
    );
  }

  // 戻り先の URL を解析する。
  //   ignore: この依頼のものではない（state が違う）。待ち受けを続ける
  //   error:  サインインが完了しなかった
  //   ok:     { code, clientId }
  function parseCallback(urlString, pending) {
    let q;
    try {
      q = new URL(urlString).searchParams;
    } catch {
      return { kind: 'ignore' };
    }
    const states = q.getAll('state');
    if (states.length !== 1 || states[0] !== pending.state) return { kind: 'ignore' };
    if (q.get('error')) return { kind: 'error', error: q.get('error') };
    const codes = q.getAll('code');
    if (codes.length !== 1) return { kind: 'error', error: 'missing_code' };
    const clientIds = q.getAll('client_id');
    if (clientIds.length > 1) return { kind: 'error', error: 'registration_incomplete' };
    const returned = clientIds[0] || '';
    const clientId = returned || pending.usedClientId || '';
    if (!clientId || clientId === 'dynamic_agent_client' || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId)) {
      return { kind: 'error', error: 'registration_incomplete' };
    }
    if (pending.usedClientId && returned && returned !== pending.usedClientId) return { kind: 'error', error: 'client_mismatch' };
    return { kind: 'ok', code: codes[0], clientId };
  }

  // ---------------------------------------------------------------- トークン

  async function postForm(fields) {
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields),
      });
    } catch {
      throw fail('ChatGPT のサインイン先（auth.openai.com）に接続できませんでした。接続を確認してください。', 'network');
    }
    let json = null;
    try {
      json = await res.json();
    } catch { /* JSON ではない */ }
    return { res, json };
  }

  function tokenError(status, json) {
    const code = json && typeof json.error === 'string' ? json.error : '';
    const detail = json && typeof json.error_description === 'string' ? json.error_description.slice(0, 160) : '';
    if (code === 'invalid_grant') {
      return fail('ChatGPT のサインインの有効期限が切れました。設定画面で、サインインし直してください。', 'auth', { reauth: true });
    }
    if (status >= 500) return fail(`ChatGPT のサインイン先でエラーが発生しました (${status})。しばらくしてからお試しください。`, 'server');
    return fail(`ChatGPT のサインインを完了できませんでした (${status})。${code}${detail ? `: ${detail}` : ''}`, 'auth');
  }

  function toAuth(json, { clientId, email = '', previous = null }) {
    const expiresIn = Number(json.expires_in);
    if (!(expiresIn > 0)) throw fail('ChatGPT のサインインの応答が、想定した形ではありません（expires_in）。', 'auth');
    const scopeText = typeof json.scope === 'string' ? json.scope : previous ? previous.scopes.join(' ') : '';
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : previous ? previous.refreshToken : '',
      idToken: typeof json.id_token === 'string' && json.id_token ? json.id_token : previous ? previous.idToken : '',
      expiresAt: Date.now() + expiresIn * 1000,
      scopes: scopeText.split(/\s+/).filter(Boolean),
      clientId,
      email,
      savedAt: Date.now(),
    };
  }

  // code をトークンに交換する。nonce が一致しない応答は、受け付けない。
  async function exchangeCode({ code, clientId, verifier, nonce }) {
    const { res, json } = await postForm({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    if (!res.ok || !json || typeof json.access_token !== 'string') throw tokenError(res.status, json);
    const claims = jwtPayload(json.id_token);
    if (!claims) throw fail('ChatGPT のサインインの応答（ID トークン）を読み取れませんでした。', 'auth');
    if (claims.nonce !== nonce) {
      throw fail('ChatGPT のサインインの応答が、今回の依頼のものではありません（nonce の不一致）。中止しました。', 'auth');
    }
    return toAuth(json, { clientId, email: typeof claims.email === 'string' ? claims.email : '' });
  }

  // リフレッシュトークンで、アクセストークンを更新する。リフレッシュトークンは、更新のたびに新しくなる。
  async function refreshTokens(auth) {
    const { res, json } = await postForm({
      grant_type: 'refresh_token',
      client_id: auth.clientId,
      refresh_token: auth.refreshToken,
      resource: RESOURCE,
    });
    if (!res.ok || !json || typeof json.access_token !== 'string') throw tokenError(res.status, json);
    return toAuth(json, { clientId: auth.clientId, email: auth.email, previous: auth });
  }

  // ---------------------------------------------------------------- サインインの状態と流れ

  const validAuth = (a) => (a && typeof a.accessToken === 'string' && Array.isArray(a.scopes) ? a : null);

  // 「保存しておく」の設定を切り替えた直後は、トークンが、もう一方の保存先に残っている。両方を見て、サインインを失わない。
  async function readAuth() {
    const area = await secretArea();
    const other = area === L ? S : L;
    return validAuth((await area.get('chatgptAuth')).chatgptAuth) || validAuth((await other.get('chatgptAuth')).chatgptAuth);
  }
  // 書き込むときは、いまの設定の保存先に置き、もう一方からは消す（「忘れる」設定なのに、ディスクに残らないように）
  async function writeAuth(auth) {
    const area = await secretArea();
    await area.set({ chatgptAuth: auth });
    await (area === L ? S : L).remove('chatgptAuth');
  }
  async function clearAuth() {
    await L.remove('chatgptAuth');
    await S.remove('chatgptAuth');
  }

  async function readReg() {
    const { chatgptReg } = await L.get('chatgptReg');
    return chatgptReg && typeof chatgptReg === 'object' ? chatgptReg : {};
  }

  const setLast = (ok, message) => S.set({ chatgptLast: { at: Date.now(), ok, message } });

  async function startSignIn() {
    const reg = await readReg();
    let hostId = reg.hostId;
    if (!hostId) {
      hostId = `urn:uuid:${crypto.randomUUID()}`;
      await L.set({ chatgptReg: { ...reg, hostId } });
    }
    const req = await createAuthRequest({ clientId: reg.clientId || '', hostId, email: reg.email || '' });
    // 戻り先が速く来ても取りこぼさないよう、タブを開く前に、待ち受け状態を保存する
    await S.set({
      chatgptPending: { state: req.state, nonce: req.nonce, verifier: req.verifier, usedClientId: req.usedClientId, startedAt: Date.now(), tabId: null },
    });
    await S.remove('chatgptLast');
    const tab = await chrome.tabs.create({ url: req.url });
    const { chatgptPending } = await S.get('chatgptPending');
    if (chatgptPending && chatgptPending.state === req.state) await S.set({ chatgptPending: { ...chatgptPending, tabId: tab.id } });
  }

  async function cancelSignIn() {
    const { chatgptPending } = await S.get('chatgptPending');
    if (chatgptPending && chatgptPending.tabId !== null) chrome.tabs.remove(chatgptPending.tabId).catch(() => {});
    await S.remove('chatgptPending');
  }

  let processing = false;

  // 戻り先を検知したときに呼ぶ。戻り値: { handled, ok }
  async function onCallback(url, tabId) {
    if (processing) return { handled: false, ok: false };
    processing = true;
    try {
      const { chatgptPending: pending } = await S.get('chatgptPending');
      if (!pending) return { handled: false, ok: false };
      const parsed = parseCallback(url, pending);
      if (parsed.kind === 'ignore') return { handled: false, ok: false }; // 待ち受けは続ける

      await chrome.tabs.remove(pending.tabId ?? tabId).catch(() => {}); // 「接続できません」の画面を見せない
      await S.remove('chatgptPending');

      if (parsed.kind === 'error') {
        const text = parsed.error === 'access_denied'
          ? 'サインインの承認が拒否されました。'
          : `サインインを完了できませんでした（${parsed.error}）。`;
        await setLast(false, text);
        return { handled: true, ok: false };
      }

      // 発行された client_id は、交換の前に保存する（交換に失敗しても、登録をやり直さないため）
      const reg = await readReg();
      await L.set({ chatgptReg: { ...reg, clientId: parsed.clientId } });
      try {
        const auth = await exchangeCode({ code: parsed.code, clientId: parsed.clientId, verifier: pending.verifier, nonce: pending.nonce });
        if (!auth.scopes.includes(PLAN_SCOPE)) {
          await setLast(false, 'ChatGPT プランの利用枠を使う権限が、付与されませんでした。');
          return { handled: true, ok: false };
        }
        await writeAuth(auth);
        await L.set({ chatgptReg: { ...reg, clientId: parsed.clientId, email: auth.email } });
        await setLast(true, 'サインインしました。');
        return { handled: true, ok: true };
      } catch (e) {
        await setLast(false, (e && e.message) || 'サインインを完了できませんでした。');
        return { handled: true, ok: false };
      }
    } finally {
      processing = false;
    }
  }

  let refreshing = null;

  async function doRefresh() {
    const current = await readAuth();
    if (!current) throw fail('ChatGPT にサインインしていません。設定画面で、サインインしてください。', 'nokey');
    // 別の呼び出しがすでに更新していれば、それを使う
    if (current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return current;
    if (!current.refreshToken) {
      await clearAuth();
      throw fail('ChatGPT のサインインの有効期限が切れました。設定画面で、サインインし直してください。', 'auth');
    }
    try {
      const next = await refreshTokens(current);
      await writeAuth(next); // アクセストークンと、新しいリフレッシュトークンを、まとめて入れ替える
      return next;
    } catch (e) {
      // 一時的な失敗（通信・混雑）では、サインインを消さない。無効になった場合だけ消す。
      if (e && e.reauth) await clearAuth();
      throw e;
    }
  }

  async function getAccessToken() {
    const auth = await readAuth();
    if (!auth) throw fail('ChatGPT にサインインしていません。設定画面で、サインインしてください。', 'nokey');
    if (auth.expiresAt - Date.now() > REFRESH_MARGIN_MS) return auth.accessToken;
    // 更新するたびにリフレッシュトークンが入れ替わる。同時に 2 回更新すると、片方が無効になるため、1 回にまとめる。
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return (await refreshing).accessToken;
  }

  // 401 のとき: 有効期限を過ぎたことにして、次の getAccessToken で更新させる
  async function invalidateAccessToken() {
    const auth = await readAuth();
    if (auth) await writeAuth({ ...auth, expiresAt: 0 });
  }

  async function status() {
    const auth = await readAuth();
    const { chatgptPending: pending, chatgptLast: last } = await S.get(['chatgptPending', 'chatgptLast']);
    const reg = await readReg();
    return {
      signedIn: !!auth,
      email: (auth && auth.email) || reg.email || '',
      hasPlanScope: !!auth && auth.scopes.includes(PLAN_SCOPE),
      expiresAt: auth ? auth.expiresAt : 0,
      pending: !!pending,
      last: last || null,
    };
  }

  // この拡張機能に保存したものを消す（ChatGPT 側の接続は、ChatGPT の設定から解除する）
  async function signOut() {
    await cancelSignIn();
    await clearAuth();
    await S.remove('chatgptLast');
    const reg = await readReg();
    await L.set({ chatgptReg: { hostId: reg.hostId } }); // ホスト ID は、この拡張機能のインストールを表すので残す
  }

  // ---------------------------------------------------------------- 応答の取り込み

  const SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

  function parseBlock(block) {
    let event = '';
    const data = [];
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return { event, data: data.join('\n') };
  }

  // Server-Sent Events を、1 イベントずつに分解する
  async function* parseSse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let m = SEPARATOR.exec(buffer); m; m = SEPARATOR.exec(buffer)) {
          const block = buffer.slice(0, m.index);
          buffer = buffer.slice(m.index + m[0].length);
          const ev = parseBlock(block);
          if (ev.data) yield ev;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const ev = parseBlock(buffer);
        if (ev.data) yield ev;
      }
    } finally {
      try { await reader.cancel(); } catch { /* すでに閉じている */ }
    }
  }

  // HTTP のエラーを、利用者に分かる言葉と「種類」に分類する。
  function classifyHttp(status, bodyText, model, retryAfterHeader) {
    let detail = '';
    let code = '';
    try {
      const json = JSON.parse(bodyText);
      const err = json && typeof json.error === 'object' && json.error ? json.error : json;
      detail = String(err.message ?? '').slice(0, 300);
      code = String(err.code ?? err.type ?? '');
    } catch {
      detail = String(bodyText || '').slice(0, 300);
    }
    const text = `${code} ${detail}`;
    const seconds = Number(retryAfterHeader);
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 40000) : 0;

    if (status === 401) {
      return fail('ChatGPT のサインインが無効になりました。設定画面で、サインインし直してください。', 'auth', { status });
    }
    if (status === 403) {
      return fail(`ChatGPT のプランの利用枠を、この条件では使えません。${detail}`, 'auth', { status });
    }
    if (status === 404) {
      return fail(`モデル「${model}」が見つかりません。設定画面でモデルを選び直してください。`, 'model', { status });
    }
    if (/subscription_sharing_usage_limit_exceeded|insufficient_quota|exceeded your current quota/i.test(text)) {
      return fail(
        'ChatGPT のプランの利用枠（アプリごとの上限、またはプラン全体の上限）に達しました。ChatGPT の「設定 → 使用状況」で、上限と残りを確認してください。',
        'quota',
        { status, exhausted: true },
      );
    }
    if (status === 429) {
      return fail('ChatGPT への依頼が多すぎます。少し待ってから、もう一度お試しください。', 'quota', { status, retry: true, delayMs: Math.max(retryAfterMs, 3000) });
    }
    if (status >= 500) {
      return fail(`ChatGPT 側でエラーが発生しました (${status})。`, 'server', { status, retry: true, delayMs: Math.max(retryAfterMs, 1500) });
    }
    return fail(`ChatGPT への依頼が受け付けられませんでした (${status})。${detail}`, 'invalid', { status });
  }

  // 応答の中で失敗が伝えられた場合（response.failed / error）
  function failureError(err) {
    const code = (err && err.code) || '';
    if (code === 'subscription_sharing_usage_limit_exceeded') {
      return fail(
        'ChatGPT のプランの利用枠（アプリごとの上限、またはプラン全体の上限）に達しました。ChatGPT の「設定 → 使用状況」で、上限と残りを確認してください。',
        'quota',
        { exhausted: true },
      );
    }
    if (code === 'subscription_sharing_usage_unavailable') {
      return fail(
        'ChatGPT のプランの利用枠を、いま利用できません。ChatGPT の「設定 → 使用状況」を確認してください。',
        'quota',
        { exhausted: true },
      );
    }
    return fail(String((err && err.message) || 'ChatGPT でエラーが発生しました。').slice(0, 300), 'server');
  }

  // 1 回の依頼。成功したら { text, usage, status, headersMs, firstTokenMs } を返す。
  //   headersMs:    依頼してから、応答の「頭」（ヘッダー）が届くまでの時間
  //   firstTokenMs: 依頼してから、最初の文字が届くまでの時間（モデルの思考・混雑の待ちが、ここに現れる）
  async function streamOnce({ accessToken, model, body, signal }) {
    const startedAt = Date.now();
    let headersMs = null;
    let firstTokenMs = null;
    let res;
    try {
      res = await fetch(`${API_BASE}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e; // 中断は、呼び出し側で扱う
      throw fail('ネットワークに接続できませんでした。接続を確認してください。', 'network');
    }
    headersMs = Date.now() - startedAt;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyHttp(res.status, text.split(accessToken).join('[トークン]'), model, res.headers.get('retry-after'));
    }

    let text = '';
    let refusal = '';
    let completed = false;
    let usage = null;
    for await (const ev of parseSse(res.body)) {
      if (ev.data === '[DONE]') break;
      let json;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (json.type || ev.event) {
        case 'response.output_text.delta':
          if (typeof json.delta === 'string') {
            if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
            text += json.delta;
          }
          break;
        case 'response.refusal.delta':
          if (typeof json.delta === 'string') refusal += json.delta;
          break;
        case 'response.completed':
          completed = true;
          usage = (json.response && json.response.usage) || null;
          break;
        case 'response.failed':
          throw failureError(json.response && json.response.error);
        case 'error':
          throw failureError(json.error || json);
        default:
          break;
      }
    }
    if (!text && refusal) throw fail('ChatGPT が、この内容の翻訳を断りました。', 'block');
    if (!text && !completed) throw fail('ChatGPT の応答が、途中で途切れました。', 'server', { retry: true, delayMs: 1500 });
    return { text, usage, status: res.status, headersMs, firstTokenMs };
  }

  const developerBody = (base, system) => ({ ...base, input: [{ role: 'developer', content: system }, ...base.input] });

  // 依頼の形。数字が大きいほど、サーバーが受け付けやすい（古い・限られた仕様）。
  //   0: システム指示（instructions）＋ 思考の量を少なめ（reasoning.effort: low）
  //   1: システム指示（instructions）のみ
  //   2: システム指示を、入力の先頭の developer メッセージにする
  // 受け付けられなかった（400 系）ときは、次の形で送り直す。通った形は、モデルごとに記憶して、次からそこから始める。
  const LAST_VARIANT = 2;
  const variantBody = (variant, base, system) => {
    if (variant === 0) return { ...base, instructions: system, reasoning: { effort: 'low' } };
    if (variant === 1) return { ...base, instructions: system };
    return developerBody(base, system);
  };
  // エラーの文面から、何が受け付けられなかったかが分かるときは、そこまで一度に進む
  const nextVariant = (variant, message) => {
    if (/instructions/i.test(message)) return LAST_VARIANT;
    if (/reasoning/i.test(message)) return Math.max(variant + 1, 1);
    return variant + 1;
  };

  async function readCaps() {
    const { chatgptCaps } = await S.get('chatgptCaps');
    return chatgptCaps && typeof chatgptCaps === 'object' ? chatgptCaps : {};
  }
  async function saveCap(model, variant) {
    const caps = await readCaps();
    caps[model] = variant;
    await S.set({ chatgptCaps: caps });
  }

  // 翻訳（1 回ぶん）。回答の全文を返す。trace に、時間・依頼の結果・トークン数を記録する。
  // fast: 思考を控えめにして、速さを優先する（受け付けなければ、自動で外す）。
  async function complete({ model, system, userText, trace, timeoutMs, fast = true }) {
    if (!MODEL_ID.test(model)) throw fail('モデル名に使えない文字が含まれています。設定画面で選び直してください。', 'model');
    // 公式の仕様: store は false、stream は true が必須
    const base = { model, input: [{ role: 'user', content: userText }], store: false, stream: true };
    let refreshedOnce = false;
    const startVariant = Math.max(fast ? 0 : 1, Number((await readCaps())[model]) || 0);

    for (let attempt = 0; ; attempt++) {
      const accessToken = await getAccessToken();
      const startedAt = Date.now();
      trace.requests += 1;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        let result;
        let variant = startVariant;
        for (;;) {
          try {
            result = await streamOnce({ accessToken, model, body: variantBody(variant, base, system), signal: controller.signal });
            break;
          } catch (e) {
            if (!(e instanceof TranslateError && e.kind === 'invalid') || variant >= LAST_VARIANT) throw e;
            variant = nextVariant(variant, e.message);
            trace.requests += 1;
          }
        }
        if (variant > startVariant) await saveCap(model, variant).catch(() => {});
        const ms = Date.now() - startedAt;
        trace.apiMs += ms;
        trace.attempts.push({
          provider: 'chatgpt', model, status: 200, ms, headersMs: result.headersMs, firstTokenMs: result.firstTokenMs, serverMs: null,
        });
        trace.model = model;
        if (result.usage) {
          trace.tokens.prompt += Number(result.usage.input_tokens) || 0;
          trace.tokens.output += Number(result.usage.output_tokens) || 0;
          const details = result.usage.output_tokens_details || {};
          trace.tokens.thoughts += Number(details.reasoning_tokens) || 0;
        }
        return result.text;
      } catch (e) {
        const ms = Date.now() - startedAt;
        trace.apiMs += ms;
        // サーバーが返した結果（TranslateError）より、中断・通信失敗を先に疑わない。中断は、素の例外として届く。
        if (!(e instanceof TranslateError)) {
          if (timedOut) {
            trace.attempts.push({ provider: 'chatgpt', model, status: 'timeout', ms });
            throw fail(`ChatGPT の応答が ${Math.round(timeoutMs / 1000)} 秒以内に返らなかったため、待つのをやめました。`, 'timeout');
          }
          trace.attempts.push({ provider: 'chatgpt', model, status: 'network', ms });
          throw fail('通信に失敗しました。ネットワーク接続を確認してください。', 'network');
        }
        trace.attempts.push({ provider: 'chatgpt', model, status: e.status || (e.kind === 'network' ? 'network' : 'error'), ms });

        // アクセストークンが無効と言われたら、1 回だけ更新して、やり直す
        if (e.status === 401 && !refreshedOnce) {
          refreshedOnce = true;
          await invalidateAccessToken();
          continue;
        }
        if (e.retry && attempt < MAX_RETRIES) {
          const wait = e.kind === 'server' ? e.delayMs * (attempt + 1) : e.delayMs;
          trace.waitedMs += wait;
          await sleep(wait);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // ---------------------------------------------------------------- モデル一覧

  // アカウントが使えるモデル。サーバーの順序のまま、表示用（visibility が list）のものだけ。
  async function listModels() {
    const accessToken = await getAccessToken();
    let res;
    try {
      res = await fetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${accessToken}` } });
    } catch {
      throw fail('通信に失敗しました。ネットワーク接続を確認してください。', 'network');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyHttp(res.status, text.split(accessToken).join('[トークン]'), '', res.headers.get('retry-after'));
    }
    const json = await res.json();
    return (json.models || [])
      .filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list' && MODEL_ID.test(m.slug))
      .map((m) => ({ id: m.slug, displayName: m.display_name || m.slug }));
  }

  // 翻訳には、小さく速いモデルで十分。名前に mini / nano / lite / luna などが入るものを優先し、なければ先頭。
  function pickDefaultModel(models) {
    const small = models.find((m) => /(^|[-_.])(luna|mini|nano|lite|small|fast|spark)([-_.]|$)/i.test(m.id));
    return (small || models[0] || { id: '' }).id;
  }

  return {
    id: 'chatgpt',
    REDIRECT_URI,
    PLAN_SCOPE,
    isCallbackUrl,
    startSignIn,
    cancelSignIn,
    onCallback,
    getAccessToken,
    status,
    signOut,
    complete,
    listModels,
    pickDefaultModel,
    // テスト用
    internals: { createAuthRequest, parseCallback, jwtPayload, classifyHttp, exchangeCode },
  };
})();
