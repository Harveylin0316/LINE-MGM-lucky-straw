/**
 * 所有遊戲類型的統一註冊入口
 *
 * 1. /games/ 跟 /games landing — LIFF Endpoint URL 入口（含 liff.state 處理）
 * 2. 個別 game type 路由（透過 gamesGeneric.registerGameType 註冊）
 *
 * 新增遊戲類型只要加一行 registerGameType 就好。
 */
const { registerGameType, registerWalletApi } = require('./gamesGeneric');

function registerGamesRoutes(app, deps) {
  const { query, pool } = deps;
  const defaultLiffId =
    process.env.GAMES_LIFF_ID || process.env.WHEEL_LIFF_ID || process.env.LIFF_ID || '';

  // ----- /games landing（含 LIFF dispatcher）-----
  const gamesLanding = async (req, res) => {
    // Server-side LIFF dispatcher：?liff.state=%2Fwheel%2Fxxx → 302 redirect
    const liffState = req.query && req.query['liff.state'];
    if (typeof liffState === 'string' && liffState) {
      try {
        const decoded = decodeURIComponent(liffState);
        const targetPath = '/games' + (decoded.startsWith('/') ? decoded : '/' + decoded);
        const otherParams = Object.entries(req.query)
          .filter(([k]) => k !== 'liff.state')
          .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
          .join('&');
        const final = otherParams
          ? targetPath + (targetPath.includes('?') ? '&' : '?') + otherParams
          : targetPath;
        return res.redirect(302, final);
      } catch (_e) { /* fall through */ }
    }
    res.setHeader('Cache-Control', 'no-store');
    let activities = [];
    try {
      const { rows } = await query(
        `SELECT slug, name, description, game_type, cover_image_url,
                start_at, end_at, liff_id_override
         FROM activities
         WHERE status = 'active'
           AND (start_at IS NULL OR start_at <= NOW())
           AND (end_at IS NULL OR end_at >= NOW())
         ORDER BY created_at DESC LIMIT 20`
      );
      activities = rows;
    } catch (e) {
      console.error('games landing query failed:', e && e.message);
    }
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const gameLabel = (t) => ({
      wheel: '輪盤抽獎', fortune: '每日抽籤', scratch: '刮刮樂', slot: '老虎機'
    })[t] || t;
    const cardsHtml = activities.length === 0
      ? `<div class="empty">目前沒有進行中的活動，請稍後再回來看看。</div>`
      : activities.map(a => {
          const cover = a.cover_image_url
            ? `<div class="cover" style="background-image:url('${esc(a.cover_image_url)}')"></div>`
            : `<div class="cover cover-default">${esc(a.name.slice(0, 2))}</div>`;
          const liffIdForThis = (a.liff_id_override && a.liff_id_override.trim()) || defaultLiffId;
          const link = liffIdForThis
            ? `https://liff.line.me/${liffIdForThis}/${esc(a.game_type)}/${encodeURIComponent(a.slug)}`
            : `/games/${esc(a.game_type)}/${encodeURIComponent(a.slug)}`;
          return `<a class="act-card" href="${link}">
            ${cover}
            <div class="info">
              <div class="title">${esc(a.name)}</div>
              <div class="type">${gameLabel(a.game_type)}</div>
              ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
            </div>
            <div class="arrow">›</div>
          </a>`;
        }).join('');
    res.send(`<!DOCTYPE html>
<html lang="zh-Hant"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenRice LINE 活動</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Microsoft JhengHei",sans-serif;
    background:#FAFAFA;color:#0F0F10;padding:24px 16px 40px;letter-spacing:-0.01em;}
  .wrap{max-width:480px;margin:0 auto;}
  h1{margin:8px 0 4px;font-size:24px;text-align:center;font-weight:700;letter-spacing:-0.02em;}
  .sub{margin:0 0 24px;color:#6B6B70;font-size:13px;text-align:center;}
  .act-card{display:flex;align-items:center;gap:12px;padding:14px;margin-bottom:10px;
    background:#FFFFFF;border:1px solid #ECECEE;border-radius:16px;text-decoration:none;color:inherit;
    transition:transform .15s,border-color .15s;}
  .act-card:active{transform:scale(0.99);}
  .act-card:hover{border-color:#D8D8DC;}
  .cover{flex-shrink:0;width:56px;height:56px;border-radius:12px;background:#FCC726;
    background-size:cover;background-position:center;
    display:flex;align-items:center;justify-content:center;
    font-weight:700;font-size:18px;color:#0F0F10;}
  .info{flex:1;min-width:0;}
  .title{font-weight:600;font-size:15px;letter-spacing:-0.012em;}
  .type{font-size:11px;color:#6B6B70;background:#F4F4F6;padding:2px 8px;border-radius:9999px;
    display:inline-block;margin-top:3px;font-weight:500;}
  .desc{margin-top:5px;color:#6B6B70;font-size:12px;line-height:1.5;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .arrow{flex-shrink:0;color:#A0A0A6;font-size:24px;line-height:1;}
  .empty{padding:36px 20px;text-align:center;color:#6B6B70;background:#FFFFFF;
    border:1px solid #ECECEE;border-radius:16px;}
</style></head><body>
<div class="wrap">
  <h1>OpenRice LINE 活動</h1>
  <p class="sub">選一個來玩吧</p>
  ${cardsHtml}
</div>
</body></html>`);
  };
  app.get('/games', gamesLanding);
  app.get('/games/', gamesLanding);

  // ----- 我的優惠券 錢包頁（LIFF 永久連結 /wallet → /games/wallet）-----
  app.get('/games/wallet', (req, res) => {
    res.render('game_wallet', {
      title: '我的優惠券 — OpenRice LINE',
      liffId: defaultLiffId
    });
  });

  // ----- 註冊所有遊戲類型 + 錢包 API -----
  const sharedOpts = { defaultLiffId };
  registerWalletApi(app, Object.assign({}, deps, { defaultLiffId }));
  registerGameType(app, deps, Object.assign({ gameType: 'wheel',   viewName: 'game_wheel'   }, sharedOpts));
  registerGameType(app, deps, Object.assign({ gameType: 'fortune', viewName: 'game_fortune' }, sharedOpts));
  registerGameType(app, deps, Object.assign({ gameType: 'scratch', viewName: 'game_scratch' }, sharedOpts));
  registerGameType(app, deps, Object.assign({ gameType: 'slot',    viewName: 'game_slot'    }, sharedOpts));
}

module.exports = { registerGamesRoutes };
