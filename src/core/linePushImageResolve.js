/**
 * LINE 圖片訊息需 HTTPS；盡量從多個環境變數組出可給 LINE 抓圖的網址。
 * 探測失敗時仍回傳第一個候選（部分託管無法 hairpin 自連，但 LINE 端可抓）。
 */

function normalizeHttpsOrigin(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** 合併多來源、去重；順序愈前愈優先 */
function buildPushImageBaseCandidates() {
  const rawList = [
    process.env.LINE_PUSH_IMAGE_BASE_URL,
    process.env.LINE_PUSH_PUBLIC_BASE_URL,
    process.env.PUBLIC_SITE_URL,
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    process.env.DEPLOY_URL,
    process.env.NETLIFY_URL,
    process.env.VERCEL_URL ? `https://${String(process.env.VERCEL_URL).replace(/^https?:\/\//i, '')}` : ''
  ];
  const seen = new Set();
  const out = [];
  for (const raw of rawList) {
    const o = normalizeHttpsOrigin(raw);
    if (o && !seen.has(o)) {
      seen.add(o);
      out.push(o);
    }
  }
  return out;
}

/**
 * @param {string[]} candidates - HTTPS origin 列表
 * @param {string} fileName - 例如 invite-bonus-granted.png
 * @returns {Promise<string>} 完整圖片 URL，無候選則空字串
 */
async function resolvePushImageUrl(candidates, fileName) {
  const name = typeof fileName === 'string' ? fileName.replace(/^\/+/, '').trim() : '';
  if (!name) return '';
  const path = `/images/${name}`;
  const list = Array.isArray(candidates) ? candidates.map(normalizeHttpsOrigin).filter(Boolean) : [];
  if (list.length === 0) return '';

  const timeoutMs = 8000;
  const tryUrl = async url => {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: ac.signal
      });
      clearTimeout(t);
      if (r.ok || r.status === 206) return true;
    } catch {
      /* ignore */
    }
    return false;
  };

  for (const base of list) {
    const url = `${base}${path}`;
    if (await tryUrl(url)) return url;
  }

  return `${list[0]}${path}`;
}

/**
 * 後端渲染 LIFF 頁時，Netlify 等環境有時未注入 URL，導致僅依 env 的候選為空。
 * 用請求的 Host + x-forwarded-proto 補上一個 https origin，讓分享圖網址可組出。
 */
function httpsOriginFromRequest(req) {
  if (!req || typeof req.get !== 'function') return '';
  const host = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (!host) return '';
  const xfProto = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xfProto === 'https') return `https://${host}`;
  if (process.env.NODE_ENV === 'production') return `https://${host}`;
  return '';
}

function mergePushImageCandidatesWithRequest(candidates, req) {
  const fromEnv = Array.isArray(candidates) ? candidates.map(normalizeHttpsOrigin).filter(Boolean) : [];
  const fromReq = httpsOriginFromRequest(req);
  const seen = new Set();
  const out = [];
  for (const o of [...fromEnv, ...(fromReq ? [fromReq] : [])]) {
    if (o && !seen.has(o)) {
      seen.add(o);
      out.push(o);
    }
  }
  return out;
}

module.exports = {
  normalizeHttpsOrigin,
  buildPushImageBaseCandidates,
  resolvePushImageUrl,
  httpsOriginFromRequest,
  mergePushImageCandidatesWithRequest
};
