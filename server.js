const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin1234';

// DB setup
const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      draws_left INTEGER NOT NULL DEFAULT 1,
      referrer_id INTEGER,
      extra_draws INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS prizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS draw_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      is_win INTEGER NOT NULL DEFAULT 0,
      prize_name TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  db.run(
    `CREATE TABLE IF NOT EXISTS prize_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      prize_id INTEGER,
      before_name TEXT,
      before_quantity INTEGER,
      after_name TEXT,
      after_quantity INTEGER,
      admin_username TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // 若舊資料表沒有相關欄位，嘗試補上（已存在時忽略錯誤）
  db.run(
    'ALTER TABLE users ADD COLUMN draws_left INTEGER NOT NULL DEFAULT 1',
    err => {
      if (err && !String(err.message).includes('duplicate column name')) {
        console.error('Failed to add draws_left column:', err.message);
      }
    }
  );

  db.run(
    'ALTER TABLE users ADD COLUMN referrer_id INTEGER',
    err => {
      if (err && !String(err.message).includes('duplicate column name')) {
        console.error('Failed to add referrer_id column:', err.message);
      }
    }
  );

  db.run(
    'ALTER TABLE users ADD COLUMN extra_draws INTEGER NOT NULL DEFAULT 0',
    err => {
      if (err && !String(err.message).includes('duplicate column name')) {
        console.error('Failed to add extra_draws column:', err.message);
      }
    }
  );

  db.run(
    'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
    err => {
      if (err && !String(err.message).includes('duplicate column name')) {
        console.error('Failed to add is_admin column:', err.message);
      }
    }
  );

  db.run(
    'ALTER TABLE prizes ADD COLUMN weight INTEGER NOT NULL DEFAULT 1',
    err => {
      if (err && !String(err.message).includes('duplicate column name')) {
        console.error('Failed to add weight column:', err.message);
      }
    }
  );

  // 啟動時自動建立預設管理員帳號（若不存在）
  db.get(
    'SELECT id FROM users WHERE username = ?',
    [ADMIN_USERNAME],
    (err, row) => {
      if (err || row) return;
      const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      db.run(
        'INSERT INTO users (username, password_hash, draws_left, is_admin) VALUES (?, ?, 1, 1)',
        [ADMIN_USERNAME, adminHash]
      );
    }
  );
});

// View engine & static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Body parser
app.use(express.urlencoded({ extended: false }));

// Session
app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
    secret: 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 } // 1 hour
  })
);

// Helpers
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).send('僅管理員可存取此頁面');
  }
  next();
}

function pickPrizeByQuantity(prizes) {
  const valid = (prizes || []).filter(p => p.quantity > 0);
  if (valid.length === 0) return null;

  const totalQty = valid.reduce((sum, p) => sum + p.quantity, 0);
  let rand = Math.floor(Math.random() * totalQty);

  for (const prize of valid) {
    rand -= prize.quantity;
    if (rand < 0) {
      return prize;
    }
  }
  return valid[valid.length - 1];
}

function enrichPrizesWithHitRate(prizes) {
  const rows = prizes || [];
  const totalQty = rows.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  return rows.map(p => {
    const qty = Number(p.quantity || 0);
    const rate = totalQty > 0 ? qty / totalQty : 0;
    return {
      ...p,
      hitRate: `${(rate * 100).toFixed(2)}%`
    };
  });
}

function logPrizeChange({
  action,
  prizeId,
  beforeName,
  beforeQuantity,
  afterName,
  afterQuantity,
  adminUsername
}) {
  db.run(
    `INSERT INTO prize_change_logs
      (action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      action,
      prizeId || null,
      beforeName || null,
      typeof beforeQuantity === 'number' ? beforeQuantity : null,
      afterName || null,
      typeof afterQuantity === 'number' ? afterQuantity : null,
      adminUsername
    ]
  );
}

