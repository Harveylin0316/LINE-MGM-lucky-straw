/**
 * 訊息庫（Message Library）routes
 *
 * 把 admin_message_templates 升級成一個獨立、可重複使用的訊息庫。
 * 流程系統（階段 2/3）的「發訊息」節點會用 message_id 引用這裡的訊息。
 *
 *   GET    /admin/messages                 訊息庫頁面
 *   GET    /admin/messages/api/list        列表
 *   GET    /admin/messages/api/:id         單一（含 message_config）
 *   POST   /admin/messages/api             新增
 *   PUT    /admin/messages/api/:id         更新
 *   DELETE /admin/messages/api/:id         刪除
 *   POST   /admin/messages/api/preview     即時預覽（不存）
 */

function registerAdminMessagesRoutes(app, deps) {
  const { query, authCore, buildLineMessages } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }
  function isPosInt(s) {
    return typeof s === 'string' && /^\d+$/.test(s) && Number(s) > 0;
  }

  // 頁面
  app.get('/admin/messages', requireAdmin, (req, res) => {
    res.render('admin_messages', {
      title: '訊息庫',
      bodyClass: 'admin-shell messages-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 列表
  app.get('/admin/messages/api/list', requireAdmin, async (_req, res) => {
    try {
      const rs = await query(
        `SELECT id, name, description, channel, message_config, created_by, created_at, updated_at
         FROM admin_message_templates
         ORDER BY id DESC`
      );
      return res.json({ ok: true, messages: rs.rows });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  // 單一
  app.get('/admin/messages/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const rs = await query(
        `SELECT id, name, description, channel, message_config, created_by, created_at, updated_at
         FROM admin_message_templates WHERE id = $1`,
        [Number(idStr)]
      );
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, message: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'get_failed', { detail: err && err.message });
    }
  });

  function validateConfig(messageConfig) {
    if (!messageConfig || typeof messageConfig !== 'object') return { ok: false, error: 'message_config_required' };
    const built = buildLineMessages(messageConfig);
    if (!built.ok) return { ok: false, error: 'message_config_invalid:' + built.error };
    return { ok: true };
  }

  // 新增
  app.post('/admin/messages/api', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 500);
      const channel = body.channel === 'email' ? 'email' : 'line';
      const messageConfig = body.message_config;
      if (!name) return jsonErr(res, 400, 'name_required');
      const v = validateConfig(messageConfig);
      if (!v.ok) return jsonErr(res, 400, v.error);

      const createdBy = (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';
      const rs = await query(
        `INSERT INTO admin_message_templates (name, description, channel, message_config, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, name, description, channel, created_by, created_at, updated_at`,
        [name, description || null, channel, JSON.stringify(messageConfig), createdBy]
      );
      return res.json({ ok: true, message: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'create_failed', { detail: err && err.message });
    }
  });

  // 更新
  app.put('/admin/messages/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 500);
      const channel = body.channel === 'email' ? 'email' : 'line';
      const messageConfig = body.message_config;
      if (!name) return jsonErr(res, 400, 'name_required');
      const v = validateConfig(messageConfig);
      if (!v.ok) return jsonErr(res, 400, v.error);

      const rs = await query(
        `UPDATE admin_message_templates
         SET name = $2, description = $3, channel = $4, message_config = $5::jsonb, updated_at = NOW()
         WHERE id = $1
         RETURNING id, name, description, channel, created_by, created_at, updated_at`,
        [Number(idStr), name, description || null, channel, JSON.stringify(messageConfig)]
      );
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, message: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'update_failed', { detail: err && err.message });
    }
  });

  // 刪除
  app.delete('/admin/messages/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      // 引用檢查：被流程 send 節點引用時不可硬刪（否則流程靜默漏發）
      const used = await query(
        `SELECT DISTINCT f.id, f.name, f.status FROM admin_flows f
         JOIN admin_flow_nodes n ON n.flow_id = f.id
         WHERE n.type = 'send' AND (n.config->>'message_id')::int = $1`,
        [Number(idStr)]
      );
      if (used.rowCount > 0) {
        return jsonErr(res, 409, 'message_in_use', { detail: '此訊息被自動化流程引用，請先移除引用再刪除', flows: used.rows });
      }
      const rs = await query('DELETE FROM admin_message_templates WHERE id = $1 RETURNING id', [Number(idStr)]);
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, deletedId: Number(idStr) });
    } catch (err) {
      return jsonErr(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });

  // 即時預覽（不存）
  app.post('/admin/messages/api/preview', requireAdmin, (req, res) => {
    try {
      const messageConfig = req.body && req.body.message_config;
      const built = buildLineMessages(messageConfig);
      if (!built.ok) return res.json({ ok: false, error: built.error });
      return res.json({ ok: true, messages: built.messages });
    } catch (err) {
      return jsonErr(res, 500, 'preview_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminMessagesRoutes };
