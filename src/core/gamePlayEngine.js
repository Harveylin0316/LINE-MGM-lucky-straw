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
  // 註：require_follow_oa 的好友驗證已移到 /play 路由，與 token 驗證「並行」執行（加速「準備中」）。

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

    const playId = playRow[0].id;

    // 8) 優惠券碼領取（僅 prize_type='coupon_code'）
    //    在同一交易內、INSERT play 拿到 play_id 之後、COMMIT 之前，
    //    從該 (activity_id, prize_id) 的碼池原子領一張 available 碼。
    //    領不到（碼用完）→ coupon_code 留 NULL、play 照常 COMMIT，
    //    絕不可因缺碼 rollback 或讓整個 /play 失敗。
    let couponCode = null;
    let couponOutOfStock = false;
    if (pick.prize_type === 'coupon_code') {
      const { rows: codeRows } = await client.query(
        `UPDATE coupon_codes
            SET status='claimed', claimed_play_id=$1, claimed_line_user_id=$2, claimed_at=now()
          WHERE id = (
            SELECT id FROM coupon_codes
             WHERE activity_id=$3 AND prize_id=$4 AND status='available'
             ORDER BY id LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING code`,
        [playId, lineUserId, a.id, pick.id]
      );
      if (codeRows.length > 0) {
        couponCode = codeRows[0].code;
        await client.query(
          'UPDATE activity_plays SET coupon_code = $1 WHERE id = $2',
          [couponCode, playId]
        );
      } else {
        couponOutOfStock = true;
      }
    }

    await client.query('COMMIT');

    return {
      ok: true,
      play_id: playId,
      coupon_code: couponCode,
      coupon_out_of_stock: couponOutOfStock,
      prize: {
        id: pick.id,
        name: pick.name,
        description: pick.description,
        image_url: pick.image_url,
        position: pick.position,
        is_grand_prize: pick.is_grand_prize,
        prize_type: pick.prize_type,
        prize_value: pick.prize_value || {},
        coupon_code: couponCode
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

// ---- 邀請成功即時通知（fire-and-forget）----
// 防騷擾：同一活動同一邀請人 60 秒內只通知一次（in-memory Map）。
// 注意：serverless（Netlify Functions）下每個 instance 各自一份 Map，跨 instance 不去重，
// 屬「盡力而為」；搭配 LINE X-Line-Retry-Key（同一筆 referral 冪等）已足夠避免重複轟炸。
const REFERRAL_NOTIFY_COOLDOWN_MS = 60 * 1000;
const referralNotifyLastAt = new Map();

function shouldSkipReferralNotify(key) {
  const now = Date.now();
  const last = referralNotifyLastAt.get(key);
  if (last && now - last < REFERRAL_NOTIFY_COOLDOWN_MS) return true;
  // 順手清掉過期項目，避免 Map 無限成長
  if (referralNotifyLastAt.size > 500) {
    for (const [k, t] of referralNotifyLastAt) {
      if (now - t >= REFERRAL_NOTIFY_COOLDOWN_MS) referralNotifyLastAt.delete(k);
    }
  }
  referralNotifyLastAt.set(key, now);
  return false;
}

// 盡力取得被邀請人的 LINE 顯示名稱（registerReferral 前已驗過是 OA 好友，profile 端點通常可取）
async function fetchLineDisplayName(lineUserId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!token || !lineUserId) return null;
  try {
    const resp = await fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(lineUserId), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const name = data && typeof data.displayName === 'string' ? data.displayName.trim() : '';
    return name || null;
  } catch (_e) {
    return null;
  }
}

async function notifyInviterOfReferral({ query, activity, activitySlug, gameType, inviterId, inviteeId }) {
  if (shouldSkipReferralNotify(activity.id + ':' + inviterId)) return;
  const refPer = Number(activity.referral_bonus_per || 0);
  const refMax = Number(activity.referral_bonus_max || 0);
  const { rows: refRows } = await query(
    `SELECT COUNT(*) AS c FROM activity_referrals
     WHERE activity_id = $1 AND inviter_line_user_id = $2`,
    [activity.id, inviterId]
  );
  const count = Number(refRows[0].c);
  // 本次實際入帳的加碼（與 computeUserQuota 的 Math.min 上限算法一致，含「最後一次只補到上限」的部分加碼）
  const gained = Math.min(refMax, count * refPer) - Math.min(refMax, (count - 1) * refPer);
  const who = (await fetchLineDisplayName(inviteeId)) || '1 位好友';
  // 遊戲連結組法與 games 路由 / 各 game view 一致：https://liff.line.me/{liffId}/{gameType}/{slug}
  const liffId = (activity.liff_id_override && String(activity.liff_id_override).trim()) ||
    process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';
  const gameUrl = liffId
    ? 'https://liff.line.me/' + liffId + '/' + gameType + '/' + encodeURIComponent(activitySlug)
    : '';
  let text;
  if (gained > 0) {
    text = '邀請成功！' + who + ' 已透過你的連結加入。你獲得 +' + gained +
      ' 次遊戲機會（已邀 ' + count + ' 位，上限 +' + refMax + ' 次）。';
    if (gameUrl) text += '打開遊戲馬上用：' + gameUrl;
  } else if (refMax > 0) {
    text = '邀請成功！' + who + ' 已加入。你的邀請加碼已達上限（+' + refMax + ' 次全數入帳），仍感謝你的分享！';
  } else {
    // referral_bonus_max <= 0 的設定邊界：避免「+0 次全數入帳」這種怪文案
    text = '邀請成功！' + who + ' 已透過你的連結加入，感謝你的分享！';
  }
  const { createLinePushService } = require('./linePush');
  const linePush = createLinePushService({
    query,
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || ''
  });
  await linePush.pushLineMessages(inviterId, [text], {
    pushType: 'referral_inviter_notify',
    retryKey: 'referral-notify:' + activity.id + ':' + inviterId + ':' + inviteeId
  });
}

async function registerReferral({ query, activitySlug, gameType, inviterId, inviteeId }) {
  if (!inviteeId || !inviterId) {
    return { error: { status: 400, code: 'missing_ids' } };
  }
  if (inviteeId === inviterId) {
    return { error: { status: 400, code: 'self_referral', detail: '不能邀請自己' } };
  }
  const { rows: act } = await query(
    `SELECT id, referral_bonus_per, referral_bonus_max, liff_id_override FROM activities
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
  const counted = ins.rows.length > 0;
  if (counted) {
    // 邀請成功 → 即時通知邀請人。fire-and-forget：通知失敗絕不影響 API 回應
    notifyInviterOfReferral({ query, activity: a, activitySlug, gameType, inviterId, inviteeId })
      .catch(err => console.error('referral inviter notify failed:', err && err.message));
  }
  return { ok: true, counted };
}

module.exports = { selectPrizeAndRecord, computeUserQuota, registerReferral };
