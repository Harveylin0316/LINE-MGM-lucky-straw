/**
 * Email Provider：Brevo (Sendinblue) Transactional Email API 整合
 *
 * 環境變數：
 *   BREVO_API_KEY              - Brevo API key (xkeysib-...)
 *   BREVO_SENDER_EMAIL         - 預設寄件人 email
 *   BREVO_SENDER_NAME          - 預設寄件人名稱
 *   BREVO_WEBHOOK_SECRET       - webhook 驗證 secret（可選，加在 X-Mailin-custom 對應）
 *
 * 主要 API：
 *   sendEmail({ to, subject, html, ... })
 *   sendBatch(messages)
 */

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

function createEmailProvider({ query } = {}) {
  const apiKey = process.env.BREVO_API_KEY || '';
  const defaultSenderEmail = process.env.BREVO_SENDER_EMAIL || '';
  const defaultSenderName = process.env.BREVO_SENDER_NAME || 'OpenRice';

  function isConfigured() {
    return !!apiKey && !!defaultSenderEmail;
  }

  async function logEmailPush(payload) {
    if (!query) return;
    try {
      await query(
        `INSERT INTO line_push_logs
          (user_id, line_user_id, push_type, status, http_status, detail, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          payload.userId || null,
          null,
          payload.pushType || 'email_broadcast',
          payload.status || 'unknown',
          typeof payload.httpStatus === 'number' ? payload.httpStatus : null,
          payload.detail || null,
          JSON.stringify({ email: payload.email || null, body: payload.body || {} })
        ]
      );
    } catch (err) {
      console.error('Email push log failed:', err.message);
    }
  }

  /**
   * 發送單封 email
   * @param {Object} opts
   * @param {string} opts.to                收件人 email
   * @param {string} [opts.toName]          收件人名稱
   * @param {string} opts.subject           主旨
   * @param {string} opts.html              HTML 內文
   * @param {string} [opts.text]            純文字版本（沒給的話 Brevo 會自動產生）
   * @param {string} [opts.senderEmail]     覆寫寄件人 email
   * @param {string} [opts.senderName]      覆寫寄件人名稱
   * @param {string} [opts.replyTo]         回覆 email
   * @param {Object} [opts.customMetadata]  會放進 X-Mailin-custom header 給 webhook 帶回（broadcast_id / recipient_id / variant）
   * @param {string[]} [opts.tags]          Brevo tag (用來分類 dashboard)
   * @returns {Promise<{ ok: boolean, messageId?: string, status?: number, error?: string }>}
   */
  async function sendEmail(opts) {
    const {
      to,
      toName,
      subject,
      html,
      text,
      senderEmail,
      senderName,
      replyTo,
      customMetadata,
      tags
    } = opts || {};

    if (!isConfigured()) {
      const error = 'brevo_not_configured';
      await logEmailPush({
        email: to,
        pushType: 'email_broadcast',
        status: 'skipped',
        detail: error,
        body: { subject }
      });
      return { ok: false, error };
    }

    if (!to || !subject || !html) {
      const error = 'missing_required_fields';
      await logEmailPush({
        email: to,
        pushType: 'email_broadcast',
        status: 'skipped',
        detail: error,
        body: { subject }
      });
      return { ok: false, error };
    }

    const body = {
      sender: {
        email: senderEmail || defaultSenderEmail,
        name: senderName || defaultSenderName
      },
      to: [{ email: to, name: toName || undefined }],
      subject,
      htmlContent: html
    };

    if (text) body.textContent = text;
    if (replyTo) body.replyTo = { email: replyTo };
    if (Array.isArray(tags) && tags.length) body.tags = tags.slice(0, 5);

    // X-Mailin-custom header 會在 webhook 事件裡回傳，用來關聯 recipient
    if (customMetadata && typeof customMetadata === 'object') {
      body.headers = body.headers || {};
      body.headers['X-Mailin-custom'] = JSON.stringify(customMetadata);
    }

    try {
      const response = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(body)
      });

      const respText = await response.text().catch(() => '');
      let respJson = null;
      try { respJson = respText ? JSON.parse(respText) : null; } catch (_) { /* ignore */ }

      if (!response.ok) {
        const detail = (respJson && (respJson.message || respJson.code)) || respText || 'brevo_api_error';
        await logEmailPush({
          email: to,
          pushType: 'email_broadcast',
          status: 'failed',
          httpStatus: Number(response.status),
          detail: String(detail).slice(0, 1500),
          body: { subject }
        });
        return { ok: false, status: response.status, error: String(detail) };
      }

      const messageId = respJson && respJson.messageId ? String(respJson.messageId) : '';
      await logEmailPush({
        email: to,
        pushType: 'email_broadcast',
        status: 'success',
        httpStatus: Number(response.status),
        body: { subject, messageId }
      });
      return { ok: true, status: response.status, messageId };
    } catch (err) {
      const detail = String(err && err.message ? err.message : err).slice(0, 1500);
      console.error('Brevo sendEmail failed:', detail);
      await logEmailPush({
        email: to,
        pushType: 'email_broadcast',
        status: 'failed',
        detail,
        body: { subject }
      });
      return { ok: false, error: detail };
    }
  }

  /**
   * 批次發送（內部仍是逐一呼叫 sendEmail；Brevo 沒有真正的 batch API for transactional，
   * 但 free plan 限制 300/日，序列化即可避免 rate limit）
   * @param {Array} messages   每個元素為 sendEmail 的 opts
   * @returns {Promise<Array<{ ok, messageId, error, to }>>}
   */
  async function sendBatch(messages) {
    const results = [];
    if (!Array.isArray(messages)) return results;
    for (const msg of messages) {
      const r = await sendEmail(msg);
      results.push({ to: msg && msg.to, ...r });
    }
    return results;
  }

  return {
    isConfigured,
    sendEmail,
    sendBatch,
    getDefaultSender: () => ({ email: defaultSenderEmail, name: defaultSenderName })
  };
}

module.exports = { createEmailProvider };
