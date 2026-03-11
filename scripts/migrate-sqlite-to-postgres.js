const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const SQLITE_PATH = path.join(__dirname, '..', 'data.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sqlite = new sqlite3.Database(SQLITE_PATH);
const pg = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

function sqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    sqlite.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function run() {
  const client = await pg.connect();
  try {
    console.log('Starting migration from sqlite to postgres...');
    await client.query('BEGIN');

    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      draws_left INTEGER NOT NULL DEFAULT 1,
      referrer_id INTEGER,
      extra_draws INTEGER NOT NULL DEFAULT 0,
      is_admin BOOLEAN NOT NULL DEFAULT false
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS prizes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS draw_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      is_win BOOLEAN NOT NULL DEFAULT false,
      prize_name TEXT,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS prize_change_logs (
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

    const users = await sqliteAll(
      'SELECT id, username, password_hash, draws_left, referrer_id, extra_draws, is_admin FROM users ORDER BY id ASC'
    );
    const prizes = await sqliteAll('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
    const drawLogs = await sqliteAll(
      'SELECT id, user_id, is_win, prize_name, message, created_at FROM draw_logs ORDER BY id ASC'
    );
    const prizeLogs = await sqliteAll(
      `SELECT id, action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username, created_at
       FROM prize_change_logs ORDER BY id ASC`
    );

    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, username, password_hash, draws_left, referrer_id, extra_draws, is_admin)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          u.id,
          u.username,
          u.password_hash,
          u.draws_left || 0,
          u.referrer_id || null,
          u.extra_draws || 0,
          !!u.is_admin
        ]
      );
    }

    for (const p of prizes) {
      await client.query(
        `INSERT INTO prizes (id, name, quantity, created_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.quantity || 0, p.created_at || new Date().toISOString()]
      );
    }

    for (const d of drawLogs) {
      await client.query(
        `INSERT INTO draw_logs (id, user_id, is_win, prize_name, message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, d.user_id, !!d.is_win, d.prize_name || null, d.message, d.created_at || new Date().toISOString()]
      );
    }

    for (const l of prizeLogs) {
      await client.query(
        `INSERT INTO prize_change_logs
          (id, action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          l.id,
          l.action,
          l.prize_id || null,
          l.before_name || null,
          l.before_quantity || null,
          l.after_name || null,
          l.after_quantity || null,
          l.admin_username,
          l.created_at || new Date().toISOString()
        ]
      );
    }

    await client.query(`SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1), true)`);
    await client.query(`SELECT setval('prizes_id_seq', COALESCE((SELECT MAX(id) FROM prizes), 1), true)`);
    await client.query(`SELECT setval('draw_logs_id_seq', COALESCE((SELECT MAX(id) FROM draw_logs), 1), true)`);
    await client.query(
      `SELECT setval('prize_change_logs_id_seq', COALESCE((SELECT MAX(id) FROM prize_change_logs), 1), true)`
    );

    await client.query('COMMIT');
    console.log('Migration done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pg.end();
    sqlite.close();
  }
}

run();
