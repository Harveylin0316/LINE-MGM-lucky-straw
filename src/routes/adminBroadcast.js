/**
 * 後台「群發訊息」功能 routes
 *
 * 流程：
 * 1. GET  /admin/broadcast                       → 後台單頁（條件 + 訊息 + 預覽 + 送出）
 * 2. POST /admin/broadcast/audience/preview      → JSON: 收件人數 + sample
 * 3. POST /admin/broadcast/hero/upload           → multer 上傳 → 存 line_push_media
 * 4. POST /admin/broadcast/preview-message       → JSON: 渲染好的 LINE Flex
 * 5. POST /admin/broadcast/create                → 建批次 + 寫 recipients（status=running）
 * 6. POST /admin/broadcast/:id/process-chunk     → 處理 N 筆 pending（前端輪詢直到 done）
 * 7. POST /admin/broadcast/:id/cancel            → 取消未發完的批次
 *
 * 為什麼用「前端輪詢 chunk」：Netlify Functions 預設 10 秒 timeout，500-5000 人
 * 同步迴圈會超時。改成前端每次送 50 個收件人，直到後端回 done=true。
 */

const crypto = require('crypto');
const multer = require('multer');

const {
  buildLineMessages,
  normalizeTemplateInput,
  FIELD_LIMITS
} = require('../core/broadcastTemplates');
const {
  normalizeConditions,
  hasAnyCondition,
  previewAudience,
  fetchAudienceRecipients,
  MAX_RECIPIENTS_PER_BROADCAST
} = require('../core/broadcastAudience');

const CHUNK_SIZE_DEFAULT = 50;
const CHUNK_SIZE_MAX = 100;

function isPositiveIntegerString(s) {
  return typeof s === 'string' && /^\d+$/.test(s) && Number(s) > 0;
}

function safeJsonError(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

function registerAdminBroadcastRoutes(app, deps) {
  const {
    query,
    pool,
    authCore,
    linePush,
    lineChannelAccessToken,
    resolvePublicSiteOrigin = () => ''
  } = deps;

  const { requireAdmin } = authCore;

  const uploadHero = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
        cb(null, true);
      } else {
        cb(new Error('INVALID_HERO_IMAGE_TYPE'));
      }
    }
  });

  // ---------- helpers ----------

  function publicOriginOrEmpty(req) {
    const origin = String(resolvePublicSiteOrigin(req) || '').replace(/\/+$/, '');
    return /^https:\/\//i.test(origin) ? origin : '';
  }

  async function loadPrizes() {
    const rs = await query(
      `SELECT id, name, quantity FROM prizes
       WHERE NOT (LOWER(BTRIM(name)) LIKE 'test%')
       ORDER BY id ASC`
    );
    return rs.rows;
  }

  async function loadRecentBroadcasts(limit = 10) {
    const rs = await query(
      `SELECT id, created_at, status, admin_username, recipient_total, recipient_ok, recipient_fail, recipient_skip,
              audience_config, message_config, started_at, finished_at
       FROM admin_broadcasts
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    return rs.rows;
  }

  async function loadBroadcast(id) {
    const rs = await query(`SELECT * FROM admin_broadcasts WHERE id = $1`, [id]);
    return rs.rowCount === 0 ? null : rs.rows[0];
  }

  // ---------- 0a-new. /v/b/:broadcastId/:recipientId/:mediaId（含 recipient 追蹤）----------
  // 新版含 recipient_id；JOIN admin_broadcast_recipients 取 line_user_id 寫入 views
  app.get('/v/b/:broadcastId(\\d+)/:recipientId(\\d+)/:mediaId([0-9a-fA-F-]{36})', async (req, res) => {
    const broadcastId = Number(req.params.broadcastId);
    const recipientId = Number(req.params.recipientId);
    const mediaId = String(req.params.mediaId).trim();
    const variant = req.query.v === 'a' || req.query.v === 'b' ? req.query.v : null;
    try {
      const rs = await query('SELECT mime_type, body FROM line_push_media WHERE id = $1', [mediaId]);
      if (rs.rowCount === 0) return res.status(404).type('text/plain').send('Not found');
      // 寫 view log + 帶 recipient_id / line_user_id（不阻塞回 image）
      query(
        `INSERT INTO admin_broadcast_views (broadcast_id, recipient_id, line_user_id, user_agent, variant)
         SELECT $1, $2, m.line_user_id, $3, $4
         FROM admin_broadcast_recipients m
         WHERE m.id = $2 AND m.broadcast_id = $1`,
        [broadcastId, recipientId, (req.get('user-agent') || '').slice(0, 500), variant]
      ).catch(err => console.error('view log (rid) failed:', err.message));
      const row = rs.rows[0];
      const buf = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body);
      res.setHeader('Content-Type', row.mime_type);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (err) {
      console.error('view tracker (rid) error:', err.message);
      return res.status(500).type('text/plain').send('Server error');
    }
  });

  // ---------- 0a. public view tracking: /v/b/:broadcastId/:mediaId（舊版 backward compat）----------
  // LINE app render hero 圖時會 fetch 這個 URL，server 寫一筆 view log + 回 image bytes。
  // 注意：開信率 proxy，非精確的「已讀」— LINE app cache 可能少報、prefetch 可能多報。
  app.get('/v/b/:broadcastId/:mediaId', async (req, res) => {
    const bIdStr = String(req.params.broadcastId || '').trim();
    const mediaId = String(req.params.mediaId || '').trim();
    if (!isPositiveIntegerString(bIdStr)) return res.status(404).type('text/plain').send('Not found');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const broadcastId = Number(bIdStr);
    const variant = req.query.v === 'a' || req.query.v === 'b' ? req.query.v : null;
    try {
      const rs = await query(
        'SELECT mime_type, body FROM line_push_media WHERE id = $1',
        [mediaId]
      );
      if (rs.rowCount === 0) return res.status(404).type('text/plain').send('Not found');
      // 寫 view log（不阻塞回 image）
      query(
        `INSERT INTO admin_broadcast_views (broadcast_id, user_agent, variant) VALUES ($1, $2, $3)`,
        [broadcastId, (req.get('user-agent') || '').slice(0, 500), variant]
      ).catch(err => console.error('view log failed:', err.message));
      const row = rs.rows[0];
      const buf = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body);
      res.setHeader('Content-Type', row.mime_type);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (err) {
      console.error('view tracker error:', err.message);
      return res.status(500).type('text/plain').send('Server error');
    }
  });

  // ---------- 0-new. /r/b/:broadcastId/:recipientId（含 recipient 追蹤）----------
  app.get('/r/b/:broadcastId(\\d+)/:recipientId(\\d+)', async (req, res) => {
    const broadcastId = Number(req.params.broadcastId);
    const recipientId = Number(req.params.recipientId);
    const variant = req.query.v === 'a' || req.query.v === 'b' ? req.query.v : null;
    try {
      const rs = await query(
        `SELECT message_config, variant_b_message_config FROM admin_broadcasts WHERE id = $1`,
        [broadcastId]
      );
      if (rs.rowCount === 0) return res.status(404).type('text/plain').send('Not found');
      const cfg = (variant === 'b' ? rs.rows[0].variant_b_message_config : rs.rows[0].message_config) || {};
      let targetUrl = '';
      if (cfg.mode === 'template' && cfg.template && typeof cfg.template.ctaUrl === 'string') {
        targetUrl = cfg.template.ctaUrl.trim();
      }
      if (!/^https?:\/\//i.test(targetUrl)) {
        return res.status(404).type('text/plain').send('Not found');
      }
      // 寫 click log + 帶 recipient_id / line_user_id
      query(
        `INSERT INTO admin_broadcast_clicks (broadcast_id, recipient_id, line_user_id, target_url, user_agent, referer, variant)
         SELECT $1, $2, m.line_user_id, $3, $4, $5, $6
         FROM admin_broadcast_recipients m
         WHERE m.id = $2 AND m.broadcast_id = $1`,
        [
          broadcastId, recipientId, targetUrl,
          (req.get('user-agent') || '').slice(0, 500),
          (req.get('referer') || '').slice(0, 500),
          variant
        ]
      ).catch(err => console.error('click log (rid) failed:', err.message));
      return res.redirect(302, targetUrl);
    } catch (err) {
      console.error('redirect (rid) error:', err.message);
      return res.status(500).type('text/plain').send('Server error');
    }
  });

  // ---------- 0. public redirect: /r/b/:broadcastId（舊版 backward compat）----------
  // 從 DB 撈該批次的 template.ctaUrl，寫一筆 click log，302 redirect。
  // 用 broadcast_id 作為授權邊界（不允許 query string 傳目標 URL，避免 open redirect）。
  app.get('/r/b/:broadcastId', async (req, res) => {
    const idStr = String(req.params.broadcastId || '').trim();
    if (!isPositiveIntegerString(idStr)) return res.status(404).type('text/plain').send('Not found');
    const broadcastId = Number(idStr);
    const variant = req.query.v === 'a' || req.query.v === 'b' ? req.query.v : null;
    try {
      const rs = await query(
        `SELECT message_config, variant_b_message_config FROM admin_broadcasts WHERE id = $1`,
        [broadcastId]
      );
      if (rs.rowCount === 0) return res.status(404).type('text/plain').send('Not found');
      const cfg = (variant === 'b' ? rs.rows[0].variant_b_message_config : rs.rows[0].message_config) || {};
      let targetUrl = '';
      if (cfg.mode === 'template' && cfg.template && typeof cfg.template.ctaUrl === 'string') {
        targetUrl = cfg.template.ctaUrl.trim();
      }
      // 防呆：必須 http(s)
      if (!/^https?:\/\//i.test(targetUrl)) {
        return res.status(404).type('text/plain').send('Not found');
      }
      // 寫 click log（不阻塞 redirect）
      query(
        `INSERT INTO admin_broadcast_clicks (broadcast_id, target_url, user_agent, referer, variant)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          broadcastId,
          targetUrl,
          (req.get('user-agent') || '').slice(0, 500),
          (req.get('referer') || '').slice(0, 500),
          variant
        ]
      ).catch(err => console.error('click log failed:', err.message));
      return res.redirect(302, targetUrl);
    } catch (err) {
      console.error('redirect error:', err.message);
      return res.status(500).type('text/plain').send('Server error');
    }
  });

  // ---------- 1. main page ----------
  app.get('/admin/broadcast', requireAdmin, async (req, res, next) => {
    try {
      const [prizes, recent, scheduledRs, runningRs] = await Promise.all([
        loadPrizes(),
        loadRecentBroadcasts(10),
        query(
          `SELECT id, scheduled_at, admin_username, recipient_total, created_at
           FROM admin_broadcasts
           WHERE status = 'scheduled'
           ORDER BY scheduled_at ASC NULLS LAST, id DESC`
        ),
        query(
          `SELECT id, scheduled_at, admin_username, recipient_total,
                  recipient_ok, recipient_fail, recipient_skip,
                  started_at, created_at,
                  (SELECT COUNT(*)::int FROM admin_broadcast_recipients
                   WHERE broadcast_id = b.id AND status IN ('pending','sending')) AS pending_count
           FROM admin_broadcasts b
           WHERE status = 'running'
           ORDER BY started_at ASC NULLS LAST, id ASC`
        )
      ]);
      return res.render('admin_broadcast', {
        title: '群發訊息',
        bodyClass: 'admin-shell broadcast-shell',
        user: req.authUser && req.authUser.un ? req.authUser.un : '',
        isAdmin: true,
        prizes,
        recent,
        scheduled: scheduledRs.rows,
        running: runningRs.rows,
        hasLineToken: Boolean(lineChannelAccessToken),
        maxRecipients: MAX_RECIPIENTS_PER_BROADCAST,
        chunkSize: CHUNK_SIZE_DEFAULT,
        fieldLimits: FIELD_LIMITS
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- 2. audience preview ----------
  app.post('/admin/broadcast/audience/preview', requireAdmin, async (req, res) => {
    try {
      const conditions = req.body && req.body.conditions;
      const result = await previewAudience(query, conditions);
      return res.json({
        ok: true,
        total: result.total,
        sample: result.sample,
        conditions: result.conditions,
        error: result.error || null
      });
    } catch (err) {
      console.error('audience preview error:', err.message);
      return safeJsonError(res, 500, 'preview_failed');
    }
  });

  // ---------- 3. hero image upload ----------
  app.post(
    '/admin/broadcast/hero/upload',
    requireAdmin,
    (req, res, next) => {
      uploadHero.single('hero')(req, res, err => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return safeJsonError(res, 400, 'file_too_large_max_2mb');
          }
          if (err.message === 'INVALID_HERO_IMAGE_TYPE') {
            return safeJsonError(res, 400, 'only_png_or_jpeg');
          }
          return next(err);
        }
        next();
      });
    },
    async (req, res) => {
      try {
        const file = req.file;
        if (!file || !file.buffer || !file.mimetype) {
          return safeJsonError(res, 400, 'no_file');
        }
        const newId = crypto.randomUUID();
        await query(`INSERT INTO line_push_media (id, mime_type, body) VALUES ($1, $2, $3)`, [
          newId,
          file.mimetype,
          file.buffer
        ]);
        const origin = publicOriginOrEmpty(req);
        const url = origin ? `${origin}/p/line-media/${newId}` : null;
        return res.json({ ok: true, mediaId: newId, url });
      } catch (err) {
        console.error('hero upload error:', err.message);
        return safeJsonError(res, 500, 'upload_failed');
      }
    }
  );

  // ---------- 2c. message templates CRUD ----------
  app.get('/admin/broadcast/templates', requireAdmin, async (_req, res) => {
    try {
      const rs = await query(
        `SELECT id, name, description, created_by, created_at
         FROM admin_message_templates
         ORDER BY id DESC`
      );
      return res.json({ ok: true, templates: rs.rows });
    } catch (err) {
      console.error('list templates error:', err);
      return safeJsonError(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  app.get('/admin/broadcast/templates/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPositiveIntegerString(idStr)) return safeJsonError(res, 400, 'invalid_id');
    try {
      const rs = await query(
        `SELECT id, name, description, message_config, created_by, created_at
         FROM admin_message_templates WHERE id = $1`,
        [Number(idStr)]
      );
      if (rs.rowCount === 0) return safeJsonError(res, 404, 'not_found');
      return res.json({ ok: true, template: rs.rows[0] });
    } catch (err) {
      console.error('get template error:', err);
      return safeJsonError(res, 500, 'get_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/broadcast/templates', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 500);
      const messageConfig = body.message_config;
      if (!name) return safeJsonError(res, 400, 'name_required');
      if (!messageConfig || typeof messageConfig !== 'object') {
        return safeJsonError(res, 400, 'message_config_required');
      }
      // 簡單驗：用 buildLineMessages 跑一次（沒 broadcastId / origin）看會不會 fail
      const built = buildLineMessages(messageConfig);
      if (!built.ok) return safeJsonError(res, 400, 'message_config_invalid:' + built.error);

      const createdBy = (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';
      try {
        const insRs = await query(
          `INSERT INTO admin_message_templates (name, description, message_config, created_by)
           VALUES ($1, $2, $3::jsonb, $4)
           RETURNING id, name, description, created_by, created_at`,
          [name, description || null, JSON.stringify(messageConfig), createdBy]
        );
        return res.json({ ok: true, template: insRs.rows[0] });
      } catch (e) {
        if (e && e.code === '23505') {
          return safeJsonError(res, 400, 'duplicate_name', {
            detail: '已有同名模板，請改名或先刪除舊的'
          });
        }
        throw e;
      }
    } catch (err) {
      console.error('create template error:', err);
      return safeJsonError(res, 500, 'create_failed', { detail: err && err.message });
    }
  });

  app.delete('/admin/broadcast/templates/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPositiveIntegerString(idStr)) return safeJsonError(res, 400, 'invalid_id');
    try {
      const rs = await query(
        'DELETE FROM admin_message_templates WHERE id = $1 RETURNING id',
        [Number(idStr)]
      );
      if (rs.rowCount === 0) return safeJsonError(res, 404, 'not_found');
      return res.json({ ok: true });
    } catch (err) {
      console.error('delete template error:', err);
      return safeJsonError(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });

  // ---------- 2b. recipient-lists CRUD（已儲存名單） ----------
  app.get('/admin/broadcast/recipient-lists', requireAdmin, async (_req, res) => {
    try {
      const rs = await query(
        `SELECT id, name, description, total, created_by, created_at
         FROM admin_recipient_lists
         ORDER BY id DESC`
      );
      return res.json({ ok: true, lists: rs.rows });
    } catch (err) {
      console.error('list recipient lists error:', err);
      return safeJsonError(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  app.get('/admin/broadcast/recipient-lists/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPositiveIntegerString(idStr)) return safeJsonError(res, 400, 'invalid_id');
    try {
      const listRs = await query(
        `SELECT id, name, description, total, created_by, created_at
         FROM admin_recipient_lists WHERE id = $1`,
        [Number(idStr)]
      );
      if (listRs.rowCount === 0) return safeJsonError(res, 404, 'not_found');
      const memRs = await query(
        `SELECT m.id, m.line_user_id, u.line_display_name, u.username
         FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.list_id = $1
         ORDER BY m.id ASC
         LIMIT 50`,
        [Number(idStr)]
      );
      return res.json({ ok: true, list: listRs.rows[0], sample: memRs.rows });
    } catch (err) {
      console.error('get recipient list error:', err);
      return safeJsonError(res, 500, 'get_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/broadcast/recipient-lists', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 500);
      const rawIds = Array.isArray(body.lineUserIds) ? body.lineUserIds : [];

      if (!name) return safeJsonError(res, 400, 'name_required');
      // 清洗 / 去重 / 驗證
      const valid = [];
      const seen = new Set();
      const invalid = [];
      for (const raw of rawIds) {
        const s = String(raw || '').trim();
        if (!s) continue;
        if (!/^U[0-9a-f]{32}$/i.test(s)) {
          invalid.push(s.slice(0, 50));
          continue;
        }
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        valid.push(s);
      }
      if (valid.length === 0) {
        return safeJsonError(res, 400, 'no_valid_line_user_ids', {
          detail: invalid.length > 0 ? '所有提供的 ID 都格式錯誤（需 U + 32 hex）' : '名單為空'
        });
      }
      if (valid.length > 5000) {
        return safeJsonError(res, 400, 'too_many_recipients', {
          detail: '單一名單上限 5000 人（提供了 ' + valid.length + '）'
        });
      }

      const createdBy = (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insListRs = await client.query(
          `INSERT INTO admin_recipient_lists (name, description, total, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, description, total, created_by, created_at`,
          [name, description || null, valid.length, createdBy]
        );
        const listId = insListRs.rows[0].id;
        // 分批 INSERT members
        const BATCH = 500;
        for (let i = 0; i < valid.length; i += BATCH) {
          const slice = valid.slice(i, i + BATCH);
          const values = [];
          const params = [];
          slice.forEach((uid, idx) => {
            const base = idx * 2;
            values.push(`($${base + 1}, $${base + 2})`);
            params.push(listId, uid);
          });
          await client.query(
            `INSERT INTO admin_recipient_list_members (list_id, line_user_id)
             VALUES ${values.join(', ')}`,
            params
          );
        }
        await client.query('COMMIT');
        return res.json({
          ok: true,
          list: insListRs.rows[0],
          accepted: valid.length,
          rejectedInvalid: invalid.length,
          rejectedSample: invalid.slice(0, 5)
        });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_rb) {}
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('create recipient list error:', err);
      return safeJsonError(res, 500, 'create_failed', { detail: err && err.message });
    }
  });

  app.delete('/admin/broadcast/recipient-lists/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPositiveIntegerString(idStr)) return safeJsonError(res, 400, 'invalid_id');
    try {
      const rs = await query(
        'DELETE FROM admin_recipient_lists WHERE id = $1 RETURNING id',
        [Number(idStr)]
      );
      if (rs.rowCount === 0) return safeJsonError(res, 404, 'not_found');
      return res.json({ ok: true });
    } catch (err) {
      console.error('delete recipient list error:', err);
      return safeJsonError(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });

  // ---------- 3a. test-recipients CRUD ----------
  app.get('/admin/broadcast/test-recipients', requireAdmin, async (_req, res) => {
    try {
      const rs = await query(
        `SELECT id, label, line_user_id, added_by, created_at
         FROM admin_test_recipients ORDER BY id ASC`
      );
      return res.json({ ok: true, recipients: rs.rows });
    } catch (err) {
      console.error('list test recipients error:', err);
      return safeJsonError(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  app.post('/admin/broadcast/test-recipients', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const label = String(body.label || '').trim().slice(0, 100);
      const lineUserId = String(body.lineUserId || '').trim();
      if (!label) return safeJsonError(res, 400, 'label_required');
      if (!/^U[0-9a-f]{32}$/i.test(lineUserId)) {
        return safeJsonError(res, 400, 'invalid_line_user_id');
      }
      const addedBy = (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';
      try {
        const rs = await query(
          `INSERT INTO admin_test_recipients (label, line_user_id, added_by)
           VALUES ($1, $2, $3)
           RETURNING id, label, line_user_id, added_by, created_at`,
          [label, lineUserId, addedBy]
        );
        return res.json({ ok: true, recipient: rs.rows[0] });
      } catch (e) {
        if (e && e.code === '23505') {
          return safeJsonError(res, 400, 'duplicate_line_user_id');
        }
        throw e;
      }
    } catch (err) {
      console.error('add test recipient error:', err);
      return safeJsonError(res, 500, 'add_failed', { detail: err && err.message });
    }
  });

  app.delete('/admin/broadcast/test-recipients/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPositiveIntegerString(idStr)) return safeJsonError(res, 400, 'invalid_id');
    try {
      const rs = await query(
        'DELETE FROM admin_test_recipients WHERE id = $1 RETURNING id',
        [Number(idStr)]
      );
      if (rs.rowCount === 0) return safeJsonError(res, 404, 'not_found');
      return res.json({ ok: true });
    } catch (err) {
      console.error('delete test recipient error:', err);
      return safeJsonError(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });

  // ---------- 3b. test push（單筆，真的打 LINE API） ----------
  app.post('/admin/broadcast/test-push', requireAdmin, async (req, res) => {
    try {
      if (!lineChannelAccessToken) {
        return safeJsonError(res, 400, 'no_line_channel_access_token');
      }
      const body = req.body || {};
      const rawTestId = String(body.test_line_user_id || '').trim();
      const rawMember = String(body.test_member_name || '').trim().slice(0, 200);
      const messageConfig = body.message_config;

      const origin = publicOriginOrEmpty(req);
      const builtMsg = buildLineMessages(messageConfig, { heroImageBaseUrl: origin });
      if (!builtMsg.ok) return safeJsonError(res, 400, builtMsg.error);

      let lineTo = '';
      let targetUserId = null;

      if (rawTestId) {
        if (!/^U[0-9a-f]{32}$/i.test(rawTestId)) {
          return safeJsonError(res, 400, 'invalid_line_user_id');
        }
        lineTo = rawTestId;
      } else if (rawMember) {
        const nameRs = await query(
          `SELECT id, line_user_id FROM users
           WHERE COALESCE(BTRIM(line_user_id), '') <> ''
             AND (
               LOWER(TRIM(COALESCE(line_display_name, ''))) = LOWER(TRIM($1::text))
               OR LOWER(TRIM(username)) = LOWER(TRIM($1::text))
             )
           ORDER BY id ASC
           LIMIT 2`,
          [rawMember]
        );
        if (nameRs.rowCount === 0) return safeJsonError(res, 400, 'name_not_found');
        if (nameRs.rowCount > 1) return safeJsonError(res, 400, 'name_ambiguous');
        lineTo = String(nameRs.rows[0].line_user_id || '').trim();
        targetUserId = nameRs.rows[0].id;
      } else {
        // 預設送給自己
        const uRs = await query('SELECT line_user_id FROM users WHERE id = $1', [req.authUser.uid]);
        lineTo = String(uRs.rows[0]?.line_user_id || '').trim();
        targetUserId = req.authUser.uid;
      }

      if (!lineTo) return safeJsonError(res, 400, 'no_recipient');

      const pushed = await linePush.pushLineMessages(lineTo, builtMsg.messages, {
        userId: targetUserId,
        pushType: 'admin_broadcast_test'
      });
      if (!pushed) return safeJsonError(res, 500, 'push_failed');
      return res.json({ ok: true, sentTo: lineTo });
    } catch (err) {
      console.error('test-push error:', err && (err.stack || err.message));
      return safeJsonError(res, 500, 'test_push_failed', {
        detail: err && err.message ? String(err.message).slice(0, 500) : ''
      });
    }
  });

  // ---------- 4. message preview ----------
  app.post('/admin/broadcast/preview-message', requireAdmin, async (req, res) => {
    try {
      const messageConfig = req.body && req.body.message_config;
      const origin = publicOriginOrEmpty(req);
      const built = buildLineMessages(messageConfig, { heroImageBaseUrl: origin });
      if (!built.ok) {
        return res.json({ ok: false, error: built.error });
      }
      return res.json({ ok: true, messages: built.messages });
    } catch (err) {
      console.error('preview-message error:', err.message);
      return safeJsonError(res, 500, 'preview_failed');
    }
  });

  // ---------- 5. create batch ----------
  app.post('/admin/broadcast/create', requireAdmin, async (req, res) => {
    if (!lineChannelAccessToken) {
      return safeJsonError(res, 400, 'no_line_channel_access_token');
    }
    try {
      const body = req.body || {};
      const rawConditions = body.conditions;
      const messageConfig = body.message_config;
      const sendMode = body.send_mode === 'scheduled' ? 'scheduled' : 'immediate';

      let scheduledAt = null;
      if (sendMode === 'scheduled') {
        const rawScheduled = String((body && body.scheduled_at) || '').trim();
        if (!rawScheduled) return safeJsonError(res, 400, 'scheduled_at_required');
        // 接受 ISO 字串或 datetime-local "YYYY-MM-DDTHH:mm"（視為台灣時間）
        let dt;
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(rawScheduled)) {
          // datetime-local 視為台北時間，UTC = 台北 - 8h
          dt = new Date(rawScheduled + ':00+08:00');
        } else {
          dt = new Date(rawScheduled);
        }
        if (Number.isNaN(dt.getTime())) return safeJsonError(res, 400, 'invalid_scheduled_at');
        if (dt.getTime() < Date.now() - 60 * 1000) {
          return safeJsonError(res, 400, 'scheduled_at_in_past');
        }
        scheduledAt = dt;
      }

      const origin = publicOriginOrEmpty(req);
      const builtMsg = buildLineMessages(messageConfig, { heroImageBaseUrl: origin });
      if (!builtMsg.ok) {
        return safeJsonError(res, 400, builtMsg.error);
      }

      // A/B test：可選的 variant B
      const isAbTest = body.ab_test === true || body.ab_test === 'true';
      const variantBConfig = isAbTest ? body.variant_b_message_config : null;
      if (isAbTest) {
        if (!variantBConfig || typeof variantBConfig !== 'object') {
          return safeJsonError(res, 400, 'variant_b_message_config_required');
        }
        const builtB = buildLineMessages(variantBConfig, { heroImageBaseUrl: origin });
        if (!builtB.ok) {
          return safeJsonError(res, 400, 'variant_b_invalid:' + builtB.error);
        }
      }

      const conditions = normalizeConditions(rawConditions);
      if (!hasAnyCondition(conditions)) {
        return safeJsonError(res, 400, 'no_conditions_selected');
      }

      const { rows: recipients } = await fetchAudienceRecipients(query, conditions);
      if (recipients.length === 0) {
        return safeJsonError(res, 400, 'no_matching_recipients');
      }
      if (isAbTest && recipients.length < 2) {
        return safeJsonError(res, 400, 'ab_test_needs_min_2_recipients');
      }

      // A/B test：隨機 shuffle + 對半分 variant
      let assignedVariants = null;
      if (isAbTest) {
        const indices = recipients.map((_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        assignedVariants = new Array(recipients.length).fill('a');
        const halfIdx = Math.floor(recipients.length / 2);
        for (let k = 0; k < halfIdx; k++) {
          assignedVariants[indices[k]] = 'b';
        }
      }

      const adminUsername =
        (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insRs = scheduledAt
          ? await client.query(
              `INSERT INTO admin_broadcasts
                (status, scheduled_at, admin_username, audience_config, message_config,
                 variant_b_message_config, is_ab_test, recipient_total)
               VALUES ('scheduled', $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)
               RETURNING id`,
              [
                scheduledAt.toISOString(),
                adminUsername,
                JSON.stringify({ conditions }),
                JSON.stringify(messageConfig || {}),
                isAbTest ? JSON.stringify(variantBConfig) : null,
                isAbTest,
                recipients.length
              ]
            )
          : await client.query(
              `INSERT INTO admin_broadcasts
                (status, started_at, admin_username, audience_config, message_config,
                 variant_b_message_config, is_ab_test, recipient_total)
               VALUES ('running', NOW(), $1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6)
               RETURNING id`,
              [
                adminUsername,
                JSON.stringify({ conditions }),
                JSON.stringify(messageConfig || {}),
                isAbTest ? JSON.stringify(variantBConfig) : null,
                isAbTest,
                recipients.length
              ]
            );
        const broadcastId = insRs.rows[0].id;

        // 分批 INSERT recipients（避免單個 INSERT 太多參數）
        const BATCH = 500;
        for (let i = 0; i < recipients.length; i += BATCH) {
          const slice = recipients.slice(i, i + BATCH);
          const values = [];
          const params = [];
          slice.forEach((r, idx) => {
            const globalIdx = i + idx;
            const base = idx * 4;
            values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
            params.push(
              broadcastId,
              r.user_id,
              r.line_user_id,
              isAbTest ? assignedVariants[globalIdx] : 'a'
            );
          });
          await client.query(
            `INSERT INTO admin_broadcast_recipients (broadcast_id, user_id, line_user_id, variant)
             VALUES ${values.join(', ')}`,
            params
          );
        }
        await client.query('COMMIT');
        return res.json({
          ok: true,
          broadcastId,
          total: recipients.length,
          scheduled: Boolean(scheduledAt),
          scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
          isAbTest,
          variantCounts: isAbTest
            ? assignedVariants.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {})
            : null
        });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_rb) {}
        console.error('create broadcast tx error:', e.message);
        return safeJsonError(res, 500, 'create_failed');
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('broadcast create error:', err.message);
      return safeJsonError(res, 500, 'create_failed');
    }
  });

  // ---------- 6. process chunk ----------
  app.post('/admin/broadcast/:id/process-chunk', requireAdmin, async (req, res) => {
    if (!lineChannelAccessToken) {
      return safeJsonError(res, 400, 'no_line_channel_access_token');
    }
    const idStr = String(req.params.id || '').trim();
    if (!isPositiveIntegerString(idStr)) {
      return safeJsonError(res, 400, 'invalid_broadcast_id');
    }
    const broadcastId = Number(idStr);

    try {
      const b = await loadBroadcast(broadcastId);
      if (!b) return safeJsonError(res, 404, 'broadcast_not_found');
      if (b.status === 'cancelled' || b.status === 'done') {
        return res.json({ ok: true, processed: 0, ok_count: 0, fail: 0, skip: 0, remaining: 0, done: true, status: b.status });
      }
      if (b.status !== 'running') {
        return safeJsonError(res, 400, `broadcast_status_${b.status}`);
      }

      const rawChunkSize = Number(req.body && req.body.chunkSize);
      const chunkSize = Math.min(
        CHUNK_SIZE_MAX,
        Math.max(1, Number.isFinite(rawChunkSize) ? rawChunkSize : CHUNK_SIZE_DEFAULT)
      );

      // 用 FOR UPDATE SKIP LOCKED 鎖 N 筆 pending，mark 為 sending
      const client = await pool.connect();
      let claimed = [];
      try {
        await client.query('BEGIN');
        const claimRs = await client.query(
          `UPDATE admin_broadcast_recipients
           SET status = 'sending'
           WHERE id IN (
             SELECT id FROM admin_broadcast_recipients
             WHERE broadcast_id = $1 AND status = 'pending'
             ORDER BY id ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, user_id, line_user_id, variant`,
          [broadcastId, chunkSize]
        );
        await client.query('COMMIT');
        claimed = claimRs.rows;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_rb) {}
        client.release();
        console.error('claim chunk error:', e.message);
        return safeJsonError(res, 500, 'claim_failed');
      }
      client.release();

      // 構造 messages：每個 recipient 各自 build 一次，URL 內嵌 recipient_id
      // → track endpoint (/r/b/:bid/:rid, /v/b/:bid/:rid/:mediaId) 能識別「誰開了/誰點了」
      // 傳 broadcastId → CTA 包成 /r/b/<id>/<rid> 中介 redirect 做點擊追蹤
      // A/B test：依 recipient.variant 選 message_config 並帶 variant 標記
      const origin = publicOriginOrEmpty(req);
      const isAbTest = Boolean(b.is_ab_test);

      // 預先驗證一下訊息設定（不帶 recipientId，用來檢查能否 build）
      function buildMsgForVariant(variant, recipientId) {
        const cfg = (isAbTest && variant === 'b') ? b.variant_b_message_config : b.message_config;
        return buildLineMessages(cfg, {
          heroImageBaseUrl: origin,
          broadcastId,
          variant: isAbTest ? variant : undefined,
          recipientId
        });
      }
      const sanityA = buildMsgForVariant('a');
      const sanityB = isAbTest ? buildMsgForVariant('b') : null;
      if (!sanityA.ok || (isAbTest && !sanityB.ok)) {
        // 訊息無效：把 claimed 退回 pending
        if (claimed.length > 0) {
          await query(
            `UPDATE admin_broadcast_recipients SET status = 'pending'
             WHERE id = ANY($1::bigint[])`,
            [claimed.map(r => r.id)]
          );
        }
        const err = !sanityA.ok ? sanityA.error : sanityB.error;
        return safeJsonError(res, 400, 'message_invalid:' + err);
      }

      let okCount = 0;
      let failCount = 0;
      let skipCount = 0;

      for (const r of claimed) {
        const lineUid = String(r.line_user_id || '').trim();
        if (!lineUid) {
          await query(
            `UPDATE admin_broadcast_recipients
             SET status = 'skipped', pushed_at = NOW(), error = 'missing_line_user_id'
             WHERE id = $1`,
            [r.id]
          );
          skipCount += 1;
          continue;
        }
        // 為這個 recipient build messages（URL 嵌入 r.id）
        const useVariant = (isAbTest && r.variant === 'b') ? 'b' : 'a';
        const useBuilt = buildMsgForVariant(useVariant, r.id);
        if (!useBuilt.ok) {
          await query(
            `UPDATE admin_broadcast_recipients SET status = 'failed', pushed_at = NOW(), error = 'build_failed' WHERE id = $1`,
            [r.id]
          );
          failCount += 1;
          continue;
        }
        const pushed = await linePush.pushLineMessages(lineUid, useBuilt.messages, {
          userId: r.user_id,
          pushType: 'admin_broadcast'
        });
        if (pushed) {
          await query(
            `UPDATE admin_broadcast_recipients SET status = 'sent', pushed_at = NOW(), error = NULL WHERE id = $1`,
            [r.id]
          );
          okCount += 1;
        } else {
          await query(
            `UPDATE admin_broadcast_recipients SET status = 'failed', pushed_at = NOW(), error = 'push_failed' WHERE id = $1`,
            [r.id]
          );
          failCount += 1;
        }
      }

      // 更新批次累計
      await query(
        `UPDATE admin_broadcasts
         SET recipient_ok = recipient_ok + $2,
             recipient_fail = recipient_fail + $3,
             recipient_skip = recipient_skip + $4,
             updated_at = NOW()
         WHERE id = $1`,
        [broadcastId, okCount, failCount, skipCount]
      );

      // 確認是否還有 pending
      const remainingRs = await query(
        `SELECT COUNT(*)::int AS n FROM admin_broadcast_recipients
         WHERE broadcast_id = $1 AND status IN ('pending', 'sending')`,
        [broadcastId]
      );
      const remaining = Number(remainingRs.rows[0]?.n || 0);
      let done = false;
      if (remaining === 0) {
        await query(
          `UPDATE admin_broadcasts SET status = 'done', finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [broadcastId]
        );
        done = true;
      }

      return res.json({
        ok: true,
        broadcastId,
        processed: claimed.length,
        ok_count: okCount,
        fail: failCount,
        skip: skipCount,
        remaining,
        done
      });
    } catch (err) {
      console.error('process-chunk error:', err.message);
      return safeJsonError(res, 500, 'process_chunk_failed');
    }
  });

  // ---------- 6a. scheduled runner（cron 內部呼叫，secret 驗證） ----------
  // 由 netlify/functions/scheduled-broadcast-runner.js 每 5 分鐘觸發一次。
  // 做兩件事：
  //   1. 把到期的 scheduled broadcasts 改成 running + started_at = NOW()
  //   2. 對所有 running broadcasts 各跑一輪 chunk（限 50 個 recipients）
  app.post('/admin/broadcast/run-scheduled', async (req, res) => {
    const expectedSecret = process.env.SCHEDULED_RUNNER_SECRET || '';
    const providedSecret = req.get('x-scheduler-secret') || '';
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (!lineChannelAccessToken) {
      return res.status(200).json({ ok: true, skipped: 'no_line_token' });
    }
    try {
      // Step 1: 把到期的 scheduled 改 running
      const dueRs = await query(
        `UPDATE admin_broadcasts
         SET status = 'running', started_at = NOW(), updated_at = NOW()
         WHERE status = 'scheduled' AND scheduled_at <= NOW()
         RETURNING id`
      );
      const startedIds = dueRs.rows.map(r => r.id);

      // Step 2: 撈所有 running broadcasts（含剛剛 start 的）
      const runningRs = await query(
        `SELECT id, message_config, variant_b_message_config, is_ab_test FROM admin_broadcasts
         WHERE status = 'running'
         ORDER BY id ASC
         LIMIT 10`
      );
      const origin = process.env.LINE_PUSH_PUBLIC_BASE_URL || process.env.URL || '';
      const cleanOrigin = String(origin).replace(/\/+$/, '');

      const results = [];
      for (const row of runningRs.rows) {
        const bId = row.id;
        const isAbTest = Boolean(row.is_ab_test);
        // helper：per-recipient build（URL 嵌入 recipientId 做 track）
        function buildForRecipient(variant, recipientId) {
          const cfg = (isAbTest && variant === 'b') ? row.variant_b_message_config : row.message_config;
          return buildLineMessages(cfg, {
            heroImageBaseUrl: cleanOrigin,
            broadcastId: bId,
            variant: isAbTest ? variant : undefined,
            recipientId
          });
        }
        // sanity check 一次（不帶 recipientId）
        const sanityA = buildForRecipient('a');
        const sanityB = isAbTest ? buildForRecipient('b') : null;
        if (!sanityA.ok || (isAbTest && !sanityB.ok)) {
          const err = !sanityA.ok ? sanityA.error : sanityB.error;
          results.push({ broadcastId: bId, skipped: 'message_invalid', detail: err });
          continue;
        }

        // 鎖最多 50 個 pending（FOR UPDATE SKIP LOCKED）
        const client = await pool.connect();
        let claimed = [];
        try {
          await client.query('BEGIN');
          const claimRs = await client.query(
            `UPDATE admin_broadcast_recipients
             SET status = 'sending'
             WHERE id IN (
               SELECT id FROM admin_broadcast_recipients
               WHERE broadcast_id = $1 AND status = 'pending'
               ORDER BY id ASC LIMIT $2 FOR UPDATE SKIP LOCKED
             )
             RETURNING id, user_id, line_user_id, variant`,
            [bId, 50]
          );
          await client.query('COMMIT');
          claimed = claimRs.rows;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_rb) {}
          client.release();
          results.push({ broadcastId: bId, error: 'claim_failed', detail: e.message });
          continue;
        }
        client.release();

        let okCount = 0, failCount = 0, skipCount = 0;
        for (const r of claimed) {
          const lineUid = String(r.line_user_id || '').trim();
          if (!lineUid) {
            await query(
              `UPDATE admin_broadcast_recipients
               SET status = 'skipped', pushed_at = NOW(), error = 'missing_line_user_id' WHERE id = $1`,
              [r.id]
            );
            skipCount++;
            continue;
          }
          // per-recipient build → URL 嵌入 r.id
          const useVariant = (isAbTest && r.variant === 'b') ? 'b' : 'a';
          const useBuilt = buildForRecipient(useVariant, r.id);
          if (!useBuilt.ok) {
            await query(
              `UPDATE admin_broadcast_recipients SET status = 'failed', pushed_at = NOW(), error = 'build_failed' WHERE id = $1`,
              [r.id]
            );
            failCount++;
            continue;
          }
          const pushed = await linePush.pushLineMessages(lineUid, useBuilt.messages, {
            userId: r.user_id,
            pushType: 'admin_broadcast'
          });
          if (pushed) {
            await query(
              `UPDATE admin_broadcast_recipients SET status = 'sent', pushed_at = NOW(), error = NULL WHERE id = $1`,
              [r.id]
            );
            okCount++;
          } else {
            await query(
              `UPDATE admin_broadcast_recipients SET status = 'failed', pushed_at = NOW(), error = 'push_failed' WHERE id = $1`,
              [r.id]
            );
            failCount++;
          }
        }

        await query(
          `UPDATE admin_broadcasts
           SET recipient_ok = recipient_ok + $2,
               recipient_fail = recipient_fail + $3,
               recipient_skip = recipient_skip + $4,
               updated_at = NOW()
           WHERE id = $1`,
          [bId, okCount, failCount, skipCount]
        );

        // 如果這個 broadcast 沒剩 pending → 結案
        const remRs = await query(
          `SELECT COUNT(*)::int AS n FROM admin_broadcast_recipients
           WHERE broadcast_id = $1 AND status IN ('pending', 'sending')`,
          [bId]
        );
        const remaining = Number(remRs.rows[0]?.n || 0);
        if (remaining === 0) {
          await query(
            `UPDATE admin_broadcasts SET status = 'done', finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [bId]
          );
        }

        results.push({ broadcastId: bId, processed: claimed.length, ok: okCount, fail: failCount, skip: skipCount, remaining });
      }

      return res.json({ ok: true, startedFromScheduled: startedIds, results });
    } catch (err) {
      console.error('run-scheduled error:', err && (err.stack || err.message));
      return res.status(500).json({ ok: false, error: 'run_scheduled_failed', detail: err && err.message });
    }
  });

  // ---------- 6b. history list page ----------
  app.get('/admin/broadcast/history', requireAdmin, async (req, res, next) => {
    try {
      const pageNum = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const perPage = 30;
      const offset = (pageNum - 1) * perPage;

      const countRs = await query(`SELECT COUNT(*)::int AS n FROM admin_broadcasts`);
      const total = Number(countRs.rows[0]?.n || 0);
      const totalPages = Math.max(1, Math.ceil(total / perPage));

      const listRs = await query(
        `SELECT b.id, b.created_at, b.status, b.admin_username, b.scheduled_at,
                b.recipient_total, b.recipient_ok, b.recipient_fail, b.recipient_skip,
                b.started_at, b.finished_at,
                (SELECT COUNT(*) FROM admin_broadcast_clicks WHERE broadcast_id = b.id)::int AS click_count
         FROM admin_broadcasts b
         ORDER BY b.id DESC
         LIMIT $1 OFFSET $2`,
        [perPage, offset]
      );

      // 撈所有未發出的排程（不限 page，獨立區塊顯示）
      const scheduledRs = await query(
        `SELECT b.id, b.created_at, b.scheduled_at, b.admin_username, b.recipient_total
         FROM admin_broadcasts b
         WHERE b.status = 'scheduled'
         ORDER BY b.scheduled_at ASC NULLS LAST, b.id DESC`
      );

      return res.render('admin_broadcast_history', {
        title: '群發歷史',
        bodyClass: 'admin-shell broadcast-history-shell',
        user: (req.authUser && req.authUser.un) || '',
        isAdmin: true,
        batches: listRs.rows,
        scheduled: scheduledRs.rows,
        page: pageNum,
        totalPages,
        total
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- 6c. single broadcast detail ----------
  app.get('/admin/broadcast/:id(\\d+)', requireAdmin, async (req, res, next) => {
    try {
      const broadcastId = Number(req.params.id);
      const b = await loadBroadcast(broadcastId);
      if (!b) return res.status(404).type('text/plain').send('Not found');

      // 收件人狀態統計
      const statusRs = await query(
        `SELECT status, COUNT(*)::int AS n
         FROM admin_broadcast_recipients
         WHERE broadcast_id = $1
         GROUP BY status`,
        [broadcastId]
      );
      const statusCounts = {};
      statusRs.rows.forEach(r => { statusCounts[r.status] = r.n; });

      // 失敗收件人 sample（給「重發」用）
      const failedSampleRs = await query(
        `SELECT m.id, m.line_user_id, m.error, m.pushed_at,
                u.line_display_name, u.username
         FROM admin_broadcast_recipients m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.broadcast_id = $1 AND m.status = 'failed'
         ORDER BY m.id ASC
         LIMIT 50`,
        [broadcastId]
      );

      // 收件人前 30 筆（一般 sample）
      const recentSampleRs = await query(
        `SELECT m.id, m.line_user_id, m.status, m.error, m.pushed_at,
                u.line_display_name, u.username
         FROM admin_broadcast_recipients m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.broadcast_id = $1
         ORDER BY m.id ASC
         LIMIT 30`,
        [broadcastId]
      );

      // click 統計
      const clickStatRs = await query(
        `SELECT COUNT(*)::int AS clicks,
                COUNT(DISTINCT user_agent)::int AS unique_ua,
                MIN(clicked_at) AS first_click,
                MAX(clicked_at) AS last_click
         FROM admin_broadcast_clicks
         WHERE broadcast_id = $1`,
        [broadcastId]
      );

      // view 統計（hero 圖被 fetch — 開信率 proxy）
      const viewStatRs = await query(
        `SELECT COUNT(*)::int AS views,
                MIN(viewed_at) AS first_view,
                MAX(viewed_at) AS last_view
         FROM admin_broadcast_views
         WHERE broadcast_id = $1`,
        [broadcastId]
      );

      // A/B 對比統計（is_ab_test=true 時才有意義）
      let abStat = null;
      if (b.is_ab_test) {
        const abRs = await query(
          `SELECT
            variant,
            COUNT(*)::int AS sent_total,
            COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_ok,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS sent_fail
           FROM admin_broadcast_recipients
           WHERE broadcast_id = $1
           GROUP BY variant
           ORDER BY variant`,
          [broadcastId]
        );
        const viewByVariant = await query(
          `SELECT variant, COUNT(*)::int AS n FROM admin_broadcast_views
           WHERE broadcast_id = $1 GROUP BY variant`,
          [broadcastId]
        );
        const clickByVariant = await query(
          `SELECT variant, COUNT(*)::int AS n FROM admin_broadcast_clicks
           WHERE broadcast_id = $1 GROUP BY variant`,
          [broadcastId]
        );
        const viewMap = {};
        viewByVariant.rows.forEach(r => { viewMap[r.variant || ''] = r.n; });
        const clickMap = {};
        clickByVariant.rows.forEach(r => { clickMap[r.variant || ''] = r.n; });
        abStat = abRs.rows.map(r => ({
          variant: r.variant,
          sent_total: r.sent_total,
          sent_ok: r.sent_ok,
          sent_fail: r.sent_fail,
          views: viewMap[r.variant] || 0,
          clicks: clickMap[r.variant] || 0
        }));
      }

      // 最近點擊 sample
      const clickRecentRs = await query(
        `SELECT clicked_at, user_agent
         FROM admin_broadcast_clicks
         WHERE broadcast_id = $1
         ORDER BY id DESC
         LIMIT 10`,
        [broadcastId]
      );

      return res.render('admin_broadcast_detail', {
        title: `批次 #${broadcastId}`,
        bodyClass: 'admin-shell broadcast-detail-shell',
        user: (req.authUser && req.authUser.un) || '',
        isAdmin: true,
        broadcast: b,
        statusCounts,
        failedSample: failedSampleRs.rows,
        recentSample: recentSampleRs.rows,
        clickStat: clickStatRs.rows[0] || { clicks: 0, unique_ua: 0 },
        clickRecent: clickRecentRs.rows,
        viewStat: viewStatRs.rows[0] || { views: 0, first_view: null, last_view: null },
        abStat
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- 6d. resend failed recipients ----------
  app.post('/admin/broadcast/:id(\\d+)/resend-failed', requireAdmin, async (req, res) => {
    if (!lineChannelAccessToken) {
      return safeJsonError(res, 400, 'no_line_channel_access_token');
    }
    const broadcastId = Number(req.params.id);
    try {
      const b = await loadBroadcast(broadcastId);
      if (!b) return safeJsonError(res, 404, 'broadcast_not_found');

      // 把 failed 改回 pending，並把 broadcast status 改回 running
      const updRs = await query(
        `UPDATE admin_broadcast_recipients
         SET status = 'pending', pushed_at = NULL, error = NULL
         WHERE broadcast_id = $1 AND status = 'failed'
         RETURNING id`,
        [broadcastId]
      );
      const resetCount = updRs.rowCount;
      if (resetCount === 0) return safeJsonError(res, 400, 'no_failed_to_resend');

      // 重設 broadcast 為 running（如果之前是 done/cancelled）+ 扣除失敗計數
      await query(
        `UPDATE admin_broadcasts
         SET status = 'running',
             recipient_fail = GREATEST(0, recipient_fail - $2),
             finished_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [broadcastId, resetCount]
      );
      return res.json({ ok: true, resetCount, broadcastId });
    } catch (err) {
      console.error('resend-failed error:', err);
      return safeJsonError(res, 500, 'resend_failed', { detail: err && err.message });
    }
  });

  // ---------- 7. cancel ----------
  app.post('/admin/broadcast/:id/cancel', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPositiveIntegerString(idStr)) return safeJsonError(res, 400, 'invalid_broadcast_id');
    const broadcastId = Number(idStr);
    try {
      const upd = await query(
        `UPDATE admin_broadcasts
         SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('running', 'scheduled', 'queued')
         RETURNING id`,
        [broadcastId]
      );
      if (upd.rowCount === 0) {
        return safeJsonError(res, 400, 'not_cancellable');
      }
      await query(
        `UPDATE admin_broadcast_recipients
         SET status = 'cancelled', error = COALESCE(error, 'cancelled_by_admin')
         WHERE broadcast_id = $1 AND status IN ('pending', 'sending')`,
        [broadcastId]
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('broadcast cancel error:', err.message);
      return safeJsonError(res, 500, 'cancel_failed');
    }
  });

  // ---------- 8. 匯出收件人成名單庫（5 種 filter）----------
  app.post('/admin/broadcast/:id(\\d+)/export-recipients-to-list', requireAdmin, async (req, res) => {
    try {
      const broadcastId = Number(req.params.id);
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 500);
      const filter = String(body.filter || 'all').trim();
      if (!name) return safeJsonError(res, 400, 'name_required');
      const ALLOWED = ['all', 'sent', 'failed', 'clicked', 'viewed'];
      if (!ALLOWED.includes(filter)) {
        return safeJsonError(res, 400, 'invalid_filter', { detail: '必須是 ' + ALLOWED.join(' / ') });
      }
      let sql;
      if (filter === 'all') {
        sql = `SELECT DISTINCT line_user_id FROM admin_broadcast_recipients
               WHERE broadcast_id = $1 AND line_user_id IS NOT NULL`;
      } else if (filter === 'sent') {
        sql = `SELECT DISTINCT line_user_id FROM admin_broadcast_recipients
               WHERE broadcast_id = $1 AND status = 'sent' AND line_user_id IS NOT NULL`;
      } else if (filter === 'failed') {
        sql = `SELECT DISTINCT line_user_id FROM admin_broadcast_recipients
               WHERE broadcast_id = $1 AND status = 'failed' AND line_user_id IS NOT NULL`;
      } else if (filter === 'clicked') {
        sql = `SELECT DISTINCT line_user_id FROM admin_broadcast_clicks
               WHERE broadcast_id = $1 AND line_user_id IS NOT NULL`;
      } else {
        // viewed
        sql = `SELECT DISTINCT line_user_id FROM admin_broadcast_views
               WHERE broadcast_id = $1 AND line_user_id IS NOT NULL`;
      }
      const { rows } = await query(sql, [broadcastId]);
      const uids = rows.map(r => r.line_user_id).filter(Boolean);
      if (uids.length === 0) {
        return safeJsonError(res, 400, 'no_matching_recipients', {
          detail: filter === 'clicked' || filter === 'viewed'
            ? '找不到符合條件的人。注意：點擊/開信追蹤只記錄在新版（含 recipient_id）的推播之後，舊批次沒有 line_user_id 對應。'
            : '找不到符合條件的人'
        });
      }
      if (uids.length > 5000) {
        return safeJsonError(res, 400, 'too_many_recipients', {
          detail: '單一名單上限 5000 人（找到 ' + uids.length + '）'
        });
      }
      const createdBy = (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insListRs = await client.query(
          `INSERT INTO admin_recipient_lists (name, description, total, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, total, created_at`,
          [name, description || null, uids.length, createdBy]
        );
        const listId = insListRs.rows[0].id;
        const BATCH = 500;
        for (let i = 0; i < uids.length; i += BATCH) {
          const slice = uids.slice(i, i + BATCH);
          const values = [];
          const params = [];
          slice.forEach((uid, idx) => {
            const base = idx * 2;
            values.push(`($${base + 1}, $${base + 2})`);
            params.push(listId, uid);
          });
          await client.query(
            `INSERT INTO admin_recipient_list_members (list_id, line_user_id)
             VALUES ${values.join(', ')}
             ON CONFLICT (list_id, line_user_id) DO NOTHING`,
            params
          );
        }
        // 更新 total（在有 dedupe 後可能略低）
        await client.query(
          `UPDATE admin_recipient_lists
           SET total = (SELECT COUNT(*) FROM admin_recipient_list_members WHERE list_id = $1)
           WHERE id = $1`,
          [listId]
        );
        await client.query('COMMIT');
        res.json({ ok: true, list: insListRs.rows[0], total: uids.length });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_e) {}
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('export recipients error:', err && err.message);
      return safeJsonError(res, 500, 'export_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminBroadcastRoutes };
