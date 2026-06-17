/**
 * 轉換歸因後台路由 — /admin/attribution「發訊息帶來什麼」
 *
 * 給 GM 看「哪一則群發真的帶動了行為」。分兩區：
 *
 * 1) 系統內歸因（現在就有數據，主體）
 *    近 N 則群發批次，每列顯示：
 *      送達數（admin_broadcasts.recipient_ok）
 *      點擊數 / 點擊率（admin_broadcast_clicks）
 *      「點擊後 N 天內又有行為的人數」= 點過連結的人之後又玩了活動遊戲（activity_plays）
 *
 *    重要：admin_broadcast_clicks 只有「逐人追蹤連結」(/r/b/:broadcastId/:recipientId)
 *    的點擊才會帶 line_user_id；舊版 /r/b/:broadcastId 連結的點擊 line_user_id 為 NULL。
 *    因此「點擊人數」「後續再互動人數」只能就「有帶 line_user_id 的點擊」計算，
 *    頁面上會誠實標示這點，避免 GM 誤判。
 *
 * 2) 訂位歸因（待橋接，誠實標示）
 *    line_user_id ↔ 訂位目前交集≈0（多數訂位走 Google Reserve、Rice Dollar 橋未建），
 *    所以這區只顯示說明卡，不硬接 bd_reports 跑出誤導數字。
 *
 * 提供：
 * - GET /admin/attribution                          頁面
 * - GET /admin/attribution/api/system?limit=N&days=D  系統內歸因表格資料
 *
 * 防 10s timeout：限制最近 20-30 則批次（limit 最多 30），查詢都加 LIMIT。
 */

function registerAdminAttributionRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  // ------------------------------------------------------------------
  // 頁面
  // ------------------------------------------------------------------
  app.get('/admin/attribution', requireAdmin, (req, res) => {
    // 訂位歸因是否已可計算：BOOKING_REPORT_DATABASE_URL 有設才有可能（目前橋未建仍顯示說明卡）
    const bookingBridgeConfigured = !!(process.env.BOOKING_REPORT_DATABASE_URL || '').trim();
    return res.render('admin_attribution', {
      title: '轉換歸因 — 發訊息帶來什麼',
      bodyClass: 'admin-shell attribution-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      bookingBridgeConfigured
    });
  });

  // ------------------------------------------------------------------
  // API: 系統內歸因表格
  // 每則群發：送達 / 點擊次 / 可歸因點擊人 / 點擊率 / 後續再互動人數
  // ------------------------------------------------------------------
  app.get('/admin/attribution/api/system', requireAdmin, async (req, res) => {
    try {
      const limit = clampInt(req.query.limit, 1, 30, 20);
      const days = clampInt(req.query.days, 1, 30, 7);

      // 一次查詢：先取最近 N 則「已送出/有送達」的群發，再左接點擊與後續行為彙總。
      //
      // - sent：recipient_ok（實際送達 LINE 的人數）
      // - clicks_total：該批次所有點擊次數（含匿名舊連結）
      // - clickers：有帶 line_user_id 的「可歸因」點擊人數（distinct）
      // - reengaged：上述可歸因點擊人之中，在「該人首次點擊後 N 天內」又玩過活動遊戲的人數
      //
      // 後續行為定義先採「又玩遊戲（activity_plays）」最單純可靠；
      // 點擊本身已是互動、加名單無時間戳難精準，故此版以遊玩為準（頁面已標示）。
      const sql = `
        WITH recent AS (
          SELECT id, created_at, status, channel,
                 recipient_total, recipient_ok, message_config
          FROM admin_broadcasts
          WHERE status IN ('sent', 'sending', 'done', 'completed', 'partial')
             OR recipient_ok > 0
          ORDER BY id DESC
          LIMIT $1
        ),
        clicks AS (
          SELECT broadcast_id,
                 COUNT(*)::int AS clicks_total,
                 COUNT(DISTINCT line_user_id) FILTER (WHERE line_user_id IS NOT NULL)::int AS clickers
          FROM admin_broadcast_clicks
          WHERE broadcast_id IN (SELECT id FROM recent)
          GROUP BY broadcast_id
        ),
        first_click AS (
          -- 每人在該批次的「首次點擊時間」（只看有 line_user_id 的）
          SELECT broadcast_id, line_user_id, MIN(clicked_at) AS first_clicked_at
          FROM admin_broadcast_clicks
          WHERE broadcast_id IN (SELECT id FROM recent)
            AND line_user_id IS NOT NULL
          GROUP BY broadcast_id, line_user_id
        ),
        reengaged AS (
          -- 首次點擊後 N 天內又玩過活動遊戲的人（distinct）
          SELECT fc.broadcast_id,
                 COUNT(DISTINCT fc.line_user_id)::int AS reengaged
          FROM first_click fc
          WHERE EXISTS (
            SELECT 1 FROM activity_plays pl
            WHERE pl.line_user_id = fc.line_user_id
              AND pl.played_at >  fc.first_clicked_at
              AND pl.played_at <= fc.first_clicked_at + ($2 || ' days')::interval
          )
          GROUP BY fc.broadcast_id
        )
        SELECT r.id, r.created_at, r.status, r.channel,
               r.recipient_total, r.recipient_ok, r.message_config,
               COALESCE(c.clicks_total, 0) AS clicks_total,
               COALESCE(c.clickers, 0)     AS clickers,
               COALESCE(re.reengaged, 0)   AS reengaged
        FROM recent r
        LEFT JOIN clicks c   ON c.broadcast_id = r.id
        LEFT JOIN reengaged re ON re.broadcast_id = r.id
        ORDER BY r.id DESC
      `;
      const { rows } = await query(sql, [limit, String(days)]);

      const data = rows.map(r => {
        const sent = Number(r.recipient_ok || 0);
        const clicksTotal = Number(r.clicks_total || 0);
        const clickers = Number(r.clickers || 0);
        const reengaged = Number(r.reengaged || 0);
        // 點擊率：可歸因點擊人 / 送達人（人本位，較貼近「多少人被打動」）
        const clickRatePct = sent > 0
          ? Math.round((clickers / sent) * 10000) / 100
          : 0;
        // 再互動率：後續再互動人 / 可歸因點擊人
        const reengageRatePct = clickers > 0
          ? Math.round((reengaged / clickers) * 10000) / 100
          : 0;
        return {
          id: Number(r.id),
          created_at: r.created_at,
          status: r.status,
          channel: r.channel === 'email' ? 'email' : 'line',
          label: buildBroadcastLabel(r.message_config),
          recipient_total: Number(r.recipient_total || 0),
          sent,
          clicks_total: clicksTotal,
          clickers,
          click_rate_pct: clickRatePct,
          reengaged,
          reengage_rate_pct: reengageRatePct
        };
      });

      res.json({ ok: true, days, limit, count: data.length, data });
    } catch (err) {
      console.error('attribution system error:', err && err.message);
      res.status(500).json({ ok: false, error: 'system_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------
function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * 從 message_config 生一個給人看的批次標題：
 * 優先 template.title → template.altText → 依模式給 fallback。
 */
function buildBroadcastLabel(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const t = c.template && typeof c.template === 'object' ? c.template : {};
  const title = typeof t.title === 'string' ? t.title.trim() : '';
  if (title) return clip(title, 60);
  const alt = typeof t.altText === 'string' ? t.altText.trim() : '';
  if (alt) return clip(alt, 60);
  const sub = typeof t.subtitle === 'string' ? t.subtitle.trim() : '';
  if (sub) return clip(sub, 60);
  if (c.mode === 'flex_json') return '自訂 Flex 訊息';
  return '未命名訊息';
}

function clip(s, max) {
  const str = String(s || '');
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

module.exports = { registerAdminAttributionRoutes };
