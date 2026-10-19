// background.js（と、importScripts で読み込む chatgpt.js）を、chrome.* と fetch を偽物に差し替えた環境で動かすための共通部品。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(here, '..', 'extension');
const source = readFileSync(path.join(extDir, 'background.js'), 'utf8');

// 呼び出し元の例
// 設定画面。open_in_tab のため、実際にはタブとして開かれ sender.tab が付く（実ブラウザで確認済み）。
export const EXT_PAGE = {
  id: 'test-id',
  url: 'chrome-extension://test-id/options.html',
  tab: { id: 3, url: 'chrome-extension://test-id/options.html' },
};
export const CONTENT_SCRIPT = { id: 'test-id', url: 'https://evil.example/page', tab: { id: 7, url: 'https://evil.example/page' } };
export const contentScriptOn = (url) => ({ id: 'test-id', url, tab: { id: 8, url } }); // ページに差し込んだスクリプト
export const OTHER_EXTENSION = { id: 'other-extension', url: 'chrome-extension://other-extension/x.html' };

const OPENAI_HOSTS = ['https://api.openai.com/', 'https://auth.openai.com/'];

// 偽の OpenAI（Responses API）の「回答の流れ」を作る
export function sseBody(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}
export function openaiTextEvents(text, usage = { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } }) {
  const half = Math.ceil(text.length / 2);
  return [
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: text.slice(0, half) },
    { type: 'response.output_text.delta', delta: text.slice(half) },
    { type: 'response.completed', response: { usage } },
  ];
}

export function makeEnv({ settings = {}, responder, listResponder, openaiResponder }) {
  const store = { apiKey: 'test-key', acknowledged: true, rememberKey: true, ...settings };
  const sessionStore = {};
  const calls = [];
  const openaiCalls = [];
  const tabsCreated = [];
  const tabsRemoved = [];
  let messageHandler = null;
  let webRequestHandler = null;
  let webRequestFilter = null;

  const accessLevels = [];
  const area = (name, backing) => ({
    setAccessLevel: (o) => { accessLevels.push([name, o.accessLevel]); },
    get: async (defaults) => {
      if (typeof defaults === 'string') return { [defaults]: backing[defaults] };
      if (Array.isArray(defaults)) return Object.fromEntries(defaults.map((k) => [k, backing[k]]));
      return { ...defaults, ...backing };
    },
    set: async (obj) => Object.assign(backing, obj),
    remove: async (key) => { delete backing[key]; },
  });

  const chrome = {
    storage: { local: area('local', store), session: area('session', sessionStore) },
    runtime: {
      id: 'test-id',
      getURL: (p = '') => 'chrome-extension://test-id/' + p,
      onInstalled: { addListener() {} },
      onMessage: { addListener: (fn) => { messageHandler = fn; } },
      openOptionsPage() {},
    },
    contextMenus: { onClicked: { addListener() {} }, create() {}, removeAll() {} },
    action: { onClicked: { addListener() {} } },
    tabs: {
      create: async (opts) => {
        tabsCreated.push(opts);
        return { id: 100 + tabsCreated.length };
      },
      remove: async (id) => { tabsRemoved.push(id); },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (fn, filter) => {
          webRequestHandler = fn;
          webRequestFilter = filter;
        },
      },
    },
  };

  const reply = (out) => ({
    ok: out.status === undefined || out.status === 200,
    status: out.status ?? 200,
    json: async () => out.json,
    text: async () => (out.text ?? JSON.stringify(out.json)),
    headers: { get: (name) => out.headers?.[String(name).toLowerCase()] ?? null },
  });

  const fetch = async (url, init = {}) => {
    // OpenAI（サインインのトークン・モデル一覧・Responses API）
    if (OPENAI_HOSTS.some((h) => String(url).startsWith(h))) {
      openaiCalls.push({ url: String(url), init });
      if (!openaiResponder) throw new Error(`想定していない OpenAI への通信: ${url}`);
      const out = await openaiResponder({ url: String(url), init, call: openaiCalls.length });
      if (out.hang) {
        return new Promise((_, reject) => {
          const abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort);
        });
      }
      const body = out.sse !== undefined ? sseBody(out.sse) : (out.text ?? JSON.stringify(out.json ?? {}));
      return new Response(body, {
        status: out.status ?? 200,
        headers: { 'content-type': out.sse !== undefined ? 'text/event-stream' : 'application/json', ...(out.headers || {}) },
      });
    }

    if (!init.method || init.method === 'GET') {
      // モデル一覧 (Gemini Models API)
      calls.push({ list: true, url, key: init.headers?.['x-goog-api-key'] });
      return reply(await listResponder({ url, call: calls.length }));
    }
    const body = JSON.parse(init.body);
    const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
    const userText = body.contents[0].parts[0].text;
    calls.push({ model, userText, key: init.headers['x-goog-api-key'], url });
    const out = await responder({ model, userText, call: calls.length });
    if (out.hang) {
      // Google が応答を返さない状況。タイムアウトで中止（abort）されたときだけ失敗させる。
      return new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort);
      });
    }
    return reply(out);
  };

  // 待機・タイムアウトのタイマーは、テストでは即座に実行する
  const ctx = vm.createContext({
    chrome, fetch, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, AbortController,
    importScripts: (...files) => {
      for (const f of files) vm.runInContext(readFileSync(path.join(extDir, f), 'utf8'), ctx, { filename: f });
    },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, URLSearchParams, atob, btoa,
    console, JSON, Map, Set, Array, Promise, URL,
  });
  vm.runInContext(source, ctx);

  // 受け付けない呼び出し元（ハンドラが true を返さない）のときは undefined を返す。
  const send = (msg, sender = EXT_PAGE) => new Promise((resolve) => {
    if (messageHandler(msg, sender, resolve) !== true) resolve(undefined);
  });

  // サインイン後の「戻り先への移動」を、webRequest のイベントとして流す（登録したフィルターに合うものだけ）
  const fireCallback = async (url, tabId = 999) => {
    if (!webRequestHandler) throw new Error('webRequest のリスナーが登録されていません');
    const pattern = webRequestFilter.urls[0];
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    if (!String(url).startsWith(prefix)) return false;
    webRequestHandler({ url, tabId });
    // 非同期の処理（トークン交換など）が終わるまで待つ
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    return true;
  };

  return {
    send, calls, openaiCalls, tabsCreated, tabsRemoved, store, sessionStore, accessLevels,
    fireCallback, webRequestFilter: () => webRequestFilter,
    // background.js の中の式（SYSTEM_PROMPT・buildTranslateRequest・parseSegments など）を取り出す
    evalIn: (code) => vm.runInContext(code, ctx),
  };
}

// "<<<n>>>\ntext" を "<<<n>>>\n訳:text" にして返す偽の Gemini
export const echoTranslate = (userText) => ({
  json: {
    candidates: [{
      content: {
        parts: [{
          text: userText.replace(/<<<(\d+)>>>\n([\s\S]*?)(?=\n<<<\d+>>>|$)/g, (_, n, t) => `<<<${n}>>>\n訳:${t}`),
        }],
      },
    }],
  },
});

// 「<<<n>>>\ntext」を「訳:」付きにして返す（OpenAI 用の、文字列だけ版）
export const echoTranslateText = (userText) =>
  userText.replace(/<<<(\d+)>>>\n([\s\S]*?)(?=\n<<<\d+>>>|$)/g, (_, n, t) => `<<<${n}>>>\n訳:${t}`);

export function createRunner() {
  let passed = 0;
  return {
    async test(name, fn) {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (e) {
        console.error(`  NG  ${name}\n      ${e.message}`);
        process.exitCode = 1;
      }
    },
    summary() {
      console.log(`\n${passed} 件成功`);
    },
  };
}
