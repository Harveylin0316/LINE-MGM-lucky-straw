/**
 * D0 歡迎訊息 — 測試端點（讓 admin 在開啟全自動前先驗證）
 *
 *   GET  /admin/d0/preview     看 D0 Flex JSON + 目前設定（enabled / cta url）
 *   POST /admin/d0/test-send   發 D0 給自己（或指定 test_line_user_id）
 *
 * 正式自動發送在 lineWebhook 的 follow 事件，gated by env D0_WELCOME_ENABLED=1。
 */

function registerAdminD0Routes(app, deps) {
  const { query, authCore, linePush, lineChannelAccessToken, d0Welcome } = deps;
  const { requireAdmin } = authCore;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 有按鈕的測試頁（不用 console）
  app.get('/admin/d0', requireAdmin, (_req, res) => {
    const enabled = d0Welcome.isEnabled();
    const ctaUrl = d0Welcome.getCtaUrl();
    const bodyLinesHtml = d0Welcome.BODY_LINES
      .map(l => `<p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#4B5563;">${esc(l)}</p>`)
      .join('');
    res.type('text/html').send(`<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>D0 歡迎訊息測試</title>
<style>
  body{margin:0;background:#f9fafb;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Microsoft JhengHei",sans-serif;line-height:1.6;}
  .wrap{max-width:560px;margin:0 auto;padding:40px 20px 80px;}
  h1{font-size:22px;margin:0 0 4px;}
  .sub{color:#6b7280;font-size:13px;margin:0 0 28px;}
  .status{border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;font-size:13px;color:#374151;margin-bottom:24px;background:#fff;}
  .status b{color:#1f2937;}
  .label{font-size:12px;color:#6b7280;letter-spacing:.04em;margin:0 0 8px;}
  .card{max-width:320px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:0 0 28px;}
  .card .bar{height:6px;background:#FCC726;}
  .card .in{padding:18px 20px;}
  .card .brand{font-size:13px;font-weight:700;color:#1f2937;margin:0 0 6px;}
  .card .title{font-size:19px;font-weight:700;color:#1f2937;margin:0 0 14px;}
  .card .btn{margin-top:6px;background:#FCC726;color:#1f2937;font-weight:700;text-align:center;padding:12px;border-radius:10px;font-size:15px;}
  .send{width:100%;padding:14px;background:#1f2937;color:#fff;border:0;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;}
  .send:disabled{opacity:.5;cursor:default;}
  .field{margin:0 0 16px;}
  .field input{width:100%;padding:11px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;}
  .field .hint{font-size:12px;color:#9ca3af;margin-top:6px;}
  #result{margin-top:16px;font-size:14px;min-height:20px;}
  .ok{color:#15803d;} .err{color:#b91c1c;}
</style></head>
<body><div class="wrap">
  <h1>D0 歡迎訊息測試</h1>
  <p class="sub">按按鈕把這張卡片發到你的 LINE 看實際長相，不會發給其他人。</p>

  <div class="status">
    目前自動發送：<b>${enabled ? '已開啟' : '尚未開啟（測試完再開）'}</b><br>
    按鈕連結：<b>${esc(ctaUrl)}</b>
  </div>

  <p class="label">卡片預覽</p>
  <div class="card">
    <div class="bar"></div>
    <div class="in">
      <div class="brand">OpenRice 開飯喇</div>
      <div class="title">${esc(d0Welcome.TITLE)}</div>
      ${bodyLinesHtml}
      <div class="btn">${esc(d0Welcome.CTA_LABEL)}</div>
    </div>
  </div>

  <p class="label">發測試到這個 LINE 帳號</p>
  <div class="field">
    <input id="uid" value="U3eca22d67d352c4db1428decf3ebcf14" placeholder="LINE userId（預設你自己）">
    <div class="hint">預設填你的 LINE userId，要發給別人可換掉。</div>
  </div>
  <button class="send" id="btn">發測試到我的 LINE</button>
  <div id="result"></div>

  <script>
    var btn=document.getElementById('btn'),out=document.getElementById('result');
    btn.addEventListener('click',function(){
      var uid=document.getElementById('uid').value.trim();
      btn.disabled=true;out.textContent='送出中…';out.className='';
      fetch('/admin/d0/test-send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({test_line_user_id:uid})})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.ok){out.className='ok';out.textContent='已送出，請看你的 LINE。';}
          else{out.className='err';out.textContent='失敗：'+(d.error||'')+(d.detail?'（'+d.detail+'）':'');}
        })
        .catch(function(e){btn.disabled=false;out.className='err';out.textContent='網路錯誤：'+e.message;});
    });
  </script>
</div></body></html>`);
  });

  app.get('/admin/d0/preview', requireAdmin, (_req, res) => {
    try {
      const flex = d0Welcome.buildD0WelcomeMessage();
      return res.json({
        ok: true,
        enabled: d0Welcome.isEnabled(),
        cta_url: d0Welcome.getCtaUrl(),
        flex
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'preview_failed', detail: err && err.message });
    }
  });

  app.post('/admin/d0/test-send', requireAdmin, async (req, res) => {
    try {
      if (!lineChannelAccessToken) return res.status(400).json({ ok: false, error: 'no_line_channel_access_token' });
      const body = req.body || {};
      let lineTo = String(body.test_line_user_id || '').trim();
      let userId = null;
      if (lineTo) {
        if (!/^U[0-9a-f]{32}$/i.test(lineTo)) return res.status(400).json({ ok: false, error: 'invalid_line_user_id' });
      } else {
        const uRs = await query('SELECT line_user_id FROM users WHERE id = $1', [req.authUser.uid]);
        lineTo = String(uRs.rows[0]?.line_user_id || '').trim();
        userId = req.authUser.uid;
      }
      if (!lineTo) return res.status(400).json({ ok: false, error: 'no_recipient_self_has_no_line_id' });

      const flex = d0Welcome.buildD0WelcomeMessage();
      const pushed = await linePush.pushLineMessages(lineTo, [flex], { userId, pushType: 'd0_welcome_test' });
      if (!pushed) return res.status(500).json({ ok: false, error: 'push_failed' });
      return res.json({ ok: true, sentTo: lineTo });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'test_send_failed', detail: err && err.message });
    }
  });
}

module.exports = { registerAdminD0Routes };
