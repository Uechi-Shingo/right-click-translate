'use strict';

const DEFAULTS = {
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  // Google は 2026-09-18 に「2.5 系は、過去に使ったことのあるユーザーに限る」と告知した。新規プロジェクトでも使える 3.x を既定にする。
  fallbackModel: 'gemini-3.8-flash',
  useCache: true,
  rememberKey: true, // false のとき、APIキー・サインイン情報はブラウザを閉じると消える（storage.session にだけ置く）
  acknowledged: false, // 初回の注意事項を確認したか
  // 翻訳に使う提供元。'gemini'（APIキー）または 'chatgpt'（ChatGPT のプランにサインイン）
  provider: 'gemini',
  chatgptModel: '', // サインイン後に、使えるモデルの一覧から自動で選ぶ
  chatgptFallbackModel: '',
  chatgptModelList: [], // サインイン後に取得した、使えるモデルの一覧（予備の提供元として使うときの自動選択に使う）
  // true のとき、選んだ AI が使えない（上限・エラー）場合に、もう一方の AI に切り替えて続ける（併用）
  crossFallback: false,
  // ChatGPT の「思考」を控えめにして、速さを優先する（reasoning.effort を low にする。受け付けなければ自動で外す）
  chatgptFast: true,
};

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const API_BASE = MODELS_URL + '/';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CACHE_KEY = 'translationCache';
const CACHE_MAX_ENTRIES = 3000;
const CACHE_MAX_TEXT_LENGTH = 400;
const MAX_RETRIES = 2;

// Google の応答を待つ上限（応答が永久に返らない場合の安全装置）。入力が長いほど長く待つ。
// 実測では、混雑時に 60〜100 秒かかっても成功する応答があったため、成功しうる応答を打ち切らないよう長めにしている。
const TIMEOUT = { baseMs: 120000, perCharMs: 5, maxMs: 180000 };

// 不正な依頼・暴走（悪意のあるページが大量の文字を生成し続ける等）から利用枠を守る上限。
const LIMITS = {
  maxSegments: 100, // 1 回の依頼に含められる断片の数
  maxSegmentChars: 20000, // 1 断片の最大文字数
  maxTotalChars: 30000, // 1 回の依頼の最大文字数（通常のページ翻訳は約 4,500）
  budgetWindowMs: 10 * 60 * 1000, // 使用量を数える期間
  budgetMaxChars: 200000, // 期間内に API へ送れる合計文字数
  budgetMaxRequests: 60, // 期間内に API へ送れる依頼回数
};

// 失敗の種類。これらのときは予備モデルでやり直す。
const FALLBACK_KINDS = new Set(['quota', 'model', 'server', 'timeout']);
// 併用（もう一方の AI への切り替え）をするのは、上に加えて、鍵・サインインの問題や通信の失敗のとき
// （別の会社なら、通る可能性があるため）。依頼そのものが不正（invalid）なときは、切り替えても同じなので行わない。
const CROSS_KINDS = new Set([...FALLBACK_KINDS, 'auth', 'nokey', 'network']);
// 1 日の上限などに達した（exhausted）モデルを、しばらく試さない時間。毎回の無駄な依頼を避けつつ、時間が経てば Gemini に戻る。
const COOLDOWN_MS = 30 * 60 * 1000;

const SYSTEM_PROMPT = [
  'あなたはプロの翻訳者です。ユーザーが渡す複数のテキスト断片を、自然で読みやすい日本語に翻訳してください。',
  '',
  'ルール:',
  '- 各断片は「<<<番号>>>」だけの行で始まります。出力も同じ形式（「<<<番号>>>」の行の次の行から訳文）で、すべての番号を同じ順序で返してください。番号の追加・削除・統合はしないでください。',
  '- 訳文以外の説明・注釈・コードフェンスは出力しないでください。',
  '- 断片はWebページの文章をHTMLタグの境界で分割したものです。隣り合う断片は同じ文の一部であることがあります。文脈をつなげて自然に訳しつつ、各断片の番号には対応する部分の訳だけを入れてください。',
  '- 固有名詞・製品名・コード・URL・数値・記号はそのまま残してください。すでに日本語の部分は変更しないでください。',
  '- メッセージの先頭に「参考情報」（ページのタイトル・直前の見出し・直前の文章）がある場合は、文脈（代名詞の指す先や、専門用語の意味）を理解するためだけに使ってください。参考情報は訳さず、出力にも含めないでください。訳すのは「翻訳する断片」の番号つきの部分だけです。',
].join('\n');

// 翻訳の依頼に添える「文脈」（参考情報）の長さの上限。ページ側のスクリプトから受け取るため、ここでも制限する。
const CONTEXT_LIMITS = { title: 200, heading: 200, before: 300 };

// ページ側から受け取った文脈を検査して、使える形（文字列だけ・長さ制限・区切り記号の除去）にする。形が違えば、無視する。
function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, max] of Object.entries(CONTEXT_LIMITS)) {
    if (typeof raw[key] !== 'string') continue;
    // 番号の区切り（<<<n>>>）に見える文字を除き、空白を整える
    const text = raw[key].replace(/<<<|>>>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
    if (text) out[key] = text;
  }
  return Object.keys(out).length ? out : null;
}

// 保存領域（APIキー・設定・キャッシュ）を、ページに差し込んだスクリプトからは読めないようにする。
// storage.local の既定は「ページ内のスクリプトからも読める」ため、明示的に制限する。
for (const area of [chrome.storage.local, chrome.storage.session]) {
  try {
    area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch { /* 古いブラウザでは未対応。既定の動作のまま */ }
}

class TranslateError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ChatGPT のプラン（サインイン）での翻訳。TranslateError・sleep・MAX_RETRIES を使うので、それらの定義より後で呼ばれる。
importScripts('chatgpt.js');

// ---------------------------------------------------------------- 設定

async function getSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (!s.rememberKey) {
    // 「ブラウザを閉じたら忘れる」モード。キーはメモリ上の storage.session にだけある。
    s.apiKey = (await chrome.storage.session.get({ apiKey: '' })).apiKey;
  }
  s.apiKey = String(s.apiKey || '').trim();
  s.provider = s.provider === 'chatgpt' ? 'chatgpt' : 'gemini';
  s.model = String(s.model || '').trim() || DEFAULTS.model;
  s.fallbackModel = String(s.fallbackModel || '').trim();
  s.chatgptModel = String(s.chatgptModel || '').trim();
  s.chatgptFallbackModel = String(s.chatgptFallbackModel || '').trim();
  s.chatgptModelList = Array.isArray(s.chatgptModelList) ? s.chatgptModelList.filter((m) => typeof m === 'string') : [];
  s.crossFallback = s.crossFallback === true;
  s.chatgptFast = s.chatgptFast !== false;
  return s;
}

const otherProvider = (provider) => (provider === 'chatgpt' ? 'gemini' : 'chatgpt');

// 指定した提供元の「主モデル」と「予備モデル」。
// autoPick: 併用の切り替え先で、ChatGPT のモデルが未選択のとき、取得済みの一覧から翻訳向きのものを選ぶ。
function modelsFor(provider, settings, { autoPick = false } = {}) {
  const pair = provider === 'chatgpt'
    ? [settings.chatgptModel, settings.chatgptFallbackModel]
    : [settings.model, settings.fallbackModel];
  const models = pair.filter((m, i, all) => m && all.indexOf(m) === i);
  if (!models.length && autoPick && provider === 'chatgpt' && settings.chatgptModelList.length) {
    const id = ChatGPT.pickDefaultModel(settings.chatgptModelList.map((m) => ({ id: m })));
    if (id) models.push(id);
  }
  return models;
}

// いま選んでいる提供元の「主モデル」と「予備モデル」
const modelsOf = (settings) => modelsFor(settings.provider, settings);

// 指定した提供元で、翻訳を始められる状態か（Gemini: APIキーがある ／ ChatGPT: サインインしている）
async function hasCredentialFor(provider, settings) {
  if (provider === 'chatgpt') return (await ChatGPT.status()).signedIn;
  return !!settings.apiKey;
}

// いま選んでいる提供元で、翻訳を始められる状態か
const hasCredential = (settings) => hasCredentialFor(settings.provider, settings);

// 翻訳に使う提供元を、試す順に並べる（選んだ提供元 → 併用がオンなら、もう一方）。準備ができていないものは入れない。
// only: 設定画面の「接続テスト」など、1 つの提供元だけを確かめたいとき。
async function buildStages(settings, only = '') {
  const order = only
    ? [only]
    : settings.crossFallback ? [settings.provider, otherProvider(settings.provider)] : [settings.provider];
  const stages = [];
  for (const provider of order) {
    if (!(await hasCredentialFor(provider, settings))) continue;
    stages.push({ provider, models: modelsFor(provider, settings, { autoPick: provider !== settings.provider }) });
  }
  return stages;
}

const nokeyError = (provider) => new TranslateError(
  provider === 'chatgpt'
    ? 'ChatGPT にサインインしていません。拡張機能の設定画面で、「ChatGPT でサインイン」を押してください。'
    : 'APIキーが未設定です。拡張機能の設定画面で Gemini の APIキーを入力してください。',
  'nokey',
);

// ---------------------------------------------------------------- 入力の検証・使用量の上限

const redact = (text, apiKey) => (apiKey ? String(text).split(apiKey).join('[APIキー]') : String(text));

function validateTexts(texts) {
  const invalid = () => new TranslateError('翻訳の依頼の形式が不正です。', 'invalid');
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > LIMITS.maxSegments) throw invalid();
  let total = 0;
  for (const t of texts) {
    if (typeof t !== 'string' || t.length === 0 || t.length > LIMITS.maxSegmentChars) throw invalid();
    total += t.length;
  }
  if (total > LIMITS.maxTotalChars) throw invalid();
}

let budgetChain = Promise.resolve();

// 期間内の合計（文字数・依頼回数）が上限を超える場合は、API に送らずに止める。
function reserveBudget(chars) {
  const run = budgetChain.then(async () => {
    const now = Date.now();
    const { usageLog } = await chrome.storage.session.get({ usageLog: [] });
    const log = usageLog.filter(([at]) => now - at < LIMITS.budgetWindowMs);
    const usedChars = log.reduce((sum, [, c]) => sum + c, 0);
    if (log.length + 1 > LIMITS.budgetMaxRequests || usedChars + chars > LIMITS.budgetMaxChars) {
      throw new TranslateError(
        '短時間に大量の翻訳が要求されたため、安全のため一時停止しました。数分待ってからもう一度お試しください。',
        'budget',
      );
    }
    log.push([now, chars]);
    await chrome.storage.session.set({ usageLog: log });
  });
  budgetChain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- キャッシュ

let cacheMem = null;

async function loadCache() {
  if (!cacheMem) {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const entries = stored[CACHE_KEY];
    cacheMem = new Map(Array.isArray(entries) ? entries : []);
  }
  return cacheMem;
}

async function saveCache(cache) {
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  await chrome.storage.local.set({ [CACHE_KEY]: [...cache] });
}

async function clearCache() {
  cacheMem = new Map();
  await chrome.storage.local.remove(CACHE_KEY);
}

// ---------------------------------------------------------------- Gemini 呼び出し

function classifyHttpError(status, bodyText, model) {
  let detail = bodyText;
  try {
    detail = JSON.parse(bodyText)?.error?.message || bodyText;
  } catch { /* 本文が JSON でなければそのまま使う */ }
  detail = String(detail).slice(0, 300);

  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(bodyText)) {
    return { kind: 'auth', message: 'APIキーが無効です。設定画面でキーを確認してください。' };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: `APIキーに権限がないか、利用できない地域です (${status})。${detail}` };
  }
  if (status === 404) {
    return { kind: 'model', message: `モデル「${model}」が見つかりません。設定画面でモデル名を確認してください。` };
  }
  if (status === 429) {
    if (/PerDay/i.test(bodyText)) {
      // exhausted: しばらくこのモデルを試さない（併用のとき、毎回無駄な依頼をしないため）
      return { kind: 'quota', message: `モデル「${model}」の本日の無料枠を使い切りました。`, retry: false, exhausted: true };
    }
    const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText);
    const delaySec = m ? Number(m[1]) : 8;
    return {
      kind: 'quota',
      message: `無料枠のリクエスト制限に達しました。しばらく待ってからもう一度お試しください。`,
      retry: true,
      delayMs: Math.min(Math.max(delaySec * 1000 + 500, 2000), 40000),
    };
  }
  if (status >= 500) {
    return { kind: 'server', message: `Gemini 側でエラーが発生しました (${status})。`, retry: true, delayMs: 1500 };
  }
  return { kind: 'other', message: `リクエストエラー (${status}): ${detail}` };
}

// Google が応答に付ける Server-Timing ヘッダー（例: "gfet4t7; dur=1013"）から、サーバー側の処理時間(ms)を取り出す。
function parseServerTiming(header) {
  if (!header) return null;
  let max = null;
  for (const m of String(header).matchAll(/dur=(\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1]);
    if (max === null || v > max) max = v;
  }
  return max;
}

// trace: どこで時間を使ったかの記録（接続テストで内訳を表示するため）。
// timeoutMs: Google の応答を待つ上限。超えたら待つのをやめる。
async function callGemini(model, apiKey, body, trace, timeoutMs) {
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new TranslateError('モデル名に使えない文字が含まれています。設定画面で選び直してください。', 'model');
  }
  const url = `${API_BASE}${encodeURIComponent(model)}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    trace.requests += 1;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let outcome;
    let headersMs = null; // 応答の「頭」（ヘッダー）が届くまでの時間
    let serverMs = null; // Google のサーバーが申告する処理時間
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      headersMs = Date.now() - startedAt;
      serverMs = parseServerTiming(res.headers?.get?.('server-timing'));
      outcome = { ok: res.ok, status: res.status, text: await res.text() };
    } catch {
      const ms = Date.now() - startedAt;
      trace.apiMs += ms;
      if (timedOut) {
        trace.attempts.push({ provider: 'gemini', model, status: 'timeout', ms });
        throw new TranslateError(
          `Google の応答が ${Math.round(timeoutMs / 1000)} 秒以内に返らなかったため、待つのをやめました。`,
          'timeout',
        );
      }
      trace.attempts.push({ provider: 'gemini', model, status: 'network', ms });
      throw new TranslateError('通信に失敗しました。ネットワーク接続を確認してください。', 'network');
    } finally {
      clearTimeout(timer);
    }

    const ms = Date.now() - startedAt;
    trace.apiMs += ms;
    trace.attempts.push({ provider: 'gemini', model, status: outcome.status, ms, headersMs, serverMs });

    if (outcome.ok) {
      let data;
      try {
        data = JSON.parse(outcome.text);
      } catch {
        throw new TranslateError('Google の応答を解釈できませんでした。', 'other');
      }
      trace.model = model;
      const usage = data?.usageMetadata;
      if (usage) {
        trace.tokens.prompt += usage.promptTokenCount || 0;
        trace.tokens.output += usage.candidatesTokenCount || 0;
        trace.tokens.thoughts += usage.thoughtsTokenCount || 0; // モデルの「思考」に使われた量
      }
      return data;
    }

    const err = classifyHttpError(outcome.status, redact(outcome.text, apiKey), model);
    if (err.retry && attempt < MAX_RETRIES) {
      // 429 は Google が示した待ち時間のとおりに待つ。5xx だけ、回数に応じて間隔を延ばす。
      const wait = err.kind === 'server' ? err.delayMs * (attempt + 1) : err.delayMs;
      trace.waitedMs += wait;
      await sleep(wait);
      continue;
    }
    throw Object.assign(new TranslateError(err.message, err.kind), err.exhausted ? { exhausted: true } : {});
  }
}

// 「<<<n>>>」区切りの出力を断片ごとに分ける。取れなかった断片は null。
function parseSegments(output, count) {
  // モデルが出力全体を ``` で包んだ場合だけ、その囲みを外す（先頭に囲みがないのに末尾だけ削ると、訳文の一部を壊す）。
  let cleaned = output;
  const opening = /^```[\w-]*\n/.exec(cleaned);
  if (opening) cleaned = cleaned.slice(opening[0].length).replace(/\n```\s*$/, '');
  const results = new Array(count).fill(null);
  const re = /<<<(\d+)>>>[ \t]*\r?\n?([\s\S]*?)(?=<<<\d+>>>|$)/g;
  let found = 0;
  let m;
  while ((m = re.exec(cleaned))) {
    const i = Number(m[1]) - 1;
    if (i >= 0 && i < count) {
      results[i] = m[2].trim();
      found++;
    }
  }
  if (found === 0 && count === 1 && cleaned.trim()) results[0] = cleaned.trim();
  return results;
}

// 翻訳の依頼の本体（requestOnce と、設定画面の「応答速度の診断」で同じ内容を使う）。
// context: 参考情報（訳さない）。{ title, heading, before }。なければ、これまでと同じ形になる。
function buildTranslateRequest(texts, context = null) {
  const segments = texts.map((t, i) => `<<<${i + 1}>>>\n${t}`).join('\n');
  const lines = [];
  if (context?.title) lines.push(`ページのタイトル: ${context.title}`);
  if (context?.heading) lines.push(`直前の見出し: ${context.heading}`);
  if (context?.before) lines.push(`直前の文章: ${context.before}`);
  const userText = lines.length
    ? `【参考情報（訳さないでください。文脈を理解するためだけに使ってください）】\n${lines.join('\n')}\n\n` +
      `【翻訳する断片（これだけを、番号つきで訳してください）】\n${segments}`
    : segments;
  return {
    userText,
    body: {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { maxOutputTokens: 8192 },
    },
  };
}

// ctx: { provider: 'gemini' | 'chatgpt', apiKey, fast }。ChatGPT のトークンは、chatgpt.js が必要に応じて更新して使う。
async function requestOnce(texts, model, ctx, trace) {
  const { userText, body } = buildTranslateRequest(texts, ctx.context);
  const timeoutMs = Math.min(TIMEOUT.maxMs, TIMEOUT.baseMs + userText.length * TIMEOUT.perCharMs);

  if (ctx.provider === 'chatgpt') {
    const text = await ChatGPT.complete({ model, system: SYSTEM_PROMPT, userText, trace, timeoutMs, fast: ctx.fast });
    if (!text.trim()) throw new TranslateError('ChatGPT が翻訳結果を返しませんでした。', 'block');
    return parseSegments(text, texts.length);
  }

  const data = await callGemini(model, ctx.apiKey, body, trace, timeoutMs);
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('');
  if (!text) {
    const reason = data.promptFeedback?.blockReason || candidate?.finishReason || 'EMPTY';
    throw new TranslateError(`Gemini が翻訳結果を返しませんでした (${reason})。`, 'block');
  }
  return parseSegments(text, texts.length);
}

async function translateBatch(texts, model, ctx, trace) {
  let results;
  try {
    results = await requestOnce(texts, model, ctx, trace);
  } catch (err) {
    // 1 件のせいでまとめてブロックされた場合は半分に分けて、訳せる部分だけ救う。
    if (err.kind === 'block' && texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const [a, b] = await Promise.all([
        translateBatch(texts.slice(0, mid), model, ctx, trace).catch(() => new Array(mid).fill(null)),
        translateBatch(texts.slice(mid), model, ctx, trace).catch(() => new Array(texts.length - mid).fill(null)),
      ]);
      return [...a, ...b];
    }
    throw err;
  }

  // 取りこぼした断片だけ 1 回やり直す。
  const missing = results.flatMap((r, i) => (r ? [] : [i]));
  if (missing.length && missing.length < texts.length) {
    const retry = await requestOnce(missing.map((i) => texts[i]), model, ctx, trace).catch(() => []);
    missing.forEach((idx, k) => {
      if (retry[k]) results[idx] = retry[k];
    });
  }
  return results;
}

// ---- 上限に達したモデルの「しばらく試さない」記録（storage.session。ブラウザを閉じると消える）

let cooldownChain = Promise.resolve();

async function loadCooldowns() {
  const { cooldown } = await chrome.storage.session.get({ cooldown: {} });
  const now = Date.now();
  const live = {};
  for (const [key, until] of Object.entries(cooldown && typeof cooldown === 'object' ? cooldown : {})) {
    if (typeof until === 'number' && until > now) live[key] = until;
  }
  return live;
}

function markCooling(key) {
  const run = cooldownChain.then(async () => {
    const live = await loadCooldowns();
    live[key] = Date.now() + COOLDOWN_MS;
    await chrome.storage.session.set({ cooldown: live });
  });
  cooldownChain = run.catch(() => {});
  return run;
}

const providerName = (provider) => (provider === 'chatgpt' ? 'ChatGPT' : 'Gemini');

// 提供元ごとに、モデルを順に試す。使えなければ、併用がオンのときだけ、もう一方の提供元へ切り替える。
// stages: buildStages の結果（試す順）。
async function translateWithModels(texts, settings, stages, trace, context = null) {
  const usable = stages.filter((stage) => stage.models.length);
  if (!usable.length) {
    throw new TranslateError('モデルが選ばれていません。設定画面で、モデルを選んでください。', 'model');
  }

  // 1 日の上限に達したモデルは、しばらく試さない。ただし、すべての候補がそうなら、記録を無視して試す（試さずに失敗するよりよい）。
  const cooling = await loadCooldowns();
  const keyOf = (stage, model) => `${stage.provider}:${model}`;
  const isCooling = (stage, model) => cooling[keyOf(stage, model)] > Date.now();
  const allCooling = usable.every((stage) => stage.models.every((model) => isCooling(stage, model)));

  const stageErrors = []; // { provider, err }
  for (let i = 0; i < usable.length; i++) {
    const stage = usable[i];
    const models = allCooling ? stage.models : stage.models.filter((model) => !isCooling(stage, model));
    if (!models.length) continue;

    trace.provider = stage.provider;
    const ctx = { provider: stage.provider, apiKey: settings.apiKey, fast: settings.chatgptFast, context };
    let stageError = null;
    for (const model of models) {
      trace.tried.push(model);
      try {
        return await translateBatch(texts, model, ctx, trace);
      } catch (err) {
        stageError = err;
        if (err.exhausted) await markCooling(keyOf(stage, model));
        if (FALLBACK_KINDS.has(err.kind)) continue; // 同じ提供元の予備モデルで続ける
        break; // キーの無効など。同じ提供元の別モデルでは直らない
      }
    }
    if (!stageError) continue;
    stageErrors.push({ provider: stage.provider, err: stageError });
    // もう一方の提供元があり、切り替えて意味のある失敗なら、そちらへ。そうでなければ、ここで止める。
    if (!(i < usable.length - 1 && CROSS_KINDS.has(stageError.kind))) break;
  }

  if (!stageErrors.length) {
    throw new TranslateError('モデルが選ばれていません。設定画面で、モデルを選んでください。', 'model');
  }
  if (stageErrors.length === 1) throw stageErrors[0].err;
  // 両方の提供元が使えなかった。どちらも理由を伝える。
  const last = stageErrors[stageErrors.length - 1].err;
  const message = stageErrors.map(({ provider, err }) => `${providerName(provider)}: ${err.message}`).join('\n');
  throw new TranslateError(message, last.kind);
}

// 翻訳キャッシュは、翻訳を依頼したページのホスト名ごとに分ける。
// 悪意のあるページが文中の指示でモデルの出力を操作しても、その結果が別サイトの表示に混ざらないようにする。
function cacheScope(sender) {
  try {
    if (!sender?.tab?.url) return '';
    const u = new URL(sender.tab.url);
    // Web ページだけをキャッシュの対象にする（設定画面など、拡張機能自身のページは対象外）
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : '';
  } catch {
    return '';
  }
}

function newTrace() {
  return {
    provider: 'gemini', // 実際に使った提供元（translateWithModels が設定する）
    primary: 'gemini', // 利用者が選んだ（最初に試す）提供元。provider と違えば、併用で切り替えたことになる
    requests: 0, apiMs: 0, waitedMs: 0, tried: [], model: '', cached: 0,
    attempts: [], // 依頼ごとの {model, status, ms}
    tokens: { prompt: 0, output: 0, thoughts: 0 },
  };
}

// 翻訳を実行し、結果と「どこで時間を使ったか」の内訳（meta）を返す。
async function translateTexts(texts, options = {}) {
  const startedAt = Date.now();
  const trace = newTrace();
  const meta = () => ({
    provider: trace.provider, // 提供元（'gemini' または 'chatgpt'）
    primaryProvider: trace.primary, // 最初に試す提供元
    fellBack: trace.provider !== trace.primary, // 併用で、もう一方の提供元に切り替えた
    totalMs: Date.now() - startedAt, // 全体の所要時間
    apiMs: trace.apiMs, // 提供元（Google / OpenAI）の応答を待っていた時間
    waitedMs: trace.waitedMs, // 再試行のために、拡張機能が待機した時間
    requests: trace.requests, // 提供元への依頼回数
    tried: trace.tried, // 試したモデル
    model: trace.model, // 実際に成功したモデル
    cached: trace.cached, // キャッシュから返した件数
    attempts: trace.attempts, // 依頼ごとの結果と時間
    tokens: trace.tokens, // 入力・出力・思考に使われたトークン数
  });
  try {
    const results = await translateTextsInner(texts, options, trace);
    return { results, meta: meta() };
  } catch (err) {
    if (err && typeof err === 'object') err.meta = meta();
    throw err;
  }
}

async function translateTextsInner(texts, { noCache = false, scope = '', only = '', context = null } = {}, trace) {
  validateTexts(texts);
  const settings = await getSettings();
  trace.provider = only || settings.provider;
  trace.primary = trace.provider;
  const stages = await buildStages(settings, only);
  if (!stages.length) throw nokeyError(only || settings.provider);
  if (!settings.acknowledged) {
    throw new TranslateError(
      '初回の確認がまだ済んでいません。設定画面の注意事項を読み、「理解しました」にチェックを入れて保存してください。',
      'consent',
    );
  }
  const cache = settings.useCache && !noCache && scope ? await loadCache() : null;
  // ホスト名には改行が含まれないので、区切りに使える
  const keyOf = (text) => `${scope}\n${text}`;

  const results = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((text, i) => {
    const hit = cache?.get(keyOf(text));
    if (hit) results[i] = hit;
    else todo.push(i);
  });

  trace.cached = texts.length - todo.length;
  if (todo.length) {
    // 参考情報（文脈）も、API に送る文字数として数える
    const contextChars = context ? Object.values(context).reduce((sum, t) => sum + t.length, 0) : 0;
    await reserveBudget(todo.reduce((sum, i) => sum + texts[i].length, 0) + contextChars);
    const translated = await translateWithModels(todo.map((i) => texts[i]), settings, stages, trace, context);
    todo.forEach((idx, k) => {
      results[idx] = translated[k];
      if (cache && translated[k] && texts[idx].length <= CACHE_MAX_TEXT_LENGTH) cache.set(keyOf(texts[idx]), translated[k]);
    });
    if (cache) await saveCache(cache);
  }
  return results;
}

// ---------------------------------------------------------------- 応答速度の診断

// 設定画面の「応答速度を診断」。モデルごとに短い依頼を同時に送って応答時間を測り、
// 主モデルについては「拡張機能の翻訳依頼と同じ内容」も測る。
// 「どのモデルでも遅いのか」「依頼の内容だけが遅いのか」を切り分けるための機能。
async function probeModels(requestedModels) {
  const settings = await getSettings();
  if (!(await hasCredential(settings))) throw nokeyError(settings.provider);

  const models = [...new Set((Array.isArray(requestedModels) ? requestedModels : [])
    .filter((m) => typeof m === 'string' && MODEL_ID_PATTERN.test(m)))].slice(0, 4);
  if (!models.length) throw new TranslateError('診断するモデルがありません。', 'invalid');

  const quick = { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] };
  const jobs = models.map((model) => ({
    model, label: 'short', body: quick, userText: 'Reply with the single word: OK', system: 'Reply briefly.',
  }));
  // 拡張機能が実際に送る翻訳依頼と同じ内容（主モデルだけ）
  const sample = buildTranslateRequest(['Hello! This is a connection test for the translation extension.']);
  jobs.push({
    model: modelsOf(settings)[0] || models[0], label: 'same', body: sample.body, userText: sample.userText, system: SYSTEM_PROMPT,
  });
  await reserveBudget(jobs.length * 200);

  return Promise.all(jobs.map(async (job) => {
    const trace = newTrace();
    const startedAt = Date.now();
    let error = '';
    try {
      if (settings.provider === 'chatgpt') {
        await ChatGPT.complete({
          model: job.model, system: job.system, userText: job.userText, trace, timeoutMs: TIMEOUT.baseMs, fast: settings.chatgptFast,
        });
      } else {
        await callGemini(job.model, settings.apiKey, job.body, trace, TIMEOUT.baseMs);
      }
    } catch (err) {
      error = err instanceof TranslateError ? err.message : '予期しないエラーが発生しました。';
    }
    const last = trace.attempts[trace.attempts.length - 1];
    return {
      model: job.model,
      label: job.label,
      ok: !error,
      error,
      ms: Date.now() - startedAt,
      serverMs: last?.serverMs ?? null,
      firstTokenMs: last?.firstTokenMs ?? null,
      status: last?.status ?? null,
      waitedMs: trace.waitedMs,
    };
  }));
}

// ---------------------------------------------------------------- 利用できるモデルの一覧

const EXCLUDED_MODEL_ID = /tts|image|embedding|live|audio|native|robotics|computer|imagen|veo|latest|-\d{3}$|-\d{2}-\d{2,4}$|-\d{8}$/;

function modelTier(id) {
  if (/flash-lite/.test(id)) return 1;
  if (/flash/.test(id)) return 0;
  if (/pro/.test(id)) return 2;
  return 3;
}

