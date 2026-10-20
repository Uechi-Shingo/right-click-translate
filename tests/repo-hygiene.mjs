// リポジトリの衛生検査。Git で管理しているファイルに、公開してはいけないものが混ざっていないか、配布物（releases/）が壊れていないかを確かめる。
// 手元でも、CI（GitHub Actions）でも実行できます。  実行: node tests/repo-hygiene.mjs
//
// 確かめること:
//   ・APIキー・トークン・秘密鍵らしき文字列がない
//   ・メールアドレス（GitHub の非公開用アドレスと、例示用の example.com を除く）や、PC のユーザーフォルダのパスがない
//   ・極端に大きなファイルがない
//   ・releases/ の zip の SHA-256 が、チェックサムのファイルと README の値に一致している
// 見つかった場合は、ファイル名と行番号だけを表示します（見つかった文字列そのものは表示しません）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { test, summary } = createRunner();

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const isBinary = (f) => /\.(png|zip|jpg|jpeg|gif|ico|woff2?)$/i.test(f);
const textFiles = tracked.filter((f) => !isBinary(f));
const read = (f) => readFileSync(path.join(root, f), 'utf8');

// 各行を調べて、パターンに合う場所（ファイル:行）の一覧を返す
function scan(regex, { skip = () => false } = {}) {
  const hits = [];
  for (const f of textFiles) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(regex)) {
        if (!skip(m[0], f)) hits.push(`${f}:${i + 1}`);
      }
    });
  }
  return hits;
}

console.log(`対象: Git で管理しているファイル ${tracked.length} 個\n`);

await test('APIキー・トークン・秘密鍵らしき文字列が、ファイルに入っていない', () => {
  const patterns = [
    /AIza[0-9A-Za-z_-]{30,}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./g,
    /gh[pousr]_[A-Za-z0-9]{30,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
  ];
  const hits = patterns.flatMap((p) => scan(p));
  assert.deepEqual(hits, [], `秘密情報らしき文字列: ${hits.join(', ')}`);
});

await test('個人のメールアドレスが、ファイルに入っていない（非公開用アドレスと example.com は除く）', () => {
  const allowed = /@(users\.noreply\.github\.com|example\.(com|org|net))$/i;
  const hits = scan(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, { skip: (m) => allowed.test(m) });
  assert.deepEqual(hits, [], `メールアドレス: ${hits.join(', ')}`);
});

await test('PC のユーザーフォルダのパス（C:\\Users\\… など）が、ファイルに入っていない', () => {
  const hits = scan(/[A-Za-z]:[\\/]Users[\\/]|\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\//g);
  assert.deepEqual(hits, [], `ローカルのパス: ${hits.join(', ')}`);
});

await test('極端に大きなファイル（2 MB 超）が、Git に入っていない', () => {
  const big = tracked.filter((f) => existsSync(path.join(root, f)) && statSync(path.join(root, f)).size > 2 * 1024 * 1024);
  assert.deepEqual(big, [], `大きなファイル: ${big.join(', ')}`);
});

await test('releases/ の zip の SHA-256 が、チェックサムのファイルと README の値に一致している', () => {
  const zips = tracked.filter((f) => /^releases\/.+\.zip$/.test(f));
  assert.ok(zips.length >= 1, 'releases/ に zip がありません');
  const readme = read('README.md');
  for (const zip of zips) {
    const actual = createHash('sha256').update(readFileSync(path.join(root, zip))).digest('hex');
    const sumFile = `${zip}.sha256.txt`;
    assert.ok(tracked.includes(sumFile), `${sumFile} がありません`);
    const recorded = read(sumFile).trim().split(/\s+/)[0].toLowerCase();
    assert.equal(actual, recorded, `${zip} の SHA-256 が、チェックサムのファイルと違います`);
    assert.ok(readme.includes(actual), `README のダウンロード欄の SHA-256 が、${zip} と違います（make-release.ps1 で更新してください）`);
  }
});

summary();
