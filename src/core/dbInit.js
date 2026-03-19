const bcrypt = require('bcryptjs');

async function initDb({ query, adminUsername, adminPassword }) {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    draws_left INTEGER NOT NULL DEFAULT 1,
    referrer_id INTEGER,
    extra_draws INTEGER NOT NULL DEFAULT 0,
    is_admin BOOLEAN NOT NULL DEFAULT false
  )`);

  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS line_user_id TEXT');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS line_display_name TEXT');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS line_picture_url TEXT');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code TEXT');

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

  await query(`CREATE TABLE IF NOT EXISTS line_invites (
    id SERIAL PRIMARY KEY,
    inviter_user_id INTEGER NOT NULL,
    invitee_line_user_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    followed_at TIMESTAMPTZ,
    rewarded_at TIMESTAMPTZ
  )`);

  await query(`CREATE TABLE IF NOT EXISTS line_webhook_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    line_user_id TEXT,
    invite_id INTEGER,
    inviter_user_id INTEGER,
    result TEXT NOT NULL,
    detail TEXT,
    event_timestamp TIMESTAMPTZ,
    raw_event JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS line_push_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    line_user_id TEXT,
    push_type TEXT NOT NULL DEFAULT 'winner_notification',
    status TEXT NOT NULL,
    http_status INTEGER,
    detail TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Supabase exposes public schema via PostgREST by default.
  // Enable RLS on app tables to prevent direct external reads/writes.
  await query('ALTER TABLE users ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE prizes ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE draw_logs ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE prize_change_logs ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE line_invites ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE line_webhook_events ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE line_push_logs ENABLE ROW LEVEL SECURITY');

  await query('CREATE INDEX IF NOT EXISTS draw_logs_user_id_id_desc_idx ON draw_logs(user_id, id DESC)');
  await query('CREATE INDEX IF NOT EXISTS prizes_quantity_id_idx ON prizes(quantity, id)');
  await query('CREATE UNIQUE INDEX IF NOT EXISTS users_line_user_id_unique_idx ON users(line_user_id)');
  await query('CREATE UNIQUE INDEX IF NOT EXISTS users_invite_code_unique_idx ON users(invite_code)');
  await query('CREATE INDEX IF NOT EXISTS line_invites_inviter_user_id_idx ON line_invites(inviter_user_id)');
  await query('CREATE INDEX IF NOT EXISTS line_webhook_events_created_id_desc_idx ON line_webhook_events(created_at DESC, id DESC)');
  await query('CREATE INDEX IF NOT EXISTS line_webhook_events_line_user_id_idx ON line_webhook_events(line_user_id)');
  await query('CREATE INDEX IF NOT EXISTS line_push_logs_created_id_desc_idx ON line_push_logs(created_at DESC, id DESC)');
  await query('CREATE INDEX IF NOT EXISTS line_push_logs_user_id_idx ON line_push_logs(user_id)');
  await query('CREATE INDEX IF NOT EXISTS line_push_logs_status_idx ON line_push_logs(status)');
  await query("DELETE FROM prizes WHERE name ~* '^\\s*test\\b'");

  const adminCheck = await query('SELECT id FROM users WHERE username = $1', [adminUsername]);
  if (adminCheck.rowCount === 0) {
    if (!adminPassword || adminPassword.length < 8) {
      throw new Error('Missing or weak ADMIN_PASSWORD. Use at least 8 characters.');
    }
    const adminHash = await bcrypt.hash(adminPassword, 10);
    await query('INSERT INTO users (username, password_hash, draws_left, is_admin) VALUES ($1, $2, 1, true)', [
      adminUsername,
      adminHash
    ]);
  }
}

module.exports = { initDb };
