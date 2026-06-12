const bcrypt = require('bcryptjs');

/** 與下方 ENABLE ROW LEVEL SECURITY 的表一致；RLS 開啟後須有 policy，否則非 superuser 連線會讀寫皆 0 列（Supabase 常見）。 */
const APP_PUBLIC_TABLES_WITH_RLS = [
  'users',
  'prizes',
  'draw_logs',
  'prize_change_logs',
  'line_invites',
  'line_webhook_events',
  'line_push_logs',
  'campaign_settings',
  'admin_login_throttle',
  'line_push_media',
  'admin_push_settings',
  'admin_manual_bonus_logs',
  'admin_broadcasts',
  'admin_broadcast_recipients',
  'admin_test_recipients',
  'admin_recipient_lists',
  'admin_recipient_list_members',
  'admin_broadcast_clicks',
  'admin_broadcast_views',
  'admin_message_templates',
  'admin_keyword_replies'
];

/**
 * 允許後端連線角色（postgres，及 Supabase 的 service_role）存取上述表。
 * anon / authenticated 仍無 policy → PostgREST 無法越權讀寫。
 */
async function ensureAppServerRlsPolicies(query) {
  const tableList = APP_PUBLIC_TABLES_WITH_RLS.map(t => `'${t}'`).join(', ');
  await query(`
DO $$
DECLARE
  t text;
  role_list text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    role_list := 'postgres, service_role';
  ELSE
    role_list := 'postgres';
  END IF;

  FOREACH t IN ARRAY ARRAY[${tableList}]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'app_server_full_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY app_server_full_access ON public.%I FOR ALL TO %s USING (true) WITH CHECK (true)',
        t,
        role_list
      );
    END IF;
  END LOOP;
END $$;
`);
}

/**
 * Netlify 等 serverless：冷啟動若跑完整 DDL（100+ 次往返 DB）會撞 10s timeout
 * → user 看到 server error。
 *
 * Schema 已透過 Supabase MCP migrations 管理（活動框架、user_events、
 * admin_* 表等都在 DB 上），dbInit 不需要再跑 DDL。
 *
 * skipDdl=true（推薦 production）→ 純 SELECT 1 驗連線，~50ms 完成
 * skipDdl=false（legacy）→ 跑完整 DDL，僅限本機初始化新環境
 */
async function initDb({ query, adminUsername, adminPassword, skipDdl = true }) {
  if (skipDdl) {
    // Cold start 第一次連 DB 偶爾撞 timeout，retry 一次再放棄
    try {
      await query('SELECT 1');
    } catch (firstErr) {
      console.warn('initDb SELECT 1 failed, retrying once:', firstErr && firstErr.message);
      await new Promise(r => setTimeout(r, 500));
      await query('SELECT 1');
    }
    return;
  }

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

  await query(`CREATE TABLE IF NOT EXISTS campaign_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(
    `INSERT INTO campaign_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );

  await query(`CREATE TABLE IF NOT EXISTS admin_login_throttle (
    id BIGSERIAL PRIMARY KEY,
    ip_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS line_push_media (
    id UUID PRIMARY KEY,
    mime_type TEXT NOT NULL,
    body BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT line_push_media_mime_chk CHECK (mime_type IN ('image/png', 'image/jpeg'))
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_push_settings (
    slug TEXT PRIMARY KEY,
    message_text TEXT NOT NULL DEFAULT '',
    image_media_id UUID REFERENCES line_push_media(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(
    `INSERT INTO admin_push_settings (slug, message_text) VALUES ('invite_reminder', '') ON CONFLICT (slug) DO NOTHING`
  );
  await query('ALTER TABLE admin_push_settings ADD COLUMN IF NOT EXISTS flex_json JSONB');

  await query(`CREATE TABLE IF NOT EXISTS admin_manual_bonus_logs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    target_user_id INTEGER NOT NULL,
    target_username TEXT NOT NULL,
    bonus_count INTEGER NOT NULL,
    adjust_extra BOOLEAN NOT NULL DEFAULT false,
    admin_username TEXT NOT NULL,
    draws_left_after INTEGER NOT NULL,
    extra_draws_after INTEGER NOT NULL
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_broadcasts (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'draft',
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    admin_username TEXT NOT NULL,
    audience_config JSONB NOT NULL,
    message_config JSONB NOT NULL,
    recipient_total INTEGER NOT NULL DEFAULT 0,
    recipient_ok INTEGER NOT NULL DEFAULT 0,
    recipient_fail INTEGER NOT NULL DEFAULT 0,
    recipient_skip INTEGER NOT NULL DEFAULT 0
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_broadcast_recipients (
    id BIGSERIAL PRIMARY KEY,
    broadcast_id BIGINT NOT NULL REFERENCES admin_broadcasts(id) ON DELETE CASCADE,
    user_id INTEGER,
    line_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pushed_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_test_recipients (
    id BIGSERIAL PRIMARY KEY,
    label TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    added_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_recipient_lists (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_recipient_list_members (
    id BIGSERIAL PRIMARY KEY,
    list_id BIGINT NOT NULL REFERENCES admin_recipient_lists(id) ON DELETE CASCADE,
    line_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_broadcast_clicks (
    id BIGSERIAL PRIMARY KEY,
    broadcast_id BIGINT NOT NULL REFERENCES admin_broadcasts(id) ON DELETE CASCADE,
    target_url TEXT NOT NULL,
    user_agent TEXT,
    referer TEXT,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_broadcast_views (
    id BIGSERIAL PRIMARY KEY,
    broadcast_id BIGINT NOT NULL REFERENCES admin_broadcasts(id) ON DELETE CASCADE,
    user_agent TEXT,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_message_templates (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    message_config JSONB NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS admin_keyword_replies (
    id SERIAL PRIMARY KEY,
    keywords TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'contains',
    message_template_id BIGINT REFERENCES admin_message_templates(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 100,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
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
  await query('ALTER TABLE campaign_settings ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_login_throttle ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE line_push_media ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_push_settings ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_manual_bonus_logs ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_broadcasts ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_broadcast_recipients ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_test_recipients ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_recipient_lists ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_recipient_list_members ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_broadcast_clicks ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_broadcast_views ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_message_templates ENABLE ROW LEVEL SECURITY');
  await query('ALTER TABLE admin_keyword_replies ENABLE ROW LEVEL SECURITY');

  await query(
    'CREATE INDEX IF NOT EXISTS admin_login_throttle_ip_created_idx ON admin_login_throttle (ip_key, created_at DESC)'
  );
  await query(
    'CREATE UNIQUE INDEX IF NOT EXISTS admin_test_recipients_line_user_id_unique ON admin_test_recipients (line_user_id)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_recipient_list_members_list_id_idx ON admin_recipient_list_members (list_id)'
  );
  await query(
    'CREATE UNIQUE INDEX IF NOT EXISTS admin_recipient_list_members_list_id_line_user_id_unique ON admin_recipient_list_members (list_id, line_user_id)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_recipient_lists_created_id_desc_idx ON admin_recipient_lists (created_at DESC, id DESC)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_broadcast_id_idx ON admin_broadcast_clicks (broadcast_id)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_clicked_at_idx ON admin_broadcast_clicks (clicked_at DESC)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_views_broadcast_id_idx ON admin_broadcast_views (broadcast_id)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_views_viewed_at_idx ON admin_broadcast_views (viewed_at DESC)'
  );
  await query(
    'CREATE UNIQUE INDEX IF NOT EXISTS admin_message_templates_name_unique ON admin_message_templates (BTRIM(name))'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_message_templates_created_id_desc_idx ON admin_message_templates (created_at DESC, id DESC)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_keyword_replies_active_priority_idx ON admin_keyword_replies (is_active, priority, id)'
  );
  // A/B test columns（後加）
  await query('ALTER TABLE admin_broadcasts ADD COLUMN IF NOT EXISTS is_ab_test BOOLEAN NOT NULL DEFAULT false');
  await query('ALTER TABLE admin_broadcasts ADD COLUMN IF NOT EXISTS variant_b_message_config JSONB');
  await query("ALTER TABLE admin_broadcast_recipients ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT 'a'");
  await query('ALTER TABLE admin_broadcast_clicks ADD COLUMN IF NOT EXISTS variant TEXT');
  await query('ALTER TABLE admin_broadcast_views ADD COLUMN IF NOT EXISTS variant TEXT');
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_recipients_broadcast_variant_idx ON admin_broadcast_recipients (broadcast_id, variant)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_clicks_broadcast_variant_idx ON admin_broadcast_clicks (broadcast_id, variant)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_views_broadcast_variant_idx ON admin_broadcast_views (broadcast_id, variant)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcasts_created_id_desc_idx ON admin_broadcasts (created_at DESC, id DESC)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcasts_status_idx ON admin_broadcasts (status)'
  );
  await query(
    'CREATE INDEX IF NOT EXISTS admin_broadcast_recipients_broadcast_status_idx ON admin_broadcast_recipients (broadcast_id, status)'
  );

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
  await query(
    'CREATE INDEX IF NOT EXISTS admin_manual_bonus_logs_created_id_desc_idx ON admin_manual_bonus_logs (created_at DESC, id DESC)'
  );
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

  await ensureAppServerRlsPolicies(query);
}

module.exports = { initDb };
