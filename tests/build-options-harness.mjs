// 設定画面 (options.html + options.js) を、chrome.* を偽物に差し替えた単体 HTML にする（見た目・操作の確認用）。
// 実行: node tests/build-options-harness.mjs <出力先.html>
// 開いたあと、開発者ツールのコンソールで次を実行すると、ChatGPT のサインインの状態を切り替えて確かめられます。
//   __chatgpt.signedIn = true; __chatgpt.hasPlanScope = true; __chatgpt.email = 'you@example.com'; __fire();
//   __chatgpt.pending = true; __fire();
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error('出力先を指定してください');
  process.exit(1);
}
const ext = path.join(here, '..', 'extension');
const html = readFileSync(path.join(ext, 'options.html'), 'utf8');
const js = readFileSync(path.join(ext, 'options.js'), 'utf8');

const stub = `
window.__store = { apiKey: 'dummy-key-for-harness', model: 'gemini-3.5-flash-lite', fallbackModel: 'gemini-2.5-flash-lite', useCache: true, provider: new URLSearchParams(location.search).get('provider') || 'gemini' };
window.__session = {};
window.__messages = [];
window.__listDelay = 150;
window.__chatgpt = { signedIn: false, pending: false, email: '', hasPlanScope: false, last: null };
const listeners = [];
window.__fire = () => listeners.forEach((fn) => fn({ chatgptAuth: {} }, 'session'));
const area = (backing) => ({
  get: async (d) => (typeof d === 'string' ? { [d]: backing[d] } : Array.isArray(d) ? Object.fromEntries(d.map((k) => [k, backing[k]])) : { ...d, ...backing }),
  set: async (o) => { Object.assign(backing, o); },
  remove: async (k) => { delete backing[k]; },
});
window.chrome = {
  storage: { local: area(window.__store), session: area(window.__session), onChanged: { addListener: (fn) => listeners.push(fn) } },
  runtime: { sendMessage: async (msg) => {
    window.__messages.push(msg.type);
    if (msg.type === 'list-models') {
      await new Promise((r) => setTimeout(r, window.__listDelay));
      if (window.__store.provider === 'chatgpt') {
        return { ok: true, models: ['gpt-demo-sol', 'gpt-demo-luna', 'gpt-demo-mini'].map((id) => ({ id, displayName: id })) };
      }
      return { ok: true, models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].map((id) => ({ id, displayName: id })) };
    }
    if (msg.type === 'chatgpt-status') return { ok: true, status: window.__chatgpt };
    if (msg.type === 'chatgpt-sign-in') { window.__chatgpt.pending = true; return { ok: true, status: window.__chatgpt }; }
    if (msg.type === 'chatgpt-cancel') { window.__chatgpt.pending = false; return { ok: true, status: window.__chatgpt }; }
    if (msg.type === 'chatgpt-sign-out') {
      window.__chatgpt = { signedIn: false, pending: false, email: '', hasPlanScope: false, last: null };
      return { ok: true, status: window.__chatgpt };
    }
    return { ok: true, results: ['こんにちは'] };
  } },
};`;

const css = readFileSync(path.join(ext, 'options.css'), 'utf8');
const withScript = html.replace(
  '<script src="options.js"></script>',
  () => `<script>${stub}</script>\n<script>\n${js}\n</script>`,
);
if (withScript === html) throw new Error('options.html の script タグが見つかりません');
// 単体で開けるように、スタイルシートも埋め込む
const built = withScript.replace('<link rel="stylesheet" href="options.css">', () => `<style>\n${css}\n</style>`);
if (built === withScript) throw new Error('options.html のスタイルシートの指定が見つかりません');
writeFileSync(out, built);
console.log(`wrote ${out}`);
