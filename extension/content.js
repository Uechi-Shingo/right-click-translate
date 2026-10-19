(() => {
  'use strict';
  if (globalThis.__jaTranslatorLoaded) return;
  globalThis.__jaTranslatorLoaded = true;

  const HOST_ID = 'ja-translator-host';
  const SKIP_SELECTOR =
    'script,style,noscript,template,textarea,code,pre,kbd,samp,svg,math,' +
    '[translate="no"],.notranslate,[contenteditable=""],[contenteditable="true"]';
  const CHUNK_CHARS = 4500; // 1 リクエストにまとめる最大文字数（無料枠はリクエスト数が貴重）
  const CHUNK_SEGMENTS = 80;
  // 段落の途中で上限に達したとき、手前の段落の境目まで戻してよい下限（上限に対する割合）。小さな依頼が増えて、依頼回数が増えすぎないようにする。
  const MIN_FILL = 0.5;
  // 翻訳の依頼に添える「文脈」（参考情報。訳さない）の長さの上限。裏方でも同じ上限で検査される。
  const CONTEXT_CHARS = { title: 200, heading: 200, before: 300 };
  // 段落（まとまり）として扱う要素。文字ノードが、どの段落に属するかを決めるために使う。
  const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'DT', 'DD', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'SUMMARY',
    'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM', 'FIELDSET', 'LEGEND',
    'UL', 'OL', 'DL', 'TR', 'TABLE', 'PRE', 'BODY',
  ]);
  const HEADING_TAG = /^H[1-6]$/;
  const MAX_INFLIGHT = 2;
  // 1 回の翻訳開始で送る文字数の上限。悪意のあるページが文字を生成し続けて、
  // 利用枠を使い切ろうとする（暴走する）のを防ぐ。「再試行」で続きを翻訳できる。
  const MAX_CHARS_PER_RUN = 150000;
  // 1 つの文字ノード（タグで区切られた 1 かたまりの文字）の最大文字数。裏方の上限（20,000）より余裕をもたせる。
  const MAX_NODE_CHARS = 15000;

  // ---------------------------------------------------------------- 状態

  const translated = new Map(); // Text -> { orig, tr }
  const groups = new Map(); // Element -> Set<Text>  画面に入るのを待っているテキスト
  const pending = new Set(); // 画面に入った（翻訳対象になった）Text
  const memo = new Map(); // 原文 -> 訳文（このページ内での重複排除）
  const chunkQueue = [];
  let inflight = 0;
  let state = 'idle'; // 'idle' | 'running' | 'error'
  let active = false;
  let total = 0;
  let done = 0;
  let sentChars = 0;
  let io = null;
  let mo = null;
  let flushTimer = 0;
  // 翻訳に使われたモデル（右下の枠に表示する）。キー: 提供元 + モデル名
  const engines = new Map();
  let usedSaved = false; // 保存済みの翻訳（キャッシュ）を再利用した部分がある

  const PROVIDER_NAMES = { gemini: 'Gemini', chatgpt: 'ChatGPT' };

  // 例: "Gemini / gemini-3.5-flash-lite"。モデルが分からない（すべて保存済みの翻訳だった）ときは空
  function metaLabel(meta) {
    if (!meta || typeof meta !== 'object' || typeof meta.model !== 'string' || !meta.model) return '';
    const provider = PROVIDER_NAMES[meta.provider] || '';
    return provider ? `${provider} / ${meta.model}` : meta.model;
  }

  // 裏方の応答（meta）から、使われたモデルを記録する
  function noteEngine(meta) {
    const label = metaLabel(meta);
    if (label) engines.set(label, label);
    if (meta && Number(meta.cached) > 0) usedSaved = true;
  }

  // 例: "モデル: Gemini / gemini-3.5-flash-lite" ／ 併用で切り替わったときは、複数並ぶ
  function engineLabel() {
    const names = [...engines.values()];
    if (!names.length) return usedSaved ? '保存済みの翻訳を再利用' : '';
    return `モデル: ${names.join('、')}${usedSaved ? '（一部は保存済みの翻訳）' : ''}`;
  }

  // ---------------------------------------------------------------- 段落の区切り・文脈（参考情報）

  let titleOrig = ''; // 翻訳を始めたときの、ページのタイトル（原文）

  // 文字ノードが属する段落（いちばん近いブロック要素）
  function blockOf(node) {
    let el = node.parentElement;
    while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el || document.body;
  }

  // 1 回の依頼に入れる個数（先頭から何個か）。上限に達したとき、できるだけ段落の境目で区切る。
  //   ・段落の途中で上限に達したら、手前の段落の境目まで戻す（戻りすぎて小さな依頼になるなら、その場で切る）
  //   ・見出しの直後で区切るなら、見出しは次の依頼に回す（見出しと本文を、同じ依頼にする）
  function cutPoint(cores, blocks, incoming) {
    const n = cores.length;
    const last = blocks[n - 1];
    // i 番目の断片が属する段落の、先頭の断片の位置
    const startOf = (i) => {
      let k = i;
      while (k > 0 && blocks[k - 1] === blocks[i]) k--;
      return k;
    };
    let cut = n;
    if (last === incoming) {
      // 段落の途中で上限に達した: 手前の段落の境目まで戻す（戻りすぎて小さな依頼になるなら、その場で切る）
      const k = startOf(n - 1);
      if (k > 0) {
        const chars = cores.slice(0, k).reduce((sum, c) => sum + c.length, 0);
        if (Math.max(chars / CHUNK_CHARS, k / CHUNK_SEGMENTS) >= MIN_FILL) cut = k;
      }
    }
    // 段落の境目で切る場合、直前が見出しなら、見出しを次の依頼に回す（先頭まで戻るなら、そのまま）
    if (!(cut === n && last === incoming) && HEADING_TAG.test(blocks[cut - 1].tagName)) {
      const k = startOf(cut - 1);
      if (k > 0) cut = k;
    }
    return cut;
  }

  // 文脈には、入力欄・コードなど、翻訳しない部分の文字は含めない
  const NO_CONTEXT = `${SKIP_SELECTOR},#${HOST_ID}`;
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  // 文字ノードの原文（すでに訳したものは、訳す前の文字に戻す）
  const sourceOf = (textNode) => translated.get(textNode)?.orig ?? textNode.nodeValue;

  // 要素の先頭から、cap 文字ぶんの原文
  function headText(el, cap) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = '';
    for (let n = walker.nextNode(); n && out.length < cap * 2; n = walker.nextNode()) {
      if (n.parentElement?.closest(NO_CONTEXT)) continue;
      out += ` ${sourceOf(n)}`;
    }
    return collapse(out).slice(0, cap);
  }

  // 要素の末尾から、cap 文字ぶんの原文（直前の段落の「終わりのほう」が、いちばん文脈になる）
  function tailText(el, cap) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = el;
    while (last.lastChild) last = last.lastChild;
    walker.currentNode = last;
    let node = last.nodeType === Node.TEXT_NODE ? last : walker.previousNode();
    let out = '';
    while (node && collapse(out).length < cap) {
      if (!node.parentElement?.closest(NO_CONTEXT)) out = `${sourceOf(node)} ${out}`;
      node = walker.previousNode();
    }
    return collapse(out).slice(-cap);
  }

  // この段落より前にある、いちばん近い見出し（headings は、文書順の見出し要素の一覧）
  function headingBefore(block, headings) {
    let found = null;
    for (const h of headings) {
      if (h === block || h.contains(block) || block.contains(h)) continue;
      if (h.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
      else break;
    }
    return found ? headText(found, CONTEXT_CHARS.heading) : '';
  }

  // この段落の直前の文章（近くの、文字のある要素）
  function previousText(block) {
    let el = block;
    for (let depth = 0; el && el !== document.body && depth < 4; depth++, el = el.parentElement) {
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.matches(NO_CONTEXT)) continue;
        const text = tailText(sib, CONTEXT_CHARS.before);
        if (text.length >= 2) return text;
      }
    }
    return '';
  }

  // 依頼の先頭の段落について、文脈（ページのタイトル・直前の見出し・直前の文章）をつくる。訳さない参考情報として、添えて送る。
  function contextFor(block, headings) {
    const ctx = {};
    if (titleOrig) ctx.title = titleOrig.slice(0, CONTEXT_CHARS.title);
    const heading = headingBefore(block, headings);
    if (heading) ctx.heading = heading;
    const before = previousText(block);
    if (before && before !== heading) ctx.before = before;
    return Object.keys(ctx).length ? ctx : undefined;
  }

  // ---------------------------------------------------------------- 翻訳対象の収集

  function isTranslatable(node) {
    const el = node.parentElement;
    if (!el || el.closest(SKIP_SELECTOR) || el.closest('#' + HOST_ID)) return false;
    const t = (node.nodeValue || '').trim();
    if (t.length < 2 || !/\p{L}/u.test(t)) return false;
    // 極端に長い 1 つの文字ノードは対象外にする（裏方の検査で依頼ごと弾かれ、他の文章まで巻き込まないため）
    if (t.length > MAX_NODE_CHARS) return false;
    const kana = (t.match(/[぀-ヿ]/g) || []).length;
    return kana / t.length <= 0.1; // すでに日本語のものは送らない
  }

  function register(root) {
    const nodes = [];
    if (root.nodeType === Node.TEXT_NODE) {
      nodes.push(root);
    } else if (root.nodeType === Node.ELEMENT_NODE) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    }
    for (const node of nodes) {
      if (translated.has(node) || !isTranslatable(node)) continue;
      const el = node.parentElement;
      let set = groups.get(el);
      if (!set) {
        set = new Set();
        groups.set(el, set);
        io.observe(el);
      }
      set.add(node);
    }
  }

  // ---------------------------------------------------------------- 翻訳の実行

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 120);
  }

  function apply(item, tr) {
    const { node, src, lead, trail } = item;
    if (!node.isConnected || node.nodeValue !== src) return; // その間にページ側が書き換えた
    node.nodeValue = lead + tr + trail;
    translated.set(node, { orig: src, tr: node.nodeValue });
  }

  function flush() {
    if (!active) return;
    const bySource = new Map(); // 原文 -> item[]
    // 文の途中でタグ分割された断片が隣り合うよう、文書内の出現順に並べる。
    const ordered = [...pending].sort((a, b) =>
      a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    for (const node of ordered) {
      if (!node.isConnected || translated.has(node)) continue;
      const src = node.nodeValue;
      const core = src.trim();
      const item = {
        node,
        src,
        lead: src.slice(0, src.length - src.trimStart().length),
        trail: src.slice(src.trimEnd().length),
      };
      total++;
      const hit = memo.get(core);
      if (hit) {
        apply(item, hit);
        done++;
        continue;
      }
      if (!bySource.has(core)) bySource.set(core, []);
      bySource.get(core).push(item);
    }
    pending.clear();

    // 依頼にまとめる。上限（文字数・断片数）に達したら、できるだけ段落の境目で区切る（cutPoint）。
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    let cores = [];
    let blocks = []; // cores と同じ並びで、それぞれが属する段落
    let chars = 0;
    const takeChunk = (count) => {
      const head = cores.slice(0, count);
      chunkQueue.push({
        cores: head,
        targets: new Map(head.map((c) => [c, bySource.get(c)])),
        context: contextFor(blocks[0], headings),
      });
      cores = cores.slice(count);
      blocks = blocks.slice(count);
      chars = cores.reduce((sum, c) => sum + c.length, 0);
    };
    for (const core of bySource.keys()) {
      const block = blockOf(bySource.get(core)[0].node);
      while (cores.length && (chars + core.length > CHUNK_CHARS || cores.length >= CHUNK_SEGMENTS)) {
        takeChunk(cutPoint(cores, blocks, block));
      }
      cores.push(core);
      blocks.push(block);
      chars += core.length;
    }
    while (cores.length) takeChunk(cores.length);

    pump();
    updateBadge();
  }

  function pump() {
    while (active && inflight < MAX_INFLIGHT && chunkQueue.length) {
      const job = chunkQueue.shift();
      sentChars += job.cores.reduce((sum, c) => sum + c.length, 0);
      if (sentChars > MAX_CHARS_PER_RUN) {
        fail('このページは翻訳する量が多すぎるため、途中で止めました。「再試行」で続きを翻訳できます。');
        return;
      }
      inflight++;
      runJob(job).finally(() => {
        inflight--;
        pump();
        updateBadge();
      });
    }
  }

  async function requestTranslation(texts, context) {
    try {
      const message = { type: 'translate', texts };
      if (context) message.context = context;
      const resp = await chrome.runtime.sendMessage(message);
      return resp || { ok: false, error: '翻訳サービスから応答がありません。' };
    } catch {
      return { ok: false, error: '拡張機能との通信に失敗しました。ページを再読み込みしてください。' };
    }
  }

  async function runJob(job) {
    const resp = await requestTranslation(job.cores, job.context);
    if (!active) return;
    if (!resp.ok) {
      if (resp.kind === 'invalid') {
        // この依頼だけが検査で弾かれた（極端な文字列など）。ページ全体の翻訳は止めない。
        // 複数の断片なら、半分ずつに分けて送り直し、問題の断片だけを切り出す。1 つだけなら、その部分を飛ばす。
        if (job.cores.length > 1) {
          const mid = Math.ceil(job.cores.length / 2);
          for (const part of [job.cores.slice(mid), job.cores.slice(0, mid)]) {
            chunkQueue.unshift({ cores: part, targets: new Map(part.map((c) => [c, job.targets.get(c)])), context: job.context });
          }
          return;
        }
        for (const items of job.targets.values()) done += items.length;
        return;
      }
      fail(resp.error);
      return;
    }
    noteEngine(resp.meta);
    job.cores.forEach((core, i) => {
      const tr = resp.results[i];
      if (tr) memo.set(core, tr);
      for (const item of job.targets.get(core) || []) {
        if (tr) apply(item, tr);
        done++;
      }
    });
  }

  // ---------------------------------------------------------------- ページ翻訳の開始・停止

  function start() {
    io?.disconnect();
    mo?.disconnect();
    chunkQueue.length = 0;
    groups.clear();
    pending.clear();
    total = 0;
    done = 0;
    sentChars = 0;
    engines.clear();
    usedSaved = false;
    {
      // 文脈に使うタイトルは、訳す前の文字（やり直しのとき、すでに訳してあっても、原文を使う）
      const titleText = document.querySelector('title')?.firstChild;
      titleOrig = collapse(titleText && titleText.nodeType === Node.TEXT_NODE ? sourceOf(titleText) : document.title || '');
    }
    active = true;
    state = 'running';

    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          const set = groups.get(e.target);
          groups.delete(e.target);
          if (set) for (const n of set) if (n.isConnected) pending.add(n);
        }
        if (pending.size) scheduleFlush();
      },
      { rootMargin: '1500px 0px 1500px 0px' },
    );

    mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach((n) => register(n));
        } else if (r.type === 'characterData') {
          const entry = translated.get(r.target);
          if (entry) {
            if (r.target.nodeValue === entry.tr) continue; // 自分の書き換え
            translated.delete(r.target);
          }
          register(r.target);
        }
      }
    });

    register(document.body);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });

    const titleNode = document.querySelector('title')?.firstChild;
    if (titleNode && titleNode.nodeType === Node.TEXT_NODE && /\p{L}/u.test(titleNode.nodeValue)) {
      pending.add(titleNode);
      scheduleFlush();
    }
    updateBadge();
  }

  function stop() {
    active = false;
    state = 'idle';
    io?.disconnect();
    mo?.disconnect();
    clearTimeout(flushTimer);
    chunkQueue.length = 0;
    groups.clear();
    pending.clear();
    for (const [node, entry] of translated) {
      if (node.isConnected && node.nodeValue === entry.tr) node.nodeValue = entry.orig;
    }
    translated.clear();
    removeBadge();
  }

  function fail(message) {
    if (state === 'error') return;
    state = 'error';
    active = false;
    io?.disconnect();
    mo?.disconnect();
    clearTimeout(flushTimer);
    chunkQueue.length = 0;
    groups.clear();
    pending.clear();
    setBadge(message, true, [
      { label: '再試行', onClick: start },
      { label: '原文に戻す', onClick: stop },
    ]);
  }

  function togglePage() {
    if (state === 'running') stop();
    else start(); // 'idle' または 'error'（再試行）
  }

  function updateBadge() {
    if (state !== 'running') return;
    const busy = chunkQueue.length > 0 || inflight > 0 || pending.size > 0;
    let text;
    if (busy) text = `翻訳中… ${done}/${total}`;
    else text = groups.size > 0 ? '日本語に翻訳済み（スクロールで続きも翻訳します）' : '日本語に翻訳済み';
    setBadge(text, false, [{ label: '原文に戻す', onClick: stop }], engineLabel());
  }

  // ---------------------------------------------------------------- UI（Shadow DOM でページの CSS から隔離）

  const CSS = `
    :host { all: initial; }
    .badge, .panel {
      position: fixed; pointer-events: auto; box-sizing: border-box;
      font: 13px/1.5 system-ui, "Yu Gothic UI", "Meiryo", sans-serif;
      color: #1f2328; background: #fff; border: 1px solid #d0d7de; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .18);
    }
    .badge { right: 16px; bottom: 16px; padding: 8px 12px; display: flex; gap: 10px; align-items: center;
      max-width: min(440px, calc(100vw - 32px)); }
    .badge.error { border-color: #cf222e; }
    .badge .msg { flex: 1; }
    .badge .detail, .panel .model { font-size: 12px; line-height: 1.4; opacity: .8; word-break: break-all; }
    .badge .detail { margin-top: 2px; }
    .panel .bar .model { flex: 1; align-self: center; text-align: left; margin-left: 4px; }
    .panel { width: min(420px, calc(100vw - 32px)); max-height: 60vh; display: flex; flex-direction: column; }
    .panel .body { padding: 12px 14px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    .panel .body.error { color: #cf222e; }
    .panel .bar { display: flex; gap: 6px; justify-content: flex-end; padding: 6px 8px; border-top: 1px solid #d0d7de; }
    button { font: inherit; color: inherit; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px;
      padding: 2px 10px; cursor: pointer; white-space: nowrap; }
    button:hover { background: #eaeef2; }
    @media (prefers-color-scheme: dark) {
      .badge, .panel { color: #e6edf3; background: #161b22; border-color: #30363d; }
      .badge.error { border-color: #f85149; }
      .panel .body.error { color: #ff7b72; }
      .panel .bar { border-top-color: #30363d; }
      button { background: #21262d; border-color: #30363d; }
      button:hover { background: #30363d; }
    }`;

  let host = null;
  let shadow = null;
  let badgeEl = null;
  let panelEl = null;

  function ensureUi() {
    if (host && host.isConnected) return;
    badgeEl = null;
    panelEl = null;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
    document.documentElement.append(host);
  }

  function makeButton(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // detail: 本文の下に小さく出す補足（使ったモデルなど）。textContent だけで組み立てる（HTML として解釈しない）。
  function setBadge(text, isError, actions, detail = '') {
    ensureUi();
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      shadow.append(badgeEl);
    }
    badgeEl.className = 'badge' + (isError ? ' error' : '');
    const msg = document.createElement('div');
    msg.className = 'msg';
    const main = document.createElement('div');
    main.textContent = text;
    msg.append(main);
    if (detail) {
      const sub = document.createElement('div');
      sub.className = 'detail';
      sub.textContent = detail;
      msg.append(sub);
    }
    badgeEl.replaceChildren(msg, ...actions.map((a) => makeButton(a.label, a.onClick)));
  }

  function removeBadge() {
    badgeEl?.remove();
    badgeEl = null;
  }

  // ---------------------------------------------------------------- 選択範囲の翻訳

  function selectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') closePanel();
  };
  const onPointerDown = (e) => {
    if (!e.composedPath().includes(host)) closePanel();
  };

  function closePanel() {
    panelEl?.remove();
    panelEl = null;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
  }

  function openPanel(rect) {
    closePanel();
    ensureUi();
    const el = document.createElement('div');
    el.className = 'panel';
    const body = document.createElement('div');
    body.className = 'body';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const copyBtn = makeButton('コピー', () => {
      navigator.clipboard?.writeText(body.textContent).catch(() => {});
    });
    const model = document.createElement('span'); // 使ったモデル（翻訳が終わったら入る）
    model.className = 'model';
    bar.append(model, copyBtn, makeButton('閉じる', closePanel));
    el.append(body, bar);
    shadow.append(el);

    const width = Math.min(420, window.innerWidth - 32);
    if (rect) {
      el.style.left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)) + 'px';
      if (rect.bottom + 140 > window.innerHeight && rect.top > 180) {
        el.style.bottom = window.innerHeight - rect.top + 8 + 'px';
      } else {
        el.style.top = rect.bottom + 8 + 'px';
      }
    } else {
      el.style.top = '16px';
      el.style.right = '16px';
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    panelEl = el;
    return {
      el,
      setBody(text, isError = false) {
        body.textContent = text;
        body.className = 'body' + (isError ? ' error' : '');
      },
      setModel(label) {
        model.textContent = label;
      },
    };
  }

  async function translateSelection(text) {
    const source = (text || window.getSelection()?.toString() || '').trim();
    if (!source) return;
    const panel = openPanel(selectionRect());
    panel.setBody('翻訳中…');
    const resp = await requestTranslation([source]);
    if (panelEl !== panel.el) return; // 閉じられた
    if (!resp.ok) panel.setBody(resp.error, true);
    else if (!resp.results[0]) panel.setBody('翻訳結果を取得できませんでした。', true);
    else {
      panel.setBody(resp.results[0]);
      panel.setModel(metaLabel(resp.meta) || (Number(resp.meta?.cached) > 0 ? '保存済みの翻訳' : ''));
    }
  }

  // ---------------------------------------------------------------- メッセージ受信

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'ping':
        sendResponse(true);
        break;
      case 'toggle-page':
        togglePage();
        break;
      case 'translate-selection':
        translateSelection(msg.text);
        break;
    }
  });
})();
