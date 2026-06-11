/**
 * LIFF ID Token 驗證 — 向 LINE 驗證前端送來的 id token，取得「無法被偽造」的真實 userId。
 *   POST https://api.line.me/oauth2/v2.1/verify  (id_token, client_id=該 LIFF 的 Login channel id)
 *     200 → 回 { sub, aud, ... }，sub 即該用戶在此 channel 的 userId
 *     其他 → 驗證失敗（過期/偽造/client_id 不符）
 *
 * channelId = LIFF id 破折號前那段（例：2008944358-649rLhGj → 2008944358）。
 */
function channelIdFromLiffId(liffId) {
  const s = String(liffId || '').trim();
  const i = s.indexOf('-');
  return i > 0 ? s.slice(0, i) : '';
}

async function verifyLiffIdToken(idToken, channelId) {
  const tok = String(idToken || '').trim();
  const cid = String(channelId || '').trim();
  if (!tok) return { ok: false, reason: 'no_token' };
  if (!cid) return { ok: false, reason: 'no_channel_id' };
  try {
    const body = new URLSearchParams();
    body.set('id_token', tok);
    body.set('client_id', cid);
    const resp = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (resp.status !== 200) {
      const t = await resp.text().catch(() => '');
      return { ok: false, reason: 'verify_failed', status: resp.status, detail: String(t).slice(0, 200) };
    }
    const data = await resp.json();
    return { ok: true, sub: data.sub || null, aud: data.aud || null };
  } catch (e) {
    return { ok: false, reason: 'error', detail: String(e && e.message || e).slice(0, 200) };
  }
}

module.exports = { verifyLiffIdToken, channelIdFromLiffId };
