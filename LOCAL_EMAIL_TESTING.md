# Email 推播 — 本地測試指引

## 1. 環境變數（.env）

在你本地的 `.env` 加上：

```bash
# 必填
BREVO_API_KEY=xkeysib-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
BREVO_SENDER_EMAIL=noreply@yourdomain.com   # 必須是 Brevo 已驗證的 email
BREVO_SENDER_NAME=OpenRice 開飯喇

# 選填（建議）— 本地測試先留空，要設 webhook 時再加
BREVO_WEBHOOK_SECRET=random-string-here
```

> 沒設 `BREVO_API_KEY` 也能啟動，只是 email broadcast 會被擋掉，可以先看 UI / DB。

## 2. DB schema

已透過 Supabase MCP 跑過 migration，不需要手動執行：

- `admin_broadcasts` 加了 `channel` / `email_subject` / `email_from_name` / `email_from_address`
- `admin_broadcast_recipients` 加了 `email` / `provider_message_id` / `opened_at` / `first_clicked_at` / `bounced_at` / `unsubscribed_at`
- `admin_recipient_list_members` 加了 `email` / `display_name`，`line_user_id` 改成可為 null
- 新建 `admin_email_unsubscribes` 表
- `admin_broadcast_views` / `admin_broadcast_clicks` 加了 `email` 欄位
- 加了 partial unique index：`(list_id, lower(email)) WHERE email IS NOT NULL`

## 3. 啟動

```bash
npm install
npm run dev   # 或 npm start
```

開瀏覽器到 `http://localhost:3000`（看 app.js 預設 port），登入後台。

## 4. 測試流程

### Step 1. 建一份 email 名單
1. 進 `/admin/recipient-lists`
2. 點「＋ 新增名單」，命名例如「Email 測試 - Harvey」
3. 點進去 → 「＋ 加入成員」→ **切到「Email」tab** → 貼自己的 email → 加入

### Step 2. 編 email broadcast
1. 進 `/admin/broadcast`
2. 上方 **通道** 切到「Email 信件」
   - 應該看到提示文字變成 Brevo 那段
   - 收件人 tab 自動切到「已儲存名單」（條件 / 上傳被隱藏）
3. 收件人選剛建的「Email 測試 - Harvey」名單
4. 訊息內容區：
   - **主旨**（必填）
   - 寄件人名稱 / Email（留空就用 .env 預設）
   - 內容欄位（title / subtitle / couponCode / disclaimer / CTA）跟 LINE 模板共用
5. 右側預覽會用 iframe 載入產出的 email HTML（即時更新）

### Step 3. 先用測試發送
1. 展開「新增 / 用其他 LINE userId 臨時發送」
2. Email 通道時會看到「Email 測試 — 發給單一收件 email」欄位
3. 填自己的 email → 點「發測試 Email」
4. 檢查你收件匣（有可能進垃圾信，標為「不是垃圾」可幫到達率）

### Step 4. 正式送
- 步驟跟 LINE 完全一樣（立即送 / 排程）
- 排程版需設 `SCHEDULED_RUNNER_SECRET` + Netlify scheduled function（本地測不到 cron，但可以手動 POST `/admin/broadcast/run-scheduled` 帶 secret 模擬）

## 5. Webhook 設定（要看開信/點擊統計才需要）

本地測試 webhook 需要 ngrok 之類的 tunnel：

```bash
# 1. 開 ngrok
ngrok http 3000
# 拿到 https://abc-123.ngrok-free.app

# 2. Brevo Settings → Transactional → Settings → Webhook
# 加新 webhook：
#   URL: https://abc-123.ngrok-free.app/webhooks/brevo?s=你的BREVO_WEBHOOK_SECRET
#   勾選事件：delivered, opened, click, hard_bounce, soft_bounce, unsubscribed, complaint, blocked
```

事件進來後會自動：
- 更新 `admin_broadcast_recipients.opened_at` / `first_clicked_at` / `bounced_at` / `unsubscribed_at`
- 寫 `admin_broadcast_views` / `admin_broadcast_clicks` 跟 LINE 共用一張表
- 退訂事件寫 `admin_email_unsubscribes`

不設 webhook 也能發信，只是後台拿不到開信率/點擊率。

## 6. 主要新增/修改的檔案

- `src/core/emailProvider.js` （新）— Brevo API 封裝
- `src/core/emailTemplates.js` （新）— Email HTML 模板（呼應 LINE Flex 模板）
- `src/core/broadcastAudience.js` — `previewAudience` / `fetchAudienceRecipients` 加 `channel` 參數
- `src/routes/adminBroadcast.js` — channel 分支 + webhook + unsubscribe + tracking pixel
- `src/routes/adminRecipientLists.js` — POST members 支援 emails 陣列
- `src/app.js` — wire emailProvider
- `views/admin_broadcast.ejs` — channel tabs + email 欄位
- `views/admin_recipient_list_detail.ejs` — modal 加 Email tab + 顯示 email 成員
- `public/admin-broadcast.js` — channel 切換邏輯 + email preview iframe + test-push 支援 email

## 7. 常見問題

- **送出回 `email_provider_not_configured`** → 檢查 `.env` 的 `BREVO_API_KEY` 跟 `BREVO_SENDER_EMAIL`
- **送出回 `email_subject_required`** → 主旨欄位忘了填
- **送出回 `email_requires_saved_list`** → Email 必須從名單庫選名單（不能用條件式 audience）
- **送出回 `no_email_recipients`** → 名單裡沒有 email 成員
- **Brevo API 回 400** → 多半是 sender email 沒驗證，去 Brevo Settings → Senders 確認
- **iframe 預覽空白** → 主旨還沒填 / 或內容欄位都空。看 console 有沒有 `email_subject_required` 之類錯誤
