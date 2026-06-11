/**
 * 用戶 360 檔案（Customer Profile）— 把單一用戶在系統內的所有行為集中看
 *
 *   GET  /admin/users                         頁面（搜尋 + 列表 + 檔案）
 *   GET  /admin/users/api/list?search=&offset= 用戶列表
 *   GET  /admin/users/api/profile/:lineUserId  單一用戶：基本資料 + 行為統計 + 餐廳興趣 + 時間軸
 */

function registerAdminUsersRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }

  app.get('/admin/users', requireAdmin, (req, res) => {
    res.render('admin_users', {
      title: '用戶檔案',
      bodyClass: 'admin-shell users-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 列表（含搜尋）
  app.get('/admin/users/api/list', requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const searchRaw = String(req.query.search || '').trim().toLowerCase();
      const search = searchRaw.replace(/[\\%_]/g, '\\$&'); // 跳脫 LIKE 萬用字元
      // 搜尋條件：$1 = like pattern（有搜尋才用）
      const baseWhere = `line_user_id IS NOT NULL AND BTRIM(line_user_id) <> '' AND is_admin = false`;
      const searchWhere = searchRaw
        ? ` AND (LOWER(line_user_id) LIKE $1 ESCAPE '\\' OR LOWER(COALESCE(line_display_name,'')) LIKE $1 ESCAPE '\\' OR LOWER(COALESCE(username,'')) LIKE $1 ESCAPE '\\')`
        : '';
      const likeParam = searchRaw ? ['%' + search + '%'] : [];
      const listParams = likeParam.concat([limit, offset]);
      const rs = await query(
        `SELECT id, line_user_id, line_display_name, username, created_at, blocked_at
         FROM users WHERE ${baseWhere}${searchWhere}
         ORDER BY created_at DESC NULLS LAST, id DESC
         LIMIT $${likeParam.length + 1} OFFSET $${likeParam.length + 2}`,
        listParams
      );
      const cnt = await query(`SELECT COUNT(*)::int AS n FROM users WHERE ${baseWhere}${searchWhere}`, likeParam);
      return res.json({ ok: true, users: rs.rows, total: Number(cnt.rows[0]?.n || 0) });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  // 單一用戶 360
  app.get('/admin/users/api/profile/:lineUserId', requireAdmin, async (req, res) => {
    const luid = String(req.params.lineUserId || '').trim();
    if (!/^U[0-9a-f]{32}$/i.test(luid)) return jsonErr(res, 400, 'invalid_line_user_id');
    try {
      const uRs = await query(
        `SELECT id, line_user_id, line_display_name, line_picture_url, username,
                created_at, blocked_at, invite_code, draws_left, extra_draws
         FROM users WHERE line_user_id = $1`,
        [luid]
      );
      const profile = uRs.rows[0] || { line_user_id: luid };
      const userId = profile.id || null;

      // RFM 增益：OA users 表沒有 email，故僅以 lineId 配對外部 RFM 檔案
      const rfmRs = await query(
        `SELECT rfm_user_id, recency, frequency, monetary_est, email, phone, updated_at, true AS matched_by_line
         FROM rfm_profiles WHERE line_user_id = $1 LIMIT 1`,
        [luid]
      );
      const rfm = rfmRs.rows[0] || null;

      // 行為統計
      const counts = {};
      const c1 = await query(`SELECT COUNT(*)::int AS plays, COUNT(*) FILTER (WHERE prize_id IS NOT NULL)::int AS wins FROM activity_plays WHERE line_user_id = $1`, [luid]);
      counts.game_plays = Number(c1.rows[0]?.plays || 0);
      counts.prizes_won = Number(c1.rows[0]?.wins || 0);
      counts.broadcast_clicks = Number((await query(`SELECT COUNT(*)::int AS n FROM admin_broadcast_clicks WHERE line_user_id = $1`, [luid])).rows[0]?.n || 0);
      counts.restaurant_clicks = Number((await query(`SELECT COUNT(*)::int AS n FROM user_restaurant_clicks WHERE line_user_id = $1`, [luid])).rows[0]?.n || 0);
      counts.inbound_messages = Number((await query(`SELECT COUNT(*)::int AS n FROM line_webhook_events WHERE line_user_id = $1 AND event_type = 'message'`, [luid])).rows[0]?.n || 0);
      counts.invites_rewarded = userId
        ? Number((await query(`SELECT COUNT(*)::int AS n FROM line_invites WHERE inviter_user_id = $1 AND status = 'rewarded'`, [userId])).rows[0]?.n || 0)
        : 0;
      counts.liff_events = Number((await query(`SELECT COUNT(*)::int AS n FROM user_events WHERE line_id = $1`, [luid])).rows[0]?.n || 0);

      // 餐廳興趣（點過的餐廳 Top）
      const interest = (await query(
        `SELECT COALESCE(restaurant_query, poi_id) AS name, COUNT(*)::int AS clicks, MAX(clicked_at) AS last
         FROM user_restaurant_clicks WHERE line_user_id = $1 AND (restaurant_query IS NOT NULL OR poi_id IS NOT NULL)
         GROUP BY COALESCE(restaurant_query, poi_id) ORDER BY clicks DESC, last DESC LIMIT 10`,
        [luid]
      )).rows;

      // 名單歸屬（在哪些名單裡）
      const lists = (await query(
        `SELECT rl.id, rl.name FROM admin_recipient_list_members m
         JOIN admin_recipient_lists rl ON rl.id = m.list_id
         WHERE m.line_user_id = $1 ORDER BY rl.id DESC`,
        [luid]
      )).rows;

      // 時間軸（多來源 union）
      const tlParams = userId ? [luid, userId] : [luid, -1];
      const timeline = (await query(
        `SELECT kind, label, at FROM (
           SELECT event_type AS kind, COALESCE(detail, event_type) AS label, event_timestamp AS at
             FROM line_webhook_events WHERE line_user_id = $1 AND event_type IN ('follow','unfollow','message')
           UNION ALL
           SELECT 'game_play', COALESCE(prize_snapshot->>'name','遊玩活動'), played_at FROM activity_plays WHERE line_user_id = $1
           UNION ALL
           SELECT 'restaurant_click', COALESCE(restaurant_query, poi_id, '餐廳'), clicked_at FROM user_restaurant_clicks WHERE line_user_id = $1
           UNION ALL
           SELECT 'broadcast_click', LEFT(target_url, 80), clicked_at FROM admin_broadcast_clicks WHERE line_user_id = $1
           UNION ALL
           SELECT 'liff', event_name, created_at FROM user_events WHERE line_id = $1
           UNION ALL
           SELECT 'invite_rewarded', invitee_line_user_id, rewarded_at FROM line_invites WHERE inviter_user_id = $2 AND status = 'rewarded'
         ) t WHERE at IS NOT NULL ORDER BY at DESC LIMIT 40`,
        tlParams
      )).rows;

      return res.json({ ok: true, profile, counts, interest, lists, timeline, rfm });
    } catch (err) {
      return jsonErr(res, 500, 'profile_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminUsersRoutes };
