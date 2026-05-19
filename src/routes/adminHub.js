/**
 * 活動 hub 頁面 routes
 *
 * 每個活動都對應一個 hub 頁面（譬如 /admin/campaigns/spring），
 * 在那裡列出該活動相關的所有運營工具。CRM nav 只放一顆 button 進來。
 *
 * 未來新活動時，新建 view + 在這裡加 route 即可，不污染 web.js。
 */

function registerAdminHubRoutes(app, deps) {
  const { authCore } = deps;
  const { requireAdmin } = authCore;

  app.get('/admin/campaigns/spring', requireAdmin, (req, res) => {
    return res.render('admin_campaign_spring', {
      title: '春日饗里活動',
      bodyClass: 'admin-shell campaign-hub-shell',
      user: (req.authUser && req.authUser.un) || '',
      isAdmin: true
    });
  });
}

module.exports = { registerAdminHubRoutes };
