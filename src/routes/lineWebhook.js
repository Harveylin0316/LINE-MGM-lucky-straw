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
  linePush
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
        if (event?.type !== 'follow') {
          await appendWebhookEventLog({
            eventType: event?.type || 'unknown',
            lineUserId: event?.source?.userId || null,
            result: 'ignored_event_type',
            detail: 'Only follow events trigger invite rewards.',
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
        await appendWebhookEventLog({
          eventType: 'follow',
          lineUserId,
          inviteId: rewardResult?.inviteId || null,
          inviterUserId: rewardResult?.inviterUserId || null,
          result: rewardResult?.result || 'processed',
          detail: null,
          eventTimestamp: event?.timestamp,
          rawEvent: event || {}
        });

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
