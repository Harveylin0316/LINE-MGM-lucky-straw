/**
 * 後台「群發訊息」黃色 Flex 模板 builder
 *
 * 設計重點：
 * - 卡片底色 #FFFBEB (amber-50)，主視覺黃色 #facc15 (amber-400)
 * - CTA 按鈕用 box+action 模擬（LINE Flex 原生 button 的 label 字色無法自訂，
 *   白字在 #facc15 上對比不足；用 box 才能達到「黃底深字」的可讀性）。
 * - 接受 messageConfig.mode = 'template' | 'flex_json' 兩種模式。
 */

const FIELD_LIMITS = {
  title: 100,
  subtitle: 500,
  couponCode: 60,
  disclaimer: 300,
  ctaLabel: 40,
  ctaUrl: 1000,
  altText: 400
};

const COLORS = {
  cardBg: '#FFFFFF',         // 卡片底（白）
  couponBoxBg: '#FFFBEB',    // 優惠碼框淺黃底
  couponBorder: '#FACC15',   // 優惠碼框黃邊
  couponLabel: '#92400E',    // amber-800 (優惠碼的「優惠碼」小標)
  couponCode: '#1F2937',
  disclaimerText: '#9CA3AF', // gray-400 注意事項
  separator: '#FDE68A',
  buttonBg: '#FACC15',
  buttonText: '#1F2937',
  titleText: '#1F2937',
  subtitleText: '#4B5563'
};

function isValidHttpUrl(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function clip(s, max) {
  return String(s == null ? '' : s).slice(0, max);
}

function normalizeTemplateInput(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const title = clip(String(safe.title || '').trim(), FIELD_LIMITS.title);
  const subtitle = clip(String(safe.subtitle || '').trim(), FIELD_LIMITS.subtitle);
  const couponCode = clip(String(safe.couponCode || '').trim(), FIELD_LIMITS.couponCode);
  const disclaimer = clip(String(safe.disclaimer || '').trim(), FIELD_LIMITS.disclaimer);
  const ctaLabel = clip(String(safe.ctaLabel || '').trim(), FIELD_LIMITS.ctaLabel);
  const ctaUrl = clip(String(safe.ctaUrl || '').trim(), FIELD_LIMITS.ctaUrl);
  const altText = clip(String(safe.altText || '').trim(), FIELD_LIMITS.altText);
  const heroMediaId =
    typeof safe.heroMediaId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(safe.heroMediaId.trim())
      ? safe.heroMediaId.trim()
      : null;
  return { title, subtitle, couponCode, disclaimer, ctaLabel, ctaUrl, altText, heroMediaId };
}

function validateTemplateInput(input) {
  const t = normalizeTemplateInput(input);
  if (!t.title && !t.heroMediaId && !t.subtitle && !t.couponCode) {
    return { ok: false, error: '請至少填入標題、副標題、優惠碼或上傳一張 Hero 圖。' };
  }
  if ((t.ctaLabel && !t.ctaUrl) || (!t.ctaLabel && t.ctaUrl)) {
    return { ok: false, error: 'CTA 按鈕的文字與連結需同時填寫，或同時留空。' };
  }
  if (t.ctaUrl && !isValidHttpUrl(t.ctaUrl)) {
    return { ok: false, error: 'CTA 連結需為 http:// 或 https:// 開頭的有效網址。' };
  }
  return { ok: true, value: t };
}

function buildYellowFlexFromTemplate(t, { heroImageUrl } = {}) {
  const bodyContents = [];

  if (t.title) {
    bodyContents.push({
      type: 'text',
      text: t.title,
      weight: 'bold',
      size: 'xxl',
      color: COLORS.titleText,
      wrap: true
    });
  }
  if (t.subtitle) {
    bodyContents.push({
      type: 'text',
      text: t.subtitle,
      size: 'lg',
      color: COLORS.subtitleText,
      wrap: true,
      margin: 'lg',
      lineSpacing: '8px'
    });
  }
  if (t.couponCode) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'xl',
      paddingTop: 'lg',
      paddingBottom: 'lg',
      paddingStart: 'xl',
      paddingEnd: 'xl',
      cornerRadius: '10px',
      borderWidth: '1px',
      borderColor: COLORS.couponBorder,
      backgroundColor: COLORS.couponBoxBg,
      contents: [
        {
          type: 'text',
          text: '優惠碼',
          size: 'sm',
          color: COLORS.couponLabel,
          align: 'center'
        },
        {
          type: 'text',
          text: t.couponCode,
          size: '3xl',
          weight: 'bold',
          color: COLORS.couponCode,
          align: 'center',
          margin: 'sm'
        }
      ]
    });
  }
  if (t.disclaimer) {
    bodyContents.push({
      type: 'text',
      text: t.disclaimer,
      size: 'xs',
      color: COLORS.disclaimerText,
      wrap: true,
      margin: 'lg'
    });
  }
  if (t.ctaLabel && t.ctaUrl) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'xl',
      backgroundColor: COLORS.buttonBg,
      cornerRadius: '10px',
      paddingTop: 'lg',
      paddingBottom: 'lg',
      paddingStart: 'lg',
      paddingEnd: 'lg',
      action: { type: 'uri', label: t.ctaLabel, uri: t.ctaUrl },
      contents: [
        {
          type: 'text',
          text: t.ctaLabel,
          color: COLORS.buttonText,
          weight: 'bold',
          size: 'lg',
          align: 'center',
          wrap: false
        }
      ]
    });
  }

  // body 至少要一個 component（Flex 規範）
  if (bodyContents.length === 0) {
    bodyContents.push({ type: 'text', text: ' ', wrap: true });
  }

  const bubble = {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: 'xl',
      backgroundColor: COLORS.cardBg,
      contents: bodyContents
    }
  };

  if (heroImageUrl) {
    bubble.hero = {
      type: 'image',
      url: heroImageUrl,
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover'
    };
  }

  const safeAlt =
    (t.altText || t.title || 'OpenRice 通知').slice(0, FIELD_LIMITS.altText) || 'OpenRice 通知';

  return {
    type: 'flex',
    altText: safeAlt,
    contents: bubble
  };
}

/**
 * 從 message_config 構造 LINE messages 陣列（給 linePush.pushLineMessages 用）
 * messageConfig: { mode: 'template'|'flex_json', template?: {...}, flex?: {...} }
 * heroImageBaseUrl: 用來組 hero 圖的 https 公開網址（line_push_media）
 */
function buildLineMessages(messageConfig, { heroImageBaseUrl } = {}) {
  if (!messageConfig || typeof messageConfig !== 'object') {
    return { ok: false, error: '訊息設定缺失' };
  }
  if (messageConfig.mode === 'flex_json') {
    const flex = messageConfig.flex;
    if (!flex || typeof flex !== 'object' || flex.type !== 'flex') {
      return { ok: false, error: '進階模式需提供完整 Flex JSON（type=flex）。' };
    }
    const alt = String(flex.altText || '').trim();
    if (alt.length < 1 || alt.length > FIELD_LIMITS.altText) {
      return { ok: false, error: 'altText 必填，長度 1～400 字元。' };
    }
    if (!flex.contents || typeof flex.contents !== 'object') {
      return { ok: false, error: '缺少 contents（氣泡內容）。' };
    }
    return { ok: true, messages: [flex] };
  }
  // template mode（預設）
  const t = normalizeTemplateInput(messageConfig.template || {});
  const v = validateTemplateInput(t);
  if (!v.ok) return { ok: false, error: v.error };

  let heroImageUrl = '';
  if (t.heroMediaId && heroImageBaseUrl && /^https:\/\//i.test(heroImageBaseUrl)) {
    heroImageUrl = `${heroImageBaseUrl.replace(/\/+$/, '')}/p/line-media/${t.heroMediaId}`;
  }
  const flex = buildYellowFlexFromTemplate(v.value, { heroImageUrl });
  return { ok: true, messages: [flex] };
}

module.exports = {
  FIELD_LIMITS,
  COLORS,
  isValidHttpUrl,
  normalizeTemplateInput,
  validateTemplateInput,
  buildYellowFlexFromTemplate,
  buildLineMessages
};
