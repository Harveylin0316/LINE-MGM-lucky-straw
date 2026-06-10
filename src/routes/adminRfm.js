/**
 * RFM 資料層（身分解析 + 資料增益）
 *  - 上傳外部 RFM 名單（分塊 upsert），隨 OA 好友/email 成長自動對應
 *  - M = 餐廳客單價推算的「預估價位帶」，非真實消費金額
 *
 *   GET  /admin/rfm                     頁面（上傳 + 統計）
 *   POST /admin/rfm/api/upload-chunk    分塊 upsert（by rfm_user_id）
 *   GET  /admin/rfm/api/stats           總量 / 對應數 / 觸及 / R 分布
 */
function registerAdminRfmRoutes(app, deps) {
  const { query, pool, authCore } = deps;
  const { requireAdmin } = authCore;

  function jsonErr(res, status, error, extra = {}) {
    return res.status(status).json({ ok: false, error, ...extra });
  }

  app.get('/admin/rfm', requireAdmin, (req, res) => {
    res.render('admin_rfm', {
      title: 'RFM 資料層',
      bodyClass: 'admin-shell rfm-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });

  // 分塊上傳：一次最多 1000 筆，upsert by rfm_user_id
  app.post('/admin/rfm/api/upload-chunk', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const source = String(body.source || '').trim().slice(0, 200) || null;
      const records = Array.isArray(body.records) ? body.records : [];
      if (records.length === 0) return jsonErr(res, 400, 'no_records');
      if (records.length > 1000) return jsonErr(res, 400, 'chunk_too_large', { detail: '單批最多 1000 筆' });

      const values = [];
      const params = [];
      let n = 0;
      for (const r of records) {
        const id = Number(r && r.userId);
        if (!Number.isFinite(id)) continue;
        const lineId = (r.lineId != null && String(r.lineId).trim()) ? String(r.lineId).trim() : null;
        const phone = (r.phone != null && String(r.phone).trim()) ? String(r.phone).trim().slice(0, 50) : null;
        const email = (r.email != null && String(r.email).trim()) ? String(r.email).trim().toLowerCase().slice(0, 200) : null;
        const recency = Number.isFinite(Number(r.recency)) ? Math.round(Number(r.recency)) : null;
        const frequency = Number.isFinite(Number(r.frequency)) ? Math.round(Number(r.frequency)) : null;
        const monetary = Number.isFinite(Number(r.monetary)) ? Number(r.monetary) : null;
        const base = n * 8;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
        params.push(id, lineId, phone, email, recency, frequency, monetary, source);
        n++;
      }
      if (n === 0) return jsonErr(res, 400, 'no_valid_records');

      await query(
        `INSERT INTO rfm_profiles (rfm_user_id, line_user_id, phone, email, recency, frequency, monetary_est, source)
         VALUES ${values.join(',')}
         ON CONFLICT (rfm_user_id) DO UPDATE SET
           line_user_id = COALESCE(EXCLUDED.line_user_id, rfm_profiles.line_user_id),
           phone = COALESCE(EXCLUDED.phone, rfm_profiles.phone),
           email = COALESCE(EXCLUDED.email, rfm_profiles.email),
           recency = EXCLUDED.recency,
           frequency = EXCLUDED.frequency,
           monetary_est = EXCLUDED.monetary_est,
           source = EXCLUDED.source,
           updated_at = now()`,
        params
      );
      return res.json({ ok: true, upserted: n });
    } catch (err) {
      console.error('rfm upload-chunk error:', err && err.message);
      return jsonErr(res, 500, 'upload_failed', { detail: err && err.message });
    }
  });

  app.get('/admin/rfm/api/stats', requireAdmin, async (req, res) => {
    try {
      const rs = await query(`
        SELECT
          (SELECT COUNT(*)::int FROM rfm_profiles) AS total,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE line_user_id IS NOT NULL AND line_user_id <> '') AS with_lineid,
          (SELECT COUNT(*)::int FROM rfm_profiles r WHERE EXISTS (
             SELECT 1 FROM users u WHERE u.line_user_id = r.line_user_id AND u.is_admin = false)) AS matched_oa_by_line,
          (SELECT COUNT(*)::int FROM rfm_profiles r WHERE r.email IS NOT NULL AND r.email <> '' AND EXISTS (
             SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(r.email) AND u.is_admin = false)) AS matched_oa_by_email,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE email IS NOT NULL AND email <> '') AS with_email,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE phone IS NOT NULL AND phone <> '') AS with_phone,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE recency <= 30) AS r_le30,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE recency > 30 AND recency <= 90) AS r_31_90,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE recency > 90 AND recency <= 365) AS r_91_365,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE recency > 365 AND recency <= 730) AS r_366_730,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE recency > 730) AS r_730plus,
          (SELECT COUNT(*)::int FROM rfm_profiles WHERE email IS NOT NULL AND email <> '' AND recency <= 365) AS email_recent365
      `);
      return res.json({ ok: true, stats: rs.rows[0] });
    } catch (err) {
      return jsonErr(res, 500, 'stats_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminRfmRoutes };
