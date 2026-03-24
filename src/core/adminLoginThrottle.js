const crypto = require('crypto');

/**
 * 管理員登入防暴力破解：以 IP（經 HMAC）在時間窗內累計失敗次數，存 DB 以支援 serverless 多實例。
 */
function createAdminLoginThrottle({ query, hmacSecret, windowMinutes = 15, maxAttempts = 8 }) {
  const win = Math.max(1, Math.min(120, Number(windowMinutes) || 15));
  const max = Math.max(3, Math.min(50, Number(maxAttempts) || 8));

  function ipKeyFromReq(req) {
    const xf = req.headers['x-forwarded-for'];
    const raw = typeof xf === 'string' ? xf.split(',')[0].trim() : '';
    const ip = raw || req.ip || req.socket?.remoteAddress || '';
    return crypto.createHmac('sha256', hmacSecret).update(String(ip)).digest('hex');
  }

  async function countRecent(ipKey) {
    const rs = await query(
      `SELECT COUNT(*)::int AS c FROM admin_login_throttle
       WHERE ip_key = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 minute')`,
      [ipKey, win]
    );
    return Number(rs.rows[0]?.c) || 0;
  }

  async function pruneStaleForKey(ipKey) {
    await query(
      `DELETE FROM admin_login_throttle
       WHERE ip_key = $1 AND created_at < NOW() - ($2::int * INTERVAL '1 minute')`,
      [ipKey, win * 4]
    );
  }

  async function isBlocked(ipKey) {
    await pruneStaleForKey(ipKey);
    const c = await countRecent(ipKey);
    return c >= max;
  }

  async function recordFailure(ipKey) {
    await query(`INSERT INTO admin_login_throttle (ip_key) VALUES ($1)`, [ipKey]);
  }

  async function clearFailures(ipKey) {
    await query(`DELETE FROM admin_login_throttle WHERE ip_key = $1`, [ipKey]);
  }

  return {
    ipKeyFromReq,
    isBlocked,
    recordFailure,
    clearFailures,
    windowMinutes: win,
    maxAttempts: max
  };
}

module.exports = { createAdminLoginThrottle };