function resequencePrizeIds(done) {
  db.all('SELECT name, quantity, weight, created_at FROM prizes ORDER BY id ASC', (readErr, rows) => {
    if (readErr) return done(readErr);

    db.serialize(() => {
      const fail = err => db.run('ROLLBACK', () => done(err));

      db.run('BEGIN TRANSACTION', beginErr => {
        if (beginErr) return done(beginErr);

        db.run('DELETE FROM prizes', deleteErr => {
          if (deleteErr) return fail(deleteErr);

          const stmt = db.prepare(
            'INSERT INTO prizes (id, name, quantity, weight, created_at) VALUES (?, ?, ?, ?, ?)'
          );

          for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            stmt.run(i + 1, row.name, row.quantity, row.weight || 1, row.created_at);
          }

          stmt.finalize(finalizeErr => {
            if (finalizeErr) return fail(finalizeErr);

            const maxId = rows.length;
            db.run("DELETE FROM sqlite_sequence WHERE name = 'prizes'", seqDeleteErr => {
              if (seqDeleteErr) return fail(seqDeleteErr);

              const commitWithSeq = () =>
                db.run('COMMIT', commitErr => {
                  if (commitErr) return done(commitErr);
                  done(null);
                });

              if (maxId > 0) {
                db.run(
                  "INSERT INTO sqlite_sequence (name, seq) VALUES ('prizes', ?)",
                  [maxId],
                  seqInsertErr => {
                    if (seqInsertErr) return fail(seqInsertErr);
                    commitWithSeq();
                  }
                );
                return;
              }

              commitWithSeq();
            });
          });
        });
      });
    });
  });
}

// Routes
app.get('/', (req, res) => {
  res.render('index', {
    user: req.session.username,
    isAdmin: !!req.session.isAdmin
  });
});

app.get('/register', (req, res) => {
  const referrerId = req.query.ref || '';
  res.render('register', { error: null, referrerId, isAdmin: false });
});

app.post('/register', (req, res) => {
  const { username, password, referrerId } = req.body;
  if (!username || !password) {
    return res.render('register', {
      error: '請輸入帳號與密碼',
      referrerId,
      isAdmin: false
    });
  }

  const hash = bcrypt.hashSync(password, 10);

  db.run(
    'INSERT INTO users (username, password_hash, referrer_id) VALUES (?, ?, ?)',
    [username, hash, referrerId || null],
    function (err) {
      if (err) {
        let msg = '註冊失敗';
        if (err && err.message && err.message.includes('UNIQUE')) {
          msg = '此帳號已被使用';
        }
        return res.render('register', { error: msg, referrerId, isAdmin: false });
      }

      // 若有推薦人，替推薦人加一次抽獎（最多額外 2 次）
      if (referrerId) {
        db.get(
          'SELECT draws_left, extra_draws FROM users WHERE id = ?',
          [referrerId],
          (getErr, refUser) => {
            if (!getErr && refUser && refUser.extra_draws < 2) {
              const newExtra = refUser.extra_draws + 1;
              db.run(
                'UPDATE users SET extra_draws = ?, draws_left = draws_left + 1 WHERE id = ?',
                [newExtra, referrerId],
                () => {
                  // 即使失敗也不影響新會員註冊流程
                }
              );
            }
          }
        );
      }

      res.redirect('/login');
    }
  );
});

app.get('/login', (req, res) => {
  res.render('login', { error: null, isAdmin: false });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: '請輸入帳號與密碼', isAdmin: false });
  }

  db.get(
    'SELECT * FROM users WHERE username = ?',
    [username],
    (err, user) => {
      if (err || !user) {
        return res.render('login', { error: '帳號或密碼錯誤', isAdmin: false });
      }

      const ok = bcrypt.compareSync(password, user.password_hash);
      if (!ok) {
        return res.render('login', { error: '帳號或密碼錯誤', isAdmin: false });
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.isAdmin = user.is_admin === 1;
      res.redirect('/lottery');
    }
  );
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Lottery page (must login)
app.get('/lottery', requireLogin, (req, res) => {
  db.get(
    'SELECT draws_left, extra_draws FROM users WHERE id = ?',
    [req.session.userId],
    (err, row) => {
      const drawsLeft = !err && row ? row.draws_left : 0;
      const extraDraws = !err && row ? row.extra_draws : 0;
      const host = req.headers.host;
      const refLink = `http://${host}/register?ref=${req.session.userId}`;
      db.all('SELECT name, quantity FROM prizes WHERE quantity > 0 ORDER BY id ASC', (prizeErr, prizeRows) => {
        res.render('lottery', {
          user: req.session.username,
          isAdmin: !!req.session.isAdmin,
          result: null,
          drawsLeft,
          extraDraws,
          refLink,
          availablePrizes: prizeErr ? [] : prizeRows || []
        });
      });
    }
  );
});

// Lottery action
app.post('/lottery/draw', requireLogin, (req, res) => {
  db.get(
    'SELECT draws_left, extra_draws FROM users WHERE id = ?',
    [req.session.userId],
    (err, row) => {
      const drawsLeftFromDb = !err && row ? row.draws_left : 0;
      const extraDraws = !err && row ? row.extra_draws : 0;
      const host = req.headers.host;
      const refLink = `http://${host}/register?ref=${req.session.userId}`;
      const renderLottery = (resultMessage, drawsLeftValue) => {
        db.all('SELECT name, quantity FROM prizes WHERE quantity > 0 ORDER BY id ASC', (prizeErr, prizeRows) => {
          res.render('lottery', {
            user: req.session.username,
            isAdmin: !!req.session.isAdmin,
            result: resultMessage,
            drawsLeft: drawsLeftValue,
            extraDraws,
            refLink,
            availablePrizes: prizeErr ? [] : prizeRows || []
          });
        });
      };

      if (err || !row) {
        return renderLottery('系統錯誤，請稍後再試', 0);
      }

      const currentLeft = drawsLeftFromDb || 0;

      if (currentLeft <= 0) {
        return renderLottery('您的抽獎次數已用完', 0);
      }

      const newLeft = currentLeft - 1;
      // 改為必中：從剩餘庫存中依比例抽出獎品
      db.all(
        'SELECT id, name, quantity FROM prizes WHERE quantity > 0',
        (prizeErr, prizeRows) => {
          if (prizeErr || !prizeRows || prizeRows.length === 0) {
            return renderLottery('目前沒有可抽獎品，請聯絡管理員補庫存', currentLeft);
          }

          const picked = pickPrizeByQuantity(prizeRows);
          if (!picked) {
            return renderLottery('目前沒有可抽獎品，請聯絡管理員補庫存', currentLeft);
          }

          db.run(
            'UPDATE prizes SET quantity = quantity - 1 WHERE id = ? AND quantity > 0',
            [picked.id],
            function (decreaseErr) {
              if (decreaseErr || this.changes === 0) {
                return renderLottery('獎品已被抽完，請再試一次', currentLeft);
              }

              db.run(
                'UPDATE users SET draws_left = ? WHERE id = ?',
                [newLeft, req.session.userId],
                userUpdateErr => {
                  if (userUpdateErr) {
                    return renderLottery('系統錯誤，請稍後再試', currentLeft);
                  }

                  const message = `恭喜中獎！獲得：${picked.name}`;
                  db.run(
                    'INSERT INTO draw_logs (user_id, is_win, prize_name, message) VALUES (?, 1, ?, ?)',
                    [req.session.userId, picked.name, message]
                  );
                  renderLottery(message, newLeft);
                }
              );
            }
          );
        }
      );
    }
  );
});

// Member - my draw history
app.get('/my-draws', requireLogin, (req, res) => {
  db.all(
    'SELECT is_win, prize_name, message, created_at FROM draw_logs WHERE user_id = ? ORDER BY id DESC',
    [req.session.userId],
    (err, rows) => {
      res.render('my_draws', {
        user: req.session.username,
        isAdmin: !!req.session.isAdmin,
        records: err ? [] : rows || []
      });
    }
  );
});

// Admin - Prize settings page
app.get('/admin/prizes', requireAdmin, (req, res) => {
  db.all('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC', (err, rows) => {
    if (err) {
      return res.render('admin_prizes', {
        user: req.session.username,
        isAdmin: true,
        error: '讀取獎品資料失敗',
        prizes: []
      });
    }

    res.render('admin_prizes', {
      user: req.session.username,
      isAdmin: true,
      error: null,
      prizes: enrichPrizesWithHitRate(rows)
    });
  });
});

app.get('/admin/prizes/logs', requireAdmin, (req, res) => {
  db.all(
    `SELECT id, action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username, created_at
     FROM prize_change_logs
     ORDER BY id DESC`,
    (err, rows) => {
      res.render('admin_prize_logs', {
        user: req.session.username,
        isAdmin: true,
        records: err ? [] : rows || []
      });
    }
  );
});

app.get('/admin/prizes/:id/edit', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.get('SELECT id, name, quantity, created_at FROM prizes WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      return res.redirect('/admin/prizes');
    }

    res.render('admin_prize_edit', {
      user: req.session.username,
      isAdmin: true,
      error: null,
      prize: row
    });
  });
});

app.post('/admin/prizes', requireAdmin, (req, res) => {
  const { name, quantity } = req.body;
  const qty = Number(quantity);

  if (!name || Number.isNaN(qty) || qty < 0) {
    return db.all('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC', (err, rows) => {
      res.render('admin_prizes', {
        user: req.session.username,
        isAdmin: true,
        error: '請輸入正確的獎品名稱與數量',
        prizes: err ? [] : enrichPrizesWithHitRate(rows)
      });
    });
  }

  db.run('INSERT INTO prizes (name, quantity) VALUES (?, ?)', [name, qty], function (insertErr) {
    if (insertErr) {
      return db.all('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC', (err, rows) => {
        res.render('admin_prizes', {
          user: req.session.username,
          isAdmin: true,
          error: '新增獎品失敗',
          prizes: err ? [] : enrichPrizesWithHitRate(rows)
        });
      });
    }
    logPrizeChange({
      action: 'create',
      prizeId: this.lastID,
      afterName: name,
      afterQuantity: qty,
      adminUsername: req.session.username
    });
    res.redirect('/admin/prizes');
  });
});

app.post('/admin/prizes/:id/update', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, quantity } = req.body;
  const qty = Number(quantity);

  if (!name || Number.isNaN(qty) || qty < 0) {
    return db.get('SELECT id, name, quantity, created_at FROM prizes WHERE id = ?', [id], (err, row) => {
      if (err || !row) return res.redirect('/admin/prizes');
      res.render('admin_prize_edit', {
        user: req.session.username,
        isAdmin: true,
        error: '修改失敗，請輸入正確的獎品名稱與數量',
        prize: {
          id: row.id,
          name,
          quantity: Number.isNaN(qty) ? row.quantity : qty,
          created_at: row.created_at
        }
      });
    });
  }

  db.get('SELECT id, name, quantity, created_at FROM prizes WHERE id = ?', [id], (getErr, existing) => {
    if (getErr || !existing) {
      return res.redirect('/admin/prizes');
    }

    db.run('UPDATE prizes SET name = ?, quantity = ? WHERE id = ?', [name, qty, id], function (updateErr) {
      if (updateErr || this.changes === 0) {
        return res.render('admin_prize_edit', {
          user: req.session.username,
          isAdmin: true,
          error: '修改獎品失敗',
          prize: existing
        });
      }

      logPrizeChange({
        action: 'update',
        prizeId: Number(id),
        beforeName: existing.name,
        beforeQuantity: existing.quantity,
        afterName: name,
        afterQuantity: qty,
        adminUsername: req.session.username
      });
      res.redirect('/admin/prizes');
    });
  });
});

app.post('/admin/prizes/:id/delete', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.get('SELECT id, name, quantity FROM prizes WHERE id = ?', [id], (getErr, existing) => {
    if (getErr || !existing) {
      return res.redirect('/admin/prizes');
    }

    db.run('DELETE FROM prizes WHERE id = ?', [id], function (deleteErr) {
      if (deleteErr || this.changes === 0) {
        return db.all('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC', (err, rows) => {
          res.render('admin_prizes', {
            user: req.session.username,
            isAdmin: true,
            error: '刪除獎品失敗',
            prizes: err ? [] : enrichPrizesWithHitRate(rows)
          });
        });
      }

      logPrizeChange({
        action: 'delete',
        prizeId: existing.id,
        beforeName: existing.name,
        beforeQuantity: existing.quantity,
        adminUsername: req.session.username
      });

      resequencePrizeIds(resequenceErr => {
        if (resequenceErr) {
          return db.all('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC', (err, rows) => {
            res.render('admin_prizes', {
              user: req.session.username,
              isAdmin: true,
              error: '刪除成功，但重排 ID 失敗，請稍後重試',
              prizes: err ? [] : enrichPrizesWithHitRate(rows)
            });
          });
        }
        res.redirect('/admin/prizes');
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

