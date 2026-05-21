/**
 * LIFF 數據分析後台路由
 *
 * 目前只接「Random Rice / 今天吃什麼」一個 LIFF。未來新增其他 LIFF 時，
 * 可在同一個 menu 下增加子路徑（e.g. /admin/liff/xxx），共用 user_events 表
 * 透過 properties 區分 LIFF 來源即可。
 *
 * 資料源：CRM 同個 Supabase 的 user_events 表（schema 對齊 Random Rice repo 的
 * ANALYTICS_INTEGRATION.md）。Random Rice 那邊把 SUPABASE_URL 指過來即可共用。
 *
 * 提供：
 * - GET /admin/liff/random-rice                       dashboard 頁面
 * - GET /admin/liff/random-rice/api/overview         今日 4 指標
 * - GET /admin/liff/random-rice/api/funnel?days=N    核心 4 步漏斗（含流失率）
 * - GET /admin/liff/random-rice/api/trend?days=N     每日趨勢（DAU、submit_draw、restaurant_click、轉換率）
 */

function registerAdminLiffAnalyticsRoutes(app, deps) {
  const { query, authCore } = deps;
  const { requireAdmin } = authCore;

  // ------------------------------------------------------------------
  // dashboard 頁面
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice', requireAdmin, (req, res) => {
    return res.render('admin_liff_analytics', {
      title: 'LIFF 數據分析 — 今天吃什麼',
      bodyClass: 'admin-shell liff-analytics-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 主選單導引：/admin/liff 沒設子路徑時 → redirect 到 random-rice
  app.get('/admin/liff', requireAdmin, (_req, res) => {
    return res.redirect('/admin/liff/random-rice');
  });

  // ------------------------------------------------------------------
  // API 1: 今日即時概覽 — 4 指標
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/overview', requireAdmin, async (_req, res) => {
    try {
      const sql = `
        WITH today AS (
          SELECT *
          FROM user_events
          WHERE created_at >= date_trunc('day', NOW())
        )
        SELECT
          (SELECT COUNT(DISTINCT line_id) FROM today
             WHERE event_name = 'app_open' AND line_id IS NOT NULL) AS dau,
          (SELECT COUNT(*) FROM today
             WHERE event_name IN ('submit_draw', 'redraw')) AS total_draws,
          (SELECT COUNT(*) FROM today
             WHERE event_name = 'restaurant_click') AS restaurant_clicks,
          (SELECT COUNT(*) FROM today
             WHERE event_name = 'result_shown') AS result_shown,
          (SELECT COUNT(*) FROM today
             WHERE event_name = 'submit_draw') AS submit_draw,
          (SELECT COUNT(*) FROM today
             WHERE event_name = 'app_open') AS app_open
      `;
      const { rows } = await query(sql);
      const r = rows[0] || {};
      const resultShown = Number(r.result_shown || 0);
      const restaurantClicks = Number(r.restaurant_clicks || 0);
      const conversionRate = resultShown > 0
        ? Math.round((restaurantClicks / resultShown) * 10000) / 100
        : 0;
      res.json({
        ok: true,
        data: {
          dau: Number(r.dau || 0),
          total_draws: Number(r.total_draws || 0),
          restaurant_clicks: restaurantClicks,
          conversion_rate_pct: conversionRate,
          // 細目（給 tooltip 用）
          app_open: Number(r.app_open || 0),
          submit_draw: Number(r.submit_draw || 0),
          result_shown: resultShown
        }
      });
    } catch (err) {
      console.error('liff overview error:', err && err.message);
      res.status(500).json({ ok: false, error: 'overview_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // API 2: 核心轉換漏斗 — app_open → submit_draw → result_shown → restaurant_click
  // 預設過去 7 天
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/funnel', requireAdmin, async (req, res) => {
    try {
      const days = clampInt(req.query.days, 1, 90, 7);
      const sql = `
        SELECT
          COUNT(*) FILTER (WHERE event_name = 'app_open') AS app_open,
          COUNT(*) FILTER (WHERE event_name = 'submit_draw') AS submit_draw,
          COUNT(*) FILTER (WHERE event_name = 'result_shown') AS result_shown,
          COUNT(*) FILTER (WHERE event_name = 'restaurant_click') AS restaurant_click
        FROM user_events
        WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      `;
      const { rows } = await query(sql, [String(days)]);
      const r = rows[0] || {};
      const steps = [
        { key: 'app_open',         label: '打開 LIFF',       count: Number(r.app_open || 0) },
        { key: 'submit_draw',      label: '首次抽選',         count: Number(r.submit_draw || 0) },
        { key: 'result_shown',     label: '看到結果',         count: Number(r.result_shown || 0) },
        { key: 'restaurant_click', label: '點訂位（轉換）',   count: Number(r.restaurant_click || 0) }
      ];
      const first = steps[0].count;
      steps.forEach((step, i) => {
        // drop_pct = 跟上一步比的流失率
        if (i === 0) {
          step.from_prev_pct = null;
          step.from_first_pct = 100;
        } else {
          const prev = steps[i - 1].count;
          step.from_prev_pct = prev > 0
            ? Math.round((step.count / prev) * 10000) / 100
            : 0;
          step.from_first_pct = first > 0
            ? Math.round((step.count / first) * 10000) / 100
            : 0;
        }
      });
      res.json({ ok: true, days, data: steps });
    } catch (err) {
      console.error('liff funnel error:', err && err.message);
      res.status(500).json({ ok: false, error: 'funnel_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ------------------------------------------------------------------
  // API 3: 每日趨勢 — DAU / 總抽次 / 點訂位 / 轉換率
  // ------------------------------------------------------------------
  app.get('/admin/liff/random-rice/api/trend', requireAdmin, async (req, res) => {
    try {
      const days = clampInt(req.query.days, 1, 90, 30);
      const sql = `
        WITH d AS (
          SELECT generate_series(
            (date_trunc('day', NOW()) - ($1 - 1 || ' days')::INTERVAL)::date,
            date_trunc('day', NOW())::date,
            '1 day'::INTERVAL
          )::date AS day
        ),
        ev AS (
          SELECT
            date_trunc('day', created_at)::date AS day,
            line_id,
            event_name
          FROM user_events
          WHERE created_at >= date_trunc('day', NOW()) - ($1 - 1 || ' days')::INTERVAL
        )
        SELECT
          d.day,
          COUNT(DISTINCT ev.line_id) FILTER (WHERE ev.event_name = 'app_open' AND ev.line_id IS NOT NULL) AS dau,
          COUNT(*) FILTER (WHERE ev.event_name IN ('submit_draw', 'redraw')) AS draws,
          COUNT(*) FILTER (WHERE ev.event_name = 'restaurant_click') AS clicks,
          COUNT(*) FILTER (WHERE ev.event_name = 'result_shown') AS shown
        FROM d
        LEFT JOIN ev ON ev.day = d.day
        GROUP BY d.day
        ORDER BY d.day
      `;
      const { rows } = await query(sql, [days]);
      const data = rows.map(r => {
        const shown = Number(r.shown || 0);
        const clicks = Number(r.clicks || 0);
        return {
          day: formatYmd(r.day),
          dau: Number(r.dau || 0),
          draws: Number(r.draws || 0),
          clicks,
          conversion_rate_pct: shown > 0
            ? Math.round((clicks / shown) * 10000) / 100
            : 0
        };
      });
      res.json({ ok: true, days, data });
    } catch (err) {
      console.error('liff trend error:', err && err.message);
      res.status(500).json({ ok: false, error: 'trend_failed', detail: String(err.message || '').slice(0, 300) });
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

function formatYmd(d) {
  if (!d) return '';
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  // pg 回 string 形態 e.g. "2026-05-21"
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

module.exports = { registerAdminLiffAnalyticsRoutes };
