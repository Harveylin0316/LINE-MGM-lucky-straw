/**
 * 通用遊戲路由註冊器 — 一行 register 一個 game type
 *
 * 用法：
 *   const { registerGameType } = require('./gamesGeneric');
 *   registerGameType(app, deps, { gameType: 'wheel',   viewName: 'game_wheel' });
 *   registerGameType(app, deps, { gameType: 'fortune', viewName: 'game_fortune' });
 *   ...
 *
 * 每個 game type 自動有：
 *   GET  /games/<type>/:slug                  渲染對應 view
 *   GET  /api/games/<type>/:slug/meta         活動 + 獎品 + (可選)用戶 quota
 *   POST /api/games/<type>/:slug/play         抽選核心（共用 engine）
 *   POST /api/games/<type>/:slug/referral     邀請拉新
 *
 * 共用 engine 在 src/core/gamePlayEngine.js
 */
const {
  selectPrizeAndRecord, computeUserQuota, registerReferral
} = require('../core/gamePlayEngine');

function registerGameType(app, deps, opts) {
  const { query, pool } = deps;
  const { gameType, viewName, defaultLiffId } = opts;

  // ----- 頁面 -----
  app.get('/games/' + gameType + '/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const { rows } = await query(
        `SELECT id, slug, name, description, game_type, status, start_at, end_at,
                cover_image_url, daily_plays_per_user, require_follow_oa, liff_id_override,
                base_plays_per_user, referral_bonus_per, referral_bonus_max
         FROM activities WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      if (rows.length === 0 || rows[0].game_type !== gameType) {
        return res.status(404).send('活動不存在或類型不符');
      }
      const a = rows[0];
      const { rows: prizes } = await query(
        `SELECT id, name, description, image_url, position, is_grand_prize, prize_value,
                CASE WHEN stock_total IS NULL THEN false
                     ELSE stock_remaining <= 0 END AS sold_out
         FROM activity_prizes WHERE activity_id = $1
         ORDER BY position ASC, id ASC`,
        [a.id]
      );
      const effectiveLiffId = (a.liff_id_override && a.liff_id_override.trim()) || defaultLiffId;
      res.render(viewName, {
        title: a.name + ' — OpenRice LINE',
        bodyClass: 'liff-shell ' + gameType + '-shell',
        activity: a,
        prizes,
        liffId: effectiveLiffId,
        gameType: gameType
      });
    } catch (err) {
      console.error(gameType + ' page error:', err && err.message);
      res.status(500).send('Server error');
    }
  });

  // ----- meta API -----
  app.get('/api/games/' + gameType + '/:slug/meta', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const lineUserId = String(req.query.line_user_id || '').trim();
      const { rows: act } = await query(
        `SELECT id, slug, name, description, status, start_at, end_at,
                cover_image_url, daily_plays_per_user, require_follow_oa,
                base_plays_per_user, referral_bonus_per, referral_bonus_max
         FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`,
        [slug, gameType]
      );
      if (act.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      const a = act[0];
      const { rows: prizes } = await query(
        `SELECT id, name, description, image_url, position, is_grand_prize, prize_value,
                CASE WHEN stock_total IS NULL THEN false
                     ELSE stock_remaining <= 0 END AS sold_out
         FROM activity_prizes WHERE activity_id = $1
         ORDER BY position ASC, id ASC`,
        [a.id]
      );
      let quota = null;
      if (lineUserId) quota = await computeUserQuota(query, a, lineUserId);
      res.json({ ok: true, activity: a, prizes, quota });
    } catch (err) {
      console.error(gameType + ' meta error:', err && err.message);
      res.status(500).json({ ok: false, error: 'meta_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ----- play API（共用） -----
  const handlePlay = async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const lineUserId = String((req.body || {}).line_user_id || '').trim();
    const lineDisplayName = String((req.body || {}).line_display_name || '').trim() || null;
    const result = await selectPrizeAndRecord({
      pool, activitySlug: slug, gameType, lineUserId, lineDisplayName, req
    });
    if (result.error) {
      return res.status(result.error.status).json({
        ok: false, error: result.error.code,
        detail: result.error.detail, quota: result.error.quota
      });
    }
    res.json(result);
  };
  // 給每個 game 一個 alias path（wheel 為了向後相容也保留 /spin）
  app.post('/api/games/' + gameType + '/:slug/play', handlePlay);
  if (gameType === 'wheel') app.post('/api/games/wheel/:slug/spin', handlePlay);

  // ----- referral API -----
  app.post('/api/games/' + gameType + '/:slug/referral', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const inviteeId = String((req.body || {}).line_user_id || '').trim();
    const inviterId = String((req.body || {}).inviter_line_user_id || '').trim();
    const result = await registerReferral({
      query, activitySlug: slug, gameType, inviterId, inviteeId
    });
    if (result.error) {
      return res.status(result.error.status).json({
        ok: false, error: result.error.code, detail: result.error.detail
      });
    }
    res.json(result);
  });
}

module.exports = { registerGameType };