// Models API の生データから、文章の翻訳に使える Gemini モデルだけを新しい順に並べる。
function pickTextModels(rawModels) {
  const seen = new Set();
  const picked = [];
  for (const m of rawModels) {
    const id = String(m.name || '').replace(/^models\//, '');
    if (!/^gemini-/.test(id) || seen.has(id)) continue;
    if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
    if (EXCLUDED_MODEL_ID.test(id)) continue;
    const version = parseFloat((/^gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1]);
    if (!(version >= 2.5)) continue; // それ以前は提供終了が近いので出さない
    seen.add(id);
    picked.push({ id, displayName: m.displayName || id, version, tier: modelTier(id) });
  }
  picked.sort((a, b) => b.version - a.version || a.tier - b.tier || a.id.localeCompare(b.id));
  return picked.map(({ id, displayName }) => ({ id, displayName }));
}

async function listModels() {
  const settings = await getSettings();
  if (settings.provider === 'chatgpt') {
    if (!(await ChatGPT.status()).signedIn) throw nokeyError('chatgpt');
    return ChatGPT.listModels(); // アカウントが使えるモデル（サーバーの順序のまま）
  }
  const { apiKey } = settings;
  if (!apiKey) throw nokeyError('gemini');
  const raw = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const url = `${MODELS_URL}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    let res;
    try {
      res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
    } catch {
      throw new TranslateError('通信に失敗しました。ネットワーク接続を確認してください。', 'network');
    }
    if (!res.ok) {
      const err = classifyHttpError(res.status, redact(await res.text(), apiKey), '');
      throw new TranslateError(err.message, err.kind);
    }
    const data = await res.json();
    raw.push(...(data.models || []));
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return pickTextModels(raw);
}

// ---------------------------------------------------------------- 右クリックメニュー・アイコン

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: '選択範囲を日本語に翻訳',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'translate-page',
      title: 'このページを日本語に翻訳 / 元に戻す',
      contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio'],
    });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

async function flashBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 3000);
  } catch { /* タブが閉じられた場合など */ }
}

async function dispatch(tabId, message) {
  const settings = await getSettings();
  // 選んだ提供元、または（併用がオンなら）もう一方のどちらかが使える状態ならよい
  if (!settings.acknowledged || !(await buildStages(settings)).length) {
    chrome.runtime.openOptionsPage();
    return;
  }
  try {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    }
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // chrome:// ページや Chrome ウェブストアなど、拡張機能が動けないページ
    await flashBadge(tabId, '×');
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'translate-page') {
    dispatch(tab.id, { type: 'toggle-page' });
  } else if (info.menuItemId === 'translate-selection') {
    dispatch(tab.id, { type: 'translate-selection', text: info.selectionText || '' });
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) dispatch(tab.id, { type: 'toggle-page' });
});

// ---------------------------------------------------------------- コンテンツスクリプト・設定画面からの依頼

// 呼び出し元の確認。ページの JavaScript は chrome.runtime.sendMessage でこの拡張機能を呼べない
// （externally_connectable を宣言していない）が、念のため送信元も確認する。
const isOwnExtension = (sender) => !!sender && sender.id === chrome.runtime.id;
// 設定画面は「タブ」として開かれるため、sender.tab は付く。区別は「送信元ページの URL が拡張機能自身のものか」で行う
// （ページに差し込んだスクリプトの sender.url は、そのページの URL になる）。
const isExtensionPage = (sender) =>
  isOwnExtension(sender) && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

function errorResponse(err) {
  const meta = err?.meta;
  if (err instanceof TranslateError) return { ok: false, error: err.message, kind: err.kind, meta };
  return { ok: false, error: '予期しないエラーが発生しました。', kind: 'other', meta };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isOwnExtension(sender)) return false;

  // 翻訳の依頼: ページに差し込んだ content.js と、設定画面（接続テスト）から受け付ける。
  if (msg?.type === 'translate') {
    // only（1 つの提供元だけで試す）は、設定画面の「接続テスト」だけが指定できる
    const only = isExtensionPage(sender) && (msg.only === 'gemini' || msg.only === 'chatgpt') ? msg.only : '';
    translateTexts(msg.texts, { noCache: !!msg.noCache, scope: cacheScope(sender), only, context: sanitizeContext(msg.context) }).then(
      ({ results, meta }) => sendResponse({ ok: true, results, meta }),
      (err) => sendResponse(errorResponse(err)),
    );
    return true;
  }
  // 以下は設定画面だけが呼べる。ページに差し込んだスクリプトからは受け付けない。
  if (msg?.type === 'list-models' && isExtensionPage(sender)) {
    listModels().then(
      (models) => sendResponse({ ok: true, models }),
      (err) => sendResponse(errorResponse(err)),
    );
    return true;
  }
  if (msg?.type === 'probe' && isExtensionPage(sender)) {
    probeModels(msg.models).then(
      (results) => sendResponse({ ok: true, results }),
      (err) => sendResponse(errorResponse(err)),
    );
    return true;
  }
  if (msg?.type === 'clear-cache' && isExtensionPage(sender)) {
    clearCache().then(() => sendResponse({ ok: true }));
    return true;
  }

  // ChatGPT のプランでのサインイン（設定画面だけ）。結果は、戻り先の検知のあとに、保存領域の変化で伝わる。
  if (isExtensionPage(sender) && msg && typeof msg.type === 'string' && msg.type.startsWith('chatgpt-')) {
    const actions = {
      'chatgpt-status': () => ChatGPT.status(),
      'chatgpt-sign-in': async () => {
        await ChatGPT.startSignIn();
        return ChatGPT.status();
      },
      'chatgpt-cancel': async () => {
        await ChatGPT.cancelSignIn();
        return ChatGPT.status();
      },
      'chatgpt-sign-out': async () => {
        await ChatGPT.signOut();
        return ChatGPT.status();
      },
    };
    const action = actions[msg.type];
    if (!action) return false;
    action().then(
      (status) => sendResponse({ ok: true, status }),
      (err) => sendResponse(errorResponse(err)),
    );
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- ChatGPT サインインの戻り先の検知

// 公式の戻り先は 127.0.0.1 の HTTP ループバック。拡張機能は待ち受けを持たないので、
// そこへの移動（リクエスト）を観測して、code などを取り出す。観測だけで、通信の内容は変更しない。
// 裏方が眠っている間にログインが進んでも、このイベントで起こされる（待ち受け状態は保存領域にある）。
chrome.webRequest?.onBeforeRequest?.addListener(
  (details) => {
    if (ChatGPT.isCallbackUrl(details.url)) onChatGptCallback(details.url, details.tabId);
  },
  { urls: [`${ChatGPT.REDIRECT_URI}*`], types: ['main_frame'] },
);

async function onChatGptCallback(url, tabId) {
  const result = await ChatGPT.onCallback(url, tabId);
  if (!(result.handled && result.ok)) return;
  // サインインできたら、使えるモデルの一覧を取得して、モデルが未選択なら、翻訳向きのものを選ぶ
  try {
    const models = await ChatGPT.listModels();
    await chrome.storage.local.set({ chatgptModelList: models.map((m) => m.id) });
    const { chatgptModel } = await chrome.storage.local.get({ chatgptModel: '' });
    if (!chatgptModel && models.length) {
      await chrome.storage.local.set({ chatgptModel: ChatGPT.pickDefaultModel(models) });
    }
  } catch { /* 一覧は、設定画面の「モデル一覧を更新」でも取得できる */ }
}
