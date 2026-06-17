/**
 * 群發訊息「收件人條件」查詢 builder
 *
 * 條件結構（JSON）：
 * {
 *   prizeFilter: {
 *     mode: 'any' | 'all' | 'none',     // 中過任一 / 中過全部 / 從未中過這些獎
 *     prizeNames: string[]               // 用 prize_name 字串比對（與 draw_logs 一致）
 *   } | null,
 *   inviteCompletedMin: number | null,  // 邀請成功 rewarded 數 ≥ N
 *   drewInCampaign: boolean | null      // true = 活動期間刮過; false = 從未刮過
 * }
 *
 * 共用過濾：line_user_id 非空、非管理員。
 */

const MAX_RECIPIENTS_PER_BROADCAST = 5000;
const PREVIEW_SAMPLE_LIMIT = 10;

// 生命週期階段門檻（天）— 與 flowEngine.runInactivityTriggers 的 last_activity 口徑一致。
const LIFECYCLE_NEW_DAYS = 14;       // 新客：加入 <= 14 天（優先判定）
const LIFECYCLE_ACTIVE_DAYS = 30;    // 活躍：last_activity <= 30 天（且非新客）
const LIFECYCLE_LOST_DAYS = 90;      // 流失：last_activity > 90 天；沉睡 = 30~90 天
const LIFECYCLE_STAGES = ['new', 'active', 'sleeping', 'lost'];

// 可重用的 last_activity SQL 片段（子查詢，以 u 為 alias）。
// 口徑：GREATEST(加好友時間, 各互動表最後時間) — 與 flowEngine 完全相同。
const LAST_ACTIVITY_SQL = `GREATEST(
  u.created_at,
  (SELECT MAX(w.event_timestamp) FROM line_webhook_events w WHERE w.line_user_id = u.line_user_id),
  (SELECT MAX(p.played_at) FROM activity_plays p WHERE p.line_user_id = u.line_user_id),
  (SELECT MAX(b.clicked_at) FROM admin_broadcast_clicks b WHERE b.line_user_id = u.line_user_id),
  (SELECT MAX(rc.clicked_at) FROM user_restaurant_clicks rc WHERE rc.line_user_id = u.line_user_id),
  (SELECT MAX(ue.created_at) FROM user_events ue WHERE ue.line_id = u.line_user_id)
)`;

// 階段判定 SQL（回傳 'new' | 'active' | 'sleeping' | 'lost'），給 profile 查詢與篩選共用。
// 以 u 為 alias、需可取得 u.created_at。
const LIFECYCLE_STAGE_SQL = `CASE
  WHEN u.created_at >= now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day') THEN 'new'
  WHEN ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_ACTIVE_DAYS} * interval '1 day') THEN 'active'
  WHEN ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_LOST_DAYS} * interval '1 day') THEN 'sleeping'
  ELSE 'lost'
END`;

// 產生「某用戶屬於指定階段集合」的 WHERE 片段（不含參數，門檻是常數）。
// stages：已驗證過的階段字串陣列（new/active/sleeping/lost）。
function lifecycleWhereSql(stages) {
  const clauses = [];
  if (stages.includes('new')) {
    clauses.push(`u.created_at >= now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')`);
  }
  if (stages.includes('active')) {
    clauses.push(`(u.created_at < now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_ACTIVE_DAYS} * interval '1 day'))`);
  }
  if (stages.includes('sleeping')) {
    clauses.push(`(u.created_at < now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} < now() - (${LIFECYCLE_ACTIVE_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} >= now() - (${LIFECYCLE_LOST_DAYS} * interval '1 day'))`);
  }
  if (stages.includes('lost')) {
    clauses.push(`(u.created_at < now() - (${LIFECYCLE_NEW_DAYS} * interval '1 day')
      AND ${LAST_ACTIVITY_SQL} < now() - (${LIFECYCLE_LOST_DAYS} * interval '1 day'))`);
  }
  if (clauses.length === 0) return null;
  return '(' + clauses.join(' OR ') + ')';
}

function normalizeConditions(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const out = {
    allMembers: false,
    joinedWithinDays: null,
    lifecycleStages: null,
    prizeFilter: null,
    inviteCompletedMin: null,
    drewInCampaign: null,
    savedListId: null
  };

  if (safe.allMembers === true || safe.allMembers === 'true') {
    out.allMembers = true;
  }

  // 生命週期階段（多選）：接受陣列或單一字串，過濾成合法集合
  if (safe.lifecycleStages != null) {
    const rawStages = Array.isArray(safe.lifecycleStages)
      ? safe.lifecycleStages
      : [safe.lifecycleStages];
    const stages = [...new Set(
      rawStages.map(s => String(s || '').trim().toLowerCase()).filter(s => LIFECYCLE_STAGES.includes(s))
    )];
    // 全選 4 個 = 等同不限，不套用條件
    if (stages.length > 0 && stages.length < LIFECYCLE_STAGES.length) {
      out.lifecycleStages = stages;
    }
  }

  const jwd = Number(safe.joinedWithinDays);
  if (Number.isInteger(jwd) && jwd > 0 && jwd <= 3650) {
    out.joinedWithinDays = jwd;
  }

  if (safe.prizeFilter && typeof safe.prizeFilter === 'object') {
    const mode = ['any', 'all', 'none'].includes(safe.prizeFilter.mode) ? safe.prizeFilter.mode : 'any';
    const prizeNames = Array.isArray(safe.prizeFilter.prizeNames)
      ? [...new Set(safe.prizeFilter.prizeNames.map(n => String(n || '').trim()).filter(Boolean))]
      : [];
    if (prizeNames.length > 0) {
      out.prizeFilter = { mode, prizeNames };
    }
  }

  const n = Number(safe.inviteCompletedMin);
  if (Number.isInteger(n) && n > 0 && n <= 1000) {
    out.inviteCompletedMin = n;
  }

  if (safe.drewInCampaign === true || safe.drewInCampaign === false) {
    out.drewInCampaign = safe.drewInCampaign;
  }

  const listId = Number(safe.savedListId);
  if (Number.isInteger(listId) && listId > 0) {
    out.savedListId = listId;
  }

  return out;
}

function hasAnyCondition(conds) {
  return Boolean(
    conds.allMembers ||
    conds.joinedWithinDays !== null ||
    conds.lifecycleStages ||
    conds.savedListId ||
    conds.prizeFilter ||
    conds.inviteCompletedMin !== null ||
    conds.drewInCampaign !== null
  );
}

