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
  const { query, pool, authCore, flowEngine = null } = deps;
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

  // ----- 所有名單的「實際可發」拆解（列表頁用，一次撈齊）-----
  //   口徑與單一名單 detail 的 breakdown 完全一致（對齊 broadcastAudience LINE_FILTER）。
  //   回傳 { ok, breakdowns: { [listId]: { line_sendable, email_only, unknown } } }
  app.get('/admin/recipient-lists/api/breakdowns', requireAdmin, async (req, res) => {
    try {
      const rs = await query(
        `SELECT m.list_id,
           COUNT(*) FILTER (
             WHERE m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
               AND (u.blocked_at IS NULL OR u.id IS NULL)
           )::int AS line_sendable,
           COUNT(*) FILTER (
             WHERE NOT (
               m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
               AND (u.blocked_at IS NULL OR u.id IS NULL)
             )
             AND m.email IS NOT NULL AND BTRIM(m.email) <> ''
           )::int AS email_only,
           COUNT(*) FILTER (
             WHERE NOT (
               m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
               AND (u.blocked_at IS NULL OR u.id IS NULL)
             )
             AND (m.email IS NULL OR BTRIM(m.email) = '')
           )::int AS unknown
         FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         GROUP BY m.list_id`
      );
      const breakdowns = {};
      for (const row of rs.rows) {
        breakdowns[row.list_id] = {
          line_sendable: Number(row.line_sendable || 0),
          email_only: Number(row.email_only || 0),
          unknown: Number(row.unknown || 0)
        };
      }
      res.json({ ok: true, breakdowns });
    } catch (err) {
      console.error('list breakdowns error:', err && err.message);
      return safeJson(res, 500, 'breakdowns_failed', { detail: err && err.message });
    }
  });

  // ----- 完整成員列表（分頁）-----
  app.get('/admin/recipient-lists/api/:id(\\d+)/members', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 1000);
      const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
      const searchRaw = String(req.query.search || '').trim().toLowerCase();
      const search = searchRaw.replace(/[\\%_]/g, '\\$&'); // 跳脫 LIKE 萬用字元
      const params = [id];
      let whereSearch = '';
      if (searchRaw) {
        params.push('%' + search + '%');
        whereSearch = ` AND (LOWER(m.line_user_id) LIKE $${params.length} ESCAPE '\\' OR LOWER(m.email) LIKE $${params.length} ESCAPE '\\' OR LOWER(u.line_display_name) LIKE $${params.length} ESCAPE '\\' OR LOWER(u.username) LIKE $${params.length} ESCAPE '\\')`;
      }
      params.push(limit, offset);
      const { rows } = await query(
        `SELECT m.id, m.line_user_id, m.email, m.display_name AS member_display_name, m.created_at,
                u.line_display_name, u.username, u.line_picture_url
         FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.list_id = $1${whereSearch}
         ORDER BY m.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      const cntParams = searchRaw ? [id, '%' + search + '%'] : [id];
      const cntSearch = searchRaw
        ? ` AND (LOWER(m.line_user_id) LIKE $2 ESCAPE '\\' OR LOWER(m.email) LIKE $2 ESCAPE '\\' OR LOWER(u.line_display_name) LIKE $2 ESCAPE '\\' OR LOWER(u.username) LIKE $2 ESCAPE '\\')`
        : '';
      const cntRs = await query(
        `SELECT COUNT(*)::int AS n FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.list_id = $1${cntSearch}`,
        cntParams
      );
      // 可發送口徑拆分（不受搜尋影響，永遠算整份名單）：
      //   line_sendable：line_user_id 有值且非空白，且未被封鎖（口徑對齊 broadcastAudience.js
      //                  LINE saved_list 的 LINE_FILTER：u.blocked_at IS NULL OR u.id IS NULL）
      //   email_only   ：不符合 LINE 可發送條件，但有 email（口徑對齊 email channel 的 email 篩選）
      //   unknown      ：兩者皆無（含「line_user_id 有值卻被封鎖且無 email」這種真實不可發送者）
      const breakdownRs = await query(
        `SELECT
           COUNT(*) FILTER (
             WHERE m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
               AND (u.blocked_at IS NULL OR u.id IS NULL)
           )::int AS line_sendable,
           COUNT(*) FILTER (
             WHERE NOT (
               m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
               AND (u.blocked_at IS NULL OR u.id IS NULL)
             )
             AND m.email IS NOT NULL AND BTRIM(m.email) <> ''
           )::int AS email_only,
           COUNT(*) FILTER (
             WHERE NOT (
               m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
               AND (u.blocked_at IS NULL OR u.id IS NULL)
             )
             AND (m.email IS NULL OR BTRIM(m.email) = '')
           )::int AS unknown
         FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.list_id = $1`,
        [id]
      );
      const bd = breakdownRs.rows[0] || {};
      res.json({
        ok: true,
        members: rows,
        total: Number(cntRs.rows[0]?.n || 0),
        breakdown: {
          line_sendable: Number(bd.line_sendable || 0),
          email_only: Number(bd.email_only || 0),
          unknown: Number(bd.unknown || 0)
        }
      });
    } catch (err) {
      console.error('list members error:', err && err.message);
      return safeJson(res, 500, 'list_members_failed', { detail: err && err.message });
    }
  });

  // ----- 批次新增成員 -----
  //  body: { lineUserIds: ['U...', ...], emails: ['x@y.com', ...] }
  //  兩個 array 可任選或同時存在
  app.post('/admin/recipient-lists/api/:id(\\d+)/members', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const rawIds = Array.isArray(body.lineUserIds) ? body.lineUserIds : [];
      const rawEmails = Array.isArray(body.emails) ? body.emails : [];
      // LINE UID 清洗
      const validUids = [];
      const seenUid = new Set();
      const invalidUids = [];
      for (const raw of rawIds) {
        const s = String(raw || '').trim();
        if (!s) continue;
        if (!/^U[0-9a-f]{32}$/i.test(s)) { invalidUids.push(s.slice(0, 50)); continue; }
        const key = s.toLowerCase();
        if (seenUid.has(key)) continue;
        seenUid.add(key);
        validUids.push(s);
      }
      // Email 清洗
      const validEmails = [];
      const seenEmail = new Set();
      const invalidEmails = [];
      for (const raw of rawEmails) {
        const s = String(raw || '').trim().toLowerCase();
        if (!s) continue;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) { invalidEmails.push(s.slice(0, 100)); continue; }
        if (seenEmail.has(s)) continue;
        seenEmail.add(s);
        validEmails.push(s);
      }

      if (validUids.length === 0 && validEmails.length === 0) {
        return safeJson(res, 400, 'no_valid_inputs', {
          detail: '沒有合法的 LINE userId 或 email',
          invalid_uid_sample: invalidUids.slice(0, 5),
          invalid_email_sample: invalidEmails.slice(0, 5)
        });
      }

      // 單一名單上限 5000（與群發建立名單一致；避免下游 fetch 靜默截斷只送前 5000）
      const MAX_LIST = 5000;
      const curRs = await query('SELECT COUNT(*)::int AS n FROM admin_recipient_list_members WHERE list_id = $1', [id]);
      const currentTotal = Number(curRs.rows[0]?.n || 0);
      if (currentTotal + validUids.length + validEmails.length > MAX_LIST) {
        return safeJson(res, 400, 'too_many_recipients', {
          detail: `單一名單上限 ${MAX_LIST} 人（目前 ${currentTotal}，欲新增 ${validUids.length + validEmails.length}）`
        });
      }

      const client = await pool.connect();
      let insertedUids = 0;
      let insertedEmails = 0;
      let existedUids = 0;
      let existedEmails = 0;
      let newUidsForTrigger = [];
      try {
        await client.query('BEGIN');
        // ----- LINE UID -----
        if (validUids.length > 0) {
          const existsRs = await client.query(
            `SELECT line_user_id FROM admin_recipient_list_members
             WHERE list_id = $1 AND line_user_id = ANY($2)`,
            [id, validUids]
          );
          const existing = new Set(existsRs.rows.map(r => r.line_user_id));
          const toInsert = validUids.filter(uid => !existing.has(uid));
          existedUids = validUids.length - toInsert.length;
          if (toInsert.length > 0) {
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
                 ON CONFLICT DO NOTHING
                 RETURNING line_user_id`,
                params
              );
              insertedUids += insRs.rowCount;
              // 只對「本交易真正插入成功」的 uid 觸發 list_join（避免並發重疊請求重複觸發）
              for (const row of insRs.rows) newUidsForTrigger.push(row.line_user_id);
            }
          }
        }

        // ----- Email -----
        if (validEmails.length > 0) {
          const existsRs = await client.query(
            `SELECT LOWER(email) AS email FROM admin_recipient_list_members
             WHERE list_id = $1 AND email IS NOT NULL AND LOWER(email) = ANY($2)`,
            [id, validEmails]
          );
          const existing = new Set(existsRs.rows.map(r => r.email));
          const toInsert = validEmails.filter(e => !existing.has(e));
          existedEmails = validEmails.length - toInsert.length;
          if (toInsert.length > 0) {
            const BATCH = 500;
            for (let i = 0; i < toInsert.length; i += BATCH) {
              const slice = toInsert.slice(i, i + BATCH);
              const values = [];
              const params = [];
              slice.forEach((e, idx) => {
                const base = idx * 2;
                values.push(`($${base + 1}, $${base + 2})`);
                params.push(id, e);
              });
              const insRs = await client.query(
                `INSERT INTO admin_recipient_list_members (list_id, email)
                 VALUES ${values.join(', ')}
                 ON CONFLICT DO NOTHING
                 RETURNING id`,
                params
              );
              insertedEmails += insRs.rowCount;
            }
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

        // 自動化流程：對新加入的 LINE 成員觸發 list_join-flows（非阻塞）
        if (flowEngine && typeof flowEngine.triggerListJoin === 'function' && newUidsForTrigger.length > 0) {
          Promise.resolve().then(async function () {
            for (const uid of newUidsForTrigger) {
              await flowEngine.triggerListJoin(id, uid, null);
            }
          }).catch(function (e) { console.error('flow list_join trigger failed:', e.message); });
        }

        res.json({
          ok: true,
          submitted_uids: rawIds.length,
          submitted_emails: rawEmails.length,
          valid_uids: validUids.length,
          valid_emails: validEmails.length,
          inserted_uids: insertedUids,
          inserted_emails: insertedEmails,
          already_existed_uids: existedUids,
          already_existed_emails: existedEmails,
          invalid_uid_count: invalidUids.length,
          invalid_email_count: invalidEmails.length,
          invalid_uid_sample: invalidUids.slice(0, 5),
          invalid_email_sample: invalidEmails.slice(0, 5),
          // 向後相容（舊版前端用）
          inserted: insertedUids + insertedEmails,
          valid: validUids.length + validEmails.length,
          already_existed: existedUids + existedEmails,
          invalid_count: invalidUids.length + invalidEmails.length,
          invalid_sample: invalidUids.concat(invalidEmails).slice(0, 5)
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

  // ----- 自動加入規則：列出「會自動把人加進這個名單」的流程 -----
  app.get('/admin/recipient-lists/api/:id(\\d+)/auto-rules', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rs = await query(
        `SELECT DISTINCT f.id, f.name, f.status, f.trigger_type
         FROM admin_flows f
         JOIN admin_flow_nodes n ON n.flow_id = f.id
         WHERE n.type = 'add_to_list' AND (n.config->>'list_id')::int = $1
         ORDER BY f.id DESC`,
        [id]
      );
      res.json({ ok: true, rules: rs.rows });
    } catch (err) {
      console.error('list auto-rules error:', err && err.message);
      return safeJson(res, 500, 'auto_rules_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminRecipientListsRoutes };
