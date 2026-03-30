/**
 * 與 liff.js、lineWebhook.js 一致：好友加碼每人最多 1 次（上限與 env 取 min）。
 */
function computeInviteLimit(inviteBonusMax) {
  return Math.min(Math.max(0, Number.isFinite(Number(inviteBonusMax)) ? Number(inviteBonusMax) : 2), 1);
}

module.exports = { computeInviteLimit };
