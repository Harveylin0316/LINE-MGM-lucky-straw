/**
 * 訂位熱榜自動推播 routes
 *
 * 三段式（跟 email 一樣，先測再發，避免一次炸 574 人）：
 *   1. GET  /admin/leaderboard/preview          → 看 Top 5 + Flex JSON（不發送）
 *   2. POST /admin/leaderboard/test-send         → 發給自己（或指定 UID）測試
 *   3. POST /admin/broadcast/run-monthly-leaderboard → 正式建批次發給所有好友
 *        - 可被 admin 手動觸發，或 Netlify 排程帶 SCHEDULED_RUNNER_SECRET 觸發
 *        - 每月只發一次（用 audience_config 防重複），?force=1 可強制重發
 *        - 建好 status=running 的 broadcast 後，由現有 run-scheduled chunk loop 送出
 */

function registerAdminLeaderboardRoutes(app, deps) {
  const {
    query,
    pool,
    authCore,
    linePush,
    lineChannelAccessToken,
    bookingLeaderboard,
    resolvePublicSiteOrigin = () => ''
  } = deps;

  const { requireAdmin } = authCore;
  const LIMIT = Math.min(Math.max(1, Number.parseInt(process.env.LEADERBOARD_TOP_N || '5', 10) || 5), 10);

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }

  async function buildLeaderboardMessage() {
    if (!bookingLeaderboard.isConfigured()) {
      return { ok: false, error: 'booking_report_not_configured' };
    }
    const top = await bookingLeaderboard.fetchTopRestaurants({ limit: LIMIT });
    if (!top.ok) return { ok: false, error: top.error };
    if (!top.rows || top.rows.length === 0) return { ok: false, error: 'no_data_for_last_month' };
    const flex = bookingLeaderboard.buildLeaderboardFlex(top.rows, {
      monthLabel: top.monthLabel,
      monthKey: top.monthKey
    });
    return { ok: true, flex, rows: top.rows, monthLabel: top.monthLabel, monthKey: top.monthKey };
  }

  // ---------- 1. 預覽（不發送）----------
  app.get('/admin/leaderboard/preview', requireAdmin, async (_req, res) => {
    try {
      const built = await buildLeaderboardMessage();
      if (!built.ok) return jsonErr(res, 400, built.error);
      return res.json({
        ok: true,
        monthLabel: built.monthLabel,
        monthKey: built.monthKey,
        rows: built.rows,
        flex: built.flex
      });
    } catch (err) {
      console.error('leaderboard preview error:', err && err.message);
      return jsonErr(res, 500, 'preview_failed', { detail: err && err.message });
    }
  });

  // ---------- 2. 測試發送（發給自己或指定 UID）----------
  app.post('/admin/leaderboard/test-send', requireAdmin, async (req, res) => {
    try {
      if (!lineChannelAccessToken) return jsonErr(res, 400, 'no_line_channel_access_token');
      const built = await buildLeaderboardMessage();
      if (!built.ok) return jsonErr(res, 400, built.error);

      const body = req.body || {};
      let lineTo = String(body.test_line_user_id || '').trim();
      let userId = null;
      if (lineTo) {
        if (!/^U[0-9a-f]{32}$/i.test(lineTo)) return jsonErr(res, 400, 'invalid_line_user_id');
      } else {
        // 預設發給自己
        const uRs = await query('SELECT line_user_id FROM users WHERE id = $1', [req.authUser.uid]);
        lineTo = String(uRs.rows[0]?.line_user_id || '').trim();
        userId = req.authUser.uid;
      }
      if (!lineTo) return jsonErr(res, 400, 'no_recipient_self_has_no_line_id');

      const pushed = await linePush.pushLineMessages(lineTo, [built.flex], {
        userId,
        pushType: 'leaderboard_test'
      });
      if (!pushed) return jsonErr(res, 500, 'push_failed');
      return res.json({ ok: true, sentTo: lineTo, monthLabel: built.monthLabel, count: built.rows.length });
    } catch (err) {
      console.error('leaderboard test-send error:', err && err.message);
      return jsonErr(res, 500, 'test_send_failed', { detail: err && err.message });
    }
  });

  // ---------- 3. 正式：建批次發給所有好友 ----------
  // auth：admin session 或 scheduler secret（兩者擇一）
  app.post('/admin/broadcast/run-monthly-leaderboard', async (req, res) => {
    // 驗證來源：scheduler secret 或 admin session（authMiddleware 已全域填好 req.authUser）
    const expectedSecret = process.env.SCHEDULED_RUNNER_SECRET || '';
    const providedSecret = req.get('x-scheduler-secret') || '';
    const viaSecret = expectedSecret && providedSecret === expectedSecret;
    const viaAdmin = !!(req.authUser && req.authUser.adm);
    if (!viaSecret && !viaAdmin) return jsonErr(res, 403, 'forbidden');

    if (!lineChannelAccessToken) return jsonErr(res, 400, 'no_line_channel_access_token');

    const force = req.query.force === '1' || (req.body && req.body.force === true);

    try {
      const built = await buildLeaderboardMessage();
      if (!built.ok) return jsonErr(res, 400, built.error);

      // 每月只發一次（idempotency）
      const dupRs = await query(
        `SELECT id, status FROM admin_broadcasts
         WHERE audience_config->>'type' = 'monthly_leaderboard'
           AND audience_config->>'month' = $1
           AND status IN ('scheduled','running','done')
         ORDER BY id DESC LIMIT 1`,
        [built.monthKey]
      );
      if (dupRs.rowCount > 0 && !force) {
        return res.json({
          ok: true,
          skipped: 'already_sent_this_month',
          monthKey: built.monthKey,
          existingBroadcastId: dupRs.rows[0].id,
          existingStatus: dupRs.rows[0].status
        });
      }

      // 撈所有好友（有 line_user_id、非管理員）
      const recRs = await query(
        `SELECT id AS user_id, line_user_id FROM users
         WHERE line_user_id IS NOT NULL AND BTRIM(line_user_id) <> '' AND is_admin = false
         ORDER BY id ASC`
      );
      const recipients = recRs.rows;
      if (recipients.length === 0) return jsonErr(res, 400, 'no_friends');

      const messageConfig = { mode: 'flex_json', flex: built.flex };
      const audienceConfig = { type: 'monthly_leaderboard', month: built.monthKey, top_n: built.rows.length };

      const client = await pool.connect();
      let broadcastId = null;
      try {
        await client.query('BEGIN');
        const insRs = await client.query(
          `INSERT INTO admin_broadcasts
             (status, started_at, admin_username, audience_config, message_config,
              is_ab_test, recipient_total, channel)
           VALUES ('running', NOW(), $1, $2::jsonb, $3::jsonb, false, $4, 'line')
           RETURNING id`,
          [
            viaSecret ? 'scheduler' : ((req.authUser && req.authUser.un) || 'admin'),
            JSON.stringify(audienceConfig),
            JSON.stringify(messageConfig),
            recipients.length
          ]
        );
        broadcastId = insRs.rows[0].id;

        const BATCH = 500;
        for (let i = 0; i < recipients.length; i += BATCH) {
          const slice = recipients.slice(i, i + BATCH);
          const values = [];
          const params = [];
          slice.forEach((r, idx) => {
            const base = idx * 3;
            values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
            params.push(broadcastId, r.user_id, r.line_user_id);
          });
          await client.query(
            `INSERT INTO admin_broadcast_recipients (broadcast_id, user_id, line_user_id)
             VALUES ${values.join(', ')}`,
            params
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('leaderboard create tx error:', e && e.message);
        return jsonErr(res, 500, 'create_failed', { detail: e && e.message });
      } finally {
        client.release();
      }

      return res.json({
        ok: true,
        broadcastId,
        monthLabel: built.monthLabel,
        monthKey: built.monthKey,
        total: recipients.length,
        note: '已建立 running 批次，將由每 5 分鐘的排程逐批送出。'
      });
    } catch (err) {
      console.error('run-monthly-leaderboard error:', err && (err.stack || err.message));
      return jsonErr(res, 500, 'run_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminLeaderboardRoutes };
