'use strict';

const DEFAULTS = {
  provider: 'gemini',
  apiKey: '',
  model: 'gemini-3.5-flash-lite',
  fallbackModel: 'gemini-3.8-flash',
  chatgptModel: '',
  chatgptFallbackModel: '',
  crossFallback: false,
  chatgptFast: true,
  useCache: true,
  rememberKey: true,
  acknowledged: false,
};

// Google から一覧を取得できないとき（キー未設定・オフライン）に出す候補
const GEMINI_FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];
// 翻訳には、小さく速いモデルで十分。名前から、そう思われるもの（chatgpt.js の pickDefaultModel と同じ基準）
const SMALL_MODEL = /(^|[-_.])(luna|mini|nano|lite|small|fast|spark)([-_.]|$)/i;
const CUSTOM = '__custom__';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const fields = {
  model: { select: $('model'), custom: $('modelCustom') },
  fallbackModel: { select: $('fallbackModel'), custom: $('fallbackCustom') },
};

let provider = 'gemini';
// 提供元ごとに、選んだモデルと候補の一覧を持つ（切り替えても、それぞれの選択を保つ）
const chosen = { gemini: { model: '', fallback: '' }, chatgpt: { model: '', fallback: '' } };
const lists = { gemini: GEMINI_FALLBACK_MODELS, chatgpt: [] };
const fetched = { gemini: false, chatgpt: false };
let chatgptStatus = { signedIn: false, pending: false, email: '', hasPlanScope: false, last: null };

const who = (p = provider) => (p === 'chatgpt' ? 'ChatGPT' : 'Google');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function describe(id) {
  if (provider === 'chatgpt') return SMALL_MODEL.test(id) ? '軽量・低コスト' : '';
  if (/flash-lite/.test(id)) return '軽量・低コスト';
  if (/flash/.test(id)) return '標準・高品質';
  if (/pro/.test(id)) return '高性能（無料枠がない場合あり）';
  return '';
}

function fillSelect({ select, custom }, value, ids, noneLabel) {
  select.replaceChildren();
  if (noneLabel) select.append(new Option(noneLabel, ''));
  const all = [...ids];
  if (value && !all.includes(value)) all.unshift(value); // 保存済みの値が一覧になくても選べるように
  for (const id of all) {
    const note = describe(id);
    select.append(new Option(note ? `${id}　${note}` : id, id));
  }
  select.append(new Option('その他（モデル名を手入力）', CUSTOM));
  select.value = value;
  custom.hidden = true;
}

function readValue({ select, custom }) {
  return select.value === CUSTOM ? custom.value.trim() : select.value;
}

// いま画面に出ている選択を、提供元ごとの記憶に書き戻す
function commitSelections() {
  chosen[provider] = { model: readValue(fields.model), fallback: readValue(fields.fallbackModel) };
}

function renderModels() {
  const ids = lists[provider];
  fillSelect(fields.model, chosen[provider].model, ids, provider === 'chatgpt' ? '（未選択）' : '');
  fillSelect(fields.fallbackModel, chosen[provider].fallback, ids, '（予備モデルを使わない）');
}

function updateModelNote(extra = '') {
  let text;
  if (provider === 'gemini') {
    text = fetched.gemini
      ? `Google から取得した ${lists.gemini.length} 件を表示中`
      : '既定の候補を表示中（キーを保存して「モデル一覧を更新」で最新を取得できます）';
  } else if (!chatgptStatus.signedIn) {
    text = 'サインインすると、ご契約のプランで使えるモデルの一覧が表示されます';
  } else if (fetched.chatgpt) {
    text = `ChatGPT のアカウントで使える ${lists.chatgpt.length} 件を表示中`;
  } else {
    text = '「モデル一覧を更新」で、使えるモデルを取得できます';
  }
  $('modelNote').textContent = text + extra;
}

