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

  // ---------- 1. main page ----------
  app.get('/admin/broadcast', requireAdmin, async (req, res, next) => {
    try {
      const [prizes, recent] = await Promise.all([loadPrizes(), loadRecentBroadcasts(10)]);
      return res.render('admin_broadcast', {
        title: '群發訊息',
        bodyClass: 'admin-shell broadcast-shell',
        user: req.authUser && req.authUser.un ? req.authUser.un : '',
        isAdmin: true,
        prizes,
        recent,
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

      if (sendMode === 'scheduled') {
        // Phase 1 不支援；schema 已備，留待 Phase 3
        return safeJsonError(res, 400, 'scheduled_not_implemented_yet');
      }

      const origin = publicOriginOrEmpty(req);
      const builtMsg = buildLineMessages(messageConfig, { heroImageBaseUrl: origin });
      if (!builtMsg.ok) {
        return safeJsonError(res, 400, builtMsg.error);
      }

      const conditions = normalizeConditions(rawConditions);
      if (!hasAnyCondition(conditions)) {
        return safeJsonError(res, 400, 'no_conditions_selected');
      }

      const { rows: recipients } = await fetchAudienceRecipients(query, conditions);
      if (recipients.length === 0) {
        return safeJsonError(res, 400, 'no_matching_recipients');
      }

      const adminUsername =
        (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insRs = await client.query(
          `INSERT INTO admin_broadcasts
            (status, started_at, admin_username, audience_config, message_config, recipient_total)
           VALUES ('running', NOW(), $1, $2::jsonb, $3::jsonb, $4)
           RETURNING id`,
          [
            adminUsername,
            JSON.stringify({ conditions }),
            JSON.stringify(messageConfig || {}),
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
        return res.json({ ok: true, broadcastId, total: recipients.length });
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
           RETURNING id, user_id, line_user_id`,
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

      // 構造 messages（每個 chunk 重新建一次，避免長時間運行訊息設定變動）
      const origin = publicOriginOrEmpty(req);
      const builtMsg = buildLineMessages(b.message_config, { heroImageBaseUrl: origin });
      if (!builtMsg.ok) {
        // 訊息無效：把 claimed 退回 pending
        if (claimed.length > 0) {
          await query(
            `UPDATE admin_broadcast_recipients SET status = 'pending'
             WHERE id = ANY($1::bigint[])`,
            [claimed.map(r => r.id)]
          );
        }
        return safeJsonError(res, 400, 'message_invalid:' + builtMsg.error);
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
        const pushed = await linePush.pushLineMessages(lineUid, builtMsg.messages, {
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
}

module.exports = { registerAdminBroadcastRoutes };
