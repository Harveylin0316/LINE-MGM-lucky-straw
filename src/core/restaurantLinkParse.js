/**
 * 從訊息裡的連結反推「是哪家餐廳」。
 *
 * 我們發出去的餐廳連結格式（訂位熱榜等）：
 *   https://tw.openrice.com/zh-tw/taipei/restaurants?what=<店名>&utm_...
 *   或 poi 連結：.../r-<slug>-r<poiId>/
 *
 * 用戶點擊 → 經過 /r/b 或 /rf 中轉時，呼叫這支解析出餐廳，連同 lineId 記進
 * user_restaurant_clicks。零外部依賴，靠自己發出去的連結。
 */

function isOpenRiceHost(hostname) {
  return /(^|\.)openrice\.com$/i.test(String(hostname || ''));
}

/**
 * @param {string} url
 * @returns {{ isRestaurant:boolean, query:string|null, poi:string|null }|null}
 *   不是 OpenRice 連結回 null；是但抓不到店名/poi 仍回 isRestaurant:true（generic）
 */
function parseOpenRiceRestaurant(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (!isOpenRiceHost(u.hostname)) return null;

  // 1. 搜尋連結 ?what=
  const what = u.searchParams.get('what');
  if (what && what.trim()) {
    return { isRestaurant: true, query: what.trim().slice(0, 200), poi: null };
  }
  // 2. poi 連結 .../r-...-r12345 或結尾 -r12345
  const m = u.pathname.match(/-r(\d+)\/?$/);
  if (m) {
    return { isRestaurant: true, query: null, poi: m[1] };
  }
  // 3. 其他 OpenRice 連結（餐廳頁但抓不到識別）
  if (/\/restaurant|\/r-/i.test(u.pathname)) {
    return { isRestaurant: true, query: null, poi: null };
  }
  // 非餐廳的 OpenRice 連結（首頁等）
  return null;
}

/**
 * 記一筆「用戶點了某餐廳」。best-effort，不阻塞。
 * @param {Function} query  pg query
 * @param {Object} opts { lineUserId, url, source }
 */
async function recordRestaurantClick(query, { lineUserId, url, source }) {
  if (!lineUserId || !url) return;
  const parsed = parseOpenRiceRestaurant(url);
  if (!parsed || !parsed.isRestaurant) return;
  try {
    await query(
      `INSERT INTO user_restaurant_clicks (line_user_id, restaurant_query, poi_id, target_url, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [lineUserId, parsed.query, parsed.poi, String(url).slice(0, 1000), source || null]
    );
  } catch (err) {
    console.error('recordRestaurantClick failed:', err.message);
  }
}

module.exports = { parseOpenRiceRestaurant, recordRestaurantClick };
