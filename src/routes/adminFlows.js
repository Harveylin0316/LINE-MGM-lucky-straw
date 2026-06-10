/**
 * 自動化流程 routes（階段 2 cron + 階段 3 編輯器 CRUD）
 *
 * 頁面：
 *   GET    /admin/flows                    流程列表 + 編輯器
 * API：
 *   GET    /admin/flows/api/options        下拉用：訊息庫 / 名單 / 活動 / 常見事件
 *   GET    /admin/flows/api/list           流程列表（含進行中人數）
 *   GET    /admin/flows/api/:id            單一流程（節點還原成步驟樹）
 *   POST   /admin/flows/api                新增
 *   PUT    /admin/flows/api/:id            更新（重寫節點）
 *   POST   /admin/flows/api/:id/status     啟用 / 暫停 / 轉草稿
 *   DELETE /admin/flows/api/:id            刪除
 * cron：
 *   POST   /admin/flows/run                每 5 分鐘排程推進
 *   POST   /admin/flows/run-now            admin 手動推進一次（測試）
 *
 * 步驟樹 ←→ 節點：
 *   steps: [ {type:'send',message_id} | {type:'wait',amount,unit}
 *            | {type:'branch',condition,yes:[...],no:[...]} ]
 *   分支限制在主序列，yes/no 內只放 send/wait（中版，員工好懂）。
 */

const KNOWN_EVENTS = [
  { value: 'app_open', label: '開啟今天吃什麼' },
  { value: 'submit_draw', label: '抽了一次餐廳' },
  { value: 'result_shown', label: '看到抽籤結果' },
  { value: 'restaurant_click', label: '點了餐廳訂位' }
];

function registerAdminFlowsRoutes(app, deps) {
  const { query, pool, flowEngine, authCore } = deps;
  const requireAdmin = authCore && authCore.requireAdmin;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }
  function isPosInt(s) { return typeof s === 'string' && /^\d+$/.test(s) && Number(s) > 0; }

  // ---------- 步驟樹 → 節點 ----------
  function flattenSteps(steps) {
    let counter = 0;
    const nodes = [];
    function newKey() { counter++; return 'n' + counter; }
    function build(stepList) {
      if (!Array.isArray(stepList) || stepList.length === 0) return null;
      let firstKey = null;
      let prev = null;
      for (const step of stepList) {
        if (!step || !step.type) continue;
        const key = newKey();
        const node = {
          node_key: key, type: step.type, config: {},
          next_key: null, branch_true_key: null, branch_false_key: null,
          is_entry: false, position: nodes.length
        };
        if (step.type === 'send') {
          node.config = { message_id: Number(step.message_id) || null };
        } else if (step.type === 'wait') {
          node.config = { amount: Number(step.amount) || 0, unit: step.unit || 'days' };
        } else if (step.type === 'branch') {
          node.config = { condition: step.condition || {} };
        } else {
          continue;
        }
        nodes.push(node);
        if (!firstKey) firstKey = key;
        if (prev) prev.next_key = key;
        if (step.type === 'branch') {
          node.branch_true_key = build(step.yes);
          node.branch_false_key = build(step.no);
          prev = null; // 分支為主序列終點
          break;
        }
        prev = node;
      }
      return firstKey;
    }
    const entryKey = build(steps);
    const entry = nodes.find(n => n.node_key === entryKey);
    if (entry) entry.is_entry = true;
    return { nodes, entryKey };
  }

  // ---------- 節點 → 步驟樹 ----------
  function unflattenNodes(nodes) {
    const byKey = {};
    nodes.forEach(n => { byKey[n.node_key] = n; });
    const entry = nodes.find(n => n.is_entry) || nodes[0];
    function walk(startKey) {
      const steps = [];
      let key = startKey;
      const seen = new Set();
      while (key && byKey[key] && !seen.has(key)) {
        seen.add(key);
        const n = byKey[key];
        if (n.type === 'send') {
          steps.push({ type: 'send', message_id: n.config && n.config.message_id });
          key = n.next_key;
        } else if (n.type === 'wait') {
          steps.push({ type: 'wait', amount: n.config && n.config.amount, unit: n.config && n.config.unit });
          key = n.next_key;
        } else if (n.type === 'branch') {
          steps.push({
            type: 'branch',
            condition: n.config && n.config.condition,
            yes: walk(n.branch_true_key),
            no: walk(n.branch_false_key)
          });
          key = null;
        } else {
          key = n.next_key;
        }
      }
      return steps;
    }
    return walk(entry ? entry.node_key : null);
  }

  function validateFlow(body) {
    const name = String(body.name || '').trim();
    if (!name) return { ok: false, error: 'name_required' };
    const trigger = body.trigger || {};
    const tType = trigger.type;
    if (!['follow', 'list_join', 'event', 'schedule', 'game_play', 'broadcast_click'].includes(tType)) return { ok: false, error: 'invalid_trigger_type' };
    const tCfg = trigger.config || {};
    if (tType === 'list_join' && !(Number(tCfg.list_id) > 0)) return { ok: false, error: 'list_join_needs_list' };
    if (tType === 'event' && !String(tCfg.event_name || '').trim()) return { ok: false, error: 'event_needs_name' };
    // game_play / broadcast_click：無必填設定（活動可選任一、推播點擊任意）
    if (tType === 'schedule') {
      if (!Number.isFinite(Number(tCfg.hour))) return { ok: false, error: 'schedule_needs_hour' };
    }
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (steps.length === 0) return { ok: false, error: 'need_at_least_one_step' };
    // 至少要有一個 send
    function hasSend(list) {
      return (list || []).some(s => s.type === 'send' || (s.type === 'branch' && (hasSend(s.yes) || hasSend(s.no))));
    }
    if (!hasSend(steps)) return { ok: false, error: 'need_at_least_one_send' };
    return { ok: true, name, trigger: { type: tType, config: tCfg }, steps, re_enroll: !!body.re_enroll };
  }

  async function writeNodes(client, flowId, steps) {
    await client.query('DELETE FROM admin_flow_nodes WHERE flow_id = $1', [flowId]);
    const { nodes } = flattenSteps(steps);
    for (const n of nodes) {
      await client.query(
        `INSERT INTO admin_flow_nodes
           (flow_id, node_key, type, config, next_key, branch_true_key, branch_false_key, is_entry, position)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
        [flowId, n.node_key, n.type, JSON.stringify(n.config), n.next_key, n.branch_true_key, n.branch_false_key, n.is_entry, n.position]
      );
    }
  }

  // ---------- 頁面 ----------
  app.get('/admin/flows', requireAdmin, (req, res) => {
    res.render('admin_flows', {
      title: '自動化流程',
      bodyClass: 'admin-shell flows-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // ---------- options（下拉資料） ----------
  app.get('/admin/flows/api/options', requireAdmin, async (_req, res) => {
    try {
      const [msgs, lists, acts] = await Promise.all([
        query(`SELECT id, name FROM admin_message_templates WHERE channel = 'line' ORDER BY id DESC`),
        query(`SELECT id, name FROM admin_recipient_lists ORDER BY id DESC`),
        query(`SELECT id, name FROM activities ORDER BY id DESC`)
      ]);
      return res.json({
        ok: true,
        messages: msgs.rows,
        lists: lists.rows,
        activities: acts.rows,
        events: KNOWN_EVENTS
      });
    } catch (err) {
      return jsonErr(res, 500, 'options_failed', { detail: err && err.message });
    }
  });

  // ---------- 列表 ----------
  app.get('/admin/flows/api/list', requireAdmin, async (_req, res) => {
    try {
      const rs = await query(
        `SELECT f.id, f.name, f.status, f.trigger_type, f.trigger_config, f.re_enroll, f.updated_at,
                (SELECT COUNT(*) FROM admin_flow_enrollments e WHERE e.flow_id = f.id AND e.status = 'active')::int AS active_count,
                (SELECT COUNT(*) FROM admin_flow_enrollments e WHERE e.flow_id = f.id)::int AS total_count
         FROM admin_flows f ORDER BY f.id DESC`
      );
      return res.json({ ok: true, flows: rs.rows });
    } catch (err) {
      return jsonErr(res, 500, 'list_failed', { detail: err && err.message });
    }
  });

  // ---------- 單一 ----------
  app.get('/admin/flows/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const fr = await query(`SELECT * FROM admin_flows WHERE id = $1`, [Number(idStr)]);
      if (fr.rowCount === 0) return jsonErr(res, 404, 'not_found');
      const nr = await query(`SELECT * FROM admin_flow_nodes WHERE flow_id = $1 ORDER BY position ASC`, [Number(idStr)]);
      const flow = fr.rows[0];
      return res.json({
        ok: true,
        flow: {
          id: flow.id, name: flow.name, status: flow.status, re_enroll: flow.re_enroll,
          trigger: { type: flow.trigger_type, config: flow.trigger_config },
          steps: unflattenNodes(nr.rows)
        }
      });
    } catch (err) {
      return jsonErr(res, 500, 'get_failed', { detail: err && err.message });
    }
  });

  // ---------- 新增 ----------
  app.post('/admin/flows/api', requireAdmin, async (req, res) => {
    const v = validateFlow(req.body || {});
    if (!v.ok) return jsonErr(res, 400, v.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const createdBy = (req.authUser && req.authUser.un) || 'admin';
      const fr = await client.query(
        `INSERT INTO admin_flows (name, status, trigger_type, trigger_config, re_enroll, created_by)
         VALUES ($1, 'draft', $2, $3::jsonb, $4, $5) RETURNING id`,
        [v.name, v.trigger.type, JSON.stringify(v.trigger.config), v.re_enroll, createdBy]
      );
      const flowId = fr.rows[0].id;
      await writeNodes(client, flowId, v.steps);
      await client.query('COMMIT');
      return res.json({ ok: true, id: flowId });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return jsonErr(res, 500, 'create_failed', { detail: err && err.message });
    } finally {
      client.release();
    }
  });

  // ---------- 更新 ----------
  app.put('/admin/flows/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    const v = validateFlow(req.body || {});
    if (!v.ok) return jsonErr(res, 400, v.error);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const up = await client.query(
        `UPDATE admin_flows SET name = $2, trigger_type = $3, trigger_config = $4::jsonb, re_enroll = $5, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [Number(idStr), v.name, v.trigger.type, JSON.stringify(v.trigger.config), v.re_enroll]
      );
      if (up.rowCount === 0) { await client.query('ROLLBACK'); return jsonErr(res, 404, 'not_found'); }
      await writeNodes(client, Number(idStr), v.steps);
      await client.query('COMMIT');
      return res.json({ ok: true, id: Number(idStr) });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      return jsonErr(res, 500, 'update_failed', { detail: err && err.message });
    } finally {
      client.release();
    }
  });

  // ---------- 狀態（啟用/暫停/草稿） ----------
  app.post('/admin/flows/api/:id/status', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    const status = (req.body && req.body.status) || '';
    if (!['draft', 'active', 'paused'].includes(status)) return jsonErr(res, 400, 'invalid_status');
    try {
      // 啟用前確認有節點
      if (status === 'active') {
        const nc = await query(`SELECT COUNT(*)::int AS n FROM admin_flow_nodes WHERE flow_id = $1`, [Number(idStr)]);
        if (Number(nc.rows[0].n) === 0) return jsonErr(res, 400, 'flow_has_no_steps');
      }
      const rs = await query(
        `UPDATE admin_flows SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status`,
        [Number(idStr), status]
      );
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, status: rs.rows[0].status });
    } catch (err) {
      return jsonErr(res, 500, 'status_failed', { detail: err && err.message });
    }
  });

  // ---------- 刪除 ----------
  app.delete('/admin/flows/api/:id', requireAdmin, async (req, res) => {
    const idStr = String(req.params.id || '').trim();
    if (!isPosInt(idStr)) return jsonErr(res, 400, 'invalid_id');
    try {
      const rs = await query(`DELETE FROM admin_flows WHERE id = $1 RETURNING id`, [Number(idStr)]);
      if (rs.rowCount === 0) return jsonErr(res, 404, 'not_found');
      return res.json({ ok: true, deletedId: Number(idStr) });
    } catch (err) {
      return jsonErr(res, 500, 'delete_failed', { detail: err && err.message });
    }
  });

  // ---------- cron 推進 ----------
  app.post('/admin/flows/run', async (req, res) => {
    const expectedSecret = process.env.SCHEDULED_RUNNER_SECRET || '';
    const providedSecret = req.get('x-scheduler-secret') || '';
    if (!expectedSecret || providedSecret !== expectedSecret) return jsonErr(res, 403, 'forbidden');
    try {
      const result = await flowEngine.run();
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('flows run error:', err && (err.stack || err.message));
      return jsonErr(res, 500, 'run_failed', { detail: err && err.message });
    }
  });

  // ---------- admin 手動推進（測試） ----------
  if (requireAdmin) {
    app.post('/admin/flows/run-now', requireAdmin, async (_req, res) => {
      try {
        const result = await flowEngine.run();
        return res.json({ ok: true, ...result });
      } catch (err) {
        return jsonErr(res, 500, 'run_failed', { detail: err && err.message });
      }
    });
  }
}

module.exports = { registerAdminFlowsRoutes };
