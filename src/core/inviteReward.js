/**
 * 被邀請人加好友後，給邀請人加碼刮次（與 LINE Webhook follow 邏輯一致）。
 * 抽出為共用模組供 Webhook 與補發腳本使用。
 */

/** 好友加碼刮次每人最多領取次數（與活動規則一致，固定為 1） */
function effectiveInviteBonusCap(inviteBonusMax) {
  const raw = Number.isFinite(Number(inviteBonusMax)) ? Number(inviteBonusMax) : 2;
  return Math.min(Math.max(0, raw), 1);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {object} opts
 * @param {string} opts.lineUserId 被邀請人 LINE userId（line_invites.invitee_line_user_id）
 * @param {number} [opts.eventTimestamp] LINE 事件時間（毫秒），與 Webhook 相同；缺省則用 Date.now()
 * @param {number} opts.inviteBonusMax 環境變數 LIFF_INVITE_BONUS_MAX 同源
 * @param {number} opts.inviteFriendsPerDraw 環境變數 LIFF_INVITE_FRIENDS_PER_DRAW 同源
 * @returns {Promise<object>} 與原 rewardInviteForFollow 相同形狀（不含 push）
 */
async function applyInviteFollowReward(client, {
  lineUserId,
  eventTimestamp,
  inviteBonusMax,
  inviteFriendsPerDraw
}) {
  const friendsPerDraw = Math.max(
    1,
    Number.isFinite(Number(inviteFriendsPerDraw)) ? Number(inviteFriendsPerDraw) : 2
  );
  const bonusCap = effectiveInviteBonusCap(inviteBonusMax);

  const inviteRs = await client.query(
    'SELECT id, inviter_user_id, status FROM line_invites WHERE invitee_line_user_id = $1 FOR UPDATE',
    [lineUserId]
  );
  if (inviteRs.rowCount === 0) {
    return { result: 'no_matching_invite' };
  }

  const invite = inviteRs.rows[0];
  if (invite.status === 'rewarded' || invite.status === 'capped' || invite.status === 'invalid') {
    return {
      result: `already_${invite.status}`,
      inviteId: invite.id,
      inviterUserId: invite.inviter_user_id
    };
  }

  const inviterRs = await client.query('SELECT id, extra_draws FROM users WHERE id = $1 FOR UPDATE', [
    invite.inviter_user_id
  ]);
  if (inviterRs.rowCount === 0) {
    const ts = eventTimestamp || Date.now();
    await client.query(
      "UPDATE line_invites SET status = 'invalid', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0) WHERE id = $1",
      [invite.id, ts]
    );
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

  await client.query('UPDATE users SET extra_draws = $1, draws_left = draws_left + $2 WHERE id = $3', [
    effectiveBonusDraws,
    grantDraws,
    invite.inviter_user_id
  ]);
  await client.query(
    "UPDATE line_invites SET status = 'rewarded', updated_at = NOW(), followed_at = TO_TIMESTAMP($2::double precision / 1000.0), rewarded_at = NOW() WHERE id = $1",
    [invite.id, followedAtMs]
  );

  return {
    result: 'rewarded',
    inviteId: invite.id,
    inviterUserId: invite.inviter_user_id,
    inviterLineUserId,
    inviteeDisplayName,
    grantDraws,
    isFirstRewardedFriend: nRewardedBefore === 0
  };
}

module.exports = { effectiveInviteBonusCap, applyInviteFollowReward };
