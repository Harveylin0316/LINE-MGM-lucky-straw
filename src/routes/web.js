const bcrypt = require('bcryptjs');

async function logPrizeChange(client, payload) {
  await client.query(
    `INSERT INTO prize_change_logs
      (action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      payload.action,
      payload.prizeId || null,
      payload.beforeName || null,
      typeof payload.beforeQuantity === 'number' ? payload.beforeQuantity : null,
      payload.afterName || null,
      typeof payload.afterQuantity === 'number' ? payload.afterQuantity : null,
      payload.adminUsername
    ]
  );
}

function normalizeNextPath(rawNextPath, fallbackPath = '/admin/prizes') {
  if (typeof rawNextPath !== 'string') return fallbackPath;
  if (!rawNextPath.startsWith('/admin')) return fallbackPath;
  if (rawNextPath.startsWith('//')) return fallbackPath;
  return rawNextPath;
}

function registerWebRoutes(app, deps) {
  const {
    query,
    pool,
    authCore,
    lotteryCore,
    viewStateCore
  } = deps;

  const { requireAdmin, signAuthToken, setAuthCookie, clearAuthCookie } = authCore;
  const { enrichPrizesWithHitRate } = lotteryCore;
  const {
    invalidateAvailablePrizesCache,
    parsePage
  } = viewStateCore;

  function renderAdminLogin(res, error = null, nextPath = '/admin/prizes') {
    return res.render('login', {
      error,
      isAdmin: false,
      nextPath,
      loginAction: '/admin/login',
      title: '管理員登入',
      hint: '此入口僅提供管理員登入。'
    });
  }

  app.get('/', (req, res) => {
    if (req.authUser && req.authUser.adm) return res.redirect('/admin/prizes');
    return res.redirect('/admin/login');
  });

  app.get('/register', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.post('/register', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get('/admin/login', (req, res) => {
    const nextPath = normalizeNextPath(req.query.next, '/admin/prizes');
    return renderAdminLogin(res, null, nextPath);
  });

  app.get('/login', (_req, res) => {
    return res.redirect('/admin/login');
  });

  async function handleAdminLogin(req, res) {
    const { username, password } = req.body;
    const nextPath = normalizeNextPath(req.body.nextPath, '/admin/prizes');
    if (!username || !password) {
      return renderAdminLogin(res, '請輸入帳號與密碼', nextPath);
    }
    const found = await query('SELECT id, username, password_hash, is_admin FROM users WHERE username = $1', [username]);
    if (found.rowCount === 0) {
      return renderAdminLogin(res, '帳號或密碼錯誤', nextPath);
    }
    const user = found.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return renderAdminLogin(res, '帳號或密碼錯誤', nextPath);
    }
    if (!(user.is_admin === true || user.is_admin === 1)) {
      clearAuthCookie(res);
      return renderAdminLogin(res, '此入口僅提供管理員登入', nextPath);
    }
    const token = signAuthToken(user);
    setAuthCookie(res, token);
    return res.redirect(nextPath);
  }

  app.post('/admin/login', handleAdminLogin);
  app.post('/login', handleAdminLogin);

  app.post('/logout', (_req, res) => {
    clearAuthCookie(res);
    res.redirect('/admin/login');
  });

  app.get('/lottery', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.post('/lottery/draw', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get('/lottery/draw', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get('/my-draws', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get('/admin/prizes', requireAdmin, async (req, res, next) => {
    try {
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: null,
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/prizes/logs', requireAdmin, async (req, res, next) => {
    try {
      const pageSize = 50;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const [rows, total] = await Promise.all([
        query(
          `SELECT id, action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username, created_at
           FROM prize_change_logs
           ORDER BY id DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset]
        ),
        query('SELECT COUNT(*)::int AS total FROM prize_change_logs')
      ]);
      const totalCount = total.rows[0]?.total || 0;
      res.render('admin_prize_logs', {
        user: req.authUser.un,
        isAdmin: true,
        records: rows.rows || [],
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (rows.rows || []).length < totalCount
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/line/webhooks', requireAdmin, async (req, res, next) => {
    try {
      const pageSize = 50;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const [rows, total] = await Promise.all([
        query(
          `SELECT id, event_type, line_user_id, invite_id, inviter_user_id, result, detail, event_timestamp, created_at
           FROM line_webhook_events
           ORDER BY id DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset]
        ),
        query('SELECT COUNT(*)::int AS total FROM line_webhook_events')
      ]);
      const totalCount = total.rows[0]?.total || 0;
      res.render('admin_line_webhooks', {
        user: req.authUser.un,
        isAdmin: true,
        records: rows.rows || [],
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (rows.rows || []).length < totalCount
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/reports', requireAdmin, async (req, res, next) => {
    try {
      const pageSize = 50;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const rawKeyword = typeof req.query.q === 'string' ? req.query.q : '';
      const keyword = rawKeyword.trim();

      const summaryQueries = Promise.all([
        query('SELECT COUNT(*)::int AS total FROM users'),
        query('SELECT COUNT(*)::int AS total FROM draw_logs'),
        query('SELECT COUNT(*)::int AS total FROM draw_logs WHERE is_win = true'),
        query("SELECT COUNT(*)::int AS total FROM draw_logs WHERE created_at >= NOW() - INTERVAL '24 hours'"),
        query("SELECT COUNT(DISTINCT user_id)::int AS total FROM draw_logs WHERE created_at >= NOW() - INTERVAL '7 days'"),
        query(
          "SELECT COUNT(*) FILTER (WHERE status = 'rewarded')::int AS rewarded, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending FROM line_invites"
        ),
        query(
          `SELECT COUNT(*)::int AS total
           FROM (
             SELECT user_id
             FROM draw_logs
             WHERE created_at >= NOW() - INTERVAL '24 hours'
             GROUP BY user_id
             HAVING COUNT(*) >= 20
           ) t`
        ),
        query("SELECT COUNT(*)::int AS total FROM line_push_logs WHERE status = 'success'"),
        query("SELECT COUNT(*)::int AS total FROM line_push_logs WHERE status = 'failed'"),
        query("SELECT COUNT(*)::int AS total FROM line_push_logs WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours'")
      ]);

      const userStatsBaseParams = [];
      let userFilterSql = '';
      if (keyword) {
        userStatsBaseParams.push(`%${keyword}%`);
        userFilterSql = 'WHERE (u.username ILIKE $1 OR COALESCE(u.line_display_name, \'\') ILIKE $1)';
      }

      const countSql = `SELECT COUNT(*)::int AS total FROM users u ${userFilterSql}`;
      const countRs = await query(countSql, userStatsBaseParams);
      const totalUsersForPage = countRs.rows[0]?.total || 0;

      const listParams = [...userStatsBaseParams];
      const limitPlaceholder = `$${listParams.length + 1}`;
      const offsetPlaceholder = `$${listParams.length + 2}`;
      listParams.push(pageSize, offset);

      const userStatsSql = `
        SELECT
          u.id,
          u.username,
          u.line_display_name,
          u.draws_left,
          u.extra_draws,
          COALESCE(COUNT(d.id), 0)::int AS draws_used,
          COALESCE(COUNT(*) FILTER (WHERE d.is_win = true), 0)::int AS wins,
          MAX(d.created_at) AS last_draw_at,
          COALESCE(COUNT(*) FILTER (WHERE d.created_at >= NOW() - INTERVAL '24 hours'), 0)::int AS draws_24h,
          COALESCE(COUNT(*) FILTER (WHERE d.created_at >= NOW() - INTERVAL '7 days'), 0)::int AS draws_7d
        FROM users u
        LEFT JOIN draw_logs d ON d.user_id = u.id
        ${userFilterSql}
        GROUP BY u.id, u.username, u.line_display_name, u.draws_left, u.extra_draws
        ORDER BY draws_used DESC, u.id ASC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `;
      const usersRs = await query(userStatsSql, listParams);
      const pushLogsRs = await query(
        `SELECT id, user_id, line_user_id, push_type, status, http_status, detail, created_at
         FROM line_push_logs
         ORDER BY id DESC
         LIMIT 30`
      );

      const [
        totalUsersRs,
        totalDrawsRs,
        totalWinsRs,
        draws24hRs,
        activeUsers7dRs,
        inviteStatsRs,
        suspiciousUsersRs,
        pushSuccessRs,
        pushFailedRs,
        pushFailed24hRs
      ] = await summaryQueries;

      const totalDraws = totalDrawsRs.rows[0]?.total || 0;
      const totalWins = totalWinsRs.rows[0]?.total || 0;
      const winRatePct = totalDraws > 0 ? ((totalWins / totalDraws) * 100).toFixed(2) : '0.00';

      return res.render('admin_reports', {
        user: req.authUser.un,
        isAdmin: true,
        keyword,
        users: usersRs.rows || [],
        pushLogs: pushLogsRs.rows || [],
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (usersRs.rows || []).length < totalUsersForPage,
        summary: {
          totalUsers: totalUsersRs.rows[0]?.total || 0,
          totalDraws,
          totalWins,
          winRatePct,
          draws24h: draws24hRs.rows[0]?.total || 0,
          activeUsers7d: activeUsers7dRs.rows[0]?.total || 0,
          rewardedInvites: inviteStatsRs.rows[0]?.rewarded || 0,
          pendingInvites: inviteStatsRs.rows[0]?.pending || 0,
          suspiciousUsers24h: suspiciousUsersRs.rows[0]?.total || 0,
          pushSuccess: pushSuccessRs.rows[0]?.total || 0,
          pushFailed: pushFailedRs.rows[0]?.total || 0,
          pushFailed24h: pushFailed24hRs.rows[0]?.total || 0
        }
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/prizes/:id/edit', requireAdmin, async (req, res, next) => {
    try {
      const row = await query('SELECT id, name, quantity, created_at FROM prizes WHERE id = $1', [req.params.id]);
      if (row.rowCount === 0) return res.redirect('/admin/prizes');
      res.render('admin_prize_edit', {
        user: req.authUser.un,
        isAdmin: true,
        error: null,
        prize: row.rows[0]
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/prizes', requireAdmin, async (req, res) => {
    const { name, quantity } = req.body;
    const qty = Number(quantity);
    if (!name || Number.isNaN(qty) || qty < 0) {
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      return res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: '請輸入正確的獎品名稱與數量',
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query('INSERT INTO prizes (name, quantity) VALUES ($1, $2) RETURNING id', [name, qty]);
      await logPrizeChange(client, {
        action: 'create',
        prizeId: inserted.rows[0].id,
        afterName: name,
        afterQuantity: qty,
        adminUsername: req.authUser.un
      });
      await client.query('COMMIT');
      invalidateAvailablePrizesCache();
      return res.redirect('/admin/prizes');
    } catch (_err) {
      await client.query('ROLLBACK');
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      return res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: '新增獎品失敗',
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    } finally {
      client.release();
    }
  });

  app.post('/admin/prizes/:id/update', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, quantity } = req.body;
    const qty = Number(quantity);
    if (!name || Number.isNaN(qty) || qty < 0) {
      const row = await query('SELECT id, name, quantity, created_at FROM prizes WHERE id = $1', [id]);
      if (row.rowCount === 0) return res.redirect('/admin/prizes');
      return res.render('admin_prize_edit', {
        user: req.authUser.un,
        isAdmin: true,
        error: '修改失敗，請輸入正確的獎品名稱與數量',
        prize: { ...row.rows[0], name, quantity: Number.isNaN(qty) ? row.rows[0].quantity : qty }
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT id, name, quantity FROM prizes WHERE id = $1 FOR UPDATE', [id]);
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/admin/prizes');
      }
      await client.query('UPDATE prizes SET name = $1, quantity = $2 WHERE id = $3', [name, qty, id]);
      await logPrizeChange(client, {
        action: 'update',
        prizeId: Number(id),
        beforeName: existing.rows[0].name,
        beforeQuantity: Number(existing.rows[0].quantity),
        afterName: name,
        afterQuantity: qty,
        adminUsername: req.authUser.un
      });
      await client.query('COMMIT');
      invalidateAvailablePrizesCache();
      return res.redirect('/admin/prizes');
    } catch (_err) {
      await client.query('ROLLBACK');
      const row = await query('SELECT id, name, quantity, created_at FROM prizes WHERE id = $1', [id]);
      if (row.rowCount === 0) return res.redirect('/admin/prizes');
      return res.render('admin_prize_edit', {
        user: req.authUser.un,
        isAdmin: true,
        error: '修改獎品失敗',
        prize: row.rows[0]
      });
    } finally {
      client.release();
    }
  });

  app.post('/admin/prizes/:id/delete', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT id, name, quantity FROM prizes WHERE id = $1 FOR UPDATE', [id]);
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/admin/prizes');
      }
      await client.query('DELETE FROM prizes WHERE id = $1', [id]);
      await logPrizeChange(client, {
        action: 'delete',
        prizeId: existing.rows[0].id,
        beforeName: existing.rows[0].name,
        beforeQuantity: Number(existing.rows[0].quantity),
        adminUsername: req.authUser.un
      });
      await client.query(`
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS new_id
          FROM prizes
        )
        UPDATE prizes p
        SET id = ordered.new_id
        FROM ordered
        WHERE p.id = ordered.id
      `);
      await client.query(`SELECT setval('prizes_id_seq', COALESCE((SELECT MAX(id) FROM prizes), 1), true)`);
      await client.query('COMMIT');
      invalidateAvailablePrizesCache();
      return res.redirect('/admin/prizes');
    } catch (_err) {
      await client.query('ROLLBACK');
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      return res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: '刪除獎品失敗',
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    } finally {
      client.release();
    }
  });
}

module.exports = { registerWebRoutes };
