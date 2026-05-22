/**
 * 名單庫管理（獨立 menu）
 *
 * Schema 既有：
 *   admin_recipient_lists (id, name, description, total, created_by, created_at, updated_at)
 *   admin_recipient_list_members (id, list_id, line_user_id, created_at)
 *   UNIQUE (list_id, line_user_id)
 *
 * 既有 API（/admin/broadcast/recipient-lists 系列）已支援 list/create/delete，
 * 此檔提供：
 *   GET  /admin/recipient-lists                   列表頁
 *   GET  /admin/recipient-lists/:id               名單詳情頁
 *   GET  /admin/recipient-lists/api/:id/members   完整成員列表（分頁）
 *   POST /admin/recipient-lists/api/:id/members   批次新增 UID 到名單
 *   DELETE /admin/recipient-lists/api/members/:id 移除單一成員
 *   PUT  /admin/recipient-lists/api/:id           更新名單名稱/描述
 */

function registerAdminRecipientListsRoutes(app, deps) {
  const { query, pool, authCore } = deps;
  const { requireAdmin } = authCore;

  function safeJson(res, status, errCode, opts = {}) {
    return res.status(status).json({ ok: false, error: errCode, ...opts });
  }

  // ----- 列表頁 -----
  app.get('/admin/recipient-lists', requireAdmin, async (req, res) => {
    res.render('admin_recipient_lists', {
      title: '名單庫',
      bodyClass: 'admin-shell recipient-lists-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // ----- 詳情頁 -----
  app.get('/admin/recipient-lists/:id(\\d+)', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await query(
        `SELECT id, name, description, total, created_by, created_at, updated_at
         FROM admin_recipient_lists WHERE id = $1`,
        [id]
      );
      if (rows.length === 0) return res.status(404).send('名單不存在');
      res.render('admin_recipient_list_detail', {
        title: '名單 — ' + rows[0].name,
        bodyClass: 'admin-shell recipient-lists-shell',
        user: (req.authUser && req.authUser.un) || '',
        isAdmin: true,
        list: rows[0]
      });
    } catch (err) {
      next(err);
    }
  });

  // ----- 完整成員列表（分頁）-----
  app.get('/admin/recipient-lists/api/:id(\\d+)/members', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
      const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
      const search = String(req.query.search || '').trim().toLowerCase();
      const params = [id];
      let whereSearch = '';
      if (search) {
        params.push('%' + search + '%');
        whereSearch = ` AND (LOWER(m.line_user_id) LIKE $${params.length} OR LOWER(u.line_display_name) LIKE $${params.length} OR LOWER(u.username) LIKE $${params.length})`;
      }
      params.push(limit, offset);
      const { rows } = await query(
        `SELECT m.id, m.line_user_id, m.created_at,
                u.line_display_name, u.username, u.line_picture_url
         FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.list_id = $1${whereSearch}
         ORDER BY m.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      const cntParams = search ? [id, '%' + search + '%'] : [id];
      const cntSearch = search
        ? ` AND (LOWER(m.line_user_id) LIKE $2 OR LOWER(u.line_display_name) LIKE $2 OR LOWER(u.username) LIKE $2)`
        : '';
      const cntRs = await query(
        `SELECT COUNT(*)::int AS n FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.list_id = $1${cntSearch}`,
        cntParams
      );
      res.json({ ok: true, members: rows, total: Number(cntRs.rows[0]?.n || 0) });
    } catch (err) {
      console.error('list members error:', err && err.message);
      return safeJson(res, 500, 'list_members_failed', { detail: err && err.message });
    }
  });

  // ----- 批次新增成員 -----
  app.post('/admin/recipient-lists/api/:id(\\d+)/members', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const rawIds = Array.isArray(body.lineUserIds) ? body.lineUserIds : [];
      // 清洗
      const valid = [];
      const seen = new Set();
      const invalid = [];
      for (const raw of rawIds) {
        const s = String(raw || '').trim();
        if (!s) continue;
        if (!/^U[0-9a-f]{32}$/i.test(s)) { invalid.push(s.slice(0, 50)); continue; }
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        valid.push(s);
      }
      if (valid.length === 0) {
        return safeJson(res, 400, 'no_valid_ids', { detail: '沒有合法的 LINE userId（需 U + 32 hex）', invalid_sample: invalid.slice(0, 5) });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // 既存 check
        const existsRs = await client.query(
          `SELECT line_user_id FROM admin_recipient_list_members
           WHERE list_id = $1 AND line_user_id = ANY($2)`,
          [id, valid]
        );
        const existing = new Set(existsRs.rows.map(r => r.line_user_id));
        const toInsert = valid.filter(uid => !existing.has(uid));
        let inserted = 0;
        if (toInsert.length > 0) {
          // 分批 insert
          const BATCH = 500;
          for (let i = 0; i < toInsert.length; i += BATCH) {
            const slice = toInsert.slice(i, i + BATCH);
            const values = [];
            const params = [];
            slice.forEach((uid, idx) => {
              const base = idx * 2;
              values.push(`($${base + 1}, $${base + 2})`);
              params.push(id, uid);
            });
            const insRs = await client.query(
              `INSERT INTO admin_recipient_list_members (list_id, line_user_id)
               VALUES ${values.join(', ')}
               ON CONFLICT (list_id, line_user_id) DO NOTHING
               RETURNING id`,
              params
            );
            inserted += insRs.rowCount;
          }
        }
        // 更新 total
        await client.query(
          `UPDATE admin_recipient_lists
           SET total = (SELECT COUNT(*) FROM admin_recipient_list_members WHERE list_id = $1),
               updated_at = NOW()
           WHERE id = $1`,
          [id]
        );
        await client.query('COMMIT');
        res.json({
          ok: true,
          submitted: rawIds.length,
          valid: valid.length,
          inserted,
          already_existed: valid.length - toInsert.length,
          invalid_count: invalid.length,
          invalid_sample: invalid.slice(0, 5)
        });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_e) {}
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('add members error:', err && err.message);
      return safeJson(res, 500, 'add_members_failed', { detail: err && err.message });
    }
  });

  // ----- 移除單一成員 -----
  app.delete('/admin/recipient-lists/api/members/:memberId(\\d+)', requireAdmin, async (req, res) => {
    try {
      const memberId = Number(req.params.memberId);
      const { rows } = await query(
        'DELETE FROM admin_recipient_list_members WHERE id = $1 RETURNING list_id',
        [memberId]
      );
      if (rows.length === 0) return safeJson(res, 404, 'not_found');
      const listId = rows[0].list_id;
      // 更新 total
      await query(
        `UPDATE admin_recipient_lists
         SET total = (SELECT COUNT(*) FROM admin_recipient_list_members WHERE list_id = $1),
             updated_at = NOW()
         WHERE id = $1`,
        [listId]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('remove member error:', err && err.message);
      return safeJson(res, 500, 'remove_member_failed', { detail: err && err.message });
    }
  });

  // ----- 更新名單基本資訊 -----
  app.put('/admin/recipient-lists/api/:id(\\d+)', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 500);
      if (!name) return safeJson(res, 400, 'name_required');
      const { rows } = await query(
        `UPDATE admin_recipient_lists
         SET name = $1, description = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [name, description || null, id]
      );
      if (rows.length === 0) return safeJson(res, 404, 'not_found');
      res.json({ ok: true, list: rows[0] });
    } catch (err) {
      console.error('update list error:', err && err.message);
      return safeJson(res, 500, 'update_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminRecipientListsRoutes };
