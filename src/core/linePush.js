/**
 * LINE Messaging API：push 訊息與寫入 line_push_logs（供 LIFF、Webhook 共用）
 * messages 可為字串（text）、{ type: 'image', ... }、{ type: 'flex', altText, contents }
 */
function normalizeLinePushMessageItem(item) {
  if (typeof item === 'string') {
    const text = item.trim();
    return text ? { type: 'text', text } : null;
  }
  if (item && typeof item === 'object' && item.type === 'image') {
    const originalContentUrl = String(item.originalContentUrl || '').trim();
    const previewImageUrl = String(item.previewImageUrl || item.originalContentUrl || '').trim();
    if (!originalContentUrl || !previewImageUrl) return null;
    return { type: 'image', originalContentUrl, previewImageUrl };
  }
  if (item && typeof item === 'object' && item.type === 'flex') {
    const altText = String(item.altText || '').trim();
    const contents = item.contents;
    if (!altText || !contents || typeof contents !== 'object') return null;
    return { type: 'flex', altText, contents };
  }
  return null;
}

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

  // 把任意穩定字串轉成合法的 UUID（X-Line-Retry-Key 必須是 UUID 格式）
  function toRetryUuid(s) {
    const h = require('crypto').createHash('sha1').update(String(s)).digest('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32);
  }

  async function pushLineMessages(lineUserId, messages, extra = {}) {
    const normalizedMessages = Array.isArray(messages)
      ? messages.map(normalizeLinePushMessageItem).filter(Boolean)
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
          Authorization: `Bearer ${lineChannelAccessToken}`,
          // 冪等鍵：claim 重送 / sweep 重跑時 LINE 端去重，避免重複投遞給真用戶
          ...(extra.retryKey ? { 'X-Line-Retry-Key': toRetryUuid(extra.retryKey) } : {})
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

  /**
   * Reply API：用 webhook 事件的 replyToken 回覆（免推播額度）。
   * 注意 reply token 一次性且有效期短，呼叫端要保證同一 token 只用一次。
   */
  async function replyLineMessages(replyToken, messages, extra = {}) {
    const normalizedMessages = Array.isArray(messages)
      ? messages.map(normalizeLinePushMessageItem).filter(Boolean)
      : [];
    const pushType = typeof extra.pushType === 'string' && extra.pushType.trim() ? extra.pushType.trim() : 'keyword_reply';
    const { pushType: _pt, ...extraForBody } = extra;
    const logPayload = {
      userId: extra.userId || null,
      lineUserId: extra.lineUserId || null,
      pushType,
      body: { messages: normalizedMessages, ...extraForBody }
    };
    if (!replyToken || !lineChannelAccessToken || normalizedMessages.length === 0) {
      await logLinePush({
        ...logPayload,
        status: 'skipped',
        detail: !replyToken
          ? 'missing_reply_token'
          : !lineChannelAccessToken
            ? 'missing_channel_access_token'
            : 'empty_messages'
      });
      return false;
    }
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lineChannelAccessToken}`
        },
        body: JSON.stringify({
          replyToken,
          messages: normalizedMessages
        })
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        console.error('LINE reply failed:', response.status, detail);
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
      console.error('LINE reply failed:', err.message);
      await logLinePush({
        ...logPayload,
        status: 'failed',
        detail: String(err.message || 'network_error').slice(0, 1500)
      });
      return false;
    }
  }

  return { logLinePush, pushLineMessages, replyLineMessages };
}

module.exports = { createLinePushService };
