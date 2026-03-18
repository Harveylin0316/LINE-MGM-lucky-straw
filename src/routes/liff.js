function normalizeLiffNextPath(rawNextPath, fallbackPath = '/liff/lottery') {
  if (typeof rawNextPath !== 'string') return fallbackPath;
  if (!rawNextPath.startsWith('/liff')) return fallbackPath;
  if (rawNextPath.startsWith('//')) return fallbackPath;
  return rawNextPath;
}

function registerLiffRoutes(app, deps) {
  const { query, pool, lotteryCore, viewStateCore } = deps;
  const { pickPrizeByQuantity } = lotteryCore;
  const {
    setDrawResultCookie,
    consumeDrawResultCookie,
    invalidateAvailablePrizesCache,
    getAvailablePrizes
  } = viewStateCore;

  function requireLiffLogin(req, res, next) {
    if (req.authUser && req.authUser.uid) return next();
    const nextPath = normalizeLiffNextPath(req.originalUrl, '/liff/lottery');
    return res.redirect(`/liff/login?next=${encodeURIComponent(nextPath)}`);
  }

  app.get('/liff', (_req, res) => {
    res.redirect('/liff/lottery');
  });

  app.get('/liff/login', (req, res) => {
    if (req.authUser && req.authUser.uid) return res.redirect('/liff/lottery');
    const nextPath = normalizeLiffNextPath(req.query.next, '/liff/lottery');
    res.render('liff_login', { nextPath });
  });

  app.get('/liff/lottery', requireLiffLogin, async (req, res, next) => {
    try {
      const [userRs, availablePrizes] = await Promise.all([
        query('SELECT draws_left, extra_draws FROM users WHERE id = $1', [req.authUser.uid]),
        getAvailablePrizes()
      ]);
      const row = userRs.rows[0] || { draws_left: 0, extra_draws: 0 };
      const drawResult = consumeDrawResultCookie(req, res);
      res.render('liff_lottery', {
        user: req.authUser.un,
        result: drawResult,
        drawsLeft: row.draws_left || 0,
        extraDraws: row.extra_draws || 0,
        availablePrizes
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/liff/lottery/draw', requireLiffLogin, async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRs = await client.query('SELECT draws_left FROM users WHERE id = $1 FOR UPDATE', [req.authUser.uid]);
      if (userRs.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/liff/lottery');
      }

      const currentLeft = Number(userRs.rows[0].draws_left || 0);
      if (currentLeft <= 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '您的抽獎次數已用完');
        return res.redirect('/liff/lottery');
      }

      const prizeRs = await client.query('SELECT id, name, quantity FROM prizes WHERE quantity > 0 ORDER BY id ASC FOR UPDATE');
      if (prizeRs.rowCount === 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '目前沒有可抽獎品，請聯絡管理員補庫存');
        return res.redirect('/liff/lottery');
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
      return res.redirect('/liff/lottery');
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  });
}

module.exports = { registerLiffRoutes };
