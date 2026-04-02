/**
 * LINE Flex Message：驗證、預設範本、佔位符替換（邀請提醒推播用）
 */

/** 按鈕連結可用 {{LIFF_URL}}，推播時替換為實際 LIFF 網址 */
const PLACEHOLDER_LIFF = '{{LIFF_URL}}';

function defaultInviteReminderFlex() {
  return {
    type: 'flex',
    altText: '春日野餐祭｜邀請好友拿加碼刮刮樂',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '邀請好友 · 加碼刮刮樂',
            weight: 'bold',
            size: 'xl',
            color: '#1a1a1a',
            align: 'center'
          }
        ],
        paddingAll: 'lg',
        backgroundColor: '#E8F5E9'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: 'lg',
        contents: [
          {
            type: 'text',
            text: '邀請尚未加入 OpenRice LINE@ 的好友完成加官方帳，累計達標即可獲得加碼刮刮樂次數。',
            wrap: true,
            size: 'md',
            color: '#333333'
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '開啟活動並分享邀請',
              uri: PLACEHOLDER_LIFF
            }
          }
        ]
      }
    }
  };
}

function validateFlexPushMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: '請提供有效的 Flex 物件（JSON）。' };
  }
  if (msg.type !== 'flex') {
    return { ok: false, error: '根層級須為 type: "flex"。' };
  }
  const alt = String(msg.altText || '').trim();
  if (alt.length < 1 || alt.length > 400) {
    return { ok: false, error: 'altText 必填，且長度須在 1～400 字元內（LINE 規範）。' };
  }
  if (!msg.contents || typeof msg.contents !== 'object') {
    return { ok: false, error: '缺少 contents（氣泡內容）。' };
  }
  return { ok: true, value: msg };
}

function deepReplacePlaceholders(obj, replacements) {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    let s = obj;
    for (const [key, val] of Object.entries(replacements)) {
      if (s.includes(key)) {
        s = s.split(key).join(val == null ? '' : String(val));
      }
    }
    return s;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => deepReplacePlaceholders(item, replacements));
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      out[k] = deepReplacePlaceholders(obj[k], replacements);
    }
    return out;
  }
  return obj;
}

function cloneFlexForPush(stored, liffUrl) {
  const raw = JSON.parse(JSON.stringify(stored));
  return deepReplacePlaceholders(raw, { [PLACEHOLDER_LIFF]: liffUrl || '' });
}

module.exports = {
  PLACEHOLDER_LIFF,
  defaultInviteReminderFlex,
  validateFlexPushMessage,
  cloneFlexForPush
};
