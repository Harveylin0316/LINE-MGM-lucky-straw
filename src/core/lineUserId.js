/**
 * LINE Messaging API / LIFF profile 的 userId：U + 32 位十六進位。
 * 不同 API 回傳的大小寫可能不同，PostgreSQL 字串比對區分大小寫，需正規化後再存或比對。
 */
function normalizeLineMessagingUserId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^U[0-9a-f]{32}$/i.test(s)) return s;
  return `U${s.slice(1).toLowerCase()}`;
}

module.exports = { normalizeLineMessagingUserId };
