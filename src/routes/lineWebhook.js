const crypto = require('crypto');

function safeEqualBase64(a, b) {
  const left = Buffer.from(a || '', 'utf8');
  const right = Buffer.from(b || '', 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createLineWebhookHandler({ pool, channelSecret, inviteBonusMax }) {
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
        return;
      }

      const invite = inviteRs.rows[0];
      if (invite.status === 'rewarded' || invite.status === 'capped' || invite.status === 'invalid') {
        await client.query('COMMIT');
        return;
      }

      const inviterRs = await client.query('SELECT id, extra_draws FROM users WHERE id = $1 FOR UPDATE', [invite.inviter_user_id]);
      if (inviterRs.rowCount === 0) {
        await client.query(
          "UPDATE line_invites SET status = 'invalid', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0) WHERE id = $1",
          [invite.id, eventTimestamp || Date.now()]
        );
        await client.query('COMMIT');
        return;
      }

      const currentExtraDraws = Number(inviterRs.rows[0].extra_draws || 0);
      const followedAtMs = eventTimestamp || Date.now();
      if (currentExtraDraws >= inviteBonusMax) {
        await client.query(
          "UPDATE line_invites SET status = 'capped', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0) WHERE id = $1",
          [invite.id, followedAtMs]
        );
        await client.query('COMMIT');
        return;
      }

      await client.query('UPDATE users SET extra_draws = extra_draws + 1, draws_left = draws_left + 1 WHERE id = $1', [
        invite.inviter_user_id
      ]);
      await client.query(
        "UPDATE line_invites SET status = 'rewarded', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0), rewarded_at = NOW() WHERE id = $1",
        [invite.id, followedAtMs]
      );
      await client.query('COMMIT');
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
        if (event?.type !== 'follow') continue;
        const lineUserId = event?.source?.userId;
        if (!lineUserId) continue;
        await rewardInviteForFollow(lineUserId, event.timestamp);
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('LINE webhook error:', err.message);
      return res.status(500).json({ ok: false });
    }
  };
}

module.exports = { createLineWebhookHandler };
