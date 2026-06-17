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

  // ============================================================
  // RFM 分群 → 一鍵生成可發名單
  // ============================================================
  //
  // 「可發 N」口徑：只算對得到本 OA 的人（INNER JOIN users，is_admin=false 且未封鎖）。
  // 與 broadcastAudience.js 的 LINE_FILTER 口徑一致：
  //   u.line_user_id 有值 + 未被封鎖 (blocked_at IS NULL)。
  // 因為多數 RFM 名單對不到 lineId，這裡刻意只回「實際可發人數」，不回 RFM 總筆數，
  // 避免使用者以為整份名單都發得出去。

  // 預設分群定義（前端按鈕用同一份 key）
  const SEGMENT_PRESETS = {
    high_value:   { label: '高價值客',   recencyMax: 90,  frequencyMin: 3,  monetaryMin: null },
    dormant:      { label: '沉睡客',     recencyMin: 366, frequencyMin: null, monetaryMin: null },
    recent_active:{ label: '近期活躍客', recencyMax: 30,  frequencyMin: null, monetaryMin: null }
  };

  // 把 body / preset 正規化成 { recencyMin, recencyMax, frequencyMin, monetaryMin, label }
  function normalizeSegment(body) {
    const b = body && typeof body === 'object' ? body : {};
    let base = { recencyMin: null, recencyMax: null, frequencyMin: null, monetaryMin: null, label: '自訂分群' };
    const presetKey = typeof b.preset === 'string' ? b.preset : null;
    if (presetKey && SEGMENT_PRESETS[presetKey]) {
      const p = SEGMENT_PRESETS[presetKey];
      base = {
        recencyMin: p.recencyMin != null ? p.recencyMin : null,
        recencyMax: p.recencyMax != null ? p.recencyMax : null,
        frequencyMin: p.frequencyMin != null ? p.frequencyMin : null,
        monetaryMin: p.monetaryMin != null ? p.monetaryMin : null,
        label: p.label
      };
    }
    // 自訂條件可覆蓋 / 補充（數字才採用）
    const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    if (b.recency_min != null && b.recency_min !== '') base.recencyMin = toNum(b.recency_min);
    if (b.recency_max != null && b.recency_max !== '') base.recencyMax = toNum(b.recency_max);
    if (b.frequency_min != null && b.frequency_min !== '') base.frequencyMin = toNum(b.frequency_min);
    if (b.monetary_min != null && b.monetary_min !== '') base.monetaryMin = toNum(b.monetary_min);
    if (typeof b.label === 'string' && b.label.trim()) base.label = b.label.trim().slice(0, 80);
    return base;
}

  // 由分群條件組 WHERE：永遠 INNER JOIN users（口徑＝可發）
  //  回傳 { whereSql, params }，whereSql 以 r=rfm_profiles、u=users 為別名
  function buildSegmentWhere(seg) {
    const params = [];
    const where = [
      // 對得到本 OA、非管理員、未封鎖（與 broadcastAudience LINE_FILTER 同口徑）
      'u.is_admin = false',
      'u.blocked_at IS NULL',
      'u.line_user_id IS NOT NULL',
      "BTRIM(u.line_user_id) <> ''"
    ];
    if (seg.recencyMin != null) {
      params.push(seg.recencyMin);
      where.push(`r.recency >= $${params.length}`);
    }
    if (seg.recencyMax != null) {
      params.push(seg.recencyMax);
      where.push(`r.recency <= $${params.length}`);
    }
    if (seg.frequencyMin != null) {
      params.push(seg.frequencyMin);
      where.push(`r.frequency >= $${params.length}`);
    }
    if (seg.monetaryMin != null) {
      params.push(seg.monetaryMin);
      where.push(`r.monetary_est >= $${params.length}`);
    }
    return { whereSql: where.join(' AND '), params };
  }

  function segmentHasCondition(seg) {
    return seg.recencyMin != null || seg.recencyMax != null || seg.frequencyMin != null || seg.monetaryMin != null;
  }

  // 預覽：只回「實際可發 N 人」（去重 line_user_id），不建名單
  app.get('/admin/rfm/api/segment-preview', requireAdmin, async (req, res) => {
    try {
      const seg = normalizeSegment(req.query);
      if (!segmentHasCondition(seg)) {
        return jsonErr(res, 400, 'no_condition', { detail: '請至少給一個分群條件' });
      }
      const { whereSql, params } = buildSegmentWhere(seg);
      const rs = await query(
        `SELECT COUNT(DISTINCT u.line_user_id)::int AS sendable
         FROM rfm_profiles r
         JOIN users u ON u.line_user_id = r.line_user_id
         WHERE ${whereSql}`,
        params
      );
      return res.json({ ok: true, sendable: Number(rs.rows[0]?.sendable || 0), segment: seg });
    } catch (err) {
      console.error('rfm segment-preview error:', err && err.message);
      return jsonErr(res, 500, 'preview_failed', { detail: err && err.message });
    }
  });

  // 一鍵建名單：把可發的人寫成一份新的 admin_recipient_lists + 成員
  //   body: { preset?, recency_min?, recency_max?, frequency_min?, monetary_min?, name?, label? }
  app.post('/admin/rfm/api/segment-to-list', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const seg = normalizeSegment(body);
      if (!segmentHasCondition(seg)) {
        return jsonErr(res, 400, 'no_condition', { detail: '請至少給一個分群條件' });
      }
      const { whereSql, params } = buildSegmentWhere(seg);

      // 撈出可發的人（去重 line_user_id，順便帶 display_name），上限 5000（與名單庫一致）
      const MAX_LIST = 5000;
      const memberRs = await query(
        `SELECT DISTINCT ON (u.line_user_id)
                u.line_user_id,
                COALESCE(NULLIF(BTRIM(u.line_display_name), ''), u.username) AS display_name
         FROM rfm_profiles r
         JOIN users u ON u.line_user_id = r.line_user_id
         WHERE ${whereSql}
         ORDER BY u.line_user_id ASC
         LIMIT ${MAX_LIST + 1}`,
        params
      );
      const members = memberRs.rows;
      if (members.length === 0) {
        return jsonErr(res, 400, 'no_sendable', { detail: '這個分群目前沒有對得到本 OA 的人，建不出可發名單。' });
      }
      if (members.length > MAX_LIST) {
        return jsonErr(res, 400, 'too_many_recipients', {
          detail: `這個分群可發人數超過單一名單上限 ${MAX_LIST} 人，請縮小條件。`
        });
      }

      // 名單名稱：前端可傳 name，否則用「RFM-分群標籤-日期」
      const dateTag = new Date().toISOString().slice(0, 10);
      const rawName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `RFM-${seg.label}-${dateTag}`;
      const name = rawName.slice(0, 200);
      const description = `由 RFM 分群「${seg.label}」一鍵生成（只含對得到本 OA 的人）`.slice(0, 500);
      const createdBy = (req.authUser && (req.authUser.un || req.authUser.username)) || 'admin';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insListRs = await client.query(
          `INSERT INTO admin_recipient_lists (name, description, total, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, total, created_at`,
          [name, description, members.length, createdBy]
        );
        const listId = insListRs.rows[0].id;
        const BATCH = 500;
        for (let i = 0; i < members.length; i += BATCH) {
          const slice = members.slice(i, i + BATCH);
          const values = [];
          const insParams = [];
          slice.forEach((m, idx) => {
            const base = idx * 3;
            values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
            insParams.push(listId, m.line_user_id, m.display_name || null);
          });
          await client.query(
            `INSERT INTO admin_recipient_list_members (list_id, line_user_id, display_name)
             VALUES ${values.join(', ')}
             ON CONFLICT (list_id, line_user_id) DO NOTHING`,
            insParams
          );
        }
        // 以實際寫入筆數回填 total（去重後可能略低）
        const finalRs = await client.query(
          `UPDATE admin_recipient_lists
           SET total = (SELECT COUNT(*) FROM admin_recipient_list_members WHERE list_id = $1),
               updated_at = NOW()
           WHERE id = $1
           RETURNING total`,
          [listId]
        );
        await client.query('COMMIT');
        const finalTotal = Number(finalRs.rows[0]?.total || members.length);
        return res.json({
          ok: true,
          list_id: listId,
          list_name: name,
          inserted: finalTotal,
          segment: seg
        });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_e) {}
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('rfm segment-to-list error:', err && err.message);
      return jsonErr(res, 500, 'segment_to_list_failed', { detail: err && err.message });
    }
  });
}

module.exports = { registerAdminRfmRoutes };
