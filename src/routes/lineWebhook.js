const crypto = require('crypto');
const { applyInviteFollowReward } = require('../core/inviteReward');
const { buildInviteRewardPushMessages } = require('../core/inviteRewardPushMessages');

function safeEqualBase64(a, b) {
  const left = Buffer.from(a || '', 'utf8');
  const right = Buffer.from(b || '', 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createLineWebhookHandler({
  pool,
  channelSecret,
  inviteBonusMax,
  inviteFriendsPerDraw,
  linePushImageBaseCandidates = [],
  liffLotteryPushUrl = '',
  linePush,
  flowEngine = null
}) {
  const friendsPerDraw = Math.max(1, Number.isFinite(Number(inviteFriendsPerDraw)) ? Number(inviteFriendsPerDraw) : 2);
  async function appendWebhookEventLog(payload) {
    await pool.query(
      `INSERT INTO line_webhook_events
        (event_type, line_user_id, invite_id, inviter_user_id, result, detail, event_timestamp, raw_event)
       VALUES
        ($1, $2, $3, $4, $5, $6,
         CASE WHEN $7::double precision > 0 THEN TO_TIMESTAMP($7::double precision / 1000.0) ELSE NULL END,
         $8::jsonb)`,
      [
        payload.eventType,
        payload.lineUserId || null,
        payload.inviteId || null,
        payload.inviterUserId || null,
        payload.result,
        payload.detail || null,
        Number(payload.eventTimestamp || 0),
        payload.rawEvent ? JSON.stringify(payload.rawEvent) : JSON.stringify({})
      ]
    );
  }

  async function rewardInviteForFollow(lineUserId, eventTimestamp) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rewardResult = await applyInviteFollowReward(client, {
        lineUserId,
        eventTimestamp,
        inviteBonusMax,
        inviteFriendsPerDraw
      });
      await client.query('COMMIT');
      return rewardResult;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return async function lineWebhookHandler(req, res) {
    try {
      if (!channelSecret) {
        return res.status(500).send('Missing LINE channel secret');
      }

      const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const rawBody = rawBodyBuffer.toString('utf8');
      const expectedSignature = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
      const incomingSignature = req.get('x-line-signature') || '';
      if (!safeEqualBase64(expectedSignature, incomingSignature)) {
        return res.status(401).send('Invalid signature');
      }

      const payload = JSON.parse(rawBody || '{}');
      const events = Array.isArray(payload.events) ? payload.events : [];
      for (const event of events) {
        // 封鎖：標記 blocked_at（給流失分眾 + 抑制發送）
        if (event?.type === 'unfollow') {
          const blockedUid = event?.source?.userId || null;
          if (blockedUid) {
            try { await pool.query(`UPDATE users SET blocked_at = now() WHERE line_user_id = $1`, [blockedUid]); }
            catch (e) { console.error('mark blocked failed:', e.message); }
          }
          await appendWebhookEventLog({
            eventType: 'unfollow', lineUserId: blockedUid, result: 'blocked',
            detail: '用戶封鎖 OA', eventTimestamp: event?.timestamp, rawEvent: event || {}
          });
          continue;
        }
        if (event?.type !== 'follow') {
          await appendWebhookEventLog({
            eventType: event?.type || 'unknown',
            lineUserId: event?.source?.userId || null,
            result: 'ignored_event_type',
            detail: '非 follow/unfollow 事件（仍記 log）',
            eventTimestamp: event?.timestamp,
            rawEvent: event || {}
          });
          continue;
        }
        const lineUserId = event?.source?.userId;
        if (!lineUserId) {
          await appendWebhookEventLog({
            eventType: 'follow',
            lineUserId: null,
            result: 'missing_user_id',
            detail: 'Follow event without source.userId.',
            eventTimestamp: event?.timestamp,
            rawEvent: event || {}
          });
          continue;
        }
        // 重新加好友：清除封鎖標記
        try { await pool.query(`UPDATE users SET blocked_at = NULL WHERE line_user_id = $1`, [lineUserId]); }
        catch (e) { console.error('clear blocked failed:', e.message); }
        let rewardResult;
        try {
          rewardResult = await rewardInviteForFollow(lineUserId, event.timestamp);
        } catch (rewardErr) {
          await appendWebhookEventLog({
            eventType: 'follow',
            lineUserId,
            result: 'reward_exception',
            detail: String(rewardErr.message || rewardErr).slice(0, 800),
            eventTimestamp: event?.timestamp,
            rawEvent: event || {}
          });
          throw rewardErr;
        }
        const resultCode = rewardResult?.result || 'processed';
        let logDetail = null;
        if (resultCode === 'no_matching_invite') {
          const staticHint =
            '找不到可更新的邀請列。請確認：①好友已用 LINE 開啟「你的邀請連結」並登入（會寫入 line_invites）後再加官方帳 ②Hosting 的 DATABASE_URL 與你在 Supabase 看的為同一資料庫 ③部署最新程式後請封鎖再重加官方帳以重送 follow。';
          logDetail = rewardResult?.detail
            ? `${rewardResult.detail} ${staticHint}`
            : staticHint;
        }
        await appendWebhookEventLog({
          eventType: 'follow',
          lineUserId,
          inviteId: rewardResult?.inviteId || null,
          inviterUserId: rewardResult?.inviterUserId || null,
          result: resultCode,
          detail: logDetail,
          eventTimestamp: event?.timestamp,
          rawEvent: event || {}
        });

        // 自動化流程：觸發 follow-flows（取代舊的寫死 D0；歡迎訊息改由流程系統發）
        if (flowEngine && typeof flowEngine.triggerFollow === 'function') {
          Promise.resolve().then(function () { return flowEngine.triggerFollow(lineUserId, null); })
            .catch(function (e) { console.error('flow follow trigger failed:', e.message); });
        }

        if (rewardResult?.result === 'rewarded' && linePush && typeof linePush.pushLineMessages === 'function') {
          Promise.resolve()
            .then(async () => {
              const payload = await buildInviteRewardPushMessages({
                rewardResult,
                friendsPerDraw,
                liffLotteryPushUrl,
                linePushImageBaseCandidates
              });
              if (!payload) return;
              return linePush.pushLineMessages(payload.inviterLineUserId, payload.messages, payload.pushExtras);
            })
            .catch(err => {
              console.error('LINE invite reward push failed:', err.message);
            });
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('LINE webhook error:', err.message);
      return res.status(500).json({ ok: false });
    }
  };
}

module.exports = { createLineWebhookHandler };
