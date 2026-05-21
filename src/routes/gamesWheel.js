/**
 * 輪盤遊戲（公開 LIFF 頁）
 *
 *   GET  /games/wheel/:slug              render 輪盤頁（LIFF）
 *   GET  /api/games/wheel/:slug/meta     回活動 + 獎品列表（公開安全資料）
 *   POST /api/games/wheel/:slug/spin     抽一次 — 決定中獎、扣庫存、寫 activity_plays
 *
 * 認證：透過 LIFF SDK 拿 line_user_id，spin 時 POST 帶上；server 也驗 daily limit。
 */

function registerGamesWheelRoutes(app, deps) {
  const { query, pool } = deps;
  // 策略 C：預設用 GAMES_LIFF_ID（共用 Endpoint /games/）
  //   - WHEEL_LIFF_ID 為舊變數名稱 fallback，避免破壞既有部署
  //   - 個別 activity 可在 DB 用 liff_id_override 覆寫（少數特殊拉新活動用）
  const defaultLiffId =
    process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';

  // ----------------------------------------------------------------------
  // 頁面
  // ----------------------------------------------------------------------
  app.get('/games/wheel/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const { rows } = await query(
        `SELECT id, slug, name, description, game_type, status, start_at, end_at,
                cover_image_url, daily_plays_per_user, require_follow_oa, liff_id_override
         FROM activities WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      if (rows.length === 0 || rows[0].game_type !== 'wheel') {
        return res.status(404).send('活動不存在或類型不符');
      }
      const a = rows[0];
      // 活動可覆寫；無則用環境變數預設
      const effectiveLiffId = (a.liff_id_override && a.liff_id_override.trim()) || defaultLiffId;
      res.render('game_wheel', {
        title: a.name + ' — OpenRice LINE',
        bodyClass: 'liff-shell wheel-shell',
        activity: a,
        liffId: effectiveLiffId
      });
    } catch (err) {
      console.error('wheel page error:', err && err.message);
      res.status(500).send('Server error');
    }
  });

  // ----------------------------------------------------------------------
  // API: 取活動 meta + 獎品列表（給前端輪盤畫圖用）
  // ----------------------------------------------------------------------
  app.get('/api/games/wheel/:slug/meta', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const { rows: act } = await query(
        `SELECT id, slug, name, description, status, start_at, end_at,
                cover_image_url, daily_plays_per_user, require_follow_oa
         FROM activities WHERE slug = $1 AND game_type = 'wheel' LIMIT 1`,
        [slug]
      );
      if (act.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      const a = act[0];
      // public-safe prizes（不洩權重，但要洩 stock 剩餘 0 的標記）
      const { rows: prizes } = await query(
        `SELECT id, name, description, image_url, position, is_grand_prize,
                CASE WHEN stock_total IS NULL THEN false
                     ELSE stock_remaining <= 0 END AS sold_out
         FROM activity_prizes WHERE activity_id = $1
         ORDER BY position ASC, id ASC`,
        [a.id]
      );
      res.json({ ok: true, activity: a, prizes });
    } catch (err) {
      console.error('wheel meta error:', err && err.message);
      res.status(500).json({ ok: false, error: 'meta_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ----------------------------------------------------------------------
  // API: 抽一次（spin）
  // ----------------------------------------------------------------------
  app.post('/api/games/wheel/:slug/spin', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const lineUserId = String((req.body || {}).line_user_id || '').trim();
    const lineDisplayName = String((req.body || {}).line_display_name || '').trim() || null;

    if (!lineUserId) {
      return res.status(400).json({ ok: false, error: 'missing_line_user_id' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) 取活動 + 鎖獎品池（FOR UPDATE 防 race）
      const { rows: actRows } = await client.query(
        `SELECT id, status, start_at, end_at, daily_plays_per_user
         FROM activities WHERE slug = $1 AND game_type = 'wheel' LIMIT 1`,
        [slug]
      );
      if (actRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'activity_not_found' });
      }
      const a = actRows[0];
      if (a.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, error: 'activity_not_active', detail: '活動目前不可玩（草稿/暫停/已結束）' });
      }
      const now = new Date();
      if (a.start_at && now < new Date(a.start_at)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, error: 'activity_not_started', detail: '活動尚未開始' });
      }
      if (a.end_at && now > new Date(a.end_at)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, error: 'activity_ended', detail: '活動已結束' });
      }

      // 2) daily limit 檢查
      if (a.daily_plays_per_user != null) {
        const { rows: dCount } = await client.query(
          `SELECT COUNT(*) AS c FROM activity_plays
           WHERE activity_id = $1 AND line_user_id = $2
             AND played_at >= date_trunc('day', NOW())`,
          [a.id, lineUserId]
        );
        if (Number(dCount[0].c) >= a.daily_plays_per_user) {
          await client.query('ROLLBACK');
          return res.status(429).json({
            ok: false, error: 'daily_limit_reached',
            detail: '今天已達可玩次數上限（' + a.daily_plays_per_user + ' 次），明天再來。'
          });
        }
      }

      // 3) 取獎品池（鎖列）— 只取還有庫存的（stock_remaining > 0 或 stock_total IS NULL 無限）
      const { rows: prizes } = await client.query(
        `SELECT id, name, probability_weight, stock_total, stock_remaining,
                prize_type, prize_value, image_url, is_grand_prize, position
         FROM activity_prizes
         WHERE activity_id = $1
           AND (stock_total IS NULL OR stock_remaining > 0)
         ORDER BY position ASC, id ASC
         FOR UPDATE`,
        [a.id]
      );
      if (prizes.length === 0) {
        await client.query('ROLLBACK');
        return res.status(503).json({ ok: false, error: 'no_prize_available', detail: '所有獎品都已抽完，活動暫停發放。' });
      }

      // 4) 概率抽選（加權隨機）
      const totalWeight = prizes.reduce((s, p) => s + Number(p.probability_weight || 0), 0);
      if (totalWeight <= 0) {
        await client.query('ROLLBACK');
        return res.status(500).json({ ok: false, error: 'no_valid_weight', detail: '所有獎品權重為 0，無法抽選。' });
      }
      let pick = null;
      const r = Math.random() * totalWeight;
      let acc = 0;
      for (const p of prizes) {
        acc += Number(p.probability_weight || 0);
        if (r < acc) { pick = p; break; }
      }
      if (!pick) pick = prizes[prizes.length - 1]; // fallback

      // 5) 扣庫存（如果有庫存上限）
      if (pick.stock_total != null) {
        await client.query(
          'UPDATE activity_prizes SET stock_remaining = stock_remaining - 1 WHERE id = $1',
          [pick.id]
        );
      }

      // 6) 寫 play 紀錄
      const prizeSnapshot = {
        name: pick.name,
        prize_type: pick.prize_type,
        prize_value: pick.prize_value || {},
        image_url: pick.image_url || null,
        is_grand_prize: pick.is_grand_prize
      };
      const { rows: playRow } = await client.query(
        `INSERT INTO activity_plays
           (activity_id, line_user_id, line_display_name, prize_id, prize_snapshot, properties, played_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
         RETURNING id, played_at`,
        [
          a.id, lineUserId, lineDisplayName, pick.id,
          JSON.stringify(prizeSnapshot),
          JSON.stringify({
            ua: req.headers['user-agent'] || null,
            ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null
          })
        ]
      );

      await client.query('COMMIT');

      // 回傳：給前端動畫用（中獎獎品 + 它在輪盤的位置 position）
      return res.json({
        ok: true,
        play_id: playRow[0].id,
        prize: {
          id: pick.id,
          name: pick.name,
          image_url: pick.image_url,
          position: pick.position,
          is_grand_prize: pick.is_grand_prize,
          prize_type: pick.prize_type,
          prize_value: pick.prize_value || {}
        }
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) {}
      console.error('wheel spin error:', err && err.message);
      return res.status(500).json({ ok: false, error: 'spin_failed', detail: String(err.message || '').slice(0, 300) });
    } finally {
      client.release();
    }
  });
}

module.exports = { registerGamesWheelRoutes };
