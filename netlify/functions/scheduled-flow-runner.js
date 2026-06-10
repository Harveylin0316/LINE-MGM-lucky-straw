/**
 * Netlify Scheduled Function：每 5 分鐘觸發自動化流程引擎。
 *
 * 呼叫 /admin/flows/run，該 endpoint 會：
 *   1. 跑 schedule 觸發（到點的定時流程 enroll 受眾）
 *   2. 跑 event 觸發（掃 user_events 新事件 enroll）
 *   3. 推進所有到期的 enrollment（發訊息 / 等待 / 條件分支）
 *
 * 環境變數：URL、SCHEDULED_RUNNER_SECRET（與群發共用）
 * Schedule 在 netlify.toml 設定。
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
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/flows/run`, {
      method: 'POST',
      headers: { 'X-Scheduler-Secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'netlify-scheduled-flows' })
    });
    const text = await res.text();
    return { statusCode: res.status, body: text };
  } catch (e) {
    console.error('scheduled-flow-runner error:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e && e.message }) };
  }
};
