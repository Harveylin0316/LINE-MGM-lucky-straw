/**
 * Email Provider：電子豹 SureNotify Transactional Email API 整合
 *
 * 與 Brevo adapter（emailProvider.js）完全相同的介面，可 drop-in 替換：
 *   { isConfigured, sendEmail, sendBatch, getDefaultSender }
 *
 * 環境變數：
 *   SURENOTIFY_API_KEY          - API key（放 x-api-key header）
 *   SURENOTIFY_SENDER_EMAIL     - 預設寄件人 email（沒設則退回 BREVO_SENDER_EMAIL）
 *   SURENOTIFY_SENDER_NAME      - 預設寄件人名稱（沒設則退回 BREVO_SENDER_NAME）
 *
 * API 摘要（docs：https://newsleopard.com/surenotify/api/v1/）：
 *   POST https://mail.surenotifyapi.com/v1/messages
 *   header：x-api-key
 *   body：{ subject, fromName, fromAddress, content(HTML), unsubscribedLink?, recipients:[{name,address,variables}] }
 *   每次最多 100 收件人；此 adapter 逐封送（維持與 Brevo 相同的 per-recipient 行為）。
 *   回應：{ id, success:[{id,address}], failure:{} }
 *   收件人的 variables 會在 webhook 事件裡以 mail.variables 帶回 → 拿來關聯 broadcast/recipient。
 */

const SURENOTIFY_ENDPOINT = 'https://mail.surenotifyapi.com/v1/messages';

function createSureNotifyProvider({ query } = {}) {
  const apiKey = process.env.SURENOTIFY_API_KEY || '';
  const defaultSenderEmail = process.env.SURENOTIFY_SENDER_EMAIL || process.env.BREVO_SENDER_EMAIL || '';
  const defaultSenderName = process.env.SURENOTIFY_SENDER_NAME || process.env.BREVO_SENDER_NAME || 'OpenRice';

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

  // customMetadata（broadcast_id/recipient_id/variant）→ variables（值需為字串、每值 <=100 字）
  function toVariables(customMetadata) {
    if (!customMetadata || typeof customMetadata !== 'object') return undefined;
    const out = {};
    Object.keys(customMetadata).forEach(function (k) {
      const v = customMetadata[k];
      if (v == null) return;
      out[k] = String(v).slice(0, 100);
    });
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * 發送單封 email（介面同 Brevo adapter 的 sendEmail）
   * @returns {Promise<{ ok:boolean, messageId?:string, status?:number, error?:string }>}
   */
  async function sendEmail(opts) {
    const {
      to, toName, subject, html,
      senderEmail, senderName,
      unsubscribedLink, customMetadata
    } = opts || {};

    if (!isConfigured()) {
      const error = 'surenotify_not_configured';
      await logEmailPush({ email: to, status: 'skipped', detail: error, body: { subject } });
      return { ok: false, error };
    }
    if (!to || !subject || !html) {
      const error = 'missing_required_fields';
      await logEmailPush({ email: to, status: 'skipped', detail: error, body: { subject } });
      return { ok: false, error };
    }

    const body = {
      subject: subject,
      fromName: senderName || defaultSenderName,
      fromAddress: senderEmail || defaultSenderEmail,
      content: html,
      recipients: [
        {
          name: toName || undefined,
          address: to,
          variables: toVariables(customMetadata)
        }
      ]
    };
    if (unsubscribedLink) body.unsubscribedLink = unsubscribedLink;

    try {
      const response = await fetch(SURENOTIFY_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(body)
      });

      const respText = await response.text().catch(() => '');
      let respJson = null;
      try { respJson = respText ? JSON.parse(respText) : null; } catch (_) { /* ignore */ }

      // HTTP 錯誤
      if (!response.ok) {
        const detail = (respJson && (respJson.message || respJson.error)) || respText || 'surenotify_api_error';
        await logEmailPush({ email: to, status: 'failed', httpStatus: Number(response.status), detail: String(detail).slice(0, 1500), body: { subject } });
        return { ok: false, status: response.status, error: String(detail) };
      }

      // 200 但該收件人落在 failure（電子豹逐收件人回報成敗）
      const success = (respJson && Array.isArray(respJson.success)) ? respJson.success : [];
      const failure = (respJson && respJson.failure) || {};
      const hit = success.find(function (s) { return s && String(s.address || '').toLowerCase() === String(to).toLowerCase(); });
      const failureNonEmpty = failure && typeof failure === 'object' && Object.keys(failure).length > 0;
      if (!hit && (failureNonEmpty || success.length === 0)) {
        const detail = 'surenotify_recipient_rejected:' + (respText || '').slice(0, 300);
        await logEmailPush({ email: to, status: 'failed', httpStatus: Number(response.status), detail: detail, body: { subject } });
        return { ok: false, status: response.status, error: detail };
      }

      const messageId = hit && hit.id ? String(hit.id) : (respJson && respJson.id ? String(respJson.id) : '');
      await logEmailPush({ email: to, status: 'success', httpStatus: Number(response.status), body: { subject, messageId } });
      return { ok: true, status: response.status, messageId };
    } catch (err) {
      const detail = String(err && err.message ? err.message : err).slice(0, 1500);
      console.error('SureNotify sendEmail failed:', detail);
      await logEmailPush({ email: to, status: 'failed', detail, body: { subject } });
      return { ok: false, error: detail };
    }
  }

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

module.exports = { createSureNotifyProvider };
