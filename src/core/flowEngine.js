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
 *   inactivity 沉睡喚醒      { days, batch_limit }（超過 N 天沒任何互動）
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
    // 原子去重：靠 partial unique index (flow_id, line_user_id) WHERE status='active'
    // 防止並發 follow/webhook 重送造成同一用戶重複 active 報名（→ 重複推播）
    // 原子去重（partial unique index: (flow_id,line_user_id) WHERE status='active'）。
    // 對所有流程：同一用戶同時最多一筆 active。re_enroll=true 的「重複進入」語意 =
    // 「上一輪跑完(done/ended)後可再次進入」，而非「同時並行多份」——這也是合理的設計，
    // 且與唯一索引相容（移除 ON CONFLICT 會在重入時直接撞唯一鍵報錯）。
    const ins = await query(
      `INSERT INTO admin_flow_enrollments (flow_id, line_user_id, user_id, current_node_key, status, next_run_at, context)
       VALUES ($1, $2, $3, $4, 'active', now(), $5::jsonb)
       ON CONFLICT (flow_id, line_user_id) WHERE status = 'active' DO NOTHING
       RETURNING id`,
      [flow.id, luid, opts.userId || null, entry.node_key, JSON.stringify(opts.context || {})]
    );
    if (ins.rowCount === 0) return { enrolled: false, reason: 'already_active' };
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
  // trigger_config.cuisine（可選）：有設時只在點擊的餐廳於 restaurant_catalog 標了該種類才觸發。
  // 用 LEFT JOIN 算 cuisine_match：cursor 仍依「掃過的所有點擊」前進，
  // 避免一直沒有符合種類的點擊時 cursor 停滯、每輪重掃同一批資料。
  async function runRestaurantClickTriggers() {
    const flows = await getActiveFlowsByTrigger('restaurant_click');
    let enrolled = 0;
    for (const f of flows) {
      const cuisine = String((f.trigger_config && f.trigger_config.cuisine) || '').trim();
      const cursor = await getCursor(f.id, `SELECT COALESCE(MAX(id),0)::bigint AS m FROM user_restaurant_clicks`);
      const params = [cursor];
      let sql = `SELECT id, line_user_id, restaurant_query, poi_id FROM user_restaurant_clicks
         WHERE id > $1 AND line_user_id IS NOT NULL AND BTRIM(line_user_id) <> ''
         ORDER BY id ASC LIMIT 500`;
      if (cuisine) {
        params.push(cuisine);
        sql = `SELECT c.id, c.line_user_id, c.restaurant_query, c.poi_id, (rc.cuisine = $2) AS cuisine_match
           FROM user_restaurant_clicks c
           LEFT JOIN restaurant_catalog rc
             ON COALESCE(c.poi_id, lower(btrim(c.restaurant_query))) = rc.ref_key
           WHERE c.id > $1 AND c.line_user_id IS NOT NULL AND BTRIM(c.line_user_id) <> ''
           ORDER BY c.id ASC LIMIT 500`;
      }
      const rs = await query(sql, params);
      let maxId = cursor;
      for (const row of rs.rows) {
        maxId = Math.max(maxId, Number(row.id));
        if (cuisine && row.cuisine_match !== true) continue;
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

  // inactivity：沉睡喚醒（超過 N 天沒有任何互動）
  // 沉睡定義：last_activity = GREATEST(加好友時間, 各互動表的最後時間) < now() - N 天。
  // 每輪每 flow 最多 enroll batch_limit 人（cron 每 5 分鐘會再跑，分批消化避免瞬間大量發送）。
  // 語義：SQL 已排除「曾進過此流程」的人 → 每人一生只會被喚醒一次（re_enroll 對此觸發無效，
  // 否則沉睡者跑完流程後仍然沉睡，每 5 分鐘會再進一次造成轟炸）。
  async function runInactivityTriggers() {
    const flows = await getActiveFlowsByTrigger('inactivity');
    let enrolled = 0;
    for (const f of flows) {
      const cfg = f.trigger_config || {};
      const days = Math.round(Number(cfg.days));
      if (!Number.isFinite(days) || days < 1) continue; // 沒設天數不跑，避免誤灌全部好友
      const blRaw = Math.round(Number(cfg.batch_limit));
      const batchLimit = Number.isFinite(blRaw) && blRaw > 0 ? Math.min(500, blRaw) : 50;
      const rs = await query(
        `SELECT u.id AS user_id, u.line_user_id
         FROM users u
         LEFT JOIN LATERAL (
           SELECT GREATEST(
             u.created_at,
             (SELECT MAX(w.event_timestamp) FROM line_webhook_events w WHERE w.line_user_id = u.line_user_id),
             (SELECT MAX(p.played_at) FROM activity_plays p WHERE p.line_user_id = u.line_user_id),
             (SELECT MAX(b.clicked_at) FROM admin_broadcast_clicks b WHERE b.line_user_id = u.line_user_id),
             (SELECT MAX(rc.clicked_at) FROM user_restaurant_clicks rc WHERE rc.line_user_id = u.line_user_id),
             (SELECT MAX(ue.created_at) FROM user_events ue WHERE ue.line_id = u.line_user_id)
           ) AS last_activity
         ) la ON true
         WHERE u.line_user_id IS NOT NULL AND BTRIM(u.line_user_id) <> ''
           AND u.is_admin = false AND u.blocked_at IS NULL
           AND la.last_activity IS NOT NULL
           AND la.last_activity < now() - make_interval(days => $2)
           AND NOT EXISTS (
             SELECT 1 FROM admin_flow_enrollments e
             WHERE e.flow_id = $1 AND e.line_user_id = u.line_user_id
           )
         ORDER BY la.last_activity ASC
         LIMIT $3`,
        [f.id, days, batchLimit]
      );
      for (const row of rs.rows) {
        const r = await enrollUser(f, row.line_user_id, { userId: row.user_id, context: { trigger: 'inactivity', days } });
        if (r.enrolled) enrolled++;
      }
    }
    return enrolled;
  }

  // ---------- 觸發：streak_risk（連勝守護：連續玩了 N 天、今天還沒玩 → 晚間提醒） ----------
  // config: { min_streak 預設 2, batch_limit 預設 50, hour_start 預設 19, hour_end 預設 21 }
  // 只在台北時間 [hour_start, hour_end) 之間 enroll（讓提醒落在晚上）；每人每天最多進一次。
  // 注意：這類流程建議 re_enroll=true（完成後隔天可再進）；同日去重由本查詢的 enrolled_at 條件把關。
  async function runStreakRiskTriggers() {
    const flows = await getActiveFlowsByTrigger('streak_risk');
    if (flows.length === 0) return 0;
    const tp = taipeiParts(new Date());
    let enrolled = 0;
    for (const f of flows) {
      const cfg = f.trigger_config || {};
      const minStreakRaw = Math.round(Number(cfg.min_streak));
      const minStreak = Number.isFinite(minStreakRaw) && minStreakRaw >= 2 ? Math.min(30, minStreakRaw) : 2;
      const hourStart = Number.isFinite(Number(cfg.hour_start)) ? Math.min(23, Math.max(0, Math.round(Number(cfg.hour_start)))) : 19;
      const hourEnd = Number.isFinite(Number(cfg.hour_end)) ? Math.min(24, Math.max(1, Math.round(Number(cfg.hour_end)))) : 21;
      if (tp.hour < hourStart || tp.hour >= hourEnd) continue;
      const blRaw = Math.round(Number(cfg.batch_limit));
      const batchLimit = Number.isFinite(blRaw) && blRaw > 0 ? Math.min(500, blRaw) : 50;
      // 連續 minStreak 天（截至昨天）每天都有玩 + 今天還沒玩 + 今天還沒被本流程 enroll 過
      const rs = await query(
        `WITH tz AS (SELECT (now() AT TIME ZONE 'Asia/Taipei')::date AS today)
         SELECT u.id AS user_id, u.line_user_id
         FROM users u, tz
         WHERE u.line_user_id IS NOT NULL AND BTRIM(u.line_user_id) <> ''
           AND u.is_admin = false AND u.blocked_at IS NULL
           AND (
             SELECT COUNT(DISTINCT (p.played_at AT TIME ZONE 'Asia/Taipei')::date)
             FROM activity_plays p
             WHERE p.line_user_id = u.line_user_id
               AND (p.played_at AT TIME ZONE 'Asia/Taipei')::date >= tz.today - $2::int
               AND (p.played_at AT TIME ZONE 'Asia/Taipei')::date <= tz.today - 1
           ) = $2::int
           AND NOT EXISTS (
             SELECT 1 FROM activity_plays p2
             WHERE p2.line_user_id = u.line_user_id
               AND (p2.played_at AT TIME ZONE 'Asia/Taipei')::date = tz.today
           )
           AND NOT EXISTS (
             SELECT 1 FROM admin_flow_enrollments e
             WHERE e.flow_id = $1 AND e.line_user_id = u.line_user_id
               AND (e.enrolled_at AT TIME ZONE 'Asia/Taipei')::date = tz.today
           )
         LIMIT $3`,
        [f.id, minStreak, batchLimit]
      );
      for (const row of rs.rows) {
        const r = await enrollUser(f, row.line_user_id, { userId: row.user_id, context: { trigger: 'streak_risk', min_streak: minStreak } });
        if (r.enrolled) enrolled++;
      }
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
      // 把 dom 夾到當月實際天數：dom=31 在 2 月會落在 28/29，否則整月不觸發
      const daysInMonth = new Date(tp.y, tp.m, 0).getDate();
      const dom = Math.min(Math.max(Number(cfg.dom) || 1, 1), daysInMonth);
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
         WHERE m.list_id = $1 AND m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
           AND (u.blocked_at IS NULL OR u.id IS NULL)`,
        [Number(audience.list_id)]
      );
      return rs.rows;
    }
    // 預設全好友（排除已封鎖）
    const rs = await query(
      `SELECT id AS user_id, line_user_id FROM users
       WHERE line_user_id IS NOT NULL AND BTRIM(line_user_id) <> '' AND is_admin = false AND blocked_at IS NULL`
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
    if (node.action && node.action.type === 'uri' && String(node.action.uri).trim() === String(fromUrl).trim()) {
      node.action.uri = toUrl;
    }
    Object.keys(node).forEach(k => { const v = node[k]; if (v && typeof v === 'object') wrapCtaUri(v, fromUrl, toUrl); });
  }

  // ---------- 加入名單 ----------
  async function addUserToList(listId, lineUserId, userId) {
    if (!listId || !lineUserId) return;
    const ins = await query(
      `INSERT INTO admin_recipient_list_members (list_id, line_user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING
       RETURNING line_user_id`,
      [listId, lineUserId]
    );
    await query(
      `UPDATE admin_recipient_lists
       SET total = (SELECT COUNT(*) FROM admin_recipient_list_members WHERE list_id = $1), updated_at = now()
       WHERE id = $1`,
      [listId]
    );
    // 只在「真正新加入」時觸發 list_join，對齊手動加名單的行為（鏈式自動化）
    if (ins.rowCount > 0) {
      try { await triggerListJoin(Number(listId), lineUserId, userId || null); }
      catch (e) { console.error('flow add_to_list -> triggerListJoin failed:', e.message); }
    }
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
    // 冪等鍵：同一 enrollment 的同一節點重跑時，LINE 端去重，避免崩潰/逾時後重發
    const retryKey = opts.enrollmentId ? `flow-${opts.enrollmentId}-${opts.nodeKey || messageId}` : undefined;
    return await linePush.pushLineMessages(lineUserId, built.messages, { userId, pushType: 'flow', retryKey });
  }

  function waitMs(cfg) {
    const amount = Math.max(0, Number(cfg && cfg.amount) || 0);
    const unit = (cfg && cfg.unit) || 'days';
    const mult = unit === 'minutes' ? 60e3 : unit === 'hours' ? 3600e3 : 86400e3;
    return amount * mult;
  }

  async function evalBranch(config, en, lastSentAt) {
    const cond = (config && config.condition) || {};
    // 只有「真的送過訊息」才用時間下限（判斷「發訊息後有沒有互動」）。
    // 若 branch 是入口節點（還沒送過任何訊息），played/event 改查「是否曾經做過」，
    // 否則時間窗退化成 enrolled_at，yes 分支幾乎永遠走不到。
    const sentAt = lastSentAt || en.last_message_sent_at;
    const hasPriorSend = !!sentAt;
    const refIso = new Date(sentAt || en.enrolled_at).toISOString();
    if (cond.type === 'event') {
      if (!cond.event_name) return false;
      let sql = `SELECT 1 FROM user_events WHERE line_id = $1 AND event_name = $2`;
      const params = [en.line_user_id, cond.event_name];
      if (hasPriorSend) { params.push(refIso); sql += ` AND created_at >= $${params.length}`; }
      const rs = await query(sql + ' LIMIT 1', params);
      return rs.rowCount > 0;
    }
    if (cond.type === 'played') {
      let sql = `SELECT 1 FROM activity_plays WHERE line_user_id = $1`;
      const params = [en.line_user_id];
      if (hasPriorSend) { params.push(refIso); sql += ` AND played_at >= $${params.length}`; }
      if (cond.activity_id) { params.push(Number(cond.activity_id)); sql += ` AND activity_id = $${params.length}`; }
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
          await sendMessage(en.line_user_id, en.user_id, msgId, { enrollmentId: en.id, nodeKey: node.node_key });
          lastMsgId = msgId || lastMsgId;
          lastSentAt = new Date();
          nodeKey = node.next_key || null;
          // 送出後立即落地進度，避免崩潰/逾時後從本 send 重跑（重發已送訊息）
          await query(
            `UPDATE admin_flow_enrollments SET current_node_key = $2, last_message_id = $3,
                    last_message_sent_at = $4, updated_at = now() WHERE id = $1`,
            [en.id, nodeKey, lastMsgId, lastSentAt.toISOString()]
          ).catch(e => console.error('flow send progress persist failed:', e.message));
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
           SELECT e.id FROM admin_flow_enrollments e
           JOIN admin_flows f ON f.id = e.flow_id
           WHERE e.status = 'active' AND e.next_run_at <= now() AND f.status = 'active'
           ORDER BY e.next_run_at ASC LIMIT $1 FOR UPDATE OF e SKIP LOCKED
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
      ev += await runInactivityTriggers();
      ev += await runStreakRiskTriggers();
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
    runInactivityTriggers,
    runStreakRiskTriggers,
    runScheduleTriggers,
    advanceDue,
    run,
    // 給測試/手動用
    _processEnrollment: processEnrollment
  };
}

module.exports = { createFlowEngine };
