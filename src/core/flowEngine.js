/**
 * 自動化流程引擎（Flow Engine）— 階段 2
 *
 * 概念：
 *   流程(admin_flows) = 觸發 + 一串節點(admin_flow_nodes)
 *   誰走到哪 = admin_flow_enrollments
 *
 * 節點型別：
 *   send   { message_id }                                發訊息庫某則訊息
 *   wait   { amount, unit: minutes|hours|days }          等待
 *   branch { condition: {...} } + branch_true/false_key  條件分支
 *   end                                                  結束
 *
 * 觸發型別：
 *   follow     有人加好友
 *   list_join  被加進某名單  { list_id }
 *   event      發生某事件    { event_name }（對 user_events）
 *   schedule   定時          { freq, hour, dow/dom, audience }
 *
 * 推進：cron 每 5 分鐘呼叫 run()：先跑 schedule/event 觸發建 enrollment，再 advance 到期的 enrollment。
 */

function createFlowEngine({ query, pool, linePush, buildLineMessages }) {
  const MAX_STEPS_PER_TICK = 12;
  const CLAIM_LEASE_MS = 10 * 60 * 1000; // 處理租約 10 分鐘

  // ---------- 共用查詢 ----------
  async function getActiveFlowsByTrigger(triggerType) {
    const rs = await query(
      `SELECT id, name, status, trigger_type, trigger_config, re_enroll
       FROM admin_flows WHERE status = 'active' AND trigger_type = $1`,
      [triggerType]
    );
    return rs.rows;
  }
  async function getEntryNode(flowId) {
    const rs = await query(
      `SELECT * FROM admin_flow_nodes WHERE flow_id = $1 AND is_entry = true ORDER BY position ASC LIMIT 1`,
      [flowId]
    );
    if (rs.rowCount > 0) return rs.rows[0];
    const fb = await query(`SELECT * FROM admin_flow_nodes WHERE flow_id = $1 ORDER BY position ASC, id ASC LIMIT 1`, [flowId]);
    return fb.rowCount > 0 ? fb.rows[0] : null;
  }
  async function getNode(flowId, nodeKey) {
    if (!nodeKey) return null;
    const rs = await query(`SELECT * FROM admin_flow_nodes WHERE flow_id = $1 AND node_key = $2 LIMIT 1`, [flowId, nodeKey]);
    return rs.rowCount > 0 ? rs.rows[0] : null;
  }

  // ---------- 報名（enrollment） ----------
  async function enrollUser(flow, lineUserId, opts = {}) {
    const luid = String(lineUserId || '').trim();
    if (!luid) return { enrolled: false, reason: 'no_user' };
    if (!flow.re_enroll) {
      const ex = await query(
        `SELECT 1 FROM admin_flow_enrollments WHERE flow_id = $1 AND line_user_id = $2 LIMIT 1`,
        [flow.id, luid]
      );
      if (ex.rowCount > 0) return { enrolled: false, reason: 'already_enrolled' };
    }
    const entry = await getEntryNode(flow.id);
    if (!entry) return { enrolled: false, reason: 'no_entry_node' };
    await query(
      `INSERT INTO admin_flow_enrollments (flow_id, line_user_id, user_id, current_node_key, status, next_run_at, context)
       VALUES ($1, $2, $3, $4, 'active', now(), $5::jsonb)`,
      [flow.id, luid, opts.userId || null, entry.node_key, JSON.stringify(opts.context || {})]
    );
    return { enrolled: true };
  }

  // ---------- 觸發：follow / list_join（由外部即時呼叫） ----------
  async function triggerFollow(lineUserId, userId) {
    try {
      const flows = await getActiveFlowsByTrigger('follow');
      for (const f of flows) await enrollUser(f, lineUserId, { userId, context: { trigger: 'follow' } });
    } catch (err) {
      console.error('flow triggerFollow error:', err.message);
    }
  }
  async function triggerListJoin(listId, lineUserId, userId) {
    try {
      const flows = await getActiveFlowsByTrigger('list_join');
      for (const f of flows) {
        const cfgListId = f.trigger_config && Number(f.trigger_config.list_id);
        if (cfgListId && Number(cfgListId) === Number(listId)) {
          await enrollUser(f, lineUserId, { userId, context: { trigger: 'list_join', list_id: Number(listId) } });
        }
      }
    } catch (err) {
      console.error('flow triggerListJoin error:', err.message);
    }
  }

  // ---------- 觸發：掃描型來源共用 cursor（避免回灌歷史） ----------
  async function getCursor(flowId, initMaxSql) {
    const rs = await query(`SELECT last_event_id FROM admin_flow_event_cursor WHERE flow_id = $1`, [flowId]);
    if (rs.rowCount > 0) return Number(rs.rows[0].last_event_id);
    const mx = await query(initMaxSql);
    const start = Number(mx.rows[0].m || 0);
    await query(
      `INSERT INTO admin_flow_event_cursor (flow_id, last_event_id) VALUES ($1, $2)
       ON CONFLICT (flow_id) DO NOTHING`,
      [flowId, start]
    );
    return start;
  }
  async function setCursor(flowId, lastId) {
    await query(`UPDATE admin_flow_event_cursor SET last_event_id = $2, updated_at = now() WHERE flow_id = $1`, [flowId, lastId]);
  }

  // event：LIFF user_events（event_name）
  async function runEventTriggers() {
    const flows = await getActiveFlowsByTrigger('event');
    let enrolled = 0;
    for (const f of flows) {
      const eventName = f.trigger_config && f.trigger_config.event_name;
      if (!eventName) continue;
      const cursor = await getCursor(f.id, `SELECT COALESCE(MAX(id),0)::bigint AS m FROM user_events`);
      const rs = await query(
        `SELECT id, line_id FROM user_events
         WHERE id > $1 AND event_name = $2 AND line_id IS NOT NULL AND BTRIM(line_id) <> ''
         ORDER BY id ASC LIMIT 500`,
        [cursor, eventName]
      );
      let maxId = cursor;
      for (const row of rs.rows) {
        maxId = Math.max(maxId, Number(row.id));
        const r = await enrollUser(f, row.line_id, { context: { trigger: 'event', event_name: eventName, event_id: Number(row.id) } });
        if (r.enrolled) enrolled++;
      }
      if (maxId > cursor) await setCursor(f.id, maxId);
    }
    return enrolled;
  }

  // game_play：玩了活動遊戲 / 中獎（activity_plays）
  async function runGamePlayTriggers() {
    const flows = await getActiveFlowsByTrigger('game_play');
    let enrolled = 0;
    for (const f of flows) {
      const cfg = f.trigger_config || {};
      const activityId = Number(cfg.activity_id) || null;
      const prizeOnly = cfg.prize_only === true || cfg.prize_only === 'true';
      const cursor = await getCursor(f.id, `SELECT COALESCE(MAX(id),0)::bigint AS m FROM activity_plays`);
      const params = [cursor];
      let sql = `SELECT id, line_user_id FROM activity_plays
                 WHERE id > $1 AND line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''`;
      if (activityId) { params.push(activityId); sql += ` AND activity_id = $${params.length}`; }
      if (prizeOnly) { sql += ` AND prize_id IS NOT NULL`; }
      sql += ` ORDER BY id ASC LIMIT 500`;
      const rs = await query(sql, params);
      let maxId = cursor;
      for (const row of rs.rows) {
        maxId = Math.max(maxId, Number(row.id));
        const r = await enrollUser(f, row.line_user_id, { context: { trigger: 'game_play', play_id: Number(row.id) } });
        if (r.enrolled) enrolled++;
      }
      if (maxId > cursor) await setCursor(f.id, maxId);
    }
    return enrolled;
  }

  // restaurant_click：點了訊息裡的餐廳連結（user_restaurant_clicks）
  async function runRestaurantClickTriggers() {
    const flows = await getActiveFlowsByTrigger('restaurant_click');
    let enrolled = 0;
    for (const f of flows) {
      const cursor = await getCursor(f.id, `SELECT COALESCE(MAX(id),0)::bigint AS m FROM user_restaurant_clicks`);
      const rs = await query(
        `SELECT id, line_user_id, restaurant_query, poi_id FROM user_restaurant_clicks
         WHERE id > $1 AND line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
         ORDER BY id ASC LIMIT 500`,
        [cursor]
      );
      let maxId = cursor;
      for (const row of rs.rows) {
        maxId = Math.max(maxId, Number(row.id));
        const r = await enrollUser(f, row.line_user_id, {
          context: { trigger: 'restaurant_click', restaurant: row.restaurant_query || row.poi_id || null, click_id: Number(row.id) }
        });
        if (r.enrolled) enrolled++;
      }
      if (maxId > cursor) await setCursor(f.id, maxId);
    }
    return enrolled;
  }

  // broadcast_click：點了推播連結（admin_broadcast_clicks）
  async function runBroadcastClickTriggers() {
    const flows = await getActiveFlowsByTrigger('broadcast_click');
    let enrolled = 0;
    for (const f of flows) {
      const cursor = await getCursor(f.id, `SELECT COALESCE(MAX(id),0)::bigint AS m FROM admin_broadcast_clicks`);
      const rs = await query(
        `SELECT id, line_user_id FROM admin_broadcast_clicks
         WHERE id > $1 AND line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
         ORDER BY id ASC LIMIT 500`,
        [cursor]
      );
      let maxId = cursor;
      for (const row of rs.rows) {
        maxId = Math.max(maxId, Number(row.id));
        const r = await enrollUser(f, row.line_user_id, { context: { trigger: 'broadcast_click', click_id: Number(row.id) } });
        if (r.enrolled) enrolled++;
      }
      if (maxId > cursor) await setCursor(f.id, maxId);
    }
    return enrolled;
  }

  // ---------- 觸發：schedule（cron 檢查是否到點） ----------
  function taipeiParts(now) {
    const s = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour12: false });
    const d = new Date(s);
    return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(), dow: d.getDay(), hour: d.getHours(), minute: d.getMinutes(), wall: d };
  }
  function schedulePeriodKeyIfDue(cfg, now) {
    if (!cfg) return null;
    const tp = taipeiParts(now);
    const hour = Number.isFinite(Number(cfg.hour)) ? Number(cfg.hour) : 11;
    const minute = Number.isFinite(Number(cfg.minute)) ? Number(cfg.minute) : 30;
    // 到點判斷：當下台北時間 >= 排程時間，且在 30 分鐘窗口內（cron 每 5 分鐘，給容錯）
    const schedMinutes = hour * 60 + minute;
    const nowMinutes = tp.hour * 60 + tp.minute;
    if (nowMinutes < schedMinutes || nowMinutes >= schedMinutes + 30) return null;
    const freq = cfg.freq || 'daily';
    if (freq === 'daily') {
      return 'D' + tp.y + '-' + String(tp.m).padStart(2, '0') + '-' + String(tp.day).padStart(2, '0');
    }
    if (freq === 'weekly') {
      const dow = Number(cfg.dow); // 0=Sun
      if (Number.isFinite(dow) && dow !== tp.dow) return null;
      // ISO-ish week key
      return 'W' + tp.y + '-' + tp.m + '-' + Math.ceil(tp.day / 7) + '-' + tp.dow;
    }
    if (freq === 'monthly') {
      const dom = Number(cfg.dom) || 1;
      if (dom !== tp.day) return null;
      return 'M' + tp.y + '-' + String(tp.m).padStart(2, '0');
    }
    return null;
  }
  async function fetchScheduleAudience(audience) {
    // audience: { type:'all' } 或 { type:'list', list_id }
    if (audience && audience.type === 'list' && audience.list_id) {
      const rs = await query(
        `SELECT u.id AS user_id, m.line_user_id FROM admin_recipient_list_members m
         LEFT JOIN users u ON u.line_user_id = m.line_user_id
         WHERE m.list_id = $1 AND m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''`,
        [Number(audience.list_id)]
      );
      return rs.rows;
    }
    // 預設全好友
    const rs = await query(
      `SELECT id AS user_id, line_user_id FROM users
       WHERE line_user_id IS NOT NULL AND BTRIM(line_user_id) <> '' AND is_admin = false`
    );
    return rs.rows;
  }
  async function runScheduleTriggers(now = new Date()) {
    const flows = await getActiveFlowsByTrigger('schedule');
    let enrolled = 0;
    for (const f of flows) {
      const periodKey = schedulePeriodKeyIfDue(f.trigger_config, now);
      if (!periodKey) continue;
      // 防重複（同一週期只觸發一次）
      const ins = await query(
        `INSERT INTO admin_flow_schedule_runs (flow_id, period_key) VALUES ($1, $2)
         ON CONFLICT (flow_id, period_key) DO NOTHING RETURNING id`,
        [f.id, periodKey]
      );
      if (ins.rowCount === 0) continue; // 已跑過
      const audience = (f.trigger_config && f.trigger_config.audience) || { type: 'all' };
      const rows = await fetchScheduleAudience(audience);
      let cnt = 0;
      for (const r of rows) {
        const out = await enrollUser(f, r.line_user_id, { userId: r.user_id, context: { trigger: 'schedule', period: periodKey } });
        if (out.enrolled) cnt++;
      }
      await query(`UPDATE admin_flow_schedule_runs SET enrolled_count = $2 WHERE flow_id = $1 AND period_key = $3`, [f.id, cnt, periodKey]);
      enrolled += cnt;
    }
    return enrolled;
  }

  // ---------- 靜音時段（21:00-08:00 台北不發行銷；第一則歡迎不受限） ----------
  function nextRunIfQuiet(now) {
    const s = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour12: false });
    const tpe = new Date(s);
    const h = tpe.getHours();
    if (h >= 8 && h < 21) return null;
    const target = new Date(tpe);
    if (h < 8) target.setHours(8, 0, 0, 0);
    else { target.setDate(target.getDate() + 1); target.setHours(8, 0, 0, 0); }
    const waitMs = target.getTime() - tpe.getTime();
    return new Date(now.getTime() + Math.max(0, waitMs));
  }

  // ---------- 公開網域（給點擊追蹤中轉網址用） ----------
  function getOrigin() {
    const o = process.env.LINE_PUSH_PUBLIC_BASE_URL || process.env.URL || process.env.PUBLIC_SITE_URL || '';
    return String(o).replace(/\/+$/, '');
  }
  // 走訪 Flex tree，把 action.uri === fromUrl 的換成 toUrl（點擊追蹤）
  function wrapCtaUri(node, fromUrl, toUrl) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => wrapCtaUri(n, fromUrl, toUrl)); return; }
    if (node.action && node.action.type === 'uri' && node.action.uri === fromUrl) {
      node.action.uri = toUrl;
    }
    Object.keys(node).forEach(k => { const v = node[k]; if (v && typeof v === 'object') wrapCtaUri(v, fromUrl, toUrl); });
  }

  // ---------- 加入名單 ----------
  async function addUserToList(listId, lineUserId, userId) {
    if (!listId || !lineUserId) return;
    await query(
      `INSERT INTO admin_recipient_list_members (list_id, line_user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [listId, lineUserId]
    );
    await query(
      `UPDATE admin_recipient_lists
       SET total = (SELECT COUNT(*) FROM admin_recipient_list_members WHERE list_id = $1), updated_at = now()
       WHERE id = $1`,
      [listId]
    );
  }

  // ---------- 發訊息 ----------
  async function sendMessage(lineUserId, userId, messageId, opts = {}) {
    if (!messageId) return false;
    const rs = await query(`SELECT message_config FROM admin_message_templates WHERE id = $1`, [messageId]);
    if (rs.rowCount === 0) return false;
    const cfg = rs.rows[0].message_config;
    const built = buildLineMessages(cfg);
    if (!built.ok) return false;
    // 點擊追蹤：template 模式有 CTA 連結時，把連結換成 /rf/:enrollmentId/:messageId 中轉
    const origin = getOrigin();
    if (opts.enrollmentId && origin && cfg && cfg.mode === 'template' && cfg.template && cfg.template.ctaUrl) {
      const trackUrl = origin + '/rf/' + opts.enrollmentId + '/' + messageId;
      wrapCtaUri(built.messages, cfg.template.ctaUrl, trackUrl);
    }
    return await linePush.pushLineMessages(lineUserId, built.messages, { userId, pushType: 'flow' });
  }

  function waitMs(cfg) {
    const amount = Math.max(0, Number(cfg && cfg.amount) || 0);
    const unit = (cfg && cfg.unit) || 'days';
    const mult = unit === 'minutes' ? 60e3 : unit === 'hours' ? 3600e3 : 86400e3;
    return amount * mult;
  }

  async function evalBranch(config, en, lastSentAt) {
    const cond = (config && config.condition) || {};
    const refTime = lastSentAt || en.last_message_sent_at || en.enrolled_at;
    const refIso = new Date(refTime).toISOString();
    if (cond.type === 'event') {
      if (!cond.event_name) return false;
      const rs = await query(
        `SELECT 1 FROM user_events WHERE line_id = $1 AND event_name = $2 AND created_at >= $3 LIMIT 1`,
        [en.line_user_id, cond.event_name, refIso]
      );
      return rs.rowCount > 0;
    }
    if (cond.type === 'played') {
      let sql = `SELECT 1 FROM activity_plays WHERE line_user_id = $1 AND played_at >= $2`;
      const params = [en.line_user_id, refIso];
      if (cond.activity_id) { sql += ` AND activity_id = $3`; params.push(Number(cond.activity_id)); }
      const rs = await query(sql + ' LIMIT 1', params);
      return rs.rowCount > 0;
    }
    if (cond.type === 'clicked') {
      // 點了上一則訊息的連結（自上次發送之後）
      const rs = await query(
        `SELECT 1 FROM admin_flow_clicks WHERE enrollment_id = $1 AND clicked_at >= $2 LIMIT 1`,
        [en.id, refIso]
      );
      return rs.rowCount > 0;
    }
    return false;
  }

  // ---------- 處理單一 enrollment ----------
  async function processEnrollment(en) {
    try {
      let nodeKey = en.current_node_key;
      let lastMsgId = en.last_message_id;
      let lastSentAt = en.last_message_sent_at;
      let steps = 0;
      while (nodeKey && steps < MAX_STEPS_PER_TICK) {
        steps++;
        const node = await getNode(en.flow_id, nodeKey);
        if (!node || node.type === 'end') {
          return finish(en.id, 'done', lastMsgId, lastSentAt);
        }
        if (node.type === 'send') {
          const isFirstSend = !lastSentAt;
          if (!isFirstSend) {
            const quietUntil = nextRunIfQuiet(new Date());
            if (quietUntil) {
              await query(
                `UPDATE admin_flow_enrollments SET current_node_key = $2, next_run_at = $3,
                        last_message_id = $4, last_message_sent_at = $5, updated_at = now() WHERE id = $1`,
                [en.id, nodeKey, quietUntil.toISOString(), lastMsgId, lastSentAt]
              );
              return;
            }
          }
          const msgId = node.config && node.config.message_id;
          await sendMessage(en.line_user_id, en.user_id, msgId, { enrollmentId: en.id });
          lastMsgId = msgId || lastMsgId;
          lastSentAt = new Date();
          nodeKey = node.next_key || null;
          continue;
        }
        if (node.type === 'add_to_list') {
          const listId = node.config && Number(node.config.list_id);
          if (listId) {
            try { await addUserToList(listId, en.line_user_id, en.user_id); }
            catch (e) { console.error('flow add_to_list failed:', e.message); }
          }
          nodeKey = node.next_key || null;
          continue;
        }
        if (node.type === 'wait') {
          const nextAt = new Date(Date.now() + waitMs(node.config));
          await query(
            `UPDATE admin_flow_enrollments SET current_node_key = $2, next_run_at = $3,
                    last_message_id = $4, last_message_sent_at = $5, updated_at = now() WHERE id = $1`,
            [en.id, node.next_key || null, nextAt.toISOString(), lastMsgId, lastSentAt]
          );
          return;
        }
        if (node.type === 'branch') {
          const yes = await evalBranch(node.config, en, lastSentAt);
          nodeKey = yes ? node.branch_true_key : node.branch_false_key;
          continue;
        }
        return finish(en.id, 'done', lastMsgId, lastSentAt);
      }
      if (!nodeKey) return finish(en.id, 'done', lastMsgId, lastSentAt);
      // 步數上限：存進度，下個 tick 繼續
      await query(
        `UPDATE admin_flow_enrollments SET current_node_key = $2, next_run_at = now(),
                last_message_id = $3, last_message_sent_at = $4, updated_at = now() WHERE id = $1`,
        [en.id, nodeKey, lastMsgId, lastSentAt]
      );
    } catch (err) {
      console.error('flow processEnrollment error:', err && err.message);
      await query(
        `UPDATE admin_flow_enrollments SET status = 'failed', context = context || $2::jsonb, updated_at = now() WHERE id = $1`,
        [en.id, JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })]
      ).catch(() => {});
    }
  }

  async function finish(id, status, lastMsgId, lastSentAt) {
    await query(
      `UPDATE admin_flow_enrollments SET status = $2, last_message_id = $3, last_message_sent_at = $4, updated_at = now() WHERE id = $1`,
      [id, status, lastMsgId || null, lastSentAt || null]
    );
  }

  // ---------- 推進到期的 enrollment（claim + 處理） ----------
  async function advanceDue({ limit = 100 } = {}) {
    const client = await pool.connect();
    let claimed = [];
    try {
      await client.query('BEGIN');
      const rs = await client.query(
        `UPDATE admin_flow_enrollments
         SET next_run_at = now() + interval '10 minutes', updated_at = now()
         WHERE id IN (
           SELECT id FROM admin_flow_enrollments
           WHERE status = 'active' AND next_run_at <= now()
           ORDER BY next_run_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [limit]
      );
      await client.query('COMMIT');
      claimed = rs.rows;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
      throw e;
    }
    client.release();
    for (const en of claimed) await processEnrollment(en);
    return { processed: claimed.length };
  }

  // ---------- cron 主入口 ----------
  async function run() {
    const result = { scheduleEnrolled: 0, eventEnrolled: 0, advanced: 0 };
    try { result.scheduleEnrolled = await runScheduleTriggers(); } catch (e) { console.error('schedule trig err', e.message); }
    try {
      let ev = 0;
      ev += await runEventTriggers();
      ev += await runGamePlayTriggers();
      ev += await runBroadcastClickTriggers();
      ev += await runRestaurantClickTriggers();
      result.eventEnrolled = ev;
    } catch (e) { console.error('event trig err', e.message); }
    try { const a = await advanceDue({ limit: 100 }); result.advanced = a.processed; } catch (e) { console.error('advance err', e.message); }
    return result;
  }

  return {
    enrollUser,
    triggerFollow,
    triggerListJoin,
    runEventTriggers,
    runGamePlayTriggers,
    runBroadcastClickTriggers,
    runRestaurantClickTriggers,
    runScheduleTriggers,
    advanceDue,
    run,
    // 給測試/手動用
    _processEnrollment: processEnrollment
  };
}

module.exports = { createFlowEngine };
