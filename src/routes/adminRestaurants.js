/**
 * 餐廳目錄 routes
 *
 * 把 user_restaurant_clicks 出現過的餐廳（GROUP BY ref_key 口徑）列出來，
 * 讓員工標上種類與價位（存進 restaurant_catalog），之後就能算用戶口味偏好。
 *
 * ref_key 口徑：COALESCE(poi_id, lower(btrim(restaurant_query)))
 *
 *   GET  /admin/restaurants            管理頁
 *   GET  /admin/restaurants/api/list   餐廳列表（點擊統計 + 目錄標記）
 *   POST /admin/restaurants/api/upsert 標記 upsert（ON CONFLICT ref_key）
 */

const CUISINE_OPTIONS = [
  '日式', '韓式', '台菜中式', '港式', '泰式東南亞', '義式',
  '美式', '火鍋', '燒肉', '甜點咖啡', '早午餐', '其他'
];

const PRICE_BAND_OPTIONS = ['$200以下', '$200-400', '$400-800', '$800-1200', '$1200以上'];

function registerAdminRestaurantsRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }

  /** 空字串視為未標記（存 NULL）；有值則必須在選項清單內 */
  function normalizeOption(raw, options) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return { ok: true, value: null };
    if (!options.includes(s)) return { ok: false };
    return { ok: true, value: s };
  }

  // 頁面
  app.get('/admin/restaurants', requireAdmin, (req, res) => {
    res.render('admin_restaurants', {
      title: '餐廳目錄',
      bodyClass: 'admin-shell restaurants-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 列表：以點擊記錄為來源 GROUP BY ref_key，LEFT JOIN 目錄帶出已標記資料
  app.get('/admin/restaurants/api/list', requireAdmin, async (_req, res) => {
    try {
      const rs = await query(
        `SELECT
           COALESCE(c.poi_id, lower(btrim(c.restaurant_query))) AS ref_key,
           MAX(c.poi_id) AS poi_id,
           MAX(c.restaurant_query) AS restaurant_query,
           COUNT(*)::int AS click_count,
           COUNT(DISTINCT c.line_user_id)::int AS user_count,
           MAX(c.clicked_at) AS last_clicked_at,
           MAX(rc.display_name) AS display_name,
           MAX(rc.cuisine) AS cuisine,
           MAX(rc.price_band) AS price_band
         FROM user_restaurant_clicks c
         LEFT JOIN restaurant_catalog rc
           ON rc.ref_key = COALESCE(c.poi_id, lower(btrim(c.restaurant_query)))
         WHERE c.poi_id IS NOT NULL OR btrim(COALESCE(c.restaurant_query, '')) <> ''
         GROUP BY 1
         ORDER BY
           CASE WHEN MAX(rc.cuisine) IS NOT NULL AND MAX(rc.price_band) IS NOT NULL THEN 1 ELSE 0 END ASC,
           COUNT(*) DESC,
           MAX(c.clicked_at) DESC
         LIMIT 1000`
      );
      const restaurants = rs.rows.map(r => ({
        ref_key: r.ref_key,
        poi_id: r.poi_id,
        query: r.restaurant_query,
        display_name: r.display_name || r.restaurant_query || r.poi_id || '',
        click_count: r.click_count,
        user_count: r.user_count,
        last_clicked_at: r.last_clicked_at,
        cuisine: r.cuisine,
        price_band: r.price_band
      }));
      return res.json({
        ok: true,
        restaurants,
        cuisineOptions: CUISINE_OPTIONS,
        priceBandOptions: PRICE_BAND_OPTIONS
      });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  // 標記 upsert：同 ref_key 重複儲存只更新標記欄位
  app.post('/admin/restaurants/api/upsert', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const refKey = typeof body.ref_key === 'string' ? body.ref_key.trim().slice(0, 300) : '';
      if (!refKey) return jsonErr(res, 400, 'ref_key_required');
      const cuisine = normalizeOption(body.cuisine, CUISINE_OPTIONS);
      if (!cuisine.ok) return jsonErr(res, 400, 'invalid_cuisine');
      const priceBand = normalizeOption(body.price_band, PRICE_BAND_OPTIONS);
      if (!priceBand.ok) return jsonErr(res, 400, 'invalid_price_band');
      const poiId = typeof body.poi_id === 'string' && body.poi_id.trim() ? body.poi_id.trim().slice(0, 100) : null;
      const q = typeof body.query === 'string' && body.query.trim() ? body.query.trim().slice(0, 200) : null;
      const displayNameRaw = typeof body.display_name === 'string' ? body.display_name.trim().slice(0, 200) : '';
      const displayName = displayNameRaw || q || poiId || null;
      const rs = await query(
        `INSERT INTO restaurant_catalog (ref_key, poi_id, query, display_name, cuisine, price_band)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (ref_key) DO UPDATE
         SET cuisine = EXCLUDED.cuisine,
             price_band = EXCLUDED.price_band,
             display_name = EXCLUDED.display_name,
             updated_at = now()
         RETURNING ref_key, poi_id, query, display_name, cuisine, price_band`,
        [refKey, poiId, q, displayName, cuisine.value, priceBand.value]
      );
      return res.json({ ok: true, restaurant: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'upsert_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminRestaurantsRoutes };
