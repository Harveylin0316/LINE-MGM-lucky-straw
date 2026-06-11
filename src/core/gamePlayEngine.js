/**
 * 通用遊戲抽選引擎 — 給所有 game types 共用（wheel / fortune / scratch / slot）
 *
 * 提供：
 *   selectPrizeAndRecord({pool, query, activity, lineUserId, lineDisplayName, gameType, properties, req})
 *     交易內：驗活動 active + 期間 / quota / 抽選獎品 / 扣庫存 / 寫 plays
 *
 *   computeUserQuota(query, activity, lineUserId)
 *     計算用戶的 quota 狀態（base + referral bonus）
 *
 * 共用邏輯確保所有遊戲類型「中獎邏輯一致」「資料一致」「未來可重用 helper」
 */
const { verifyOaFollower } = require('./oaFollower');

async function selectPrizeAndRecord(opts) {
  const { pool, activitySlug, gameType, lineUserId, lineDisplayName, req } = opts;
  if (!lineUserId) return { error: { status: 400, code: 'missing_line_user_id' } };

  // require_follow_oa：先在交易外用 LINE API 確認是否加 OA 好友（不佔用 DB 連線）
  try {
    const preChk = await pool.query(
      `SELECT require_follow_oa FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`,
      [activitySlug, gameType]
    );
    if (preChk.rows[0] && preChk.rows[0].require_follow_oa) {
      const f = await verifyOaFollower(lineUserId);
      if (f === false) {
        return { error: { status: 403, code: 'must_follow_oa', detail: '請先加入官方帳號好友才能參加。' } };
      }
    }
  } catch (e) { console.error('require_follow_oa precheck error:', e && e.message); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 取活動 + 驗
    const { rows: actRows } = await client.query(
      `SELECT id, status, start_at, end_at,
              daily_plays_per_user, base_plays_per_user,
              referral_bonus_per, referral_bonus_max
       FROM activities WHERE slug = $1 AND game_type = $2 LIMIT 1`,
      [activitySlug, gameType]
    );
    if (actRows.length === 0) {
      await client.query('ROLLBACK');
      return { error: { status: 404, code: 'activity_not_found' } };
    }
    const a = actRows[0];
    if (a.status !== 'active') {
      await client.query('ROLLBACK');
      return { error: { status: 403, code: 'activity_not_active', detail: '活動目前不可玩' } };
    }
    const now = new Date();
    if (a.start_at && now < new Date(a.start_at)) {
      await client.query('ROLLBACK');
      return { error: { status: 403, code: 'activity_not_started', detail: '活動尚未開始' } };
    }
    if (a.end_at && now > new Date(a.end_at)) {
      await client.query('ROLLBACK');
      return { error: { status: 403, code: 'activity_ended', detail: '活動已結束' } };
    }

    // 2) Quota 檢查（含 per-user override + base + referral bonus）
    const { rows: overrideRow } = await client.query(
      `SELECT max_plays_override FROM activity_user_quotas
       WHERE activity_id = $1 AND line_user_id = $2 LIMIT 1`,
      [a.id, lineUserId]
    );
    const override = overrideRow[0] || null;
    const { rows: playedRow } = await client.query(
      'SELECT COUNT(*) AS c FROM activity_plays WHERE activity_id = $1 AND line_user_id = $2',
      [a.id, lineUserId]
    );
    const played = Number(playedRow[0].c);
    const { rows: refRow } = await client.query(
      `SELECT COUNT(*) AS c FROM activity_referrals
       WHERE activity_id = $1 AND inviter_line_user_id = $2`,
      [a.id, lineUserId]
    );
    const referralCount = Number(refRow[0].c);
    const basePlays = Number(a.base_plays_per_user || 1);
    const refPer = Number(a.referral_bonus_per || 0);
    const refMax = Number(a.referral_bonus_max || 0);
    const referralBonus = Math.min(refMax, referralCount * refPer);
    // override 直接決定 total；否則用標準算法
    const totalQuota = override
      ? Number(override.max_plays_override)
      : basePlays + referralBonus;
    if (played >= totalQuota) {
      await client.query('ROLLBACK');
      const canEarnMore = !override && refPer > 0 && referralBonus < refMax;
      return {
        error: {
          status: 429,
          code: 'quota_exhausted',
          detail: canEarnMore
            ? '次數已用完！邀請朋友來玩可以再加 ' + refPer + ' 次。'
            : (override ? '此用戶配額已用完（後台設定上限 ' + totalQuota + ' 次）。' : '次數已用完。'),
          quota: {
            total: totalQuota, played, remaining: 0, referrals: referralCount,
            base: basePlays, referral_bonus: referralBonus,
            referral_bonus_max: refMax, referral_bonus_per: refPer,
            override: override ? { max_plays: Number(override.max_plays_override) } : null
          }
        }
      };
    }

    // 3) Daily limit 額外檢查
    if (a.daily_plays_per_user != null) {
      const { rows: dCount } = await client.query(
        `SELECT COUNT(*) AS c FROM activity_plays
         WHERE activity_id = $1 AND line_user_id = $2
           AND played_at >= date_trunc('day', NOW())`,
        [a.id, lineUserId]
      );
      if (Number(dCount[0].c) >= a.daily_plays_per_user) {
        await client.query('ROLLBACK');
        return {
          error: {
            status: 429,
            code: 'daily_limit_reached',
            detail: '今天已達可玩次數上限（' + a.daily_plays_per_user + ' 次），明天再來。'
          }
        };
      }
    }

    // 4) 取獎品池（鎖列）
    const { rows: prizes } = await client.query(
      `SELECT id, name, description, probability_weight, stock_total, stock_remaining,
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
      return { error: { status: 503, code: 'no_prize_available', detail: '所有獎品都已抽完。' } };
    }

    // 併發防護：取得獎品列鎖（FOR UPDATE）後複查遊玩數，避免併發 /play 超領
    // （所有 play 都鎖同一批 activity_prizes 列 → 同活動同用戶會被序列化）
    const { rows: reCount } = await client.query(
      'SELECT COUNT(*) AS c FROM activity_plays WHERE activity_id = $1 AND line_user_id = $2',
      [a.id, lineUserId]
    );
    if (Number(reCount[0].c) >= totalQuota) {
      await client.query('ROLLBACK');
      return { error: { status: 429, code: 'quota_exhausted', detail: '次數已用完。' } };
    }

    // 5) 加權隨機
    const totalWeight = prizes.reduce((s, p) => s + Number(p.probability_weight || 0), 0);
    if (totalWeight <= 0) {
      await client.query('ROLLBACK');
      return { error: { status: 500, code: 'no_valid_weight', detail: '所有獎品權重為 0。' } };
    }
    let pick = null;
    const r = Math.random() * totalWeight;
    let acc = 0;
    for (const p of prizes) {
      acc += Number(p.probability_weight || 0);
      if (r < acc) { pick = p; break; }
    }
    if (!pick) pick = prizes[prizes.length - 1];

    // 6) 扣庫存
    if (pick.stock_total != null) {
      await client.query(
        'UPDATE activity_prizes SET stock_remaining = stock_remaining - 1 WHERE id = $1',
        [pick.id]
      );
    }

    // 7) 寫 play 紀錄
    const prizeSnapshot = {
      name: pick.name,
      description: pick.description,
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
        a.id, lineUserId, lineDisplayName || null, pick.id,
        JSON.stringify(prizeSnapshot),
        JSON.stringify({
          game_type: gameType,
          ua: req && req.headers && req.headers['user-agent'] || null,
          ip: req && ((req.headers && req.headers['x-forwarded-for']) || req.ip || '')
            ? (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null
            : null
        })
      ]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      play_id: playRow[0].id,
      prize: {
        id: pick.id,
        name: pick.name,
        description: pick.description,
        image_url: pick.image_url,
        position: pick.position,
        is_grand_prize: pick.is_grand_prize,
        prize_type: pick.prize_type,
        prize_value: pick.prize_value || {}
      }
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) {}
    console.error('selectPrizeAndRecord error:', err && err.message);
    return { error: { status: 500, code: 'play_failed', detail: String(err.message || '').slice(0, 300) } };
  } finally {
    client.release();
  }
}

async function computeUserQuota(query, activity, lineUserId) {
  const basePlays = Number(activity.base_plays_per_user || 1);
  const refPer = Number(activity.referral_bonus_per || 0);
  const refMax = Number(activity.referral_bonus_max || 0);
  // 1) 個別用戶配額 override（admin 後台設的）
  const { rows: overrideRows } = await query(
    `SELECT max_plays_override, note FROM activity_user_quotas
     WHERE activity_id = $1 AND line_user_id = $2 LIMIT 1`,
    [activity.id, lineUserId]
  );
  const override = overrideRows[0] || null;
  // 2) 已玩次數
  const { rows: playedRows } = await query(
    'SELECT COUNT(*) AS c FROM activity_plays WHERE activity_id = $1 AND line_user_id = $2',
    [activity.id, lineUserId]
  );
  const played = Number(playedRows[0].c);
  // 3) 邀請成功數
  const { rows: refRows } = await query(
    `SELECT COUNT(*) AS c FROM activity_referrals
     WHERE activity_id = $1 AND inviter_line_user_id = $2`,
    [activity.id, lineUserId]
  );
  const referrals = Number(refRows[0].c);
  const referralBonus = Math.min(refMax, referrals * refPer);
  // override 直接覆寫 total（取代 base + referral）；否則用標準計算
  const total = override
    ? Number(override.max_plays_override)
    : basePlays + referralBonus;
  return {
    total,
    played,
    remaining: Math.max(0, total - played),
    referrals,
    base: basePlays,
    referral_bonus: referralBonus,
    referral_bonus_max: refMax,
    referral_bonus_per: refPer,
    override: override ? {
      max_plays: Number(override.max_plays_override),
      note: override.note || null
    } : null
  };
}

async function registerReferral({ query, activitySlug, gameType, inviterId, inviteeId }) {
  if (!inviteeId || !inviterId) {
    return { error: { status: 400, code: 'missing_ids' } };
  }
  if (inviteeId === inviterId) {
    return { error: { status: 400, code: 'self_referral', detail: '不能邀請自己' } };
  }
  const { rows: act } = await query(
    `SELECT id, referral_bonus_per FROM activities
     WHERE slug = $1 AND game_type = $2 LIMIT 1`,
    [activitySlug, gameType]
  );
  if (act.length === 0) return { error: { status: 404, code: 'activity_not_found' } };
  const a = act[0];
  if (!a.referral_bonus_per || a.referral_bonus_per <= 0) {
    return { error: { status: 400, code: 'mgm_disabled', detail: '此活動未啟用邀請機制' } };
  }
  // 只認「真實加 OA 好友的被邀者」：擋偽造假 id 灌配額、確保邀請真的長 OA、獎勵對應真實獲客
  const invFollows = await verifyOaFollower(inviteeId);
  if (invFollows === false) {
    return { error: { status: 400, code: 'invitee_not_follower', detail: '被邀請的人要先加官方帳號好友，邀請才算成功。' } };
  }
  const ins = await query(
    `INSERT INTO activity_referrals (activity_id, inviter_line_user_id, invitee_line_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (activity_id, invitee_line_user_id) DO NOTHING
     RETURNING id`,
    [a.id, inviterId, inviteeId]
  );
  return { ok: true, counted: ins.rows.length > 0 };
}

module.exports = { selectPrizeAndRecord, computeUserQuota, registerReferral };
