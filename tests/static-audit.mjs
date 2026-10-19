// 拡張機能のファイルを静的に調べて、「危険な構成が入り込んでいないか」を確認する。
// 配布前・受け取った後に、誰でも実行できます。  実行: node tests/static-audit.mjs [extension フォルダ]
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '..', 'extension'));
const { test, summary } = createRunner();

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const OPENAI_API_HOST = 'api.openai.com';
const OPENAI_AUTH_HOST = 'auth.openai.com';
const CALLBACK = 'http://127.0.0.1:1455/auth/callback'; // ChatGPT サインインの戻り先（公式の手順どおりのループバック）

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(root);
const rel = (p) => path.relative(root, p).replaceAll('\\', '/');
const text = (p) => readFileSync(p, 'utf8');
const sources = files.filter((p) => /\.(js|html|css|json)$/.test(p));
const scripts = files.filter((p) => p.endsWith('.js'));
const manifest = JSON.parse(text(path.join(root, 'manifest.json')));
const bg = text(path.join(root, 'background.js'));
const chatgpt = text(path.join(root, 'chatgpt.js'));

// 目に見えない文字（NUL などの制御文字、ゼロ幅文字、右から左への書き換え文字など）
const isInvisible = (code) =>
  code < 9 ||
  code === 11 ||
  code === 12 ||
  (code >= 14 && code <= 31) ||
  code === 127 ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  code === 0x2060 ||
  code === 0xfeff;

console.log(`対象: ${root}（${files.length} ファイル）\n`);

await test('権限は必要最小限（宣言した 5 つだけ）', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'storage', 'webRequest']);
});

await test('通信を許可するサイトは、Gemini の API・OpenAI の API とサインイン・サインインの戻り先（ループバック 1 つ）だけ', () => {
  assert.deepEqual([...manifest.host_permissions].sort(), [
    `http://127.0.0.1:1455/auth/callback*`,
    `https://${OPENAI_API_HOST}/*`,
    `https://${OPENAI_AUTH_HOST}/*`,
    `https://${GEMINI_HOST}/*`,
  ].sort());
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
});

await test('常時ページに入り込む設定（content_scripts）がない', () => {
  assert.equal(manifest.content_scripts, undefined);
});

