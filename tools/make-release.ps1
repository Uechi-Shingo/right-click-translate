# 配布用の zip と、改ざん確認用の SHA-256 チェックサムを作ります。
#
# 使い方（PowerShell）:
#   .\tools\make-release.ps1
#
# 作られるもの（dist フォルダ）:
#   right-click-translate-<バージョン>.zip         … 配る zip（中に manual.html = 説明書 を同梱）
#   right-click-translate-<バージョン>.zip.sha256.txt … zip の SHA-256（受け取る人が照合する）
#   README.md                                       … 外出し用の README（バージョン・SHA-256 入り。zip と一緒に置く）
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist'),
  # 公式の入手先（GitHub のリポジトリ URL）。指定すると、README に「公式の入手先」として載せる（なりすまし・改変版対策）。
  # 例: .\tools\make-release.ps1 -RepoUrl https://github.com/<ユーザー名>/right-click-translate
  [string]$RepoUrl = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ext = Join-Path $root 'extension'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js が見つかりません。配布前の安全確認（監査・テスト）に使います。'
}

# 1. 配布前の安全確認。ひとつでも失敗したら、配布物は作らない。
Write-Host '== 安全確認（静的監査・自動テスト）' -ForegroundColor Cyan
foreach ($script in @('tests\static-audit.mjs', 'tests\security.test.mjs', 'tests\background.test.mjs', 'tests\chatgpt.test.mjs', 'tests\failover.test.mjs', 'tests\roundtrip.test.mjs')) {
  & node (Join-Path $root $script) | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$script が失敗しました。配布物は作りません。" }
}

# 2. 配布物を組み立てる（zip の中身: README.txt と extension フォルダ）
$manifest = Get-Content (Join-Path $ext 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$name = "right-click-translate-$version"

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("$name-" + [guid]::NewGuid().ToString('N'))
$pkg = Join-Path $stage $name
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
Copy-Item -Recurse -Force $ext (Join-Path $pkg 'extension')

# 説明書（HTML）を同梱する。zip だけを渡しても、受け取った人が説明書を読めるようにする。
# zip 内のファイル名は、解凍ソフトによる文字化けを避けるため、英数字にする。
$manualSrc = Join-Path $root '説明書.html'
if (Test-Path $manualSrc) { Copy-Item $manualSrc (Join-Path $pkg 'manual.html') }

# ライセンス（MIT）を同梱する。MIT は、複製物にライセンスの文面を含めることを条件にしているため。
$licenseSrc = Join-Path $root 'LICENSE'
if (Test-Path $licenseSrc) { Copy-Item $licenseSrc (Join-Path $pkg 'LICENSE') }

# 変更履歴を同梱する（静的な監査が、先頭の版が manifest のバージョンと一致することを確認する）。
$changelogSrc = Join-Path $root 'CHANGELOG.md'
if (Test-Path $changelogSrc) { Copy-Item $changelogSrc (Join-Path $pkg 'CHANGELOG.md') }

$readme = @"
右クリックで日本語に翻訳  バージョン $version

■ これは何？
  ブラウザ(Brave / Chrome / Edge)で右クリックすると、ページ全体や選んだ文章を日本語に翻訳する拡張機能です。
  翻訳には、次のどちらかを選べます。
    ・Google の Gemini API の「無料枠」（ご自身の APIキーが必要）
    ・ChatGPT のプラン（Plus / Pro など。APIキーは不要で、ChatGPT アカウントでサインインします）

■ 入れ方
  1. この zip を展開し、できたフォルダを「移動・削除しない場所」に置く（例: ドキュメント）
  2. ブラウザで brave://extensions（Chrome は chrome://extensions）を開く
  3. 右上の「デベロッパーモード」をオンにする
  4. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダの中の「extension」フォルダを選ぶ
  5. 開いた設定画面で、注意事項を読み、「使う AI」を選ぶ
     Gemini なら、ご自身の APIキーを入力して保存。ChatGPT なら、「ChatGPT でサインイン」を押して承認する

■ とても大事なこと
  - 鍵は「あなた専用」です。配布した人のキーやアカウントは使えません。
    Gemini の APIキーは、必ずご自身で https://aistudio.google.com/apikey から無料で作成してください。
  - APIキー・サインイン情報を、他の人に教えない・画面ごと共有しない・メールやチャットに貼らないでください。
  - Gemini を使う場合、Google 側で、支払い方法（請求先アカウント）を登録しないでください。
  - ChatGPT のプランで使うと、翻訳した分だけ、ご契約の利用枠が減ります。OpenAI の公式ドキュメントは、
    ブラウザの拡張機能での利用に触れていません。仕様変更で使えなくなる可能性があります。
  - 翻訳するページの文章は Google または OpenAI に送信されます。メール・社内文書・個人情報や機密情報を含むページでは使わないでください。

■ 配布物が改ざんされていないか確認する（おすすめ）
  PowerShell で次を実行し、配布した人から別の方法で受け取った SHA-256 の値と一致することを確認します。
    Get-FileHash .\right-click-translate-$version.zip -Algorithm SHA256

■ 詳しい説明
  同梱の manual.html（説明書）を、ブラウザで開いてご覧ください。

■ 変更履歴
  同梱の CHANGELOG.md を参照してください。

■ ライセンス
  MIT License（同梱の LICENSE を参照）。無保証で提供します。
"@
# Windows のメモ帳でも文字化けしないよう、BOM 付き UTF-8 で書く
[System.IO.File]::WriteAllText((Join-Path $pkg 'README.txt'), $readme, (New-Object System.Text.UTF8Encoding($true)))

# 3. zip にして、SHA-256 を記録する
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path (Resolve-Path $OutDir).Path "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# zip の規格どおり、フォルダ区切りは「/」にする（Mac や他の解凍ソフトでも正しく展開できるように）
$fileStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem $pkg -Recurse -File | ForEach-Object {
    $entryName = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    $source = [System.IO.File]::OpenRead($_.FullName)
    try { $source.CopyTo($entryStream) } finally { $source.Dispose(); $entryStream.Dispose() }
  }
} finally {
  $archive.Dispose()
  $fileStream.Dispose()
}
Remove-Item -Recurse -Force $stage

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$sumFile = "$zip.sha256.txt"
[System.IO.File]::WriteAllText($sumFile, "$hash *$(Split-Path $zip -Leaf)`r`n", (New-Object System.Text.UTF8Encoding($false)))

# 外出し用の README（GitHub などで zip と一緒に置く）。ひな形に、バージョンと SHA-256 を入れて書き出す。
$readmeOut = $null
$template = Join-Path $PSScriptRoot 'README.dist.template.md'
if (Test-Path $template) {
  $md = [System.IO.File]::ReadAllText($template, [System.Text.Encoding]::UTF8)
  $md = $md.Replace('{{VERSION}}', $version).Replace('{{ZIP_NAME}}', (Split-Path $zip -Leaf)).Replace('{{SHA256}}', $hash)
  $md = $md.Replace('{{DATE}}', (Get-Date -Format 'yyyy年M月d日'))
  $repoLine = ''
  if ($RepoUrl) {
    $repoLine = "> **公式の入手先:** <$RepoUrl>`n> これ以外の場所で配布されているものは、改変されている可能性があります。入手先を確認してください。"
  }
  $md = $md.Replace('{{REPO_LINE}}', $repoLine)
  $readmeOut = Join-Path (Split-Path $zip -Parent) 'README.md'
  [System.IO.File]::WriteAllText($readmeOut, $md, (New-Object System.Text.UTF8Encoding($false)))
}

# 4. Git 管理用: リポジトリ直下の releases/ に、最新版の zip と SHA-256 を置き、README のダウンロード欄を更新する。
#    古い版は、Git の履歴に残る（releases/ には、最新版だけを置く）。
$releasesDir = Join-Path $root 'releases'
New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null
Get-ChildItem $releasesDir -Filter 'right-click-translate-*' -File | Remove-Item -Force
Copy-Item $zip $releasesDir
Copy-Item $sumFile $releasesDir

$zipLeaf = Split-Path $zip -Leaf
$readmePath = Join-Path $root 'README.md'
$readmeUpdated = $false
if (Test-Path $readmePath) {
  $current = [System.IO.File]::ReadAllText($readmePath, [System.Text.Encoding]::UTF8)
  $pattern = '(?s)<!-- release:start -->.*?<!-- release:end -->'
  if ($current -match $pattern) {
    # RepoUrl があれば、押すとそのままダウンロードが始まるリンクにする（なければ、リポジトリ内のファイルへのリンク）
    $zipLink = if ($RepoUrl) { "$($RepoUrl.TrimEnd('/'))/raw/main/releases/$zipLeaf" } else { "releases/$zipLeaf" }
    $block = @"
<!-- release:start -->
| | |
| --- | --- |
| 最新バージョン | **$version**（$(Get-Date -Format 'yyyy年M月d日') 更新） |
| ダウンロード | [``$zipLeaf``]($zipLink) |
| SHA-256 | ``$hash`` |
<!-- release:end -->
"@
    $block = $block.TrimEnd("`r", "`n")
    $new = [regex]::Replace($current, $pattern, { param($m) $block })
    [System.IO.File]::WriteAllText($readmePath, $new, (New-Object System.Text.UTF8Encoding($false)))
    $readmeUpdated = $true
  }
}

Write-Host ''
Write-Host "== 完成" -ForegroundColor Green
Write-Host "  zip    : $zip"
Write-Host "  SHA-256: $hash"
if ($readmeOut) { Write-Host "  README : $readmeOut" }
Write-Host "  releases: $(Join-Path $releasesDir $zipLeaf)（Git 管理用。最新版だけを置きます）"
Write-Host "  README  : $(if ($readmeUpdated) { 'README.md のダウンロード欄を更新しました' } else { 'README.md に <!-- release:start --> の目印がないため、更新していません' })"
Write-Host ''
Write-Host 'Git で公開するとき: git add -A → git commit -m "変更の説明" → git push'
Write-Host "  そのあと、版のタグ: git tag -a v$version -m `"v$version`" → git push origin v$version"
Write-Host '（zip だけを置く配布用リポジトリにする場合は、dist フォルダの zip・README.md・SHA-256 を使います）'
Write-Host '配るときは、zip と SHA-256 の値を「別の経路」でも送ると、すり替えに気づきやすくなります。'
