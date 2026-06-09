/**
 * D0 歡迎訊息（加好友後自動發的第一則）
 *
 * 設計定稿（零 emoji、不提任何優惠、CTA 導向「今天吃什麼」）：
 *   標題：今天吃什麼，交給開飯
 *   內文：
 *     每天最難的一題不是工作，是這餐到底吃哪間。
 *     卡住的時候按下面，讓小工具幫你決定。
 *     之後會不定期推幾間訂得到的好店，不洗版。
 *   按鈕：幫我決定吃哪間 → D0_CTA_URL
 *
 * 按鈕網址用環境變數 D0_CTA_URL（預設今天吃什麼 LIFF）。
 * 注意：今天吃什麼 Mini App 若還在 Development 階段，非 tester 點了會打不開，
 * 等上架 Published 後此按鈕才對所有人有效。
 */

const BRAND = {
  yellow: '#FCC726',
  cardBg: '#FFFFFF',
  ink: '#1F2937',
  sub: '#4B5563'
};

// 預設指向今天吃什麼 LIFF（Mini App ID 2010198695-KNvBANCO）
const DEFAULT_CTA_URL = 'https://liff.line.me/2010198695-KNvBANCO';

const TITLE = '今天吃什麼，交給開飯';
const BODY_LINES = [
  '每天最難的一題不是工作，是這餐到底吃哪間。',
  '卡住的時候按下面，讓小工具幫你決定。',
  '之後會不定期推幾間訂得到的好店，不洗版。'
];
const CTA_LABEL = '幫我決定吃哪間';
const ALT_TEXT = '今天吃什麼，交給開飯。我幫你決定這餐吃哪間、找到訂得到的好店。';

function getCtaUrl() {
  const u = String(process.env.D0_CTA_URL || '').trim();
  return u || DEFAULT_CTA_URL;
}

function isEnabled() {
  return process.env.D0_WELCOME_ENABLED === '1';
}

/**
 * 建 D0 歡迎 Flex 訊息（單一 bubble）
 * @returns {{ type:'flex', altText:string, contents:object }}
 */
function buildD0WelcomeMessage() {
  const ctaUrl = getCtaUrl();
  const bodyContents = [
    { type: 'text', text: 'OpenRice 開飯喇', size: 'sm', weight: 'bold', color: BRAND.ink },
    { type: 'text', text: TITLE, size: 'xl', weight: 'bold', color: BRAND.ink, wrap: true, margin: 'md' }
  ];
  BODY_LINES.forEach((line, idx) => {
    bodyContents.push({
      type: 'text',
      text: line,
      size: 'md',
      color: BRAND.sub,
      wrap: true,
      margin: idx === 0 ? 'lg' : 'md',
      lineSpacing: '6px'
    });
  });
  bodyContents.push({
    type: 'box',
    layout: 'vertical',
    margin: 'xl',
    backgroundColor: BRAND.yellow,
    cornerRadius: '12px',
    paddingTop: 'lg',
    paddingBottom: 'lg',
    action: { type: 'uri', label: CTA_LABEL, uri: ctaUrl },
    contents: [
      { type: 'text', text: CTA_LABEL, color: BRAND.ink, weight: 'bold', size: 'md', align: 'center' }
    ]
  });

  return {
    type: 'flex',
    altText: ALT_TEXT,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'xl',
        backgroundColor: BRAND.cardBg,
        contents: bodyContents
      }
    }
  };
}

module.exports = {
  isEnabled,
  getCtaUrl,
  buildD0WelcomeMessage,
  TITLE,
  BODY_LINES,
  CTA_LABEL,
  ALT_TEXT
};
