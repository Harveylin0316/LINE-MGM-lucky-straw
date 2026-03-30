/**
 * LIFF 永久連結（https://liff.line.me/{liffId}/...）與 liff.js 路由一致。
 * LIFF_ENDPOINT_IS_SITE_ROOT=1 時 Endpoint 為網站根目錄，suffix 保留 /liff/...。
 */

function liffPermalinkSuffixFromExpressPath(expressPath, fallbackExpressPath = '/liff/lottery') {
  const p =
    typeof expressPath === 'string' && expressPath.startsWith('/') ? expressPath : fallbackExpressPath;
  if (String(process.env.LIFF_ENDPOINT_IS_SITE_ROOT || '').trim() === '1') {
    return p;
  }
  if (p === '/liff' || p === '/liff/') return '/';
  if (p.startsWith('/liff/')) return p.slice('/liff'.length);
  return p;
}

function buildLiffPermanentUrl(liffId, expressPath, fallbackExpressPath = '/liff/lottery') {
  const safeLiffId = typeof liffId === 'string' ? liffId.trim() : '';
  const resolved =
    typeof expressPath === 'string' && expressPath.startsWith('/') ? expressPath : fallbackExpressPath;
  if (!safeLiffId) return resolved;
  const suffix = liffPermalinkSuffixFromExpressPath(resolved, fallbackExpressPath);
  const safeSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `https://liff.line.me/${encodeURIComponent(safeLiffId)}${safeSuffix}`;
}

module.exports = { buildLiffPermanentUrl };
