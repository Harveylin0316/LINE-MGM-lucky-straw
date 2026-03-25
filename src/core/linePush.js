/**
 * LINE Messaging API：push 訊息與寫入 line_push_logs（供 LIFF、Webhook 共用）
 */
function createLinePushService({ query, lineChannelAccessToken }) {
  async function logLinePush(payload) {
    try {
      await query(
        `INSERT INTO line_push_logs
          (user_id, line_user_id, push_type, status, http_status, detail, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          payload.userId || null,
          payload.lineUserId || null,
          payload.pushType || 'unknown',
          payload.status || 'unknown',
          typeof payload.httpStatus === 'number' ? payload.httpStatus : null,
          payload.detail || null,
          JSON.stringify(payload.body || {})
        ]
      );
    } catch (err) {
      console.error('LINE push log failed:', err.message);
    }
  }

  async function pushLineMessages(lineUserId, messages, extra = {}) {
    const normalizedMessages = Array.isArray(messages)
      ? messages
          .map(item => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
          .map(text => ({ type: 'text', text }))
      : [];
    const pushType = typeof extra.pushType === 'string' && extra.pushType.trim() ? extra.pushType.trim() : 'winner_notification';
    const { pushType: _pt, ...extraForBody } = extra;
    const logPayload = {
      userId: extra.userId || null,
      lineUserId,
      pushType,
      body: { messages: normalizedMessages, ...extraForBody }
    };
    if (!lineUserId || !lineChannelAccessToken || normalizedMessages.length === 0) {
      await logLinePush({
        ...logPayload,
        status: 'skipped',
        detail: !lineUserId
          ? 'missing_line_user_id'
          : !lineChannelAccessToken
            ? 'missing_channel_access_token'
            : 'empty_messages'
      });
      return false;
    }
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lineChannelAccessToken}`
        },
        body: JSON.stringify({
          to: lineUserId,
          messages: normalizedMessages
        })
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        console.error('LINE push failed:', response.status, detail);
        await logLinePush({
          ...logPayload,
          status: 'failed',
          httpStatus: Number(response.status),
          detail: detail ? String(detail).slice(0, 1500) : 'line_api_error'
        });
        return false;
      }
      await logLinePush({
        ...logPayload,
        status: 'success',
        httpStatus: Number(response.status)
      });
      return true;
    } catch (err) {
      console.error('LINE push failed:', err.message);
      await logLinePush({
        ...logPayload,
        status: 'failed',
        detail: String(err.message || 'network_error').slice(0, 1500)
      });
      return false;
    }
  }

  return { logLinePush, pushLineMessages };
}

module.exports = { createLinePushService };
