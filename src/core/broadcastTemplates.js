/**
 * 後台「群發訊息」黃色 Flex 模板 builder
 *
 * 設計重點：
 * - 卡片底色 #FFFFFF，主視覺黃色 #FCC726（OpenRice 官方品牌黃）
 * - CTA 按鈕用 box+action 模擬（LINE Flex 原生 button 的 label 字色無法自訂，
 *   白字在 #FCC726 上對比不足；用 box 才能達到「黃底深字」的可讀性）。
 * - 接受 messageConfig.mode = 'template' | 'flex_json' 兩種模式。
 */

/**
 * 預先存在 line_push_media 的「OpenRice 黃色品牌 bar」(1200x80 純色 PNG)。
 * 沒有 user 上傳 hero 時，自動套這個 bar 當 hero — 達成兩個目的：
 *   1. 品牌一致（每則訊息都有 OpenRice 黃 header）
 *   2. 開信率追蹤（hero 圖被 fetch → server 寫 view log）
 * Migration: see add_admin_broadcast_views（同時期 seed 這張圖）。
 */
const DEFAULT_BRAND_BAR_MEDIA_ID = 'fcc72600-0000-4000-8000-000000000001';
const DEFAULT_BRAND_BAR_ASPECT_RATIO = '15:1';

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
  couponBorder: '#FCC726',   // 優惠碼框黃邊（OpenRice 官方黃）
  couponLabel: '#92400E',    // amber-800 (優惠碼的「優惠碼」小標)
  couponCode: '#1F2937',
  disclaimerText: '#9CA3AF', // gray-400 注意事項
  separator: '#FDE68A',
  buttonBg: '#FCC726',
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

function buildYellowFlexFromTemplate(t, { heroImageUrl, heroIsBrandBar } = {}) {
  const bodyContents = [];

  if (t.title) {
    bodyContents.push({
      type: 'text',
      text: t.title,
      weight: 'bold',
      size: 'xl',
      color: COLORS.titleText,
      wrap: true
    });
  }
  if (t.subtitle) {
    // 用 \n\n 切段，每段獨立 text + spacing，視覺更有節奏
    const subtitleParagraphs = t.subtitle.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    subtitleParagraphs.forEach((para, idx) => {
      bodyContents.push({
        type: 'text',
        text: para,
        size: 'md',
        color: COLORS.subtitleText,
        wrap: true,
        margin: idx === 0 ? 'md' : 'lg',
        lineSpacing: '6px'
      });
    });
  }
  if (t.couponCode) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      paddingTop: 'md',
      paddingBottom: 'md',
      paddingStart: 'lg',
      paddingEnd: 'lg',
      cornerRadius: '8px',
      borderWidth: '1px',
      borderColor: COLORS.couponBorder,
      backgroundColor: COLORS.couponBoxBg,
      contents: [
        {
          type: 'text',
          text: '優惠碼',
          size: 'xs',
          color: COLORS.couponLabel,
          align: 'center'
        },
        {
          type: 'text',
          text: t.couponCode,
          size: 'xxl',
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
    // CTA 刻意加大、加粗，做為卡片視覺重點
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'xl',
      backgroundColor: COLORS.buttonBg,
      cornerRadius: '12px',
      paddingTop: 'lg',
      paddingBottom: 'lg',
      paddingStart: 'xl',
      paddingEnd: 'xl',
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
      paddingAll: 'lg',
      backgroundColor: COLORS.cardBg,
      contents: bodyContents
    }
  };

  if (heroImageUrl) {
    bubble.hero = {
      type: 'image',
      url: heroImageUrl,
      size: 'full',
      aspectRatio: heroIsBrandBar ? DEFAULT_BRAND_BAR_ASPECT_RATIO : '20:13',
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
 * broadcastId: 若提供且 template 模式有 CTA，會把 CTA URL 包成 /r/b/<id> 中介 redirect
 *              （給點擊追蹤用）。flex_json 模式不包，由 user 自行用 utm 追蹤。
 * variant: 'a' | 'b' | undefined — A/B test 時帶入；URL 會加 ?v=<variant> 標記，
 *          給 redirect / view endpoint 寫進對應的 variant 欄位。
 */
/**
 * 走訪 Flex tree 移除 url 仍含 REPLACE_* placeholder 的 image。
 * 這樣 user 載入 JSON 模板沒上傳 hero 就送出時，LINE 那邊看到的不是
 * broken image，而是直接沒這個區塊。
 */
function stripPlaceholderImages(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const item = node[i];
      if (
        item && item.type === 'image' &&
        typeof item.url === 'string' && /REPLACE_[A-Z0-9_]+/.test(item.url)
      ) {
        node.splice(i, 1);
      } else {
        stripPlaceholderImages(item);
      }
    }
    return;
  }
  Object.keys(node).forEach(k => {
    const v = node[k];
    if (
      v && typeof v === 'object' && v.type === 'image' &&
      typeof v.url === 'string' && /REPLACE_[A-Z0-9_]+/.test(v.url)
    ) {
      delete node[k];
    } else if (v && typeof v === 'object') {
      stripPlaceholderImages(v);
    }
  });
}

function buildLineMessages(messageConfig, { heroImageBaseUrl, broadcastId, variant } = {}) {
  const variantSuffix = variant === 'a' || variant === 'b' ? `?v=${variant}` : '';
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
    // Clone 後移除尚未替換的 placeholder image（沒上傳 hero 時，LINE 不會看到 broken image）
    const cloned = JSON.parse(JSON.stringify(flex));
    stripPlaceholderImages(cloned.contents);
    return { ok: true, messages: [cloned] };
  }
  // template mode（預設）
  const t = normalizeTemplateInput(messageConfig.template || {});
  const v = validateTemplateInput(t);
  if (!v.ok) return { ok: false, error: v.error };

  // Hero 圖選擇邏輯：
  //   user 上傳 → 用 user 的
  //   user 沒上傳 → 套 OpenRice 黃色品牌 bar 當 default（細條，能追蹤開信率）
  let heroImageUrl = '';
  let heroIsBrandBar = false;
  const effectiveHeroMediaId = t.heroMediaId || DEFAULT_BRAND_BAR_MEDIA_ID;
  if (effectiveHeroMediaId && heroImageBaseUrl && /^https:\/\//i.test(heroImageBaseUrl)) {
    const origin = heroImageBaseUrl.replace(/\/+$/, '');
    if (!t.heroMediaId) heroIsBrandBar = true;
    // 有 broadcastId → 用 /v/b/<id>/<mediaId> 中介 endpoint，server 寫 view log（開信率 proxy）
    // 無 broadcastId（譬如 test-push、後台預覽）→ 原本 /p/line-media/<id>，不追蹤
    heroImageUrl = broadcastId
      ? `${origin}/v/b/${broadcastId}/${effectiveHeroMediaId}${variantSuffix}`
      : `${origin}/p/line-media/${effectiveHeroMediaId}`;
  }

  // 點擊追蹤：把模板 CTA URL 包成中介 redirect endpoint
  // 條件：有 broadcastId、有 publicOrigin、CTA URL 是 http(s)
  const tForBuild = { ...v.value };
  if (
    broadcastId &&
    heroImageBaseUrl &&
    /^https:\/\//i.test(heroImageBaseUrl) &&
    tForBuild.ctaUrl &&
    tForBuild.ctaLabel
  ) {
    const origin = heroImageBaseUrl.replace(/\/+$/, '');
    tForBuild.ctaUrl = `${origin}/r/b/${broadcastId}${variantSuffix}`;
  }

  const flex = buildYellowFlexFromTemplate(tForBuild, { heroImageUrl, heroIsBrandBar });
  // 防呆：即使是模板模式，也 strip 殘留 placeholder image
  stripPlaceholderImages(flex.contents);
  return { ok: true, messages: [flex] };
}

module.exports = {
  FIELD_LIMITS,
  COLORS,
  DEFAULT_BRAND_BAR_MEDIA_ID,
  DEFAULT_BRAND_BAR_ASPECT_RATIO,
  isValidHttpUrl,
  normalizeTemplateInput,
  validateTemplateInput,
  buildYellowFlexFromTemplate,
  buildLineMessages
};
