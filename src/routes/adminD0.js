/**
 * D0 歡迎訊息 — 測試端點（讓 admin 在開啟全自動前先驗證）
 *
 *   GET  /admin/d0/preview     看 D0 Flex JSON + 目前設定（enabled / cta url）
 *   POST /admin/d0/test-send   發 D0 給自己（或指定 test_line_user_id）
 *
 * 正式自動發送在 lineWebhook 的 follow 事件，gated by env D0_WELCOME_ENABLED=1。
 */

function registerAdminD0Routes(app, deps) {
  const { query, authCore, linePush, lineChannelAccessToken, d0Welcome } = deps;
  const { requireAdmin } = authCore;

  app.get('/admin/d0/preview', requireAdmin, (_req, res) => {
    try {
      const flex = d0Welcome.buildD0WelcomeMessage();
      return res.json({
        ok: true,
        enabled: d0Welcome.isEnabled(),
        cta_url: d0Welcome.getCtaUrl(),
        flex
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'preview_failed', detail: err && err.message });
    }
  });

  app.post('/admin/d0/test-send', requireAdmin, async (req, res) => {
    try {
      if (!lineChannelAccessToken) return res.status(400).json({ ok: false, error: 'no_line_channel_access_token' });
      const body = req.body || {};
      let lineTo = String(body.test_line_user_id || '').trim();
      let userId = null;
      if (lineTo) {
        if (!/^U[0-9a-f]{32}$/i.test(lineTo)) return res.status(400).json({ ok: false, error: 'invalid_line_user_id' });
      } else {
        const uRs = await query('SELECT line_user_id FROM users WHERE id = $1', [req.authUser.uid]);
        lineTo = String(uRs.rows[0]?.line_user_id || '').trim();
        userId = req.authUser.uid;
      }
      if (!lineTo) return res.status(400).json({ ok: false, error: 'no_recipient_self_has_no_line_id' });

      const flex = d0Welcome.buildD0WelcomeMessage();
      const pushed = await linePush.pushLineMessages(lineTo, [flex], { userId, pushType: 'd0_welcome_test' });
      if (!pushed) return res.status(500).json({ ok: false, error: 'push_failed' });
      return res.json({ ok: true, sentTo: lineTo });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'test_send_failed', detail: err && err.message });
    }
  });
}

module.exports = { registerAdminD0Routes };
