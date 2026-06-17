/**
 * 優惠券核銷閉環 — 後台管理 + 店員核銷頁
 *
 * 共用 schema（統一建表）：
 *   coupon_codes(id, activity_id, prize_id, code, status, claimed_play_id,
 *                claimed_line_user_id, claimed_at, redeemed_at, redeemed_by,
 *                source, created_at)
 *     狀態：available → claimed → redeemed；void 作廢
 *   只有 prize_type='coupon_code' 的獎品會從碼池領碼；碼池綁 (activity_id, prize_id)。
 *
 * 後台（requireAdmin）：
 *   GET  /admin/coupons                       管理頁（上傳碼池 + 統計）
 *   GET  /admin/coupons/api/activities        列出有 coupon_code 獎品的活動 + 該活動獎品
 *   POST /admin/coupons/api/upload-chunk      分塊上傳碼池（ON CONFLICT DO NOTHING）
 *   GET  /admin/coupons/api/stats             各活動/獎品碼池狀態（COUNT FILTER）
 *
 * 店員核銷（不走 admin 登入，獨立密碼 env REDEEM_PASSWORD）：
 *   GET  /redeem                              核銷頁
 *   POST /redeem/api/lookup                   查詢序號（驗密碼）
 *   POST /redeem/api/redeem                   核銷（驗密碼，狀態機防呆）
 */

function registerAdminCouponsRoutes(app, deps) {
  const { query, pool, authCore } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }

  // ============================================================
  // 後台：優惠券管理
  // ============================================================
  app.get('/admin/coupons', requireAdmin, (req, res) => {
    res.render('admin_coupons', {
      title: '優惠券',
      bodyClass: 'admin-shell coupons-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 列出「有 coupon_code 獎品」的活動，連帶各活動的 coupon_code 獎品清單。
  // 給上傳頁的兩段式下拉（先選活動、再選獎品）用。
  app.get('/admin/coupons/api/activities', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT p.activity_id, a.name AS activity_name,
                p.id AS prize_id, p.name AS prize_name
           FROM activity_prizes p
           JOIN activities a ON a.id = p.activity_id
          WHERE p.prize_type = 'coupon_code'
          ORDER BY a.created_at DESC, p.position ASC, p.id ASC
          LIMIT 2000`
      );
      // 收斂成 [{ activity_id, activity_name, prizes:[{prize_id, prize_name}] }]
      const byActivity = new Map();
      for (const r of rows) {
        if (!byActivity.has(r.activity_id)) {
          byActivity.set(r.activity_id, {
            activity_id: r.activity_id,
            activity_name: r.activity_name,
            prizes: []
          });
        }
        byActivity.get(r.activity_id).prizes.push({
          prize_id: r.prize_id,
          prize_name: r.prize_name
        });
      }
      return res.json({ ok: true, activities: Array.from(byActivity.values()) });
    } catch (err) {
      console.error('coupons activities error:', err && err.message);
      return jsonErr(res, 500, 'list_failed', { detail: String(err.message || '').slice(0, 300) });
    }
  });

  // 分塊上傳碼池：一次最多 1000 筆，沿用 RFM 分塊 pattern。
  // INSERT ... ON CONFLICT (activity_id, code) DO NOTHING（重複碼自動跳過）。
  app.post('/admin/coupons/api/upload-chunk', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const activityId = Number(body.activity_id);
      const prizeId = Number(body.prize_id);
      if (!Number.isFinite(activityId)) return jsonErr(res, 400, 'invalid_activity');
      if (!Number.isFinite(prizeId)) return jsonErr(res, 400, 'invalid_prize');

      const source = String(body.source || '').trim().slice(0, 200) || null;
      const codes = Array.isArray(body.codes) ? body.codes : [];
      if (codes.length === 0) return jsonErr(res, 400, 'no_codes');
      if (codes.length > 1000) return jsonErr(res, 400, 'chunk_too_large', { detail: '單批最多 1000 筆' });

      // 驗證該獎品確實屬於該活動且為 coupon_code（避免把碼灌到不對的池）
      const { rows: prizeRows } = await query(
        `SELECT 1 FROM activity_prizes
          WHERE id = $1 AND activity_id = $2 AND prize_type = 'coupon_code'
          LIMIT 1`,
        [prizeId, activityId]
      );
      if (prizeRows.length === 0) {
        return jsonErr(res, 400, 'prize_not_coupon', {
          detail: '這個獎品不是優惠券類型，或不屬於所選活動。'
        });
      }

      const values = [];
      const params = [];
      let n = 0;
      const seen = new Set(); // 同一批內也去重，避免 ON CONFLICT 因批內重複報錯
      for (const raw of codes) {
        const code = String(raw == null ? '' : raw).trim().slice(0, 200);
        if (!code) continue;
        if (seen.has(code)) continue;
        seen.add(code);
        const base = n * 4;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
        params.push(activityId, prizeId, code, source);
        n++;
      }
      if (n === 0) return jsonErr(res, 400, 'no_valid_codes');

      const { rows: insRows } = await query(
        `INSERT INTO coupon_codes (activity_id, prize_id, code, source)
         VALUES ${values.join(',')}
         ON CONFLICT (activity_id, code) DO NOTHING
         RETURNING id`,
        params
      );
      const inserted = insRows.length;
      return res.json({ ok: true, received: n, inserted, skipped: n - inserted });
    } catch (err) {
      console.error('coupons upload-chunk error:', err && err.message);
      return jsonErr(res, 500, 'upload_failed', { detail: String(err.message || '').slice(0, 300) });
    }
  });

  // 統計：每個活動/獎品的碼池狀態（總數 / available / claimed / redeemed / void）
  app.get('/admin/coupons/api/stats', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.activity_id, a.name AS activity_name,
                c.prize_id, p.name AS prize_name,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE c.status = 'available')::int AS available,
                COUNT(*) FILTER (WHERE c.status = 'claimed')::int   AS claimed,
                COUNT(*) FILTER (WHERE c.status = 'redeemed')::int  AS redeemed,
                COUNT(*) FILTER (WHERE c.status = 'void')::int      AS voided
           FROM coupon_codes c
           JOIN activities a ON a.id = c.activity_id
           LEFT JOIN activity_prizes p ON p.id = c.prize_id
          GROUP BY c.activity_id, a.name, c.prize_id, p.name, a.created_at
          ORDER BY a.created_at DESC, c.prize_id ASC
          LIMIT 500`
      );
      return res.json({ ok: true, pools: rows });
    } catch (err) {
      console.error('coupons stats error:', err && err.message);
      return jsonErr(res, 500, 'stats_failed', { detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ============================================================
  // 店員核銷頁（獨立密碼，不走 admin 登入）
  // ============================================================
  //
  // 安全：
  //  - 密碼比對 process.env.REDEEM_PASSWORD；未設定則拒絕一切操作並提示管理員設定。
  //  - 失敗限流（記憶體計數，serverless 容器內有效；給友善提示，不洩漏細節）。
  //  - 不可列舉序號：查詢一律帶完整序號精準比對（WHERE code=$1），只回單筆結果。
  //  - 回應一律不夾帶其他序號 / line_user_id 等敏感欄位。

  function redeemPasswordConfigured() {
    return typeof process.env.REDEEM_PASSWORD === 'string' && process.env.REDEEM_PASSWORD.length > 0;
  }

  // 簡易失敗限流：以「來源 IP」為 key，記憶體滑動窗。serverless 單容器內生效，
  // 不求完美（無常駐 / 多容器），只擋同一容器的暴力嘗試並給友善提示。
  const failWindowMs = 5 * 60 * 1000; // 5 分鐘
  const failMax = 8;                  // 視窗內最多 8 次密碼錯誤
  const failMap = new Map();          // ip -> { count, resetAt }

  function clientKey(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
    return (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown');
  }
  function isLocked(req) {
    const k = clientKey(req);
    const rec = failMap.get(k);
    if (!rec) return false;
    if (Date.now() > rec.resetAt) { failMap.delete(k); return false; }
    return rec.count >= failMax;
  }
  function noteFail(req) {
    const k = clientKey(req);
    const now = Date.now();
    const rec = failMap.get(k);
    if (!rec || now > rec.resetAt) {
      failMap.set(k, { count: 1, resetAt: now + failWindowMs });
    } else {
      rec.count += 1;
    }
  }
  function clearFail(req) {
    failMap.delete(clientKey(req));
  }

  function checkPassword(req, res) {
    if (!redeemPasswordConfigured()) {
      jsonErr(res, 503, 'not_configured', {
        message: '尚未設定核銷密碼，請管理員設定 REDEEM_PASSWORD。'
      });
      return false;
    }
    if (isLocked(req)) {
      jsonErr(res, 429, 'too_many_attempts', {
        message: '嘗試次數過多，請稍後幾分鐘再試。'
      });
      return false;
    }
    const pw = String((req.body && req.body.password) || '');
    if (pw !== process.env.REDEEM_PASSWORD) {
      noteFail(req);
      jsonErr(res, 401, 'bad_password', { message: '核銷密碼錯誤，請再確認。' });
      return false;
    }
    clearFail(req);
    return true;
  }

  // 把核銷狀態翻成店員看得懂的訊息（不講機制）
  function tsLabel(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const pad = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_e) { return ''; }
  }

  // 核銷頁
  app.get('/redeem', (_req, res) => {
    res.render('redeem', {
      title: '優惠券核銷',
      configured: redeemPasswordConfigured()
    });
  });

  // 查詢序號（驗密碼）→ 回單筆狀態
  app.post('/redeem/api/lookup', async (req, res) => {
    if (!checkPassword(req, res)) return;
    try {
      const code = String((req.body && req.body.code) || '').trim().slice(0, 200);
      if (!code) return jsonErr(res, 400, 'no_code', { message: '請輸入優惠序號。' });

      const { rows } = await query(
        `SELECT c.code, c.status, c.redeemed_at,
                a.name AS activity_name,
                p.name AS prize_name
           FROM coupon_codes c
           JOIN activities a ON a.id = c.activity_id
           LEFT JOIN activity_prizes p ON p.id = c.prize_id
          WHERE c.code = $1
          LIMIT 1`,
        [code]
      );
      if (rows.length === 0) {
        return res.json({ ok: true, found: false, message: '找不到此序號。' });
      }
      const r = rows[0];
      const out = {
        ok: true,
        found: true,
        code: r.code,
        status: r.status,
        activity_name: r.activity_name || '',
        prize_name: r.prize_name || '優惠券',
        redeemable: r.status === 'claimed'
      };
      if (r.status === 'claimed') {
        out.message = '可核銷';
      } else if (r.status === 'redeemed') {
        out.message = '此序號已於 ' + tsLabel(r.redeemed_at) + ' 核銷過。';
      } else if (r.status === 'available') {
        out.message = '此序號尚未發出。';
      } else if (r.status === 'void') {
        out.message = '此序號已作廢。';
      } else {
        out.message = '此序號目前無法核銷。';
      }
      return res.json(out);
    } catch (err) {
      console.error('redeem lookup error:', err && err.message);
      return jsonErr(res, 500, 'lookup_failed', { message: '查詢失敗，請稍後再試。' });
    }
  });

  // 核銷（驗密碼，狀態機防呆 + 防重複）
  app.post('/redeem/api/redeem', async (req, res) => {
    if (!checkPassword(req, res)) return;
    const code = String((req.body && req.body.code) || '').trim().slice(0, 200);
    if (!code) return jsonErr(res, 400, 'no_code', { message: '請輸入優惠序號。' });

    const by = String((req.body && req.body.by) || 'redeem').trim().slice(0, 100) || 'redeem';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 原子核銷：只有 claimed 能轉 redeemed（防重複核銷）
      const { rows } = await client.query(
        `UPDATE coupon_codes
            SET status='redeemed', redeemed_at=now(), redeemed_by=$2
          WHERE code=$1 AND status='claimed'
          RETURNING claimed_play_id, prize_id, activity_id`,
        [code, by]
      );
      if (rows.length > 0) {
        const playId = rows[0].claimed_play_id;
        if (playId != null) {
          await client.query(
            `UPDATE activity_plays
                SET is_redeemed=true, redeemed_at=now()
              WHERE id=$1`,
            [playId]
          );
        }
        // 撈獎品名給成功畫面（同交易內，確保一致）
        const { rows: pr } = await client.query(
          `SELECT p.name AS prize_name, a.name AS activity_name
             FROM activities a
             LEFT JOIN activity_prizes p ON p.id = $2
            WHERE a.id = $1
            LIMIT 1`,
          [rows[0].activity_id, rows[0].prize_id]
        );
        await client.query('COMMIT');
        const prizeName = (pr[0] && pr[0].prize_name) || '優惠券';
        return res.json({
          ok: true,
          redeemed: true,
          prize_name: prizeName,
          activity_name: (pr[0] && pr[0].activity_name) || ''
        });
      }

      // 沒更新到：查現況回對應的防呆訊息（同交易讀，避免狀態漂移）
      await client.query('ROLLBACK');
      const { rows: cur } = await query(
        `SELECT status, redeemed_at FROM coupon_codes WHERE code=$1 LIMIT 1`,
        [code]
      );
      if (cur.length === 0) {
        return res.json({ ok: true, redeemed: false, reason: 'not_found', message: '找不到此序號。' });
      }
      const st = cur[0].status;
      if (st === 'redeemed') {
        return res.json({
          ok: true, redeemed: false, reason: 'already_redeemed',
          message: '此序號已於 ' + tsLabel(cur[0].redeemed_at) + ' 核銷過。'
        });
      }
      if (st === 'available') {
        return res.json({ ok: true, redeemed: false, reason: 'not_claimed', message: '此序號尚未發出。' });
      }
      if (st === 'void') {
        return res.json({ ok: true, redeemed: false, reason: 'void', message: '此序號已作廢。' });
      }
      return res.json({ ok: true, redeemed: false, reason: 'not_redeemable', message: '此序號目前無法核銷。' });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) {}
      console.error('redeem error:', err && err.message);
      return jsonErr(res, 500, 'redeem_failed', { message: '核銷失敗，請稍後再試。' });
    } finally {
      client.release();
    }
  });
}

module.exports = { registerAdminCouponsRoutes };
