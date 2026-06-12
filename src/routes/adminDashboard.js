/**
 * 後台首頁（儀表板）— 登入後的落地頁
 *
 *   GET /admin                關鍵數字 + 三步驟引導 + 快速入口
 *   GET /admin/api/dashboard  統計 JSON
 */

function registerAdminDashboardRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  app.get('/admin', requireAdmin, (req, res) => {
    res.render('admin_dashboard', {
      title: '首頁',
      bodyClass: 'admin-shell dashboard-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  app.get('/admin/api/dashboard', requireAdmin, async (req, res) => {
    try {
      const rs = await query(`
        SELECT
          (SELECT COUNT(*)::int FROM users
            WHERE line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
              AND is_admin = false AND blocked_at IS NULL) AS friends,
          (SELECT COUNT(*)::int FROM users
            WHERE line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
              AND is_admin = false AND blocked_at IS NULL
              AND created_at > now() - interval '7 days') AS friends_7d,
          (SELECT COUNT(*)::int FROM activities WHERE status = 'active') AS active_activities,
          (SELECT COUNT(*)::int FROM admin_flows WHERE status = 'active') AS active_flows,
          (SELECT COUNT(*)::int FROM admin_message_templates WHERE channel = 'line') AS templates
      `);
      const lastRs = await query(`
        SELECT id, created_at, status, recipient_total, recipient_ok, recipient_fail
        FROM admin_broadcasts
        WHERE status IN ('done','sending','running','scheduled','failed')
        ORDER BY id DESC LIMIT 1
      `);
      return res.json({ ok: true, stats: rs.rows[0], lastBroadcast: lastRs.rows[0] || null });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'dashboard_failed', detail: err && err.message });
    }
  });
}

module.exports = { registerAdminDashboardRoutes };
