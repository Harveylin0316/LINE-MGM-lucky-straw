/**
 * 邀請成效（MGM）儀表板 — 不用再下 SQL 就能看誰成功邀請。
 *   GET /admin/referrals               頁面
 *   GET /admin/referrals/api/data      春日(line_invites) + 活動(activity_referrals) 成效
 *
 * 「成功」定義：被邀請人現在是 OA 好友（存在於 users）。這是真實口徑，
 * 不依賴 line_invites.status（舊機制把很多其實已加入的人卡在 pending）。
 */
function registerAdminReferralsRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;
  function jsonErr(res, s, e, extra = {}) { return res.status(s).json({ ok: false, error: e, ...extra }); }

  app.get('/admin/referrals', requireAdmin, (req, res) => {
    res.render('admin_referrals', {
      title: '邀請成效',
      bodyClass: 'admin-shell referrals-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  app.get('/admin/referrals/api/data', requireAdmin, async (_req, res) => {
    try {
      const FOLLOWER = `EXISTS (SELECT 1 FROM users uu WHERE LOWER(TRIM(uu.line_user_id)) = LOWER(TRIM(li.invitee_line_user_id)))`;

      // 春日 line_invites 總覽
      const sum = (await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE ${FOLLOWER})::int AS success,
           COUNT(*) FILTER (WHERE li.rewarded_at IS NOT NULL)::int AS rewarded,
           COUNT(*) FILTER (WHERE ${FOLLOWER} AND li.rewarded_at IS NULL)::int AS success_unrewarded
         FROM line_invites li`
      )).rows[0];

      // 春日 per-inviter 排行（真實成功口徑）
      const legacy = (await query(
        `SELECT li.inviter_user_id AS inviter_id,
                COALESCE(u.line_display_name, u.username, '用戶#'||li.inviter_user_id) AS inviter_name,
                u.line_user_id AS inviter_line,
                COUNT(*)::int AS invites,
                COUNT(*) FILTER (WHERE ${FOLLOWER})::int AS success,
                COUNT(*) FILTER (WHERE li.rewarded_at IS NOT NULL)::int AS rewarded
         FROM line_invites li
         LEFT JOIN users u ON u.id = li.inviter_user_id
         GROUP BY li.inviter_user_id, u.line_display_name, u.username, u.line_user_id
         ORDER BY success DESC, invites DESC
         LIMIT 200`
      )).rows;

      // 活動框架 activity_referrals per-activity per-inviter
      const activity = (await query(
        `SELECT a.id AS activity_id, a.name AS activity_name,
                ar.inviter_line_user_id AS inviter_line,
                COALESCE(u.line_display_name, u.username, '—') AS inviter_name,
                COUNT(*)::int AS referrals
         FROM activity_referrals ar
         JOIN activities a ON a.id = ar.activity_id
         LEFT JOIN users u ON LOWER(TRIM(u.line_user_id)) = LOWER(TRIM(ar.inviter_line_user_id))
         GROUP BY a.id, a.name, ar.inviter_line_user_id, u.line_display_name, u.username
         ORDER BY a.id DESC, referrals DESC
         LIMIT 300`
      )).rows;

      // 有開 MGM 的活動清單（referral_bonus_per > 0）
      const mgmActivities = (await query(
        `SELECT id, name, slug, status, base_plays_per_user, referral_bonus_per, referral_bonus_max, require_follow_oa
         FROM activities WHERE referral_bonus_per > 0 ORDER BY id DESC`
      )).rows;

      return res.json({ ok: true, summary: sum, legacy, activity, mgmActivities });
    } catch (err) {
      console.error('referrals data error:', err && err.message);
      return jsonErr(res, 500, 'data_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminReferralsRoutes };
