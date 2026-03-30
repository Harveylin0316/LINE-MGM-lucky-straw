const crypto = require('crypto');
const { resolvePushImageUrl } = require('../core/linePushImageResolve');

function safeEqualBase64(a, b) {
  const left = Buffer.from(a || '', 'utf8');
  const right = Buffer.from(b || '', 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** 好友加碼刮次每人最多領取次數（與活動規則一致，固定為 1） */
function effectiveInviteBonusCap(inviteBonusMax) {
  const raw = Number.isFinite(Number(inviteBonusMax)) ? Number(inviteBonusMax) : 2;
  return Math.min(Math.max(0, raw), 1);
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
  const bonusCap = effectiveInviteBonusCap(inviteBonusMax);
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
      const inviteRs = await client.query(
        'SELECT id, inviter_user_id, status FROM line_invites WHERE invitee_line_user_id = $1 FOR UPDATE',
        [lineUserId]
      );
      if (inviteRs.rowCount === 0) {
        await client.query('COMMIT');
        return { result: 'no_matching_invite' };
      }

      const invite = inviteRs.rows[0];
      if (invite.status === 'rewarded' || invite.status === 'capped' || invite.status === 'invalid') {
        await client.query('COMMIT');
        return {
          result: `already_${invite.status}`,
          inviteId: invite.id,
          inviterUserId: invite.inviter_user_id
        };
      }

      const inviterRs = await client.query('SELECT id, extra_draws FROM users WHERE id = $1 FOR UPDATE', [invite.inviter_user_id]);
      if (inviterRs.rowCount === 0) {
        await client.query(
          "UPDATE line_invites SET status = 'invalid', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0) WHERE id = $1",
          [invite.id, eventTimestamp || Date.now()]
        );
        await client.query('COMMIT');
        return {
          result: 'inviter_not_found',
          inviteId: invite.id,
          inviterUserId: invite.inviter_user_id
        };
      }

      const oldExtraDraws = Number(inviterRs.rows[0].extra_draws || 0);
      const followedAtMs = eventTimestamp || Date.now();
      if (bonusCap <= 0 || oldExtraDraws >= bonusCap) {
        await client.query(
          "UPDATE line_invites SET status = 'capped', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0) WHERE id = $1",
          [invite.id, followedAtMs]
        );
        await client.query('COMMIT');
        return {
          result: 'capped',
          inviteId: invite.id,
          inviterUserId: invite.inviter_user_id
        };
      }

      const rewardedCountRs = await client.query(
        `SELECT COUNT(*)::int AS c FROM line_invites
         WHERE inviter_user_id = $1 AND status = 'rewarded'`,
        [invite.inviter_user_id]
      );
      const nRewardedBefore = Number(rewardedCountRs.rows[0]?.c || 0);
      const nAfterThisInvite = nRewardedBefore + 1;
      const targetBonusDraws = Math.min(Math.floor(nAfterThisInvite / friendsPerDraw), bonusCap);
      const effectiveBonusDraws = Math.max(oldExtraDraws, targetBonusDraws);
      const grantDraws = effectiveBonusDraws - oldExtraDraws;

      const [inviteeUserRs, inviterLineRs] = await Promise.all([
        client.query('SELECT line_display_name, username FROM users WHERE line_user_id = $1', [lineUserId]),
        client.query('SELECT line_user_id FROM users WHERE id = $1', [invite.inviter_user_id])
      ]);
      const inviteeRow = inviteeUserRs.rows[0] || {};
      const inviterRow = inviterLineRs.rows[0] || {};
      const inviteeDisplayName =
        String(inviteeRow.line_display_name || '').trim() ||
        String(inviteeRow.username || '').trim() ||
        '您的好友';
      const inviterLineUserId = inviterRow.line_user_id || null;

      await client.query(
        'UPDATE users SET extra_draws = $1, draws_left = draws_left + $2 WHERE id = $3',
        [effectiveBonusDraws, grantDraws, invite.inviter_user_id]
      );
      await client.query(
        "UPDATE line_invites SET status = 'rewarded', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0), rewarded_at = NOW() WHERE id = $1",
        [invite.id, followedAtMs]
      );
      await client.query('COMMIT');
      return {
        result: 'rewarded',
        inviteId: invite.id,
        inviterUserId: invite.inviter_user_id,
        inviterLineUserId,
        inviteeDisplayName,
        grantDraws,
        isFirstRewardedFriend: nRewardedBefore === 0
      };
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
        const rewardResult = await rewardInviteForFollow(lineUserId, event.timestamp);
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

        if (
          rewardResult?.result === 'rewarded' &&
          rewardResult.inviterLineUserId &&
          linePush &&
          typeof linePush.pushLineMessages === 'function'
        ) {
          const friendName = String(rewardResult.inviteeDisplayName || '您的好友').slice(0, 80);
          const grantDraws = Number(rewardResult.grantDraws || 0);
          const messages = [];
          let pushType = 'invite_reward_notification';
          if (grantDraws > 0) {
            pushType = 'invite_bonus_granted_notification';
            const liffLine =
              typeof liffLotteryPushUrl === 'string' && /^https:\/\/liff\.line\.me\//i.test(liffLotteryPushUrl.trim())
                ? `\n\n立即玩春日刮刮樂：\n${liffLotteryPushUrl.trim()}`
                : '';
            messages.push(
              `您的朋友「${friendName}」已成功加入 OpenRice LINE@！已累計 ${friendsPerDraw} 位好友完成任務，恭喜您獲得 1 次加碼刮刮樂次數！${liffLine}`
            );
            messages.push({ type: 'image', _pushAssetFile: 'invite-bonus-granted.png' });
          } else if (rewardResult.isFirstRewardedFriend) {
            pushType = 'invite_progress_notification';
            messages.push(
              `您的朋友「${friendName}」已成功加入 OpenRice LINE@！再邀請 ${Math.max(1, friendsPerDraw - 1)} 位尚未加入的好友完成加好友，即可獲得 1 次加碼刮刮樂次數。`
            );
            messages.push({ type: 'image', _pushAssetFile: 'picnic-basket-002.png' });
          }
          if (messages.length > 0) {
            Promise.resolve()
              .then(async () => {
                const built = [];
                for (const m of messages) {
                  if (typeof m === 'string') {
                    built.push(m);
                    continue;
                  }
                  if (m && m.type === 'image' && m._pushAssetFile) {
                    const u = await resolvePushImageUrl(linePushImageBaseCandidates, m._pushAssetFile);
                    if (u) built.push({ type: 'image', originalContentUrl: u, previewImageUrl: u });
                    continue;
                  }
                  if (m && m.type === 'image') {
                    built.push(m);
                  }
                }
                return linePush.pushLineMessages(rewardResult.inviterLineUserId, built, {
                  userId: rewardResult.inviterUserId,
                  pushType,
                  inviteeDisplayName: friendName,
                  inviteId: rewardResult.inviteId,
                  grantDraws,
                  liffLotteryPushUrl: liffLotteryPushUrl || null
                });
              })
              .catch(err => {
                console.error('LINE invite reward push failed:', err.message);
              });
          }
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
