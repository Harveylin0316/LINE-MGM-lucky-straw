/**
 * 電子豹 SureNotify 網域驗證助手
 *
 *   GET  /admin/email-domain                頁面
 *   POST /admin/email-domain/api/create     建立網域驗證 → 回傳要加的 DNS 記錄（SureNotify POST /v1/domains/{domain}）
 *   POST /admin/email-domain/api/verify      重新檢查驗證狀態（SureNotify PUT /v1/domains/{domain}）
 *
 * API key 來源：環境變數 SURENOTIFY_API_KEY（優先），否則從頁面輸入帶入（不儲存，僅該次轉發）。
 */
const SURENOTIFY_BASE = 'https://mail.surenotifyapi.com';

function registerAdminEmailDomainRoutes(app, deps) {
  const { authCore } = deps;
  const { requireAdmin } = authCore;

  function apiKeyFrom(body) {
    return String((body && body.apiKey) || process.env.SURENOTIFY_API_KEY || '').trim();
  }
  function domainFrom(body) {
    return String((body && body.domain) || '').trim().toLowerCase().replace(/[^a-z0-9.\-]/g, '');
  }

  async function callSureNotify(method, domain, apiKey) {
    const resp = await fetch(SURENOTIFY_BASE + '/v1/domains/' + encodeURIComponent(domain), {
      method: method,
      headers: { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' }
    });
    const text = await resp.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* ignore */ }
    return { status: resp.status, ok: resp.ok, data: data, raw: text };
  }

  app.get('/admin/email-domain', requireAdmin, (req, res) => {
    res.render('admin_email_domain', {
      title: 'Email 網域驗證',
      bodyClass: 'admin-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true,
      hasEnvKey: !!process.env.SURENOTIFY_API_KEY,
      defaultDomain: 'openrice.com.tw'
    });
  });

  async function handle(method, req, res) {
    const apiKey = apiKeyFrom(req.body);
    if (!apiKey) return res.status(400).json({ ok: false, error: 'no_api_key', detail: '缺 API key（請在環境變數設 SURENOTIFY_API_KEY，或在頁面填入）。' });
    const domain = domainFrom(req.body);
    if (!domain || domain.indexOf('.') < 0) return res.status(400).json({ ok: false, error: 'bad_domain', detail: '請填正確的網域，例如 openrice.com.tw。' });
    try {
      const r = await callSureNotify(method, domain, apiKey);
      if (!r.ok) {
        return res.status(502).json({
          ok: false, error: 'surenotify_error', status: r.status,
          detail: (r.data && (r.data.message || r.data.error)) || String(r.raw || '').slice(0, 300)
        });
      }
      return res.json({ ok: true, domain: domain, records: Array.isArray(r.data) ? r.data : [] });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'request_failed', detail: String(err && err.message || err).slice(0, 300) });
    }
  }

  app.post('/admin/email-domain/api/create', requireAdmin, (req, res) => handle('POST', req, res));
  app.post('/admin/email-domain/api/verify', requireAdmin, (req, res) => handle('PUT', req, res));
}

module.exports = { registerAdminEmailDomainRoutes };
