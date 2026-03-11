const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'change-this-jwt-secret';
const DATABASE_URL = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';

if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL. Please configure Postgres connection string.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

function resolveAssetDir(dirName, expectedFile) {
  const candidates = [
    path.join(__dirname, dirName),
    path.join(__dirname, '..', dirName),
    path.join(process.cwd(), dirName),
    path.join('/var/task', dirName),
    path.join('/var/task', 'src', dirName)
  ];
  for (const candidate of candidates) {
    const target = expectedFile ? path.join(candidate, expectedFile) : candidate;
    if (fs.existsSync(target)) return candidate;
  }
  return path.join(__dirname, dirName);
}

const viewsDir = resolveAssetDir('views', 'index.ejs');
const publicDir = resolveAssetDir('public', 'style.css');

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', viewsDir);
app.use(express.static(publicDir));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/login', authLimiter);
app.use('/register', authLimiter);

async function query(text, params = []) {
  return pool.query(text, params);
}

function signAuthToken(user) {
  return jwt.sign(
    { uid: user.id, un: user.username, adm: user.is_admin === true || user.is_admin === 1 },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function setAuthCookie(res, token) {
  res.cookie('auth_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie('auth_token');
}

function authMiddleware(req, _res, next) {
  const token = req.cookies.auth_token;
  if (!token) {
    req.authUser = null;
    return next();
  }
  try {
    req.authUser = jwt.verify(token, JWT_SECRET);
  } catch (_err) {
    req.authUser = null;
  }
  next();
}

app.use(authMiddleware);

function requireLogin(req, res, next) {
  if (!req.authUser || !req.authUser.uid) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.authUser || !req.authUser.adm) return res.status(403).send('僅管理員可存取此頁面');
  next();
}

function pickPrizeByQuantity(prizes) {
  const valid = prizes.filter(p => Number(p.quantity) > 0);
  const totalQty = valid.reduce((sum, p) => sum + Number(p.quantity), 0);
  let rand = Math.floor(Math.random() * totalQty);
  for (const prize of valid) {
    rand -= Number(prize.quantity);
    if (rand < 0) return prize;
  }
  return valid[valid.length - 1];
}

function enrichPrizesWithHitRate(prizes) {
  const totalQty = prizes.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  return prizes.map(p => ({
    ...p,
    hitRate: `${(totalQty > 0 ? (Number(p.quantity || 0) / totalQty) * 100 : 0).toFixed(2)}%`
  }));
}

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

async function initDb() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    draws_left INTEGER NOT NULL DEFAULT 1,
    referrer_id INTEGER,
    extra_draws INTEGER NOT NULL DEFAULT 0,
    is_admin BOOLEAN NOT NULL DEFAULT false
  )`);

  await query(`CREATE TABLE IF NOT EXISTS prizes (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS draw_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    is_win BOOLEAN NOT NULL DEFAULT false,
    prize_name TEXT,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS prize_change_logs (
    id SERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    prize_id INTEGER,
    before_name TEXT,
    before_quantity INTEGER,
    after_name TEXT,
    after_quantity INTEGER,
    admin_username TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const adminCheck = await query('SELECT id FROM users WHERE username = $1', [ADMIN_USERNAME]);
  if (adminCheck.rowCount === 0) {
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await query(
      'INSERT INTO users (username, password_hash, draws_left, is_admin) VALUES ($1, $2, 1, true)',
      [ADMIN_USERNAME, adminHash]
    );
  }
}

const initPromise = initDb().catch(err => {
  console.error('Database initialization failed:', err.message);
  throw err;
});

app.use(async (_req, _res, next) => {
  try {
    await initPromise;
    next();
  } catch (err) {
    next(err);
  }
});

app.get('/', (req, res) => {
  res.render('index', {
    user: req.authUser ? req.authUser.un : null,
    isAdmin: !!(req.authUser && req.authUser.adm)
  });
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

app.get('/login', (_req, res) => {
  res.render('login', { error: null, isAdmin: false });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: '請輸入帳號與密碼', isAdmin: false });
  }
  const found = await query('SELECT id, username, password_hash, is_admin FROM users WHERE username = $1', [username]);
  if (found.rowCount === 0) {
    return res.render('login', { error: '帳號或密碼錯誤', isAdmin: false });
  }
  const user = found.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.render('login', { error: '帳號或密碼錯誤', isAdmin: false });
  }
  const token = signAuthToken(user);
  setAuthCookie(res, token);
  return res.redirect('/lottery');
});

app.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.redirect('/');
});

app.get('/lottery', requireLogin, async (req, res, next) => {
  try {
    const userRs = await query('SELECT draws_left, extra_draws FROM users WHERE id = $1', [req.authUser.uid]);
    const row = userRs.rows[0] || { draws_left: 0, extra_draws: 0 };
    const prizeRs = await query('SELECT name FROM prizes WHERE quantity > 0 ORDER BY id ASC');
    const refLink = `https://${req.headers.host}/register?ref=${req.authUser.uid}`;
    res.render('lottery', {
      user: req.authUser.un,
      isAdmin: !!req.authUser.adm,
      result: null,
      drawsLeft: row.draws_left || 0,
      extraDraws: row.extra_draws || 0,
      refLink,
      availablePrizes: prizeRs.rows || []
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
    const extraDraws = Number(userRs.rows[0].extra_draws || 0);
    if (currentLeft <= 0) {
      await client.query('ROLLBACK');
      const prizeRs = await query('SELECT name FROM prizes WHERE quantity > 0 ORDER BY id ASC');
      return res.render('lottery', {
        user: req.authUser.un,
        isAdmin: !!req.authUser.adm,
        result: '您的抽獎次數已用完',
        drawsLeft: 0,
        extraDraws,
        refLink: `https://${req.headers.host}/register?ref=${req.authUser.uid}`,
        availablePrizes: prizeRs.rows || []
      });
    }

    const prizeRs = await client.query('SELECT id, name, quantity FROM prizes WHERE quantity > 0 ORDER BY id ASC FOR UPDATE');
    if (prizeRs.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.render('lottery', {
        user: req.authUser.un,
        isAdmin: !!req.authUser.adm,
        result: '目前沒有可抽獎品，請聯絡管理員補庫存',
        drawsLeft: currentLeft,
        extraDraws,
        refLink: `https://${req.headers.host}/register?ref=${req.authUser.uid}`,
        availablePrizes: []
      });
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

    const latestPrizeRs = await query('SELECT name FROM prizes WHERE quantity > 0 ORDER BY id ASC');
    return res.render('lottery', {
      user: req.authUser.un,
      isAdmin: !!req.authUser.adm,
      result: message,
      drawsLeft: currentLeft - 1,
      extraDraws,
      refLink: `https://${req.headers.host}/register?ref=${req.authUser.uid}`,
      availablePrizes: latestPrizeRs.rows || []
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

app.get('/my-draws', requireLogin, async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT is_win, prize_name, message, created_at FROM draw_logs WHERE user_id = $1 ORDER BY id DESC',
      [req.authUser.uid]
    );
    res.render('my_draws', {
      user: req.authUser.un,
      isAdmin: !!req.authUser.adm,
      records: rows.rows || []
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
    const rows = await query(
      `SELECT id, action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username, created_at
       FROM prize_change_logs
       ORDER BY id DESC`
    );
    res.render('admin_prize_logs', {
      user: req.authUser.un,
      isAdmin: true,
      records: rows.rows || []
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
    const inserted = await client.query(
      'INSERT INTO prizes (name, quantity) VALUES ($1, $2) RETURNING id',
      [name, qty]
    );
    await logPrizeChange(client, {
      action: 'create',
      prizeId: inserted.rows[0].id,
      afterName: name,
      afterQuantity: qty,
      adminUsername: req.authUser.un
    });
    await client.query('COMMIT');
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

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).send('Server error');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;

