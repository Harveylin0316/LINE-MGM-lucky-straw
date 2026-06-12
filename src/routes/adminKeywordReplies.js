/**
 * 關鍵字自動回覆 routes
 *
 * 用戶在 OA 聊天室輸入文字訊息命中關鍵字 → webhook 用 reply token
 * 自動回覆訊息庫（admin_message_templates）的指定訊息。
 *
 *   GET    /admin/keyword-replies                 管理頁
 *   GET    /admin/keyword-replies/api/list        規則列表（含訊息庫下拉選項）
 *   POST   /admin/keyword-replies/api/create      新增
 *   POST   /admin/keyword-replies/api/:id/update  更新（含啟用 toggle）
 *   DELETE /admin/keyword-replies/api/:id         刪除
 */

function registerAdminKeywordRepliesRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }
  function isPosInt(s) {
    return typeof s === 'string' && /^\d+$/.test(s) && Number(s) > 0;
  }
  /** 全形逗號轉半形、去空白、去空項，存回標準「a, b, c」格式 */
  function normalizeKeywords(raw) {
    return String(raw == null ? '' : raw)
      .replace(/，/g, ',')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .join(', ')
      .slice(0, 500);
  }

  // 頁面
  app.get('/admin/keyword-replies', requireAdmin, (req, res) => {
    res.render('admin_keyword_replies', {
      title: '關鍵字回覆',
      bodyClass: 'admin-shell keyword-replies-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 列表（一次帶回規則 + 訊息庫下拉選項，前端不用打兩支）
  app.get('/admin/keyword-replies/api/list', requireAdmin, async (_req, res) => {
    try {
      const rules = await query(
        `SELECT r.id, r.keywords, r.match_type, r.message_template_id, r.is_active,
                r.priority, r.hit_count, r.created_at, r.updated_at,
                t.name AS template_name
         FROM admin_keyword_replies r
         LEFT JOIN admin_message_templates t ON t.id = r.message_template_id
         ORDER BY r.priority ASC, r.id ASC`
      );
      const templates = await query(
        `SELECT id, name FROM admin_message_templates
         WHERE COALESCE(channel, 'line') = 'line'
         ORDER BY id DESC`
      );
      return res.json({ ok: true, rules: rules.rows, templates: templates.rows });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  async function validateInput(body) {
    const keywords = normalizeKeywords(body.keywords);
    if (!keywords) return { ok: false, error: 'keywords_required' };
    const matchType = body.match_type === 'exact' ? 'exact' : 'contains';
    const templateId = Number(body.message_template_id);
    if (!Number.isInteger(templateId) || templateId <= 0) return { ok: false, error: 'message_template_required' };
    const t = await query(`SELECT id FROM admin_message_templates WHERE id = $1`, [templateId]);
    if (t.rowCount === 0) return { ok: false, error: 'message_template_not_found' };
    const priorityRaw = Number(body.priority);
    const priority = Number.isInteger(priorityRaw) && priorityRaw >= 0 && priorityRaw <= 9999 ? priorityRaw : 100;
    const isActive = body.is_active !== false && body.is_active !== 'false';
    return { ok: true, value: { keywords, matchType, templateId, priority, isActive } };
  }

  // 新增
  app.post('/admin/keyword-replies/api/create', requireAdmin, async (req, res) => {
    try {
      const v = await validateInput(req.body || {});
      if (!v.ok) return jsonErr(res, 400, v.error);
      const rs = await query(
        `INSERT INTO admin_keyword_replies (keywords, match_type, message_template_id, is_active, priority)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, keywords, match_type, message_template_id, is_active, priority, hit_count, created_at, updated_at`,
        [v.value.keywords, v.value.matchType, v.value.templateId, v.value.isActive, v.value.priority]
      );
      return res.json({ ok: true, rule: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'create_failed', { detail: err && err.message });
    }
  });

  // 更新（編輯表單整筆更新；只帶 is_active 時做啟用 toggle）
  app.post('/admin/keyword-replies/api/:id/update', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const body = req.body || {};
      // toggle 模式：body 只帶 is_active
      if (body.keywords === undefined && body.message_template_id === undefined) {
        const isActive = body.is_active === true || body.is_active === 'true';
        const rs = await query(
          `UPDATE admin_keyword_replies SET is_active = $2, updated_at = now()
           WHERE id = $1
           RETURNING id, keywords, match_type, message_template_id, is_active, priority, hit_count`,
          [Number(idStr), isActive]
        );
        if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
        return res.json({ ok: true, rule: rs.rows[0] });
      }
      const v = await validateInput(body);
      if (!v.ok) return jsonErr(res, 400, v.error);
      const rs = await query(
        `UPDATE admin_keyword_replies
         SET keywords = $2, match_type = $3, message_template_id = $4, is_active = $5, priority = $6, updated_at = now()
         WHERE id = $1
         RETURNING id, keywords, match_type, message_template_id, is_active, priority, hit_count, created_at, updated_at`,
        [Number(idStr), v.value.keywords, v.value.matchType, v.value.templateId, v.value.isActive, v.value.priority]
      );
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, rule: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'update_failed', { detail: err && err.message });
    }
  });

  // 刪除
  app.delete('/admin/keyword-replies/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const rs = await query('DELETE FROM admin_keyword_replies WHERE id = $1 RETURNING id', [Number(idStr)]);
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, deletedId: Number(idStr) });
    } catch (err) {
      return jsonErr(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminKeywordRepliesRoutes };
