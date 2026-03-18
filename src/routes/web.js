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

function normalizeNextPath(rawNextPath, fallbackPath = '/lottery') {
  if (typeof rawNextPath !== 'string') return fallbackPath;
  if (!rawNextPath.startsWith('/')) return fallbackPath;
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

  const { requireLogin, requireAdmin, signAuthToken, setAuthCookie, clearAuthCookie } = authCore;
  const { pickPrizeByQuantity, enrichPrizesWithHitRate } = lotteryCore;
  const {
    setDrawResultCookie,
    consumeDrawResultCookie,
    invalidateAvailablePrizesCache,
    getAvailablePrizes,
    buildRefLink,
    parsePage
  } = viewStateCore;

  app.get('/', requireLogin, (_req, res) => {
    res.redirect('/lottery');
  });

  app.get('/register', (req, res) => {
    const referrerId = req.query.ref || '';
    res.render('register', { error: null, referrerId, isAdmin: false });
  });

  app.post('/register', async (req, res) => {
    const { username, password, referrerId } = req.body;
    if (!username || !password) {
      return res.render('register', { error: '請輸入帳號與密碼', referrerId, isAdmin: false });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      const inserted = await query(
        'INSERT INTO users (username, password_hash, referrer_id) VALUES ($1, $2, $3) RETURNING id',
        [username, hash, referrerId || null]
      );
      const newUserId = inserted.rows[0].id;

      if (referrerId && Number(referrerId) !== Number(newUserId)) {
        await query(
          `UPDATE users
           SET extra_draws = CASE WHEN extra_draws < 2 THEN extra_draws + 1 ELSE extra_draws END,
               draws_left = CASE WHEN extra_draws < 2 THEN draws_left + 1 ELSE draws_left END
           WHERE id = $1`,
          [referrerId]
        );
      }
      return res.redirect('/login');
    } catch (err) {
      const msg = String(err.message || '').includes('duplicate key') ? '此帳號已被使用' : '註冊失敗';
      return res.render('register', { error: msg, referrerId, isAdmin: false });
    }
  });

  app.get('/login', (req, res) => {
    const nextPath = normalizeNextPath(req.query.next, '/lottery');
    res.render('login', { error: null, isAdmin: false, nextPath });
  });

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const nextPath = normalizeNextPath(req.body.nextPath, '/lottery');
    if (!username || !password) {
      return res.render('login', { error: '請輸入帳號與密碼', isAdmin: false, nextPath });
    }
    const found = await query('SELECT id, username, password_hash, is_admin FROM users WHERE username = $1', [username]);
    if (found.rowCount === 0) {
      return res.render('login', { error: '帳號或密碼錯誤', isAdmin: false, nextPath });
    }
    const user = found.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.render('login', { error: '帳號或密碼錯誤', isAdmin: false, nextPath });
    }
    const token = signAuthToken(user);
    setAuthCookie(res, token);
    return res.redirect(nextPath);
  });

  app.post('/logout', (_req, res) => {
    clearAuthCookie(res);
    res.redirect('/');
  });

  app.get('/lottery', requireLogin, async (req, res, next) => {
    try {
      const [userRs, availablePrizes] = await Promise.all([
        query('SELECT draws_left, extra_draws FROM users WHERE id = $1', [req.authUser.uid]),
        getAvailablePrizes()
      ]);
      const row = userRs.rows[0] || { draws_left: 0, extra_draws: 0 };
      const refLink = buildRefLink(req, req.authUser.uid);
      const drawResult = consumeDrawResultCookie(req, res);
      res.render('lottery', {
        user: req.authUser.un,
        isAdmin: !!req.authUser.adm,
        result: drawResult,
        drawsLeft: row.draws_left || 0,
        extraDraws: row.extra_draws || 0,
        refLink,
        availablePrizes
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/lottery/draw', requireLogin, async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRs = await client.query(
        'SELECT draws_left, extra_draws FROM users WHERE id = $1 FOR UPDATE',
        [req.authUser.uid]
      );
      if (userRs.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/lottery');
      }

      const currentLeft = Number(userRs.rows[0].draws_left || 0);
      if (currentLeft <= 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '您的抽獎次數已用完');
        return res.redirect('/lottery');
      }

      const prizeRs = await client.query('SELECT id, name, quantity FROM prizes WHERE quantity > 0 ORDER BY id ASC FOR UPDATE');
      if (prizeRs.rowCount === 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '目前沒有可抽獎品，請聯絡管理員補庫存');
        return res.redirect('/lottery');
      }

      const picked = pickPrizeByQuantity(prizeRs.rows);
      await client.query('UPDATE prizes SET quantity = quantity - 1 WHERE id = $1 AND quantity > 0', [picked.id]);
      await client.query('UPDATE users SET draws_left = draws_left - 1 WHERE id = $1', [req.authUser.uid]);
      const message = `恭喜中獎！獲得：${picked.name}`;
      await client.query(
        'INSERT INTO draw_logs (user_id, is_win, prize_name, message) VALUES ($1, true, $2, $3)',
        [req.authUser.uid, picked.name, message]
      );
      await client.query('COMMIT');

      invalidateAvailablePrizesCache();
      setDrawResultCookie(res, message);
      return res.redirect('/lottery');
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  });

  app.get('/lottery/draw', requireLogin, (_req, res) => {
    res.redirect('/lottery');
  });

  app.get('/my-draws', requireLogin, async (req, res, next) => {
    try {
      const pageSize = 30;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const [rows, total] = await Promise.all([
        query(
          'SELECT is_win, prize_name, message, created_at FROM draw_logs WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3',
          [req.authUser.uid, pageSize, offset]
        ),
        query('SELECT COUNT(*)::int AS total FROM draw_logs WHERE user_id = $1', [req.authUser.uid])
      ]);
      const totalCount = total.rows[0]?.total || 0;
      res.render('my_draws', {
        user: req.authUser.un,
        isAdmin: !!req.authUser.adm,
        records: rows.rows || [],
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (rows.rows || []).length < totalCount
      });
    } catch (err) {
      next(err);
    }
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
