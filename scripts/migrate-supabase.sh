#!/usr/bin/env bash
# 從舊 Supabase 專案 dump，還原到新專案。連線請寫在專案根目錄 .env.migrate（勿提交）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v pg_dump >/dev/null 2>&1; then
  for d in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
    if [[ -x "$d/pg_dump" ]]; then
      export PATH="$d:$PATH"
      break
    fi
  done
fi

if [[ ! -f .env.migrate ]]; then
  echo "缺少 $ROOT/.env.migrate"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ROOT/.env.migrate"
set +a

: "${OLD_DATABASE_URL:?請在 .env.migrate 設定 OLD_DATABASE_URL}"
: "${NEW_DATABASE_URL:?請在 .env.migrate 設定 NEW_DATABASE_URL}"

DUMP="$ROOT/supabase_backup.dump"
LOG="$ROOT/supabase_restore.log"

command -v pg_dump >/dev/null 2>&1 || {
  echo "找不到 pg_dump。Mac 可執行: brew install libpq && echo 'export PATH=\"\$(brew --prefix libpq)/bin:\$PATH\"' >> ~/.zshrc"
  exit 1
}

echo "==> Dump 舊庫..."
if ! pg_dump --format=custom --no-owner --file="$DUMP" "$OLD_DATABASE_URL"; then
  echo ""
  echo "若錯誤為 could not translate host name：Direct 連線 (db.*.supabase.co) 常僅支援 IPv6。"
  echo "請到 Supabase 專案 → Connect → 選「Session pooler」，複製 URI（port 5432，使用者名 postgres.專案REF），"
  echo "更新 .env.migrate 的 OLD_DATABASE_URL / NEW_DATABASE_URL 後再執行本腳本。"
  exit 1
fi

echo "==> Restore 至新庫（部分物件錯誤可忽略，見 $LOG）..."
set +e
pg_restore --dbname="$NEW_DATABASE_URL" --no-owner --no-acl --verbose "$DUMP" 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
set -e

echo ""
echo "pg_restore 結束碼: $RC（非 0 時請檢查 $LOG，常見為 extension/owner 已存在）"
echo "備份檔: $DUMP"
exit 0
