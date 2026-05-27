/**
 * Email HTML 模板 builder（對應 broadcastTemplates.js 的 LINE Flex 模板）
 *
 * 跟 LINE 模板的欄位對齊：title / subtitle / couponCode / disclaimer / ctaLabel / ctaUrl / heroMediaId
 * Email 額外需要：subject、unsubscribe link、open tracking pixel
 *
 * 設計重點：
 * - 600px 固定寬度（業界標準）
 * - table-based layout（最相容，避免 Outlook 把 div 拆爛）
 * - 全部 inline CSS（部分 mail client 會剔除 <style>）
 * - 退訂連結（CAN-SPAM 法規必要）
 * - 1x1 透明 pixel 開信追蹤（Brevo webhook 也會回傳 open 事件，雙保險）
 */

const COLORS = {
  bg: '#F9FAFB',              // 整封信背景灰
  cardBg: '#FFFFFF',          // 卡片白
  brandYellow: '#FCC726',     // OpenRice 黃
  couponBoxBg: '#FFFBEB',
  couponBorder: '#FCC726',
  couponLabel: '#92400E',
  couponCode: '#1F2937',
  titleText: '#1F2937',
  subtitleText: '#4B5563',
  disclaimerText: '#9CA3AF',
  buttonBg: '#FCC726',
  buttonText: '#1F2937',
  footerText: '#9CA3AF',
  linkText: '#6B7280'
};

const FIELD_LIMITS = {
  subject: 200,
  title: 100,
  subtitle: 2000,
  couponCode: 60,
  disclaimer: 500,
  ctaLabel: 40,
  ctaUrl: 1000
};

function clip(s, max) {
  return String(s == null ? '' : s).slice(0, max);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidHttpUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeEmailTemplateInput(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  return {
    subject: clip(String(safe.subject || safe.emailSubject || '').trim(), FIELD_LIMITS.subject),
    title: clip(String(safe.title || '').trim(), FIELD_LIMITS.title),
    subtitle: clip(String(safe.subtitle || '').trim(), FIELD_LIMITS.subtitle),
    couponCode: clip(String(safe.couponCode || '').trim(), FIELD_LIMITS.couponCode),
    disclaimer: clip(String(safe.disclaimer || '').trim(), FIELD_LIMITS.disclaimer),
    ctaLabel: clip(String(safe.ctaLabel || '').trim(), FIELD_LIMITS.ctaLabel),
    ctaUrl: clip(String(safe.ctaUrl || '').trim(), FIELD_LIMITS.ctaUrl)
  };
}

function validateEmailTemplateInput(input) {
  const t = normalizeEmailTemplateInput(input);
  if (!t.subject) {
    return { ok: false, error: 'Email 主旨必填。' };
  }
  if (!t.title && !t.subtitle && !t.couponCode) {
    return { ok: false, error: '請至少填入標題、副標題或優惠碼。' };
  }
  if ((t.ctaLabel && !t.ctaUrl) || (!t.ctaLabel && t.ctaUrl)) {
    return { ok: false, error: 'CTA 按鈕的文字與連結需同時填寫，或同時留空。' };
  }
  if (t.ctaUrl && !isValidHttpUrl(t.ctaUrl)) {
    return { ok: false, error: 'CTA 連結需為 http:// 或 https:// 開頭的有效網址。' };
  }
  return { ok: true, value: t };
}

/**
 * 把 subtitle 內以 \n\n 分隔的段落 + 單行 \n 換行轉成 HTML
 */
function subtitleToHtml(subtitle) {
  if (!subtitle) return '';
  const paragraphs = subtitle.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  return paragraphs.map(p => {
    const lines = p.split('\n').map(escapeHtml).join('<br>');
    return `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.7;color:${COLORS.subtitleText};">${lines}</p>`;
  }).join('');
}

/**
 * 建出整封 email HTML
 * @param {Object} t                  normalized template input
 * @param {Object} opts
 * @param {string} [opts.heroImageUrl]   hero 圖 URL（有的話塞在卡片頂）
 * @param {string} [opts.ctaUrl]         CTA 點擊用的最終 URL（已包好追蹤 redirect）
 * @param {string} [opts.unsubscribeUrl] 退訂連結（必須）
 * @param {string} [opts.openPixelUrl]   1x1 開信追蹤 pixel URL（可選；Brevo 也會自動加）
 * @param {string} [opts.previewText]    預覽文字（inbox preview，不顯示在內容裡）
 * @returns {string} HTML
 */
function buildEmailHtml(t, opts = {}) {
  const {
    heroImageUrl,
    ctaUrl,
    unsubscribeUrl,
    openPixelUrl,
    previewText
  } = opts;

  const previewSnippet = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(previewText)}</div>`
    : '';

  const heroBlock = heroImageUrl
    ? `<tr>
        <td style="padding:0;">
          <img src="${escapeHtml(heroImageUrl)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;">
        </td>
      </tr>`
    : '';

  const titleBlock = t.title
    ? `<tr>
        <td style="padding:32px 32px 0 32px;">
          <h1 style="margin:0;font-size:24px;line-height:1.4;color:${COLORS.titleText};font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">${escapeHtml(t.title)}</h1>
        </td>
      </tr>`
    : '';

  const subtitleBlock = t.subtitle
    ? `<tr>
        <td style="padding:16px 32px 0 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">
          ${subtitleToHtml(t.subtitle)}
        </td>
      </tr>`
    : '';

  const couponBlock = t.couponCode
    ? `<tr>
        <td style="padding:8px 32px 0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.couponBoxBg};border:1px solid ${COLORS.couponBorder};border-radius:8px;">
            <tr><td align="center" style="padding:16px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">
              <div style="font-size:12px;color:${COLORS.couponLabel};margin-bottom:6px;">優惠碼</div>
              <div style="font-size:26px;font-weight:700;color:${COLORS.couponCode};letter-spacing:2px;">${escapeHtml(t.couponCode)}</div>
            </td></tr>
          </table>
        </td>
      </tr>`
    : '';

  const disclaimerBlock = t.disclaimer
    ? `<tr>
        <td style="padding:16px 32px 0 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:${COLORS.disclaimerText};">${escapeHtml(t.disclaimer).replace(/\n/g, '<br>')}</p>
        </td>
      </tr>`
    : '';

  const ctaTarget = ctaUrl || t.ctaUrl || '';
  const ctaBlock = (t.ctaLabel && ctaTarget)
    ? `<tr>
        <td style="padding:32px 32px 0 32px;" align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" style="background:${COLORS.buttonBg};border-radius:12px;">
              <a href="${escapeHtml(ctaTarget)}" target="_blank" style="display:inline-block;padding:16px 40px;font-size:16px;font-weight:700;color:${COLORS.buttonText};text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;">${escapeHtml(t.ctaLabel)}</a>
            </td></tr>
          </table>
        </td>
      </tr>`
    : '';

  // 卡片底部 padding（保證最後一個元素跟卡片底之間有空間）
  const bottomPaddingBlock = `<tr><td style="padding:0 32px 32px 32px;"></td></tr>`;

  const footerHtml = `
    <tr>
      <td style="padding:24px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang TC','Microsoft JhengHei',sans-serif;" align="center">
        <p style="margin:0 0 8px 0;font-size:12px;color:${COLORS.footerText};">© OpenRice 開飯喇 · 台灣</p>
        ${unsubscribeUrl ? `<p style="margin:0;font-size:12px;color:${COLORS.linkText};"><a href="${escapeHtml(unsubscribeUrl)}" style="color:${COLORS.linkText};text-decoration:underline;">取消訂閱</a></p>` : ''}
      </td>
    </tr>
  `;

  const openPixel = openPixelUrl
    ? `<img src="${escapeHtml(openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;outline:none;width:1px;height:1px;">`
    : '';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(t.subject || 'OpenRice')}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bg};">
${previewSnippet}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.bg};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${COLORS.cardBg};border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
        ${heroBlock}
        ${titleBlock}
        ${subtitleBlock}
        ${couponBlock}
        ${disclaimerBlock}
        ${ctaBlock}
        ${bottomPaddingBlock}
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
        ${footerHtml}
      </table>
    </td>
  </tr>
</table>
${openPixel}
</body>
</html>`;
}

/**
 * 從純文字版的 subtitle 抓出來，組純文字 fallback（給不支援 HTML 的 mail client）
 */
function buildEmailText(t, { ctaUrl, unsubscribeUrl } = {}) {
  const lines = [];
  if (t.title) lines.push(t.title, '');
  if (t.subtitle) lines.push(t.subtitle, '');
  if (t.couponCode) lines.push(`優惠碼：${t.couponCode}`, '');
  if (t.disclaimer) lines.push(t.disclaimer, '');
  if (t.ctaLabel && (ctaUrl || t.ctaUrl)) lines.push(`${t.ctaLabel}：${ctaUrl || t.ctaUrl}`, '');
  lines.push('---');
  lines.push('OpenRice 開飯喇 · 台灣');
  if (unsubscribeUrl) lines.push(`取消訂閱：${unsubscribeUrl}`);
  return lines.join('\n');
}

/**
 * 對應 broadcastTemplates.buildLineMessages 的 email 版本
 *
 * @param {Object} messageConfig          { template: {...}, mode: 'template' }
 * @param {string} emailSubject           Email 主旨（從 admin_broadcasts.email_subject 來）
 * @param {Object} opts
 * @param {string} opts.heroImageBaseUrl  hero 圖公開 URL base（line_push_media）
 * @param {number} opts.broadcastId       廣播 ID（給 CTA / open pixel tracking）
 * @param {number} [opts.recipientId]     收件人 ID（per-recipient tracking）
 * @param {string} [opts.variant]         'a' | 'b'
 * @param {string} opts.origin            APP_BASE_URL or request origin
 * @returns {{ ok: boolean, subject?: string, html?: string, text?: string, error?: string }}
 */
function buildEmailMessage(messageConfig, emailSubject, opts = {}) {
  const cfg = messageConfig && typeof messageConfig === 'object' ? messageConfig : {};
  const tpl = cfg.template && typeof cfg.template === 'object' ? cfg.template : {};
  const merged = { ...tpl, subject: emailSubject || tpl.subject || '' };

  const v = validateEmailTemplateInput(merged);
  if (!v.ok) return { ok: false, error: v.error };
  const t = v.value;

  const {
    heroImageBaseUrl,
    broadcastId,
    recipientId,
    variant,
    origin
  } = opts;

  const variantSuffix = (variant === 'a' || variant === 'b') ? `?v=${variant}` : '';
  const rSeg = (recipientId != null && Number.isFinite(Number(recipientId)))
    ? `/${Number(recipientId)}`
    : '';

  // hero 圖：經過 /v/b/:bid/:rid/:mediaId 中介，順便當開信追蹤
  let heroImageUrl = '';
  const heroMediaId = t.heroMediaId || (tpl.heroMediaId || null);
  // 注意：t 沒帶 heroMediaId（normalizeEmailTemplateInput 沒收）— 從原始 tpl 拿
  const effectiveHeroMediaId = tpl.heroMediaId || null;
  if (effectiveHeroMediaId && origin && broadcastId) {
    heroImageUrl = `${origin}/v/b/${broadcastId}${rSeg}/${effectiveHeroMediaId}${variantSuffix}`;
  } else if (effectiveHeroMediaId && heroImageBaseUrl) {
    heroImageUrl = `${heroImageBaseUrl.replace(/\/$/, '')}/${effectiveHeroMediaId}`;
  }

  // CTA URL：包成 /r/b/:bid/:rid?v=x 點擊追蹤
  let trackedCtaUrl = t.ctaUrl;
  if (t.ctaUrl && origin && broadcastId) {
    trackedCtaUrl = `${origin}/r/b/${broadcastId}${rSeg}${variantSuffix}`;
  }

  // 退訂連結
  const unsubscribeUrl = (origin && broadcastId)
    ? `${origin}/email/unsubscribe?bid=${broadcastId}${recipientId != null ? `&rid=${recipientId}` : ''}`
    : '';

  // Open tracking pixel（雖然 Brevo 也會自動加，但我們也加一個自己的 fallback）
  const openPixelUrl = (origin && broadcastId)
    ? `${origin}/v/b/${broadcastId}${rSeg}/pixel.gif${variantSuffix}`
    : '';

  const html = buildEmailHtml(t, {
    heroImageUrl,
    ctaUrl: trackedCtaUrl,
    unsubscribeUrl,
    openPixelUrl,
    previewText: t.subtitle ? String(t.subtitle).slice(0, 100) : ''
  });
  const text = buildEmailText(t, { ctaUrl: trackedCtaUrl, unsubscribeUrl });

  return {
    ok: true,
    subject: t.subject,
    html,
    text
  };
}

module.exports = {
  COLORS,
  FIELD_LIMITS,
  normalizeEmailTemplateInput,
  validateEmailTemplateInput,
  buildEmailHtml,
  buildEmailText,
  buildEmailMessage
};
