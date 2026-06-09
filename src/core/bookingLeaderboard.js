/**
 * 訂位熱榜（Booking Leaderboard）
 *
 * 資料來源：openrice-booking-report 的 Supabase（schema bd_reports）。
 * 用「第二個 PG pool」直連，連線字串由 env BOOKING_REPORT_DATABASE_URL 提供。
 *
 * 功能：
 *   1. fetchTopRestaurants() — 撈「上個月（台北時區）訂位量 Top N」餐廳
 *   2. buildLeaderboardFlex() — 把 Top N 組成 LINE Flex carousel（含標題卡 + N 張餐廳卡）
 *
 * 餐廳連結：booking-report 的 or_restaurant_id 不是公開網頁 POI，裸網址打不開；
 * crawler 的 poi_id 又是另一套 ID。最可靠的是「tw.openrice.com 依店名搜尋」，
 * 實測 HTTP 200 且停在台灣站。
 */

const { Pool } = require('pg');

// OpenRice 品牌黃（沿用 CRM 既有 Flex 配色）
const BRAND = {
  yellow: '#FCC726',
  cardBg: '#FFFFFF',
  ink: '#1F2937',
  sub: '#4B5563',
  muted: '#9CA3AF',
  accentBg: '#FFFBEB',
  line: '#FDE68A'
};

let bookingPool = null;

function getBookingPool() {
  if (bookingPool) return bookingPool;
  const connStr = process.env.BOOKING_REPORT_DATABASE_URL || '';
  if (!connStr) return null;
  const sslDisabled = process.env.BOOKING_REPORT_SSL_DISABLED === '1';
  bookingPool = new Pool({
    connectionString: connStr,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
    max: Number.parseInt(process.env.BOOKING_REPORT_POOL_MAX || '', 10) || 2,
    connectionTimeoutMillis:
      Number.parseInt(process.env.BOOKING_REPORT_CONNECTION_TIMEOUT_MS || '', 10) || 8000,
    idleTimeoutMillis: 10000
  });
  bookingPool.on('error', err => {
    console.error('[bookingLeaderboard] pool error:', err && err.message);
  });
  return bookingPool;
}

function isConfigured() {
  return !!(process.env.BOOKING_REPORT_DATABASE_URL || '').trim();
}

/**
 * 算「上個月」的台北時區起訖（回傳 { startDate, endDate, monthLabel, monthKey }）
 * 以執行當下的台北時間為基準。endDate 為「這個月 1 號」（不含）。
 * @param {Date} [now] 測試用，可注入固定時間
 */
function lastMonthRangeTaipei(now = new Date()) {
  // 取台北當前年月
  const tpe = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = tpe.getFullYear();
  const m = tpe.getMonth(); // 0-based, 當月
  // 上個月
  const lastMonthDate = new Date(y, m - 1, 1);
  const thisMonthDate = new Date(y, m, 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const startDate = fmt(lastMonthDate);
  const endDate = fmt(thisMonthDate);
  const monthLabel = `${lastMonthDate.getFullYear()} 年 ${lastMonthDate.getMonth() + 1} 月`;
  const monthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
  return { startDate, endDate, monthLabel, monthKey };
}

/**
 * 撈上月訂位 Top N
 * @param {Object} opts
 * @param {number} [opts.limit=5]
 * @param {Date}   [opts.now]   測試用
 * @returns {Promise<{ ok:boolean, error?:string, monthLabel?:string, monthKey?:string, rows?:Array }>}
 *   rows: [{ rank, or_restaurant_id, name, district, booking_count }]
 */
async function fetchTopRestaurants({ limit = 5, now } = {}) {
  const pool = getBookingPool();
  if (!pool) return { ok: false, error: 'booking_report_not_configured' };
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 5), 12);
  const { startDate, endDate, monthLabel, monthKey } = lastMonthRangeTaipei(now);
  try {
    const rs = await pool.query(
      `SELECT b.or_restaurant_id,
              COALESCE(r.name, b.restaurant_name) AS name,
              r.district,
              COUNT(*)::int AS booking_count
       FROM bd_reports.bookings b
       LEFT JOIN bd_reports.restaurants r ON r.or_restaurant_id = b.or_restaurant_id
       WHERE b.status = 'Confirm'
         AND b.booking_date >= $1::date
         AND b.booking_date <  $2::date
       GROUP BY b.or_restaurant_id, COALESCE(r.name, b.restaurant_name), r.district
       ORDER BY booking_count DESC
       LIMIT $3`,
      [startDate, endDate, cappedLimit]
    );
    const rows = rs.rows.map((row, idx) => ({
      rank: idx + 1,
      or_restaurant_id: row.or_restaurant_id,
      name: String(row.name || '').trim() || '餐廳',
      district: String(row.district || '').trim(),
      booking_count: Number(row.booking_count || 0)
    }));
    return { ok: true, monthLabel, monthKey, rows };
  } catch (err) {
    console.error('[bookingLeaderboard] query failed:', err && err.message);
    return { ok: false, error: 'query_failed:' + (err && err.message ? err.message : 'unknown') };
  }
}

