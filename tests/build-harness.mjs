// content-harness.html に content.js を埋め込んだ単体 HTML を作る。
// 実行: node tests/build-harness.mjs <出力先.html>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error('出力先を指定してください');
  process.exit(1);
}
const html = readFileSync(path.join(here, 'content-harness.html'), 'utf8');
const js = readFileSync(path.join(here, '..', 'extension', 'content.js'), 'utf8');
if (js.includes('</script>')) throw new Error('content.js に </script> が含まれています');
const built = html.replace(
  '<script src="../extension/content.js"></script>',
  () => `<script>\n${js}\n</script>`,
);
writeFileSync(out, built);
console.log(`wrote ${out}`);