function buildWhere(conds) {
  const params = [];
  const where = [
    'u.line_user_id IS NOT NULL',
    "BTRIM(u.line_user_id) <> ''",
    "u.is_admin = false",
    'u.blocked_at IS NULL'
  ];

  // allMembers = 全部會員（不套用其他行為條件，但加入時間仍可疊加）
  if (conds.joinedWithinDays !== null) {
    params.push(conds.joinedWithinDays);
    where.push(`u.created_at >= now() - ($${params.length}::int * interval '1 day')`);
  }
  // allMembers 為 true 時，跳過後面的行為條件（生命週期/prize/invite/drew）
  if (conds.allMembers) {
    return { whereSql: where.join(' AND '), params };
  }

  if (conds.lifecycleStages) {
    const lcSql = lifecycleWhereSql(conds.lifecycleStages);
    if (lcSql) where.push(lcSql);
  }

  if (conds.prizeFilter) {
    params.push(conds.prizeFilter.prizeNames);
    const p = `$${params.length}::text[]`;
    if (conds.prizeFilter.mode === 'any') {
      where.push(`EXISTS (
        SELECT 1 FROM draw_logs d
        WHERE d.user_id = u.id AND d.is_win = true AND d.prize_name = ANY(${p})
      )`);
    } else if (conds.prizeFilter.mode === 'all') {
      where.push(`(
        SELECT COUNT(DISTINCT d.prize_name) FROM draw_logs d
        WHERE d.user_id = u.id AND d.is_win = true AND d.prize_name = ANY(${p})
      ) = ${conds.prizeFilter.prizeNames.length}`);
    } else if (conds.prizeFilter.mode === 'none') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM draw_logs d
        WHERE d.user_id = u.id AND d.is_win = true AND d.prize_name = ANY(${p})
      )`);
    }
  }

  if (conds.inviteCompletedMin !== null) {
    params.push(conds.inviteCompletedMin);
    where.push(`(
      SELECT COUNT(*) FROM line_invites li
      WHERE li.inviter_user_id = u.id AND li.status = 'rewarded'
    ) >= $${params.length}`);
  }

  if (conds.drewInCampaign === true) {
    where.push(`EXISTS (SELECT 1 FROM draw_logs d WHERE d.user_id = u.id)`);
  } else if (conds.drewInCampaign === false) {
    where.push(`NOT EXISTS (SELECT 1 FROM draw_logs d WHERE d.user_id = u.id)`);
  }

  return { whereSql: where.join(' AND '), params };
}

async function previewAudience(query, rawConditions, { channel = 'line' } = {}) {
  const conds = normalizeConditions(rawConditions);
  // channel=email 時：條件式 audience 不適用（users 表沒 email），只能用 savedListId
  if (channel === 'email') {
    if (!conds.savedListId) {
      return { total: 0, sample: [], conditions: conds, error: 'Email 通道請選一份名單（需含 email 欄位）。' };
    }
    const UNSUB = `AND NOT EXISTS (SELECT 1 FROM admin_email_unsubscribes ue WHERE LOWER(ue.email) = LOWER(BTRIM(m.email)))`;
    const total = await query(
      `SELECT COUNT(*)::int AS n FROM admin_recipient_list_members m
       WHERE m.list_id = $1 AND m.email IS NOT NULL AND BTRIM(m.email) <> '' ${UNSUB}`,
      [conds.savedListId]
    );
    const sampleRs = await query(
      `SELECT m.id, m.email, m.display_name
       FROM admin_recipient_list_members m
       WHERE m.list_id = $1 AND m.email IS NOT NULL AND BTRIM(m.email) <> '' ${UNSUB}
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, PREVIEW_SAMPLE_LIMIT]
    );
    return {
      total: Number(total.rows[0]?.n || 0),
      sample: sampleRs.rows,
      conditions: conds,
      error: null
    };
  }
  if (!hasAnyCondition(conds)) {
    return { total: 0, sample: [], conditions: conds, error: '請至少選一個條件或選擇一份名單。' };
  }
  // 來源：已儲存名單
  if (conds.savedListId) {
    // LINE 通道：只算有 line_user_id 的成員（email-only 成員不能用 LINE 發），並排除已封鎖
    const LINE_FILTER = `AND m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> '' AND (u.blocked_at IS NULL OR u.id IS NULL)`;
    const total = await query(
      `SELECT COUNT(*)::int AS n FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 ${LINE_FILTER}`,
      [conds.savedListId]
    );
    const sampleRs = await query(
      `SELECT m.id, m.line_user_id, u.line_display_name, u.username
       FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 ${LINE_FILTER}
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, PREVIEW_SAMPLE_LIMIT]
    );
    return {
      total: Number(total.rows[0]?.n || 0),
      sample: sampleRs.rows,
      conditions: conds,
      error: null
    };
  }
  // 來源：條件篩選
  const { whereSql, params } = buildWhere(conds);
  const countSql = `SELECT COUNT(DISTINCT u.id) AS total FROM users u WHERE ${whereSql}`;
  const sampleParams = params.slice();
  sampleParams.push(PREVIEW_SAMPLE_LIMIT);
  const sampleSql = `
    SELECT u.id, u.line_user_id, u.line_display_name, u.username
    FROM users u
    WHERE ${whereSql}
    ORDER BY u.id ASC
    LIMIT $${sampleParams.length}
  `;
  const [c, s] = await Promise.all([query(countSql, params), query(sampleSql, sampleParams)]);
  return {
    total: Number(c.rows[0]?.total || 0),
    sample: s.rows,
    conditions: conds,
    error: null
  };
}

async function fetchAudienceRecipients(query, rawConditions, { limit = MAX_RECIPIENTS_PER_BROADCAST, channel = 'line' } = {}) {
  const conds = normalizeConditions(rawConditions);
  const cappedLimit = Math.min(Math.max(1, Number(limit) || MAX_RECIPIENTS_PER_BROADCAST), MAX_RECIPIENTS_PER_BROADCAST);
  // channel=email：只能從 list 拿 email
  if (channel === 'email') {
    if (!conds.savedListId) return { conditions: conds, rows: [] };
    const rs = await query(
      `SELECT u.id AS user_id, m.line_user_id, m.email, m.display_name
       FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 AND m.email IS NOT NULL AND BTRIM(m.email) <> ''
         AND NOT EXISTS (SELECT 1 FROM admin_email_unsubscribes ue WHERE LOWER(ue.email) = LOWER(BTRIM(m.email)))
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, cappedLimit]
    );
    return { conditions: conds, rows: rs.rows };
  }
  if (!hasAnyCondition(conds)) return { conditions: conds, rows: [] };
  // 來源：已儲存名單
  if (conds.savedListId) {
    // LINE 通道：只送有 line_user_id 的成員、排除已封鎖（與預覽一致，避免灌水+漏發）
    const rs = await query(
      `SELECT u.id AS user_id, m.line_user_id
       FROM admin_recipient_list_members m
       LEFT JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.list_id = $1 AND m.line_user_id IS NOT NULL AND BTRIM(m.line_user_id) <> ''
         AND (u.blocked_at IS NULL OR u.id IS NULL)
       ORDER BY m.id ASC
       LIMIT $2`,
      [conds.savedListId, cappedLimit]
    );
    return { conditions: conds, rows: rs.rows };
  }
  // 來源：條件篩選
  const { whereSql, params } = buildWhere(conds);
  params.push(cappedLimit);
  const sql = `
    SELECT u.id AS user_id, u.line_user_id
    FROM users u
    WHERE ${whereSql}
    ORDER BY u.id ASC
    LIMIT $${params.length}
  `;
  const rs = await query(sql, params);
  return { conditions: conds, rows: rs.rows };
}

module.exports = {
  MAX_RECIPIENTS_PER_BROADCAST,
  PREVIEW_SAMPLE_LIMIT,
  LIFECYCLE_STAGES,
  LIFECYCLE_NEW_DAYS,
  LIFECYCLE_ACTIVE_DAYS,
  LIFECYCLE_LOST_DAYS,
  LAST_ACTIVITY_SQL,
  LIFECYCLE_STAGE_SQL,
  lifecycleWhereSql,
  normalizeConditions,
  hasAnyCondition,
  previewAudience,
  fetchAudienceRecipients
};
