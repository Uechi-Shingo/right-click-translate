#!/usr/bin/env bash
# 検証を 1 つ実行する。失敗したときは、原因（NG の項目・エラーの行）を、GitHub の「注釈（アノテーション）」に出す。
# 注釈は、Actions の画面と、公開 API（チェックの結果）から読める。ログを開かなくても、失敗の理由が分かる。
#
# 使い方: bash .github/scripts/run-check.sh <表示名> <実行するコマンド...>
set -u
title="$1"
shift

out="$(mktemp)"
"$@" >"$out" 2>&1
code=$?
cat "$out"

if [ "$code" -ne 0 ]; then
  # NG の行とエラーの行（と、その直後の詳細）を集める。何もなければ、出力の末尾を使う
  detail="$(grep -E '^  NG|エラー|Error|error' -A2 "$out" | head -c 1800)"
  if [ -z "$detail" ]; then
    detail="$(tail -c 1500 "$out")"
  fi
  # ワークフローコマンドの書式: % → %25、改行 → %0A、復帰 → %0D
  detail="$(printf '%s' "$detail" | sed ':a;N;$!ba;s/%/%25/g;s/\r/%0D/g;s/\n/%0A/g')"
  echo "::error title=${title} が失敗しました（終了コード ${code}）::${detail}"
else
  # 成功したときも、結果の行（例: 「15 / 15 件成功」）を注釈に残す。実際に検証が行われたことを、ログを開かずに確認できる
  summary="$(grep -E '件成功' "$out" | tail -n 1)"
  echo "::notice title=${title}::${summary:-完了}"
fi
exit "$code"