await test('外部（ページや他の拡張機能）から呼び出せる口がない', () => {
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

await test('CSP で、画面・裏方の通信先を 3 つのホストに固定し、外部スクリプトを禁止している', () => {
  const csp = manifest.content_security_policy?.extension_pages;
  assert.ok(csp, 'content_security_policy.extension_pages がありません');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  const connect = /connect-src ([^;]+)(;|$)/.exec(csp);
  assert.ok(connect, 'connect-src がありません');
  assert.deepEqual(connect[1].trim().split(/\s+/).sort(), [
    `https://${OPENAI_API_HOST}`,
    `https://${OPENAI_AUTH_HOST}`,
    `https://${GEMINI_HOST}`,
  ].sort());
  assert.ok(!/unsafe-eval|unsafe-inline|\*|http:/.test(csp), `危険な指定があります: ${csp}`);
});

await test('動的なコード実行・HTML の直接挿入を使っていない', () => {
  const banned = /\beval\s*\(|new\s+Function\s*\(|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\s*\(|setTimeout\s*\(\s*['"`]/;
  for (const p of scripts) assert.ok(!banned.test(text(p)), `${rel(p)} に禁止された書き方があります`);
});

await test('別ファイルの読み込み（importScripts）は、background.js から chatgpt.js だけ', () => {
  for (const p of scripts) {
    const calls = [...text(p).matchAll(/\bimportScripts\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
    if (rel(p) === 'background.js') assert.deepEqual(calls, ["'chatgpt.js'"]);
    else assert.deepEqual(calls, [], `${rel(p)} で importScripts を使っています`);
  }
  assert.ok(existsSync(path.join(root, 'chatgpt.js')));
});

await test('ソースに目に見えない文字（NUL などの制御文字・ゼロ幅文字）が混入していない', () => {
  for (const p of sources) {
    const s = text(p);
    let found = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code === 0xfeff && i === 0) continue; // ファイル先頭の BOM は許容
      if (isInvisible(code)) found++;
    }
    assert.equal(found, 0, `${rel(p)} に不可視文字・制御文字が ${found} 個あります`);
  }
});

await test('ログ出力・デバッグ出力を使っていない（キー・トークン・本文が残らない）', () => {
  for (const p of scripts) assert.ok(!/\bconsole\.|\bdebugger\b/.test(text(p)), `${rel(p)} に console / debugger があります`);
});

await test('通信（fetch）は 5 か所だけで、すべて固定アドレス（Gemini 2・OpenAI 3）', () => {
  const calls = [];
  for (const p of scripts) {
    for (const m of text(p).matchAll(/\bfetch\s*\(\s*([^,)]+)/g)) calls.push(`${rel(p)}: ${m[1].trim()}`);
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(text(p)), `${rel(p)} に別の通信手段があります`);
  }
  assert.deepEqual(calls.sort(), [
    'background.js: url',
    'background.js: url',
    'chatgpt.js: TOKEN_URL',
    'chatgpt.js: `${API_BASE}/models`',
    'chatgpt.js: `${API_BASE}/responses`',
  ].sort());
  // 宛先の元になる定数は、固定の文字列だけ
  assert.match(bg, new RegExp(`const MODELS_URL = 'https://${GEMINI_HOST}/v1beta/models';`));
  assert.match(chatgpt, new RegExp(`const TOKEN_URL = 'https://${OPENAI_AUTH_HOST}/api/accounts/oauth/token';`));
  assert.match(chatgpt, new RegExp(`const API_BASE = 'https://${OPENAI_API_HOST}/v1';`));
  assert.match(chatgpt, new RegExp(`const AUTHORIZE_URL = 'https://${OPENAI_AUTH_HOST}/api/accounts/authorize';`));
  assert.match(chatgpt, new RegExp(`const REDIRECT_URI = '${CALLBACK.replaceAll('.', '\\.')}';`));
});

await test('コードに書かれている URL は、許可した宛先（Gemini・OpenAI・Google AI Studio のリンク・ループバック 1 つ）だけ', () => {
  const allowed = [GEMINI_HOST, 'aistudio.google.com', OPENAI_API_HOST, OPENAI_AUTH_HOST];
  for (const p of sources) {
    for (const m of text(p).matchAll(/https?:\/\/[^\s'"`<>)]+/g)) {
      const raw = m[0].replace(/[.,;]+$/, '').replace(/\*$/, '');
      if (raw === CALLBACK) continue; // サインインの戻り先。この 1 つの http だけ許可する
      const u = new URL(raw);
      assert.equal(u.protocol, 'https:', `${rel(p)}: 許可していない http:// の URL ${m[0]}`);
      assert.ok(allowed.includes(u.hostname), `${rel(p)}: 想定外のホスト ${u.hostname}`);
    }
  }
});

await test('webRequest は「戻り先の観測」だけ（通信の書き換え・ブロックをしない）', () => {
  for (const p of scripts) {
    const s = text(p);
    assert.ok(!/webRequestBlocking|declarativeNetRequest|extraInfoSpec|['"]blocking['"]|onBeforeSendHeaders|onHeadersReceived/.test(s), `${rel(p)} に通信を変える API があります`);
    if (rel(p) !== 'background.js') assert.ok(!/chrome\.webRequest/.test(s), `${rel(p)} が webRequest を使っています`);
  }
  assert.equal([...bg.matchAll(/chrome\.webRequest/g)].length, 1);
  assert.match(bg, /chrome\.webRequest\?\.onBeforeRequest\?\.addListener\(/);
  assert.match(bg, /\{ urls: \[`\$\{ChatGPT\.REDIRECT_URI\}\*`\], types: \['main_frame'\] \}/);
});

await test('新しいタブを開くのは、ChatGPT のサインイン画面（chatgpt.js の 1 か所）だけ', () => {
  const uses = [];
  for (const p of scripts) for (const m of text(p).matchAll(/chrome\.tabs\.create\s*\(([^)]*)\)/g)) uses.push(`${rel(p)}: ${m[1].trim()}`);
  assert.deepEqual(uses, ['chatgpt.js: { url: req.url }']);
});

await test('秘密情報（APIキー・トークン）らしき文字列がファイルに埋め込まれていない', () => {
  for (const p of sources) {
    assert.ok(!/AIza[0-9A-Za-z_-]{30,}/.test(text(p)), `${rel(p)} にキーらしき文字列があります`);
    assert.ok(!/(sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(text(p)), `${rel(p)} に秘密情報らしき文字列があります`);
    assert.ok(!/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./.test(text(p)), `${rel(p)} にトークンらしき文字列があります`);
  }
});

await test('設定画面に、インライン script / イベント属性 / インライン style / 外部読み込みがない', () => {
  const html = text(path.join(root, 'options.html'));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'インライン script があります');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'onclick 等のイベント属性があります');
  assert.ok(!/\sstyle\s*=/i.test(html), 'インライン style があります');
  assert.ok(!/<style[\s>]/i.test(html), '<style> があります');
  assert.ok(!/(src|href)\s*=\s*["']https?:\/\/(?!aistudio\.google\.com)/i.test(html), '外部リソースの読み込みがあります');
  assert.ok(!/<iframe|<object|<embed/i.test(html));
});

await test('外部リンクには noopener noreferrer が付いている', () => {
  const html = text(path.join(root, 'options.html'));
  for (const m of html.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)) {
    assert.match(m[0], /rel="noopener noreferrer"/, m[0]);
  }
});

await test('設定画面のライト／ダークは、利用者の設定に合わせる（強制していない）', () => {
  const css = text(path.join(root, 'options.css'));
  assert.match(css, /prefers-color-scheme:\s*dark/, 'ダーク設定に合わせる指定がありません');
  assert.ok(!/color-scheme:\s*(light|dark)\s*[;}]/.test(css), 'ライトまたはダークに固定する指定があります');
});

await test('配布物に開発用ファイル（テスト・秘密鍵・ソースマップ等）が混ざっていない', () => {
  for (const p of files) {
    assert.ok(!/\.(pem|key|crx|map|env|log)$|(^|\/)(node_modules|tests|\.git)(\/|$)/i.test(rel(p)), `混入: ${rel(p)}`);
  }
});

await test('変更履歴（CHANGELOG.md）の先頭が、manifest のバージョンと一致している', () => {
  const file = path.join(root, '..', 'CHANGELOG.md');
  if (!existsSync(file)) return; // 配布物の展開先など、変更履歴が隣にない場合は対象外
  const top = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?/m.exec(text(file));
  assert.ok(top, 'CHANGELOG.md に「## 0.0.0」形式の見出しがありません');
  assert.equal(top[1], manifest.version, `CHANGELOG の先頭 ${top[1]} と manifest の ${manifest.version} が違います`);
});

summary();
