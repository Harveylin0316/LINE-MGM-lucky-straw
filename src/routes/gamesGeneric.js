/**
 * 通用遊戲路由註冊器 — 一行 register 一個 game type
 *
 * 用法：
 *   const { registerGameType } = require('./gamesGeneric');
 *   registerGameType(app, deps, { gameType: 'wheel',   viewName: 'game_wheel' });
 *   registerGameType(app, deps, { gameType: 'fortune', viewName: 'game_fortune' });
 *   ...
 *
 * 每個 game type 自動有：
 *   GET  /games/<type>/:slug                  渲染對應 view
 *   GET  /api/games/<type>/:slug/meta         活動 + 獎品 + (可選)用戶 quota
 *   POST /api/games/<type>/:slug/play         抽選核心（共用 engine）
 *   POST /api/games/<type>/:slug/referral     邀請拉新
 *
 * 共用 engine 在 src/core/gamePlayEngine.js
 */
const {
  selectPrizeAndRecord, computeUserQuota, registerReferral
} = require('../core/gamePlayEngine');
const { verifyLiffIdToken, channelIdFromLiffId } = require('../core/liffAuth');
const { verifyOaFollower } = require('../core/oaFollower');

function registerGameType(app, deps, opts) {
  const { query, pool } = deps;
  const { gameType, viewName, defaultLiffId } = opts;

  // LIFF id token 驗證 + 紀錄探針。回傳 { pass, reject? }。
  // 強制模式（預設開，可用環境變數 LIFF_TOKEN_ENFORCE=0 關閉）：
  //   無 token / 驗證失敗 / sub≠前端送的 userId → pass=false（擋冒用）。
  // /meta 為唯讀（不檢查 pass，只記探針），避免擋住頁面載入。
  async function verifyGameIdentity(endpoint, slug, bodyUid, idToken, actRow) {
    const enforce = process.env.LIFF_TOKEN_ENFORCE !== '0';
    if (!idToken) {
      return enforce
        ? { pass: false, reject: { status: 401, code: 'token_required', detail: '登入憑證遺失，請關閉後從 LINE 重新開啟此頁。' } }
        : { pass: true };
    }
    let channelId = channelIdFromLiffId(defaultLiffId);
    try {
      // actRow 已帶 liff_id_override 時直接用，省一次查詢；否則才查
      let ov = actRow ? actRow.liff_id_override : undefined;
      if (ov === undefined) {
        const r = await query(`SELECT liff_id_override FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`, [slug, gameType]);
        ov = r.rows[0] && r.rows[0].liff_id_override;
      }
      if (ov && String(ov).trim()) channelId = channelIdFromLiffId(ov);
    } catch (e) { /* ignore */ }
    let v;
    try { v = await verifyLiffIdToken(idToken, channelId); }
    catch (e) { v = { ok: false, reason: 'error', detail: String(e && e.message || e).slice(0, 100) }; }
    const verified = !!v.ok;
    const matches = !!(verified && v.sub && bodyUid && v.sub === bodyUid);
    query(
      `INSERT INTO liff_token_probe (endpoint, game_type, slug, body_line_user_id, token_present, verified, verified_sub, sub_matches, channel_id, detail)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9)`,
      [endpoint, gameType, slug, bodyUid || null, verified, v.sub || null, matches, channelId || null,
       (v.reason || 'ok') + (v.detail ? (' ' + v.detail) : '') + (v.status ? (' http' + v.status) : '')]
    ).catch(e => console.error('probe insert failed:', e && e.message));
    if (!enforce) return { pass: true };
    if (!verified) return { pass: false, reject: { status: 401, code: 'token_invalid', detail: '身分驗證失敗，請重新開啟頁面。' } };
    if (!matches) return { pass: false, reject: { status: 403, code: 'identity_mismatch', detail: '身分不符，無法進行。' } };
    return { pass: true };
  }

  // ----- 頁面 -----
  app.get('/games/' + gameType + '/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const { rows } = await query(
        `SELECT id, slug, name, description, game_type, status, start_at, end_at,
                cover_image_url, daily_plays_per_user, require_follow_oa, liff_id_override,
                base_plays_per_user, referral_bonus_per, referral_bonus_max
         FROM activities WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      if (rows.length === 0 || rows[0].game_type !== gameType) {
        return res.status(404).send('活動不存在或類型不符');
      }
      const a = rows[0];
      const { rows: prizes } = await query(
        `SELECT id, name, description, image_url, position, is_grand_prize, prize_value,
                CASE WHEN stock_total IS NULL THEN false
                     ELSE stock_remaining <= 0 END AS sold_out
         FROM activity_prizes WHERE activity_id = $1
         ORDER BY position ASC, id ASC`,
        [a.id]
      );
      const effectiveLiffId = (a.liff_id_override && a.liff_id_override.trim()) || defaultLiffId;
      res.render(viewName, {
        title: a.name + ' — OpenRice LINE',
        bodyClass: 'liff-shell ' + gameType + '-shell',
        activity: a,
        prizes,
        liffId: effectiveLiffId,
        gameType: gameType
      });
    } catch (err) {
      console.error(gameType + ' page error:', err && err.message);
      res.status(500).send('Server error');
    }
  });

  // ----- meta API -----
  app.get('/api/games/' + gameType + '/:slug/meta', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').trim();
      const lineUserId = String(req.query.line_user_id || '').trim();
      verifyGameIdentity('meta', slug, lineUserId, String(req.query.id_token || '').trim()); // 唯讀：只記探針，不擋
      const { rows: act } = await query(
        `SELECT id, slug, name, description, status, start_at, end_at,
                cover_image_url, daily_plays_per_user, require_follow_oa,
                base_plays_per_user, referral_bonus_per, referral_bonus_max
         FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`,
        [slug, gameType]
      );
      if (act.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
      const a = act[0];
      const { rows: prizes } = await query(
        `SELECT id, name, description, image_url, position, is_grand_prize, prize_value,
                CASE WHEN stock_total IS NULL THEN false
                     ELSE stock_remaining <= 0 END AS sold_out
         FROM activity_prizes WHERE activity_id = $1
         ORDER BY position ASC, id ASC`,
        [a.id]
      );
      let quota = null;
      if (lineUserId) quota = await computeUserQuota(query, a, lineUserId);
      res.json({ ok: true, activity: a, prizes, quota });
    } catch (err) {
      console.error(gameType + ' meta error:', err && err.message);
      res.status(500).json({ ok: false, error: 'meta_failed', detail: String(err.message || '').slice(0, 300) });
    }
  });

  // ----- play API（共用） -----
  const handlePlay = async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const lineUserId = String((req.body || {}).line_user_id || '').trim();
    const lineDisplayName = String((req.body || {}).line_display_name || '').trim() || null;
    const idToken = String((req.body || {}).id_token || '').trim();
    // 一次查活動旗標，再把「token 驗證」「加好友驗證」兩個 LINE API 並行跑（不要一個等一個 → 加速「準備中」）
    let actRow = null;
    try { actRow = (await query(`SELECT require_follow_oa, liff_id_override FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`, [slug, gameType])).rows[0] || null; } catch (e) { /* ignore */ }
    const needFollow = !!(actRow && actRow.require_follow_oa);
    const [idCheck, followerOk] = await Promise.all([
      verifyGameIdentity('play', slug, lineUserId, idToken, actRow),
      needFollow ? verifyOaFollower(lineUserId) : Promise.resolve(true)
    ]);
    if (!idCheck.pass) return res.status(idCheck.reject.status).json({ ok: false, error: idCheck.reject.code, detail: idCheck.reject.detail });
    if (followerOk === false) return res.status(403).json({ ok: false, error: 'must_follow_oa', detail: '請先加入官方帳號好友才能參加。' });
    const result = await selectPrizeAndRecord({
      pool, activitySlug: slug, gameType, lineUserId, lineDisplayName, req
    });
    if (result.error) {
      return res.status(result.error.status).json({
        ok: false, error: result.error.code,
        detail: result.error.detail, quota: result.error.quota
      });
    }
    res.json(result);
  };
  // 給每個 game 一個 alias path（wheel 為了向後相容也保留 /spin）
  app.post('/api/games/' + gameType + '/:slug/play', handlePlay);
  if (gameType === 'wheel') app.post('/api/games/wheel/:slug/spin', handlePlay);

  // ----- referral API -----
  app.post('/api/games/' + gameType + '/:slug/referral', async (req, res) => {
    const slug = String(req.params.slug || '').trim();
    const inviteeId = String((req.body || {}).line_user_id || '').trim();
    const inviterId = String((req.body || {}).inviter_line_user_id || '').trim();
    const idCheck = await verifyGameIdentity('referral', slug, inviteeId, String((req.body || {}).id_token || '').trim());
    if (!idCheck.pass) return res.status(idCheck.reject.status).json({ ok: false, error: idCheck.reject.code, detail: idCheck.reject.detail });
    const result = await registerReferral({
      query, activitySlug: slug, gameType, inviterId, inviteeId
    });
    if (result.error) {
      return res.status(result.error.status).json({
        ok: false, error: result.error.code, detail: result.error.detail
      });
    }
    res.json(result);
  });
}

module.exports = { registerGameType };
