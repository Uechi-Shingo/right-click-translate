# 右クリックで日本語に翻訳

Chrome 系ブラウザ（Brave / Chrome / Edge）用の翻訳拡張機能です。右クリックで **ページ全体** または **選択範囲** を日本語に翻訳します。
翻訳に使う AI は、設定画面で次の 2 つから選べます。

- **Gemini API の無料枠**（Google AI Studio の APIキー）。API の追加課金はありません
- **ChatGPT のプラン**（Plus / Pro など）。OpenAI の「Sign in with ChatGPT」でサインインし、APIキーなしでご契約の利用枠を使います（v0.3.0 から）

**併用**もできます（v0.4.0 から）。設定画面で「上限・エラーのときは、もう一方の AI に切り替える」をオンにすると、たとえば「通常は Gemini の無料枠、使い切ったら ChatGPT」のように自動で切り替わります（既定はオフ）。ページ右下の枠には、実際に翻訳した**モデル名**（例: `モデル: Gemini / gemini-3.5-flash-lite`）が出ます。

詳しい説明（使い方・安全性・仕組み・技術）は、**説明書**（zip の中の `manual.html`、リポジトリでは [`説明書.html`](説明書.html)）をブラウザで開いてください。GitHub の画面では HTML が整形されないので、ダウンロードして開きます。変更履歴は **[CHANGELOG.md](CHANGELOG.md)** です。

> 個人が作成した非公式のツールです。Google・OpenAI とは関係がありません。無保証で提供しており、利用は自己責任です。
> ライセンスは MIT License です（`LICENSE` を参照）。

## ダウンロード

<!-- release:start -->
| | |
| --- | --- |
| 最新バージョン | **0.5.0**（2026年10月19日 更新） |
| ダウンロード | [`right-click-translate-0.5.0.zip`](https://github.com/Uechi-Shingo/right-click-translate/raw/main/releases/right-click-translate-0.5.0.zip) |
| SHA-256 | `3d714b3a31df71ab011c231434ab85b6fd5d77ac460e68c6517c0f9a67d07105` |
<!-- release:end -->

ダウンロードした zip は、PowerShell で `Get-FileHash .\right-click-translate-<バージョン>.zip -Algorithm SHA256` を実行し、上の SHA-256 と**1 文字も違わず**一致することを確かめてから使うと安心です。入れ方は、zip の中の `README.txt` と説明書を見てください（`brave://extensions` で「デベロッパーモード」をオンにして、`extension` フォルダを読み込みます）。

## OpenAI（ChatGPT のプラン）に関する注意

ChatGPT のプランでの利用は、OpenAI の公式ドキュメント「Sign in with ChatGPT」（<https://developers.openai.com/siwc>）の手順に沿って実装しています。ただし、ドキュメントは**ブラウザの拡張機能での利用には触れていません**（許可も禁止も書かれていません）。**ご自身でも原文と OpenAI の規約を確認してください。**

- 翻訳に使った分は、ご契約のプランの利用枠から差し引かれます（ChatGPT 本体や Codex など、同じプランの他の使い方と分け合います）
- 公式の手順では、サインインの戻り先を、自分のパソコン内（`127.0.0.1:1455`）で待ち受けるプログラムが受け取ります。拡張機能は待ち受けができないため、`webRequest` でその移動を**観測するだけ**にして、確認コードを取り出します（通信の書き換え・遮断はしません）
- OpenAI 側の仕様変更で、使えなくなる可能性があります。そのときは Gemini API に切り替えられます

## Google の利用規約に関する注意（Gemini API を使う場合・必ずお読みください）

Gemini API を使う場合、利用者ご自身が取得した Gemini API のキーを使います。Google の「Gemini API 追加利用規約」（<https://ai.google.dev/gemini-api/terms>）には、次のような記載があります。**ご自身でも原文を確認してください。**

| 項目 | 規約の内容（要旨） |
| --- | --- |
| EEA（欧州経済領域）・スイス・英国 | これらの地域のユーザーに API クライアントを提供する場合は、有料サービス（Paid Services）のみを使うこととされています。この拡張機能は無料枠を前提としているため、**これらの地域の方は、無料枠では利用できない可能性があります。** |
| 年齢 | Gemini API は 18 歳以上が対象です。18 歳未満が利用する可能性の高いアプリでの利用も認められていません。 |
| 用途 | Google AI Studio と Gemini API は、開発者が業務目的で使うことを想定し、一般消費者としての利用は想定外とされています。 |
| 無料枠のデータの扱い | 送信した内容が Google の製品改善に使われ、人間の担当者が入出力を確認する場合があります。機密情報・個人情報は送らないでください。 |

規約は変更されることがあります。この拡張機能の作者は、これらの規約への適合を保証しません。

## 使う人向け

1. 配布された zip を展開し、消さない場所に置く
2. `brave://extensions`（Chrome は `chrome://extensions`）を開き、デベロッパーモードをオン
3. 「パッケージ化されていない拡張機能を読み込む」→ **`extension` フォルダ** を選ぶ
4. 設定画面で注意事項を確認し、「使う AI」を選ぶ
   - **Gemini API**: **ご自身の APIキー**（<https://aistudio.google.com/apikey> で無料発行）を入力して「保存して接続テスト」
   - **ChatGPT のプラン**: 「ChatGPT でサインイン」を押し、OpenAI の画面で承認。戻ったら「保存して接続テスト」

操作：ページ上で右クリック →「このページを日本語に翻訳 / 元に戻す」、文字列を選択して右クリック →「選択範囲を日本語に翻訳」。

### 守ってほしいこと

- APIキー・サインインは**自分のものを使い、他人に見せない・貸さない**
- Gemini を使う場合、Google 側で**支払い方法（請求先）を登録しない**
- メール・社内文書・個人情報のあるページでは**使わない**（文章が Google または OpenAI に送られます）

## 配布する人向け

```powershell
.\tools\make-release.ps1
```

安全確認（静的な監査・自動テスト）に**すべて合格したときだけ**、`dist/` に次の 3 つを作ります。さらに、Git 管理用に、最新版の zip と SHA-256 を `releases/` にコピーし、この README の「ダウンロード」欄を書き換えます。

| ファイル | 内容 |
| --- | --- |
| `right-click-translate-<バージョン>.zip` | 配布用 zip（拡張機能と、説明書 `manual.html`・`CHANGELOG.md` を同梱） |
| `…zip.sha256.txt` | zip の SHA-256 |
| `README.md`（`dist/` 内） | zip だけを置く配布用リポジトリ向けの README（バージョンと SHA-256 入り。ひな形は `tools/README.dist.template.md`） |

zip と SHA-256 の値は、**別の経路**で渡してください。自分のキーは絶対に渡さない・埋め込まないでください。

### Git で管理する（このリポジトリの運用）

リポジトリには、ソース一式（`extension/`・`tests/`・`tools/`・説明書・README・CHANGELOG）と、`releases/`（最新版の zip と SHA-256）を置きます。`dist/` は、作業用なのでコミットしません（`.gitignore`）。

```powershell
git status                         # 変更したファイルを確認
git add -A                         # 変更をまとめて、記録の対象にする
git commit -m "変更の説明"          # ローカルに記録
git push                           # GitHub に反映（公開される）
```

- 変更したら、`manifest.json` の `version` と `CHANGELOG.md` の先頭の版を**揃えて**上げます（静的な監査が、一致していることを確認します）。
- 新しい版を出すときは、`.\tools\make-release.ps1 -RepoUrl https://github.com/Uechi-Shingo/right-click-translate` を実行し、できた `releases/` と README の変更を、そのままコミットします。
- **メールアドレスに注意**: コミットには、設定したメールアドレスが載り、公開されます。GitHub の「Settings → Emails」で、「Keep my email addresses private」と「Block command line pushes that expose my email」をオンにし、このフォルダでは次のように、非公開用のアドレスを設定してください（GitHub の画面に、`数字+ユーザー名@users.noreply.github.com` の形で表示されます）。

  ```powershell
  git config user.name "Uechi-Shingo"
  git config user.email "97339267+Uechi-Shingo@users.noreply.github.com"
  ```
- 公開してはいけないもの（APIキー・トークン・個人情報）をコミットしてしまったら、消しても履歴に残ります。キーなら、先に無効にしてください。

## 安全面の仕組み（要点）

| 項目 | 内容 |
| --- | --- |
| 権限 | `contextMenus` / `activeTab` / `scripting` / `storage` / `webRequest`（サインインの戻り先 1 つの観測だけ）と、Gemini・OpenAI への通信のみ |
| 通信先 | CSP により、画面・裏方（background）は `generativelanguage.googleapis.com`・`api.openai.com`・`auth.openai.com` 以外へ通信できない |
| キー・トークン | 設定画面と裏方だけが扱う。ページに差し込むスクリプトには渡さず、保存領域も信頼された領域だけに限定 |
| 保存方法 | 「保存しておく」をオフにすると、ブラウザを閉じたときに忘れる（共用 PC 向け）。ChatGPT のトークンも同じ扱い |
| サインイン | PKCE（S256）・state・nonce を毎回検証。利用枠の権限が付与されなければ受け付けない |
| 暴走防止 | 1 回の依頼 3 万文字まで / 1 回の翻訳開始で 15 万文字まで / 10 分間で 20 万文字・60 回まで |
| 検査 | 依頼の形式・サイズ・呼び出し元を検証。エラー表示ではキーを伏せ字にする |
| キャッシュ | サイト（ホスト名）ごとに分離。別サイトの表示に混ざらない |
| 同意 | 初回に注意事項の確認（チェック）を必須にする |

**限界**：ブラウザの保存領域は暗号化されません。パソコン自体がウイルス感染している場合などは防げません。
これらの検証は作成者による自己検証で、第三者の監査ではありません。

## 開発者向け

```
extension/    ブラウザに読み込むフォルダ（配布物の中身）
tests/        自動テスト・監査・確認用ページ
tools/        配布用 zip の作成スクリプト
```

| コマンド | 内容 |
| --- | --- |
| `node tests/static-audit.mjs` | 静的な監査（権限・通信先・CSP・禁止された書き方・キーの埋め込み 等） |
| `node tests/security.test.mjs` | 安全装置の自動テスト |
| `node tests/background.test.mjs` | 通信・翻訳動作の自動テスト |
| `node tests/chatgpt.test.mjs` | ChatGPT のプラン（サインイン・トークン更新・翻訳・利用枠の上限・安全面）の自動テスト。OpenAI は偽物に差し替え |
| `node tests/failover.test.mjs` | 併用（切り替え・上限に達したモデルを一定時間飛ばす・自動で戻る）と、ChatGPT の速さ優先の自動テスト |
| `node tests/roundtrip.test.mjs` | 翻訳結果の取り込みの正確さ（ランダムな文字列で、欠け・ずれがないか） |
| `node tests/perf-check.mjs "<ブラウザの exe>"` | 拡張機能自身の処理時間・ページ内の負荷・「元に戻す」の正確さを実ブラウザで測定 |
| `node tests/site-check.mjs "<ブラウザの exe>" <URL>…` | 実際のサイトで、ページ翻訳がどこまで効くか（コードを残すか、Shadow DOM・iframe の有無など）を確認。翻訳は偽の応答で、APIキーは不要 |
| `node tests/browser-load-check.mjs "<ブラウザの exe>"` | 実ブラウザ（一時プロファイル）に読み込んで安全装置を検証（偽キーを Google へ、認証なしの GET を OpenAI へ送る） |
| `node tests/context-check.mjs "<ブラウザの exe>"` | 実ブラウザで、依頼の区切り（段落の境目・見出し）と、文脈（タイトル・直前の見出し・直前の文章）の添え方を検証 |
| `node tests/ab-quality.mjs "<ブラウザの exe>" <URL>…` | 翻訳の質を、旧方式と新方式で、実際の Gemini を使って比べる（環境変数 `GEMINI_API_KEY` が必要。手順はファイル先頭。`--selftest` で、キーなしでツール自体の動作確認ができます） |
| `node tests/e2e-chatgpt.mjs "<ブラウザの exe>"` | 実ブラウザで、ChatGPT のサインイン → 戻り先の検知 → 翻訳 → 保存先の切り替え → サインアウト、併用での切り替えを検証（OpenAI への通信は偽物に差し替え。ポート 1455 が空いている必要があります） |
| `node tests/badge-check.mjs "<ブラウザの exe>"` | 実ブラウザで、右下の枠・選択範囲のパネルに、使ったモデルが出ることを検証 |
| `node tests/latency-probe.mjs [モデル名…]` | ブラウザを介さずに Gemini の応答時間を測る診断（環境変数 `GEMINI_API_KEY` が必要。手順はファイル先頭） |
| `node tests/build-harness.mjs <出力.html>` | ページ内動作を確かめる確認用ページを生成 |
| `node tests/build-options-harness.mjs <出力.html>` | 設定画面を確かめる確認用ページを生成 |

- 既定のモデルは `gemini-3.5-flash-lite`、予備は `gemini-3.8-flash`（Gemini 2.5 系は、Google の告知により新しいプロジェクトでは使えない場合があるため既定にしていません）。設定画面のモデル欄は、保存したキーで Google から利用可能な一覧を取得して新しい順に表示します
- コードを変えたら `brave://extensions` で「再読み込み」。配布前は必ず `make-release.ps1` を実行します