/**
 * 組 OpenRice 餐廳搜尋連結（依店名），帶 UTM 方便追蹤
 */
function buildRestaurantUrl(name, monthKey) {
  const q = encodeURIComponent(String(name || '').trim());
  const utm = `utm_source=line&utm_medium=push&utm_campaign=booking_leaderboard_${monthKey || ''}`;
  return `https://tw.openrice.com/zh-tw/taipei/restaurants?what=${q}&${utm}`;
}

/**
 * 標題卡（carousel 第一張）
 */
function buildTitleBubble(monthLabel, count) {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'xl',
      backgroundColor: BRAND.yellow,
      contents: [
        { type: 'text', text: 'OpenRice 開飯喇', size: 'sm', weight: 'bold', color: BRAND.ink },
        { type: 'text', text: '訂位熱榜', size: 'xxl', weight: 'bold', color: BRAND.ink, margin: 'md' },
        { type: 'text', text: `${monthLabel} 最多人訂的 ${count} 間`, size: 'md', color: BRAND.ink, margin: 'sm', wrap: true },
        { type: 'text', text: '向左滑看完整榜單', size: 'xs', color: BRAND.ink, margin: 'lg' }
      ]
    }
  };
}

/**
 * 單一餐廳卡
 */
function buildRestaurantBubble(r, monthLabel, monthKey) {
  const subtitleParts = [];
  if (r.district) subtitleParts.push(r.district);
  const subtitle = subtitleParts.join(' · ');
  const url = buildRestaurantUrl(r.name, monthKey);

  const body = [
    { type: 'text', text: `NO. ${r.rank}`, size: 'sm', weight: 'bold', color: BRAND.muted },
    { type: 'text', text: r.name, size: 'lg', weight: 'bold', color: BRAND.ink, wrap: true, margin: 'sm' }
  ];
  if (subtitle) {
    body.push({ type: 'text', text: subtitle, size: 'sm', color: BRAND.sub, margin: 'sm' });
  }
  body.push({
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    paddingAll: 'md',
    cornerRadius: '8px',
    backgroundColor: BRAND.accentBg,
    contents: [
      { type: 'text', text: `${monthLabel} ${r.booking_count} 筆訂位`, size: 'sm', weight: 'bold', color: BRAND.ink, align: 'center' }
    ]
  });
  body.push({
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    backgroundColor: BRAND.yellow,
    cornerRadius: '10px',
    paddingTop: 'md',
    paddingBottom: 'md',
    action: { type: 'uri', label: '立即訂位', uri: url },
    contents: [
      { type: 'text', text: '立即訂位', color: BRAND.ink, weight: 'bold', size: 'md', align: 'center' }
    ]
  });

  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'lg',
      backgroundColor: BRAND.cardBg,
      contents: body
    }
  };
}

/**
 * 把 Top N 組成 LINE Flex carousel 訊息（單一 flex message）
 * @returns {{ type:'flex', altText:string, contents:{ type:'carousel', contents:[] } }}
 */
function buildLeaderboardFlex(rows, { monthLabel, monthKey } = {}) {
  const bubbles = [buildTitleBubble(monthLabel, rows.length)];
  rows.forEach(r => bubbles.push(buildRestaurantBubble(r, monthLabel, monthKey)));
  const altText = `${monthLabel} OpenRice 訂位熱榜：${rows.map(r => r.name).slice(0, 3).join('、')}…`;
  return {
    type: 'flex',
    altText: altText.slice(0, 400),
    contents: { type: 'carousel', contents: bubbles.slice(0, 12) }
  };
}

module.exports = {
  isConfigured,
  lastMonthRangeTaipei,
  fetchTopRestaurants,
  buildRestaurantUrl,
  buildLeaderboardFlex
};
