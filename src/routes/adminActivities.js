/**
 * 活動管理後台路由
 *
 * 核心抽象：activity（活動 = 一個遊戲實例）。每個 activity 有 game_type
 * (wheel / fortune / scratch / ...) 與一組 activity_prizes（獎品池），
 * 用戶在前端遊玩會產生 activity_plays 紀錄。
 *
 * 加新遊戲類型時：
 *   1. 在 LIFF 前端寫 component（views/games/<type>.ejs + public/games/<type>.js）
 *   2. 後台 game_type select 加一條
 *   3. DB schema 不動
 *
 * 提供：
 *   GET  /admin/activities                  列表頁
 *   GET  /admin/activities/new              新增頁
 *   GET  /admin/activities/:id              編輯頁
 *   POST /admin/activities/api              新增 (JSON)
 *   PUT  /admin/activities/api/:id          更新基本資訊 (JSON)
 *   DELETE /admin/activities/api/:id        刪除
 *   GET  /admin/activities/api/:id          取單一活動 + 獎品列表
 *   POST /admin/activities/api/:id/prizes   新增獎品
 *   PUT  /admin/activities/api/prizes/:pid  更新獎品
 *   DELETE /admin/activities/api/prizes/:pid 刪除獎品
 *   GET  /admin/activities/api/:id/stats    遊玩統計
 */

const GAME_TYPES = ['wheel']; // v1 只支援輪盤；後續加 fortune / scratch 在這裡
const STATUSES = ['draft', 'active', 'paused', 'ended'];
const PRIZE_TYPES = ['rice_dollar', 'coupon_code', 'badge', 'physical', 'none'];

function registerAdminActivitiesRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  // ------------------------------------------------------------------
  // 頁面：列表
  // ------------------------------------------------------------------
  app.get('/admin/activities', requireAdmin, (req, res) => {
    res.render('admin_activities', {
      title: '活動管理',
      bodyClass: 'admin-shell activities-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 頁面：新增
  app.get('/admin/activities/new', requireAdmin, (req, res) => {
    res.render('admin_activity_edit', {
      title: '新增活動',
      bodyClass: 'admin-shell activities-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      activityId: null,
      gameTypes: GAME_TYPES,
      statuses: STATUSES,
      prizeTypes: PRIZE_TYPES
    });
  });

  // 頁面：編輯
  app.get('/admin/activities/:id(\\d+)', requireAdmin, (req, res) => {
    res.render('admin_activity_edit', {
      title: '編輯活動',
      bodyClass: 'admin-shell activities-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      activityId: Number(req.params.id),
      gameTypes: GAME_TYPES,
      statuses: STATUSES,
      prizeTypes: PRIZE_TYPES
    });
  });

  // ------------------------------------------------------------------
  // API: 列表
  // ------------------------------------------------------------------
  app.get('/admin/activities/api', requireAdmin, async (_req, res) => {
    try {
      const sql = `
        SELECT
          a.id, a.slug, a.name, a.description, a.game_type, a.status,
          a.start_at, a.end_at, a.cover_image_url, a.daily_plays_per_user,
          a.require_follow_oa, a.created_at, a.updated_at,
          (SELECT COUNT(*) FROM activity_prizes p WHERE p.activity_id = a.id) AS prize_count,
          (SELECT COUNT(*) FROM activity_plays pl WHERE pl.activity_id = a.id) AS play_count,
          (SELECT COUNT(DISTINCT pl.line_user_id) FROM activity_plays pl WHERE pl.activity_id = a.id) AS player_count
        FROM activities a
        ORDER BY a.created_at DESC
      `;
      const { rows } = await query(sql);
      res.json({ ok: true, activities: rows });
    } catch (err) {
      console.error('activities list error:', err && err.message);
      res.status(500).json({ ok: false, error: 'list_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // API: 取單一
  app.get('/admin/activities/api/:id(\\d+)', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await query('SELECT * FROM activities WHERE id = $1', [id]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      const { rows: prizes } = await query(
        'SELECT * FROM activity_prizes WHERE activity_id = $1 ORDER BY position ASC, id ASC',
        [id]
      );
      res.json({ ok: true, activity: rows[0], prizes });
    } catch (err) {
      console.error('activity get error:', err && err.message);
      res.status(500).json({ ok: false, error: 'get_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // API: 新增
  app.post('/admin/activities/api', requireAdmin, async (req, res) => {
    try {
      const data = sanitizeActivityInput(req.body || {});
      if (data._err) return res.status(400).json({ ok: false, error: 'invalid_input', detail: data._err });
      const sql = `
        INSERT INTO activities
          (slug, name, description, game_type, status, start_at, end_at,
           cover_image_url, rules, daily_plays_per_user, require_follow_oa, liff_id_override)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
        RETURNING *
      `;
      const { rows } = await query(sql, [
        data.slug, data.name, data.description, data.game_type, data.status,
        data.start_at, data.end_at, data.cover_image_url,
        JSON.stringify(data.rules || {}),
        data.daily_plays_per_user, data.require_follow_oa, data.liff_id_override
      ]);
      res.json({ ok: true, activity: rows[0] });
    } catch (err) {
      console.error('activity create error:', err && err.message);
      if (err && err.code === '23505') {
        return res.status(400).json({ ok: false, error: 'slug_taken', detail: '這個 slug 已被使用，請換一個。' });
      }
      res.status(500).json({ ok: false, error: 'create_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // API: 更新
  app.put('/admin/activities/api/:id(\\d+)', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const data = sanitizeActivityInput(req.body || {});
      if (data._err) return res.status(400).json({ ok: false, error: 'invalid_input', detail: data._err });
      const sql = `
        UPDATE activities SET
          slug = $1, name = $2, description = $3, game_type = $4, status = $5,
          start_at = $6, end_at = $7, cover_image_url = $8,
          rules = $9::jsonb, daily_plays_per_user = $10, require_follow_oa = $11,
          liff_id_override = $12
        WHERE id = $13 RETURNING *
      `;
      const { rows } = await query(sql, [
        data.slug, data.name, data.description, data.game_type, data.status,
        data.start_at, data.end_at, data.cover_image_url,
        JSON.stringify(data.rules || {}),
        data.daily_plays_per_user, data.require_follow_oa, data.liff_id_override, id
      ]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, activity: rows[0] });
    } catch (err) {
      console.error('activity update error:', err && err.message);
      if (err && err.code === '23505') {
        return res.status(400).json({ ok: false, error: 'slug_taken', detail: '這個 slug 已被使用，請換一個。' });
      }
      res.status(500).json({ ok: false, error: 'update_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // API: 刪除
  app.delete('/admin/activities/api/:id(\\d+)', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      await query('DELETE FROM activities WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('activity delete error:', err && err.message);
      res.status(500).json({ ok: false, error: 'delete_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // 獎品 CRUD
  // ------------------------------------------------------------------
  app.post('/admin/activities/api/:id(\\d+)/prizes', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const data = sanitizePrizeInput(req.body || {});
      if (data._err) return res.status(400).json({ ok: false, error: 'invalid_input', detail: data._err });
      const sql = `
        INSERT INTO activity_prizes
          (activity_id, name, description, image_url, probability_weight,
           stock_total, stock_remaining, prize_type, prize_value, position, is_grand_prize)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
        RETURNING *
      `;
      const { rows } = await query(sql, [
        id, data.name, data.description, data.image_url, data.probability_weight,
        data.stock_total, data.stock_total, data.prize_type,
        JSON.stringify(data.prize_value || {}), data.position, data.is_grand_prize
      ]);
      res.json({ ok: true, prize: rows[0] });
    } catch (err) {
      console.error('prize create error:', err && err.message);
      res.status(500).json({ ok: false, error: 'prize_create_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  app.put('/admin/activities/api/prizes/:pid(\\d+)', requireAdmin, async (req, res) => {
    try {
      const pid = Number(req.params.pid);
      const data = sanitizePrizeInput(req.body || {});
      if (data._err) return res.status(400).json({ ok: false, error: 'invalid_input', detail: data._err });
      // 更新時 stock_remaining 跟著 stock_total 同步調整（若 stock_total 變更）
      const sql = `
        UPDATE activity_prizes SET
          name = $1, description = $2, image_url = $3, probability_weight = $4,
          stock_total = $5,
          stock_remaining = CASE
            WHEN $5 IS NULL THEN NULL
            WHEN stock_total IS NULL OR $5 = stock_total THEN stock_remaining
            ELSE GREATEST(0, stock_remaining + ($5 - COALESCE(stock_total, 0)))
          END,
          prize_type = $6, prize_value = $7::jsonb, position = $8, is_grand_prize = $9
        WHERE id = $10
        RETURNING *
      `;
      const { rows } = await query(sql, [
        data.name, data.description, data.image_url, data.probability_weight,
        data.stock_total, data.prize_type,
        JSON.stringify(data.prize_value || {}), data.position, data.is_grand_prize, pid
      ]);
      if (rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      res.json({ ok: true, prize: rows[0] });
    } catch (err) {
      console.error('prize update error:', err && err.message);
      res.status(500).json({ ok: false, error: 'prize_update_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  app.delete('/admin/activities/api/prizes/:pid(\\d+)', requireAdmin, async (req, res) => {
    try {
      const pid = Number(req.params.pid);
      await query('DELETE FROM activity_prizes WHERE id = $1', [pid]);
      res.json({ ok: true });
    } catch (err) {
      console.error('prize delete error:', err && err.message);
      res.status(500).json({ ok: false, error: 'prize_delete_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // 統計
  // ------------------------------------------------------------------
  app.get('/admin/activities/api/:id(\\d+)/stats', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const overviewSQL = `
        SELECT
          COUNT(*) AS plays,
          COUNT(DISTINCT line_user_id) AS players,
          COUNT(*) FILTER (WHERE prize_id IS NOT NULL) AS wins,
          COUNT(*) FILTER (WHERE played_at >= date_trunc('day', NOW())) AS plays_today
        FROM activity_plays WHERE activity_id = $1
      `;
      const prizesSQL = `
        SELECT
          p.id, p.name, p.is_grand_prize,
          p.stock_total, p.stock_remaining,
          COUNT(pl.id) AS hit_count
        FROM activity_prizes p
        LEFT JOIN activity_plays pl ON pl.prize_id = p.id
        WHERE p.activity_id = $1
        GROUP BY p.id
        ORDER BY p.position ASC, p.id ASC
      `;
      const recentSQL = `
        SELECT pl.id, pl.line_user_id, pl.line_display_name, pl.played_at,
               p.name AS prize_name
        FROM activity_plays pl
        LEFT JOIN activity_prizes p ON p.id = pl.prize_id
        WHERE pl.activity_id = $1
        ORDER BY pl.played_at DESC LIMIT 20
      `;
      const [ov, pr, rc] = await Promise.all([
        query(overviewSQL, [id]),
        query(prizesSQL, [id]),
        query(recentSQL, [id])
      ]);
      res.json({
        ok: true,
        overview: ov.rows[0] || {},
        prizes: pr.rows,
        recent: rc.rows
      });
    } catch (err) {
      console.error('activity stats error:', err && err.message);
      res.status(500).json({ ok: false, error: 'stats_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });
}

// ------------------------------------------------------------------
// Input sanitizers
// ------------------------------------------------------------------
function sanitizeActivityInput(body) {
  const slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return { _err: 'slug 必填，只接受英數字與 -' };
  const name = String(body.name || '').trim();
  if (!name) return { _err: 'name 必填' };
  const game_type = String(body.game_type || 'wheel').trim();
  if (!GAME_TYPES.includes(game_type)) return { _err: `game_type 必須為 ${GAME_TYPES.join(' / ')}` };
  const status = String(body.status || 'draft').trim();
  if (!STATUSES.includes(status)) return { _err: `status 必須為 ${STATUSES.join(' / ')}` };
  return {
    slug, name, game_type, status,
    description: body.description ? String(body.description) : null,
    start_at: body.start_at || null,
    end_at: body.end_at || null,
    cover_image_url: body.cover_image_url ? String(body.cover_image_url) : null,
    rules: (body.rules && typeof body.rules === 'object') ? body.rules : {},
    daily_plays_per_user: numOrNull(body.daily_plays_per_user, 0),
    require_follow_oa: Boolean(body.require_follow_oa),
    liff_id_override: body.liff_id_override
      ? String(body.liff_id_override).trim() || null
      : null
  };
}

function sanitizePrizeInput(body) {
  const name = String(body.name || '').trim();
  if (!name) return { _err: 'name 必填' };
  const prize_type = String(body.prize_type || 'badge').trim();
  if (!PRIZE_TYPES.includes(prize_type)) return { _err: `prize_type 必須為 ${PRIZE_TYPES.join(' / ')}` };
  return {
    name,
    description: body.description ? String(body.description) : null,
    image_url: body.image_url ? String(body.image_url) : null,
    probability_weight: Math.max(0, Number(body.probability_weight ?? 1)),
    stock_total: numOrNull(body.stock_total, 0),
    prize_type,
    prize_value: (body.prize_value && typeof body.prize_value === 'object') ? body.prize_value : {},
    position: Math.max(0, Number(body.position || 0)),
    is_grand_prize: Boolean(body.is_grand_prize)
  };
}

function numOrNull(v, min) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (typeof min === 'number' && n < min) return min;
  return Math.floor(n);
}

module.exports = { registerAdminActivitiesRoutes, GAME_TYPES, STATUSES, PRIZE_TYPES };