// 「もう一方の AI に切り替える」（併用）の説明と、切り替え先の準備ができているかの表示
function updateCross() {
  const other = provider === 'chatgpt' ? 'gemini' : 'chatgpt';
  $('crossLabel').textContent = provider === 'chatgpt'
    ? 'ChatGPT が上限・エラーのときは、Gemini API に切り替える'
    : 'Gemini が上限・エラーのときは、ChatGPT のプランに切り替える';
  let text;
  let kind;
  if (other === 'chatgpt') {
    if (!chatgptStatus.signedIn) {
      text = '切り替え先の ChatGPT: まだサインインしていません。上の「使う AI」を「ChatGPT のプラン」にしてサインインしてください（設定は両方とも保存されます）。';
      kind = 'warn';
    } else if (!chosen.chatgpt.model && !lists.chatgpt.length) {
      text = '切り替え先の ChatGPT: サインイン済みですが、モデルが選ばれていません。上の「使う AI」を「ChatGPT のプラン」にして、モデルを選んでください。';
      kind = 'warn';
    } else {
      text = `切り替え先の ChatGPT: サインイン済み（モデル: ${chosen.chatgpt.model || '自動で選びます'}）`;
      kind = 'ok';
    }
  } else if (!$('apiKey').value.trim()) {
    text = '切り替え先の Gemini: APIキーが未入力です。上の「使う AI」を「Gemini API」にして入力してください（設定は両方とも保存されます）。';
    kind = 'warn';
  } else {
    text = `切り替え先の Gemini: APIキーが入力済みです（モデル: ${chosen.gemini.model || DEFAULTS.model}）`;
    kind = 'ok';
  }
  const note = $('crossNote');
  note.textContent = text;
  note.className = `hint block ${kind}`;
}

// 選んだ提供元に合わせて、画面の出し分けをする
function applyProvider() {
  const isChatgpt = provider === 'chatgpt';
  $('geminiSection').hidden = isChatgpt;
  $('chatgptSection').hidden = !isChatgpt;
  $('geminiHelp').hidden = isChatgpt;
  $('chatgptHelp').hidden = !isChatgpt;
  $('deleteKey').hidden = isChatgpt;
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== provider;
  $('modelHint').textContent = isChatgpt
    ? 'サインインしたアカウントで使えるモデルです。翻訳には、名前に mini などが付く、軽量で速いモデルが向いています。'
    : '新しい順に並んでいます。無料枠の回数制限はモデルごとに別なので、AI Studio の「Rate limits」で確認できます。';
  fields.model.custom.placeholder = isChatgpt ? 'モデル名を入力' : 'モデル名を入力（例: gemini-3.8-flash）';
  fields.fallbackModel.custom.placeholder = isChatgpt ? 'モデル名を入力' : 'モデル名を入力（例: gemini-2.5-flash-lite）';
  renderModels();
  updateModelNote();
  updateCross();
}

$('apiKey').addEventListener('input', updateCross);

for (const f of Object.values(fields)) {
  f.select.addEventListener('change', () => {
    f.custom.hidden = f.select.value !== CUSTOM;
    if (!f.custom.hidden) f.custom.focus();
  });
}

for (const radio of document.querySelectorAll('input[name="provider"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    commitSelections();
    provider = radio.value === 'chatgpt' ? 'chatgpt' : 'gemini';
    applyProvider();
    setStatus('');
    if (provider === 'chatgpt') refreshChatgptStatus();
  });
}

// ---------------------------------------------------------------- ChatGPT のサインイン

function renderChatgpt() {
  const st = chatgptStatus;
  const stateEl = $('chatgptState');
  stateEl.className = 'state';
  if (st.signedIn) {
    stateEl.textContent = st.hasPlanScope
      ? `サインイン済み${st.email ? `: ${st.email}` : ''}`
      : 'サインインしていますが、プランの利用枠を使う権限がありません。サインインし直してください。';
    stateEl.classList.add(st.hasPlanScope ? 'ok' : 'wait');
  } else if (st.pending) {
    stateEl.textContent = 'サインイン待ち: 開いたタブで、ログインして承認してください。完了すると、自動でここに反映されます。';
    stateEl.classList.add('wait');
  } else {
    stateEl.textContent = '未サインイン';
  }

  const message = $('chatgptMessage');
  const last = st.last;
  if (last && last.message && !st.pending && !(st.signedIn && last.ok)) {
    message.textContent = last.message;
    message.className = last.ok ? 'hint' : 'hint err';
  } else {
    message.textContent = '';
    message.className = 'hint';
  }

  $('chatgptSignIn').textContent = st.signedIn ? 'ChatGPT でサインインし直す' : 'ChatGPT でサインイン';
  $('chatgptSignIn').hidden = st.pending;
  $('chatgptCancel').hidden = !st.pending;
  $('chatgptSignOut').hidden = !st.signedIn;
  if (provider === 'chatgpt') updateModelNote();
  updateCross();
}

async function refreshChatgptStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'chatgpt-status' });
    if (resp?.ok && resp.status) chatgptStatus = resp.status;
  } catch { /* 裏方が起動中などの場合。次の変化で更新される */ }
  renderChatgpt();
}

async function chatgptAction(type) {
  setStatus('');
  const resp = await chrome.runtime.sendMessage({ type });
  if (resp?.ok && resp.status) {
    chatgptStatus = resp.status;
    renderChatgpt();
  } else {
    setStatus(resp?.error || '応答がありません。', 'err');
  }
}

$('chatgptSignIn').addEventListener('click', async () => {
  await save(); // 「ChatGPT を使う」という選択を、先に保存する
  await chatgptAction('chatgpt-sign-in');
});
$('chatgptCancel').addEventListener('click', () => chatgptAction('chatgpt-cancel'));
$('chatgptSignOut').addEventListener('click', async () => {
  await chatgptAction('chatgpt-sign-out');
  lists.chatgpt = [];
  fetched.chatgpt = false;
  await chrome.storage.local.remove('chatgptModelList');
  if (provider === 'chatgpt') {
    renderModels();
    updateModelNote();
  }
  setStatus('サインアウトしました。このブラウザには、もうサインイン情報が残っていません。', 'ok');
});

// 裏方がサインインを完了したときや、モデルの既定値を入れたときに、画面へ反映する
chrome.storage.onChanged.addListener((changes, area) => {
  if (changes.chatgptAuth || changes.chatgptPending || changes.chatgptLast) refreshChatgptStatus();
  if (area !== 'local' || !(changes.chatgptModelList || changes.chatgptModel)) return;
  commitSelections();
  const list = changes.chatgptModelList?.newValue;
  if (Array.isArray(list) && list.length) {
    lists.chatgpt = list;
    fetched.chatgpt = true;
  }
  const model = changes.chatgptModel?.newValue;
  if (model && !chosen.chatgpt.model) chosen.chatgpt.model = model; // 自分で選んだ値は、上書きしない
  if (provider === 'chatgpt') {
    renderModels();
    updateModelNote();
  }
});

// ---------------------------------------------------------------- 読み込み・保存

async function load() {
  const s = await chrome.storage.local.get({ ...DEFAULTS, modelList: null, chatgptModelList: null });
  provider = s.provider === 'chatgpt' ? 'chatgpt' : 'gemini';
  if (Array.isArray(s.modelList) && s.modelList.length) {
    lists.gemini = s.modelList;
    fetched.gemini = true;
  }
  if (Array.isArray(s.chatgptModelList) && s.chatgptModelList.length) {
    lists.chatgpt = s.chatgptModelList;
    fetched.chatgpt = true;
  }
  chosen.gemini = { model: s.model, fallback: s.fallbackModel };
  chosen.chatgpt = { model: s.chatgptModel, fallback: s.chatgptFallbackModel };
  // 「ブラウザを閉じたら忘れる」モードのキーは storage.session にある
  const apiKey = s.rememberKey ? s.apiKey : (await chrome.storage.session.get({ apiKey: '' })).apiKey;
  $('apiKey').value = apiKey;
  $('rememberKey').checked = s.rememberKey;
  $('acknowledged').checked = s.acknowledged;
  $('useCache').checked = s.useCache;
  $('crossFallback').checked = s.crossFallback === true;
  $('chatgptFast').checked = s.chatgptFast !== false;
  $(provider === 'chatgpt' ? 'providerChatgpt' : 'providerGemini').checked = true;
  await refreshChatgptStatus();
  applyProvider();
  if (provider === 'gemini' && apiKey) refreshModels({ saveFirst: false, quiet: true });
  if (provider === 'chatgpt' && chatgptStatus.signedIn) refreshModels({ saveFirst: false, quiet: true });
}

async function save() {
  commitSelections();
  const apiKey = $('apiKey').value.trim();
  const remember = $('rememberKey').checked;
  await chrome.storage.local.set({
    provider,
    // 「忘れる」モードでは、キーをディスク上の保存領域に書かない
    apiKey: remember ? apiKey : '',
    rememberKey: remember,
    acknowledged: $('acknowledged').checked,
    model: chosen.gemini.model || DEFAULTS.model,
    fallbackModel: chosen.gemini.fallback,
    chatgptModel: chosen.chatgpt.model,
    chatgptFallbackModel: chosen.chatgpt.fallback,
    crossFallback: $('crossFallback').checked,
    chatgptFast: $('chatgptFast').checked,
    useCache: $('useCache').checked,
  });
  if (remember) await chrome.storage.session.remove('apiKey');
  else await chrome.storage.session.set({ apiKey });

  // ChatGPT のサインイン情報も、キーと同じ保存先に合わせる（「忘れる」に切り替えたら、ディスクから移す）
  const from = remember ? chrome.storage.session : chrome.storage.local;
  const to = remember ? chrome.storage.local : chrome.storage.session;
  const { chatgptAuth } = await from.get('chatgptAuth');
  if (chatgptAuth) {
    await to.set({ chatgptAuth });
    await from.remove('chatgptAuth');
  }
}

// 提供元を使える状態か。使えないときは、案内の文を返す
function credentialProblem() {
  if (provider === 'chatgpt') return chatgptStatus.signedIn ? '' : '先に ChatGPT にサインインしてください。';
  return $('apiKey').value.trim() ? '' : 'APIキーを入力してください。';
}

async function refreshModels({ saveFirst, quiet }) {
  const target = provider;
  const problem = credentialProblem();
  if (problem) {
    if (!quiet) setStatus(target === 'gemini' ? '先に APIキーを入力してください。' : problem, 'err');
    return;
  }
  const button = $('refreshModels');
  button.disabled = true;
  $('modelNote').textContent = '取得中…';
  try {
    if (saveFirst) await save(); // 一覧の取得は、保存済みのキー・サインインを使う
    const resp = await chrome.runtime.sendMessage({ type: 'list-models' });
    if (resp?.ok && resp.models.length) {
      commitSelections();
      lists[target] = resp.models.map((m) => m.id);
      fetched[target] = true;
      await chrome.storage.local.set({ [target === 'chatgpt' ? 'chatgptModelList' : 'modelList']: lists[target] });
      if (target !== provider) return; // 取得中に、提供元を切り替えた
      renderModels();
      const unavailable = [chosen[target].model, chosen[target].fallback].filter((m) => m && !lists[target].includes(m));
      updateModelNote(unavailable.length
        ? `（注意: 選択中の ${unavailable.join('、')} は、このアカウントの一覧にありません。使えない可能性があります）`
        : '');
    } else if (resp?.ok) {
      $('modelNote').textContent = '使えるモデルが見つかりませんでした（既定の候補を表示中）';
    } else {
      $('modelNote').textContent = `一覧を取得できませんでした: ${resp?.error || '応答がありません。'}`;
    }
  } finally {
    button.disabled = false;
  }
}

$('save').addEventListener('click', async () => {
  await save();
  if (!$('acknowledged').checked) setStatus('保存しました。翻訳を使うには「上記を理解しました」にチェックを入れて、もう一度保存してください。', 'err');
  else if (provider === 'chatgpt' && !chatgptStatus.signedIn) setStatus('保存しました。翻訳を使うには、ChatGPT にサインインしてください。', 'err');
  else if (provider === 'chatgpt' && !chosen.chatgpt.model) setStatus('保存しました。翻訳を使うには、モデルを選んでください。', 'err');
  else setStatus('保存しました。', 'ok');
});

$('refreshModels').addEventListener('click', () => refreshModels({ saveFirst: true, quiet: false }));

$('test').addEventListener('click', async () => {
  await save();
  const problem = credentialProblem();
  if (problem) {
    setStatus(problem, 'err');
    return;
  }
  const startedAt = Date.now();
  const tick = () => setStatus(`テスト中… ${Math.floor((Date.now() - startedAt) / 1000)} 秒経過`);
  tick();
  const timer = setInterval(tick, 500);
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'translate',
      noCache: true,
      only: provider, // 併用がオンでも、いま表示している AI だけを確かめる（切り替え先に隠れて、成功に見えないように）
      texts: ['Hello! This is a connection test for the translation extension.'],
    });
  } finally {
    clearInterval(timer);
  }
  const detail = describeTiming(resp?.meta, Date.now() - startedAt);
  if (resp?.ok && resp.results[0]) setStatus(`成功しました:\n${resp.results[0]}\n\n${detail}`, 'ok');
  else setStatus(`失敗しました:\n${resp?.error || '応答がありません。'}\n\n${detail}`, 'err');
});

// 接続テストの所要時間の内訳。「相手側が遅いのか、拡張機能側の待機なのか」を判断するための情報。
function describeTiming(meta, measuredMs) {
  const sec = (ms) => `${(ms / 1000).toFixed(1)} 秒`;
  if (!meta) return `所要時間: ${sec(measuredMs)}`;
  const w = who(meta.provider);
  const attemptLabel = (s) => (s === 'timeout' ? 'タイムアウト' : s === 'network' ? '通信失敗' : s === 200 ? '成功' : `HTTP ${s}`);
  const providerLabel = (p) => (p === 'chatgpt' ? 'ChatGPT' : 'Gemini');
  const lines = [
    `所要時間: ${sec(meta.totalMs)}（${w} の応答待ち ${sec(meta.apiMs)} ／ 再試行のための待機 ${sec(meta.waitedMs)}）`,
    `${w} への依頼: ${meta.requests} 回 ／ モデル: ${meta.model || '（成功なし）'}`,
  ];
  if (meta.attempts?.length) {
    const one = (a, i) => {
      const parts = [sec(a.ms)];
      if (a.serverMs != null) parts.push(`うち Google サーバー処理 ${sec(a.serverMs)}`);
      // ChatGPT: 依頼してから、応答の頭・最初の文字が届くまで（「待ち」と「文字の生成」を見分ける手がかり）
      if (a.headersMs != null && a.provider === 'chatgpt') parts.push(`応答の頭まで ${sec(a.headersMs)}`);
      if (a.firstTokenMs != null) parts.push(`最初の文字まで ${sec(a.firstTokenMs)}`);
      const name = `${a.provider ? `${providerLabel(a.provider)} ` : ''}${a.model}`;
      return `${i + 1} 回目 ${name} → ${attemptLabel(a.status)}（${parts.join('、')}）`;
    };
    lines.push(`依頼ごとの結果: ${meta.attempts.map(one).join(' ／ ')}`);
  }
  if (meta.fellBack) {
    lines.push(`→ ${who(meta.primaryProvider)} が使えなかったため、${w} に切り替えて翻訳しました（併用）。`);
  }
  const t = meta.tokens;
  if (t && (t.prompt || t.output || t.thoughts)) {
    lines.push(`トークン数: 入力 ${t.prompt} ／ 出力 ${t.output} ／ 思考 ${t.thoughts}`);
  }

  const timedOut = meta.attempts?.some((a) => a.status === 'timeout');
  if (timedOut) {
    lines.push(`→ ${w} の応答が遅かったため、待つのをやめて別のモデルに切り替えました。`);
  } else if (meta.waitedMs >= 1000) {
    lines.push(`→ ${meta.provider === 'chatgpt' ? '利用枠の回数制限' : '無料枠の回数制限'}やサーバーの一時的なエラーのため、再試行の待機が発生していました。`);
  } else if (meta.apiMs >= 8000) {
    const last = meta.attempts?.[meta.attempts.length - 1];
    if (t && t.thoughts >= 300) {
      lines.push(meta.provider === 'chatgpt'
        ? '→ モデルの「思考」に時間を使っています（思考のトークン数が多い）。名前に mini などが付く、軽量なモデルで速くなることがあります。'
        : '→ モデルの「思考」に時間を使っています（思考のトークン数が多い）。思考の少ない Flash-Lite 系のモデルで速くなることがあります。');
    } else if (last?.serverMs != null && last.serverMs >= last.ms * 0.8) {
      lines.push('→ 時間の大半は、Google のサーバー内での待ち・処理です（混雑など）。思考のトークン数は多くないため、モデルの思考は原因ではありません。拡張機能やネットワークの問題ではありません。');
    } else if (last?.serverMs != null) {
      lines.push(`→ Google のサーバー処理は ${sec(last.serverMs)} と短いのに、全体では ${sec(last.ms)} かかっています。Google の手前（ブラウザ・ネットワーク・セキュリティソフト等）の経路に原因がある可能性があります。`);
    } else if (meta.provider === 'chatgpt' && last?.firstTokenMs != null && last.firstTokenMs >= last.ms * 0.7) {
      lines.push(`→ 最初の文字が出るまでの待ち（${sec(last.firstTokenMs)}）が大半です。モデルが考えている、または混雑している時間で、拡張機能やネットワークの問題ではありません。「速さを優先する」がオンか、より軽量なモデルがないかを確認してください。`);
    } else if (meta.provider === 'chatgpt' && last?.firstTokenMs != null) {
      lines.push(`→ 最初の文字は ${sec(last.firstTokenMs)} で届いており、残りは文章の生成に時間がかかっています（出力が長い）。`);
    } else {
      lines.push(`→ ${w} の応答待ちに時間がかかっています（混雑など）。思考のトークン数は多くないため、モデルの思考は原因ではありません。`);
    }
  } else {
    lines.push('→ 正常です。待機や再試行はありませんでした。');
  }
  return lines.join('\n');
}

// 応答速度の診断。複数のモデルに短い依頼を同時に送り、「どのモデルが速いか」「依頼内容だけが遅いのか」を調べる。
$('probe').addEventListener('click', async () => {
  await save();
  const problem = credentialProblem();
  if (problem) {
    setStatus(problem, 'err');
    return;
  }
  const target = provider;
  const primary = readValue(fields.model);
  const backup = readValue(fields.fallbackModel);
  // 主モデル・予備モデルに、一覧にある軽量系を優先して足し、最大 4 つ測る
  const isSmall = (id) => (target === 'chatgpt' ? SMALL_MODEL.test(id) : /flash-lite/.test(id));
  const others = [...lists[target]].sort((a, b) => Number(isSmall(b)) - Number(isSmall(a)));
  const models = [...new Set([primary, backup, ...others].filter(Boolean))].slice(0, 4);
  if (!models.length) {
    setStatus('診断するモデルがありません。先にモデルを選んでください。', 'err');
    return;
  }

  const startedAt = Date.now();
  const tick = () => setStatus(`診断中… ${Math.floor((Date.now() - startedAt) / 1000)} 秒経過（最大 2〜3 分かかります）\n対象: ${models.join(' ／ ')}`);
  tick();
  const timer = setInterval(tick, 500);
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'probe', models });
  } finally {
    clearInterval(timer);
  }
  if (resp?.ok) setStatus(describeProbe(resp.results, primary, target), 'ok');
  else setStatus(`診断に失敗しました:\n${resp?.error || '応答がありません。'}`, 'err');
});

function describeProbe(results, primary, target) {
  const sec = (ms) => `${(ms / 1000).toFixed(1)} 秒`;
  const FAST_MS = 10000;
  const w = who(target);
  const kind = (r) => (r.label === 'same' ? '拡張機能の翻訳依頼と同じ内容' : '短い依頼');
  const lines = ['応答速度の診断結果（同時に測定）:'];
  for (const r of results) {
    const timing = `全体 ${sec(r.ms)}${r.serverMs != null ? ` ／ Google サーバー処理 ${sec(r.serverMs)}` : ''}${r.firstTokenMs != null ? ` ／ 最初の文字まで ${sec(r.firstTokenMs)}` : ''}`;
    lines.push(`  ${r.model} ／ ${kind(r)} → ${r.ok ? '成功' : `失敗（${r.error}）`} ／ ${timing}`);
  }
  lines.push('');

  const shorts = results.filter((r) => r.label === 'short' && r.ok);
  const same = results.find((r) => r.label === 'same');
  const fast = shorts.filter((r) => r.ms < FAST_MS).sort((a, b) => a.ms - b.ms);
  const primaryShort = shorts.find((r) => r.model === primary);

  if (!shorts.length) {
    lines.push('→ すべて失敗しました。上のエラー内容を確認してください。');
  } else if (!fast.length) {
    lines.push(`→ どのモデルも 10 秒以上かかっています。${w} 側の全体的な混雑の可能性が高く、拡張機能では改善できません。時間を置いて試してください。`);
  } else if (primaryShort && primaryShort.ms >= FAST_MS) {
    lines.push(`→ 速いモデルがあります: ${fast[0].model}（${sec(fast[0].ms)}）。主モデルをこれに変えると改善する見込みです。`);
  } else {
    lines.push('→ 主モデルは短い依頼には速く応答しています。');
    if (same && same.ok && same.ms >= FAST_MS) {
      lines.push('   ただし、拡張機能の翻訳依頼と同じ内容だけが遅くなっています。依頼内容に起因する可能性があります。');
    }
  }
  return lines.join('\n');
}

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-cache' });
  setStatus('キャッシュを削除しました。', 'ok');
});

$('deleteKey').addEventListener('click', async () => {
  $('apiKey').value = '';
  await chrome.storage.local.set({ apiKey: '' });
  await chrome.storage.session.remove('apiKey');
  setStatus('APIキーを削除しました。このブラウザには、もうキーが残っていません。', 'ok');
});

load();
