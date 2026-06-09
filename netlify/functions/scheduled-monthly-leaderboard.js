/**
 * Netlify Scheduled Function：每月 1 號 03:30 UTC（= 台北 11:30）觸發一次。
 *
 * 工作：HTTP 呼叫 /admin/broadcast/run-monthly-leaderboard，
 * 該 endpoint 會：
 *   1. 從 booking-report 撈上月訂位 Top N
 *   2. 組成 LINE Flex carousel
 *   3. 建立 status=running 的 broadcast + 全好友 recipients（每月只建一次）
 *   4. 由每 5 分鐘的 scheduled-broadcast-runner 逐批送出
 *
 * 環境變數：
 *   - URL：Netlify 自動注入的主網域
 *   - SCHEDULED_RUNNER_SECRET：跟 server 端共享的 secret
 *
 * Schedule 在 netlify.toml 設定（cron 為 UTC）。
 */

exports.handler = async () => {
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || '';
  const secret = process.env.SCHEDULED_RUNNER_SECRET || '';
  if (!baseUrl) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_URL_env' }) };
  }
  if (!secret) {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'no_SCHEDULED_RUNNER_SECRET' }) };
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/broadcast/run-monthly-leaderboard`, {
      method: 'POST',
      headers: {
        'X-Scheduler-Secret': secret,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ source: 'netlify-scheduled-monthly' })
    });
    const text = await res.text();
    return { statusCode: res.status, body: text };
  } catch (e) {
    console.error('scheduled-monthly-leaderboard error:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e && e.message }) };
  }
};
