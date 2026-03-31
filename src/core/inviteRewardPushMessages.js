const { resolvePushImageUrl } = require('./linePushImageResolve');

/**
 * 與 LINE Webhook follow 成功發獎後相同文案／圖片（供 Webhook、補發腳本共用）。
 * @returns {Promise<{ inviterLineUserId: string, messages: unknown[], pushExtras: object } | null>}
 */
async function buildInviteRewardPushMessages({
  rewardResult,
  friendsPerDraw,
  liffLotteryPushUrl = '',
  linePushImageBaseCandidates = []
}) {
  if (rewardResult?.result !== 'rewarded' || !rewardResult.inviterLineUserId) {
    return null;
  }

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

  if (messages.length === 0) {
    return null;
  }

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

  if (built.length === 0) {
    return null;
  }

  return {
    inviterLineUserId: rewardResult.inviterLineUserId,
    messages: built,
    pushExtras: {
      userId: rewardResult.inviterUserId,
      pushType,
      inviteeDisplayName: friendName,
      inviteId: rewardResult.inviteId,
      grantDraws,
      liffLotteryPushUrl: liffLotteryPushUrl || null
    }
  };
}

module.exports = { buildInviteRewardPushMessages };
