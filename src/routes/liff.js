const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getCampaignPhase } = require('../core/campaignWindow');

function normalizeLiffNextPath(rawNextPath, fallbackPath = '/liff/lottery') {
  if (typeof rawNextPath !== 'string') return fallbackPath;
  if (!rawNextPath.startsWith('/liff')) return fallbackPath;
  if (rawNextPath.startsWith('//')) return fallbackPath;
  return rawNextPath;
}

/**
 * Path segment after https://liff.line.me/{liffId}/ is appended to the LIFF Endpoint URL from LINE Console.
 * If Endpoint is https://host/liff, use /lottery or /inviteCode — not /liff/lottery (would become /liff/liff/...).
 * Set LIFF_ENDPOINT_IS_SITE_ROOT=1 when Endpoint is https://host (no /liff); then keep /liff/... here.
 */
function liffPermalinkSuffixFromExpressPath(expressPath, fallbackExpressPath = '/liff/lottery') {
  const p =
    typeof expressPath === 'string' && expressPath.startsWith('/')
      ? expressPath
      : fallbackExpressPath;
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

function isLineMobileClientRequest(req) {
  const userAgent = String(req.get('user-agent') || '');
  const hasLineToken = /Line\//i.test(userAgent);
  const isMobileOrTablet = /iPhone|iPad|Android/i.test(userAgent);
  return hasLineToken && isMobileOrTablet;
}

function generateShortInviteCode() {
  const num = crypto.randomInt(0, 36 ** 4);
  return num.toString(36).padStart(4, '0');
}

function registerLiffRoutes(app, deps) {
  const {
    query,
    pool,
    authCore,
    lotteryCore,
    viewStateCore,
    liffId,
    inviteBonusMax,
    lineOfficialAddFriendUrl,
    lineUserPasswordHashRounds,
    liffRedemptionNote,
    liffCampaignPageUrl,
    linePush,
    linePushPublicBaseUrl = ''
  } = deps;

  function safeHttpUrl(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.href;
    } catch {
      return '';
    }
  }

  const campaignPageUrlResolved = safeHttpUrl(liffCampaignPageUrl);
  const { pickPrizeByQuantity } = lotteryCore;
  const { signAuthToken, setAuthCookie, clearAuthCookie } = authCore;
  const hashRounds = Math.min(12, Math.max(4, Number(lineUserPasswordHashRounds || 6)));
  const inviteLimit = Math.max(0, Number.isFinite(Number(inviteBonusMax)) ? Number(inviteBonusMax) : 2);
  const defaultRedemptionNote =
    '1. 請開啟「OpenRice LINE@」對話視窗聯繫客服。\n' +
    '2. 提供本頁「我的中獎紀錄」截圖或中獎畫面截圖，並說明欲兌換的獎項。\n' +
    '3. 客服將依活動規則協助完成兌換（實際辦法以官方公告為準）。';

  function escapeHtmlText(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatWinTime(value) {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function redemptionNoteToHtml(note) {
    return String(note)
      .split(/\r?\n/)
      .map(line => escapeHtmlText(line) || '\u00a0')
      .join('<br>');
  }

  const {
    setDrawResultCookie,
    consumeDrawResultCookie,
    invalidateAvailablePrizesCache,
    getAvailablePrizes
  } = viewStateCore;

  async function fetchLineProfile(accessToken) {
    const response = await fetch('https://api.line.me/v2/profile', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      return null;
    }
    return response.json();
  }

  function buildLineUsernameBase(lineUserId) {
    const cleaned = String(lineUserId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const suffix = cleaned.slice(-12) || crypto.randomBytes(4).toString('hex');
    return `line_${suffix}`;
  }

  async function findUniqueLineUsername(client, lineUserId) {
    const base = buildLineUsernameBase(lineUserId);
    for (let i = 0; i < 100; i += 1) {
      const candidate = i === 0 ? base : `${base}_${i}`;
      const exists = await client.query('SELECT id FROM users WHERE username = $1', [candidate]);
      if (exists.rowCount === 0) return candidate;
    }
    return `line_${crypto.randomBytes(8).toString('hex')}`;
  }

  async function upsertLineUser(client, profile) {
    const existing = await client.query('SELECT id, username, is_admin FROM users WHERE line_user_id = $1 FOR UPDATE', [
      profile.userId
    ]);
    if (existing.rowCount > 0) {
      await client.query('UPDATE users SET line_display_name = $1, line_picture_url = $2 WHERE id = $3', [
        profile.displayName || null,
        profile.pictureUrl || null,
        existing.rows[0].id
      ]);
      return existing.rows[0];
    }

    const username = await findUniqueLineUsername(client, profile.userId);
    const randomPassword = crypto.randomBytes(24).toString('hex');
    // LINE users do not authenticate with a typed password in this flow;
    // use a lower cost factor to reduce first-login latency.
    const passwordHash = await bcrypt.hash(randomPassword, hashRounds);
    const inserted = await client.query(
      `INSERT INTO users (username, password_hash, draws_left, extra_draws, is_admin, line_user_id, line_display_name, line_picture_url)
       VALUES ($1, $2, 1, 0, false, $3, $4, $5)
       RETURNING id, username, is_admin`,
      [username, passwordHash, profile.userId, profile.displayName || null, profile.pictureUrl || null]
    );
    return inserted.rows[0];
  }

  async function bindInviteIntent(inviterUserId, inviteeUserId) {
    if (!Number.isInteger(inviterUserId) || inviterUserId <= 0) return 'invalid_ref';
    if (!Number.isInteger(inviteeUserId) || inviteeUserId <= 0) return 'invalid_user';
    if (inviterUserId === inviteeUserId) return 'self_ref';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inviteeRs = await client.query('SELECT line_user_id FROM users WHERE id = $1 FOR UPDATE', [inviteeUserId]);
      if (inviteeRs.rowCount === 0 || !inviteeRs.rows[0].line_user_id) {
        await client.query('ROLLBACK');
        return 'missing_line_account';
      }

      const inviterRs = await client.query('SELECT id FROM users WHERE id = $1', [inviterUserId]);
      if (inviterRs.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'invalid_ref';
      }

      const inviteeLineUserId = inviteeRs.rows[0].line_user_id;
      const inserted = await client.query(
        `INSERT INTO line_invites (inviter_user_id, invitee_line_user_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (invitee_line_user_id) DO NOTHING
         RETURNING id`,
        [inviterUserId, inviteeLineUserId]
      );
      if (inserted.rowCount > 0) {
        await client.query('COMMIT');
        return 'bound';
      }

      const existing = await client.query(
        'SELECT inviter_user_id, status FROM line_invites WHERE invitee_line_user_id = $1',
        [inviteeLineUserId]
      );
      await client.query('COMMIT');
      if (existing.rowCount === 0) return 'exists';
      const row = existing.rows[0];
      if (Number(row.inviter_user_id) === inviterUserId) {
        if (row.status === 'rewarded') return 'already_rewarded';
        if (row.status === 'capped') return 'already_capped';
        return 'already_bound';
      }
      return 'bound_other';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function resolveInviterUserId(refValue) {
    if (typeof refValue !== 'string' || !refValue.trim()) return null;
    const normalized = refValue.trim();
    const codeRs = await query('SELECT id FROM users WHERE invite_code = $1', [normalized]);
    if (codeRs.rowCount > 0) return Number(codeRs.rows[0].id);

    // Backward compatibility for old numeric links that were already shared.
    if (/^\d+$/.test(normalized)) {
      const fallbackId = Number.parseInt(normalized, 10);
      if (Number.isFinite(fallbackId) && fallbackId > 0) return fallbackId;
    }
    return null;
  }

  /**
   * @param {number} userId
   * @param {string|null|undefined} knownInviteCode 若已由其他查詢帶出，可略過開頭 SELECT
   */
  async function ensureInviteCode(userId, knownInviteCode) {
    let currentCode;
    if (knownInviteCode !== undefined) {
      currentCode = String(knownInviteCode ?? '').trim();
    } else {
      const found = await query('SELECT invite_code FROM users WHERE id = $1', [userId]);
      if (found.rowCount === 0) return null;
      currentCode = String(found.rows[0]?.invite_code || '').trim();
    }
    if (/^[a-z0-9]{4}$/i.test(currentCode)) return currentCode;

    for (let i = 0; i < 40; i += 1) {
      const candidate = generateShortInviteCode();
      try {
        const updated = await query(
          'UPDATE users SET invite_code = $1 WHERE id = $2 AND invite_code IS NOT DISTINCT FROM $3 RETURNING invite_code',
          [candidate, userId, currentCode || null]
        );
        if (updated.rowCount > 0) return updated.rows[0].invite_code;
        const latest = await query('SELECT invite_code FROM users WHERE id = $1', [userId]);
        const latestCode = String(latest.rows[0]?.invite_code || '').trim();
        if (/^[a-z0-9]{4}$/i.test(latestCode)) return latestCode;
        currentCode = latestCode;
      } catch (err) {
        if (err?.code !== '23505') throw err;
      }
    }
    return null;
  }

  async function getInviteStats(inviterUserId) {
    const rows = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'rewarded')::int AS rewarded_count,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
       FROM line_invites
       WHERE inviter_user_id = $1`,
      [inviterUserId]
    );
    return rows.rows[0] || { rewarded_count: 0, pending_count: 0 };
  }

  async function getLineLinkedUser(userId) {
    if (!Number.isInteger(Number(userId))) return null;
    const rs = await query('SELECT id, username, line_user_id FROM users WHERE id = $1', [userId]);
    if (rs.rowCount === 0) return null;
    return rs.rows[0];
  }

  async function requireLiffLogin(req, res, next) {
    try {
      if (!isLineMobileClientRequest(req)) {
        return res.redirect('/liff/login?reason=line_client_only');
      }
      if (req.authUser && req.authUser.uid) {
        const lineUser = await getLineLinkedUser(req.authUser.uid);
        if (lineUser && lineUser.line_user_id) {
          return next();
        }
        clearAuthCookie(res);
        return res.redirect('/liff/login?reason=line_only');
      }
      const nextPath = normalizeLiffNextPath(req.originalUrl, '/liff/lottery');
      return res.redirect(`/liff/login?next=${encodeURIComponent(nextPath)}`);
    } catch (err) {
      return next(err);
    }
  }

  /** 刮刮樂首屏：一次查 users + 邀請統計，取代 requireLiffLogin + 重複 users / line_invites 查詢 */
  async function requireLiffLotteryPage(req, res, next) {
    try {
      if (!isLineMobileClientRequest(req)) {
        return res.redirect('/liff/login?reason=line_client_only');
      }
      if (!req.authUser?.uid) {
        const nextPath = normalizeLiffNextPath(req.originalUrl, '/liff/lottery');
        return res.redirect(`/liff/login?next=${encodeURIComponent(nextPath)}`);
      }
      const uid = Number(req.authUser.uid);
      if (!Number.isFinite(uid) || uid <= 0) {
        clearAuthCookie(res);
        return res.redirect('/liff/login?reason=line_only');
      }
      const rs = await query(
        `SELECT u.draws_left,
                u.extra_draws,
                u.line_user_id,
                u.line_display_name,
                u.username,
                u.invite_code,
                COALESCE(
                  (SELECT COUNT(*) FILTER (WHERE li.status = 'rewarded')::int
                   FROM line_invites li
                   WHERE li.inviter_user_id = u.id),
                  0
                ) AS rewarded_count,
                COALESCE(
                  (SELECT COUNT(*) FILTER (WHERE li.status = 'pending')::int
                   FROM line_invites li
                   WHERE li.inviter_user_id = u.id),
                  0
                ) AS pending_count
         FROM users u
         WHERE u.id = $1`,
        [uid]
      );
      if (rs.rowCount === 0 || !rs.rows[0].line_user_id) {
        clearAuthCookie(res);
        return res.redirect('/liff/login?reason=line_only');
      }
      req.liffLotteryContext = rs.rows[0];
      return next();
    } catch (err) {
      return next(err);
    }
  }

  app.get('/liff', (_req, res) => {
    res.redirect('/liff/lottery');
  });

  app.get('/liff/login', async (req, res, next) => {
    try {
      if (req.authUser && req.authUser.uid) {
        const lineUser = await getLineLinkedUser(req.authUser.uid);
        if (lineUser && lineUser.line_user_id) return res.redirect('/liff/lottery');
        clearAuthCookie(res);
      }
      const nextPath = normalizeLiffNextPath(req.query.next, '/liff/lottery');
      const reason = typeof req.query.reason === 'string' ? req.query.reason : '';
      return res.render('liff_login', { nextPath, liffId: liffId || '', reason });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/liff/auth', async (req, res) => {
    const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken : '';
    const nextPath = normalizeLiffNextPath(req.body?.nextPath, '/liff/lottery');
    if (!accessToken) {
      return res.status(400).json({ ok: false, error: 'missing_access_token' });
    }

    const profile = await fetchLineProfile(accessToken);
    if (!profile || !profile.userId) {
      return res.status(401).json({ ok: false, error: 'invalid_line_access_token' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await upsertLineUser(client, profile);
      await client.query('COMMIT');
      const token = signAuthToken(user);
      setAuthCookie(res, token);
      return res.json({ ok: true, redirect: nextPath });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('LIFF auth failed:', err.message);
      return res.status(500).json({ ok: false, error: 'liff_auth_failed' });
    } finally {
      client.release();
    }
  });

  app.post('/liff/logout', (_req, res) => {
    clearAuthCookie(res);
    return res.redirect('/liff/login');
  });

  async function handleInviteLanding(req, res, next) {
    try {
      const refUserId = await resolveInviterUserId(req.params.refUserId);
      const bindResult = await bindInviteIntent(refUserId, Number(req.authUser.uid));
      if (bindResult === 'bound') {
        return res.render('liff_invite_confirm', {
          user: req.authUser.un,
          lineOfficialAddFriendUrl: lineOfficialAddFriendUrl || '',
          statusText: '綁定成功！若您尚未加入 OpenRice LINE@，請點下方按鈕加好友以完成任務（僅限尚未加入者）。'
        });
      } else if (bindResult === 'self_ref') {
        setDrawResultCookie(res, '不能邀請自己。');
      } else if (bindResult === 'already_rewarded') {
        setDrawResultCookie(res, '你已完成過邀請任務。');
      } else if (bindResult === 'already_bound') {
        return res.render('liff_invite_confirm', {
          user: req.authUser.un,
          lineOfficialAddFriendUrl: lineOfficialAddFriendUrl || '',
          statusText: '你已綁定過此邀請關係。若尚未加入 OpenRice LINE@，可點下方按鈕加好友（僅限尚未加入者才能完成邀請任務）。'
        });
      } else if (bindResult === 'bound_other') {
        setDrawResultCookie(res, '你已綁定其他邀請，無法重複綁定。');
      } else if (bindResult === 'already_capped') {
        setDrawResultCookie(res, '邀請人的好友加碼已達上限，無法再發放次數。');
      } else if (bindResult === 'missing_line_account') {
        setDrawResultCookie(res, '無法取得 LINE 帳號，請重新登入後再試。');
      } else if (bindResult === 'invalid_ref') {
        setDrawResultCookie(res, '邀請連結無效或已失效。');
      } else {
        setDrawResultCookie(res, '邀請連結無效或無法綁定。');
      }
      return res.redirect('/liff/lottery');
    } catch (err) {
      next(err);
    }
  }

  app.get('/liff/lottery', requireLiffLotteryPage, async (req, res, next) => {
    try {
      const row = req.liffLotteryContext || {};
      const [availablePrizes, winsRs, campaignRs] = await Promise.all([
        getAvailablePrizes(),
        query(
          `SELECT prize_name, message, created_at
           FROM draw_logs
           WHERE user_id = $1 AND is_win = true
           ORDER BY id DESC
           LIMIT 30`,
          [req.authUser.uid]
        ),
        query('SELECT starts_at, ends_at FROM campaign_settings WHERE id = 1')
      ]);
      const campaignPhase = getCampaignPhase(campaignRs.rows[0] || null);
      const drawResult = consumeDrawResultCookie(req, res);
      const inviteCode = await ensureInviteCode(req.authUser.uid, row.invite_code);
      const invitePath = inviteCode ? `/liff/${encodeURIComponent(inviteCode)}` : '/liff/lottery';
      const inviteLink = buildLiffPermanentUrl(liffId, invitePath, '/liff/lottery');
      const redemptionNoteRaw =
        typeof liffRedemptionNote === 'string' && liffRedemptionNote.trim()
          ? liffRedemptionNote.trim()
          : defaultRedemptionNote;
      const recentWins = (winsRs.rows || []).map(r => ({
        prizeName: escapeHtmlText(r.prize_name || '獎項'),
        atText: escapeHtmlText(formatWinTime(r.created_at))
      }));
      res.render('liff_lottery', {
        user: req.authUser.un,
        result: drawResult,
        drawsLeft: row.draws_left || 0,
        extraDraws: row.extra_draws || 0,
        displayName: row.line_display_name || row.username || req.authUser.un,
        availablePrizes,
        inviteLink,
        rewardedInviteCount: Number(row.rewarded_count) || 0,
        pendingInviteCount: Number(row.pending_count) || 0,
        inviteBonusMax: inviteLimit,
        lineOfficialAddFriendUrl: lineOfficialAddFriendUrl || '',
        liffId: liffId || '',
        recentWins,
        redemptionNoteHtml: redemptionNoteToHtml(redemptionNoteRaw),
        campaignPageUrl: campaignPageUrlResolved,
        campaignPhase
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/liff/lottery/draw', requireLiffLogin, async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRs = await client.query('SELECT draws_left, line_user_id FROM users WHERE id = $1 FOR UPDATE', [req.authUser.uid]);
      if (userRs.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/liff/lottery');
      }

      const currentLeft = Number(userRs.rows[0].draws_left || 0);
      if (currentLeft <= 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '您的刮刮樂次數已用完');
        return res.redirect('/liff/lottery');
      }

      const campaignRs = await client.query('SELECT starts_at, ends_at FROM campaign_settings WHERE id = 1');
      const drawCampaignPhase = getCampaignPhase(campaignRs.rows[0] || null);
      if (drawCampaignPhase !== 'active') {
        await client.query('ROLLBACK');
        const msg = drawCampaignPhase === 'not_started' ? '活動尚未開始' : '活動已經結束';
        setDrawResultCookie(res, msg);
        return res.redirect('/liff/lottery');
      }

      const prizeRs = await client.query(
        "SELECT id, name, quantity FROM prizes WHERE quantity > 0 AND name !~* '^\\s*test\\b' ORDER BY id ASC FOR UPDATE"
      );
      if (prizeRs.rowCount === 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '系統維護中，請稍後再試或於官方帳號 LINE@ 回報');
        return res.redirect('/liff/lottery');
      }

      const picked = pickPrizeByQuantity(prizeRs.rows);
      const lineUserId = userRs.rows[0]?.line_user_id || null;
      await client.query('UPDATE prizes SET quantity = quantity - 1 WHERE id = $1 AND quantity > 0', [picked.id]);
      await client.query('UPDATE users SET draws_left = draws_left - 1 WHERE id = $1', [req.authUser.uid]);
      const message = `恭喜中獎！獲得：${picked.name}`;
      await client.query(
        'INSERT INTO draw_logs (user_id, is_win, prize_name, message) VALUES ($1, true, $2, $3)',
        [req.authUser.uid, picked.name, message]
      );
      const drawCountRs = await client.query(
        'SELECT COUNT(*)::int AS c FROM draw_logs WHERE user_id = $1',
        [req.authUser.uid]
      );
      const totalDrawsSoFar = Number(drawCountRs.rows[0]?.c || 0);
      await client.query('COMMIT');

      const inviteStats = await getInviteStats(req.authUser.uid);
      const rewardedCount = Number(inviteStats?.rewarded_count || 0);
      const remainingInviteBonus = Math.max(0, inviteLimit - rewardedCount);
      const inviteCode = await ensureInviteCode(req.authUser.uid);
      const invitePath = inviteCode ? `/liff/${encodeURIComponent(inviteCode)}` : '/liff/lottery';
      const inviteLink = buildLiffPermanentUrl(liffId, invitePath, '/liff/lottery');

      const firstMessage = `🌸 春日野餐祭中獎通知\n恭喜你刮中：${picked.name}`;
      const drawsAfterThis = currentLeft - 1;
      const pushMessages = [firstMessage];
      const picnicImagePathByDraw = {
        1: '/images/picnic-basket-001.png',
        2: '/images/picnic-basket-002.png',
        3: '/images/picnic-basket-003.png'
      };
      const picnicPath =
        typeof linePushPublicBaseUrl === 'string' && linePushPublicBaseUrl.trim()
          ? picnicImagePathByDraw[totalDrawsSoFar]
          : '';
      if (picnicPath) {
        const imageUrl = `${linePushPublicBaseUrl.trim().replace(/\/+$/, '')}${picnicPath}`;
        pushMessages.push({
          type: 'image',
          originalContentUrl: imageUrl,
          previewImageUrl: imageUrl
        });
      }
      if (remainingInviteBonus > 0) {
        let secondMessage;
        if (drawsAfterThis === 0) {
          secondMessage =
            '你的春日刮刮樂次數已用完。尚餘好友加碼名額，邀請尚未加入 OpenRice LINE@ 的好友完成任務，即可再獲刮刮樂機會！';
        } else {
          secondMessage = `你還可透過邀請好友加入 OpenRice LINE@，再獲得 ${remainingInviteBonus} 次刮刮樂機會。`;
        }
        if (inviteLink) {
          secondMessage += `\n\n分享你的專屬邀請連結：\n${inviteLink}`;
        }
        pushMessages.push(secondMessage);
      } else if (drawsAfterThis === 0) {
        pushMessages.push('你的春日刮刮樂次數已用完，好友加碼名額也已用罄。感謝參與春日野餐祭！');
      }
      // 加碼用罄且仍有刮次：僅推播中獎（刮次優先，不另述加碼狀態）。
      // Keep scratch-card UX responsive: send LINE push in background.
      Promise.resolve()
        .then(() =>
          linePush.pushLineMessages(lineUserId, pushMessages, {
            userId: req.authUser.uid,
            pushType: 'winner_notification',
            prizeName: picked.name,
            remainingInviteBonus,
            drawsAfterThis,
            inviteLink
          })
        )
        .catch(err => {
          console.error('LINE push async task failed:', err.message);
        });

      invalidateAvailablePrizesCache();
      setDrawResultCookie(res, message);
      return res.redirect('/liff/lottery');
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  });

  // Keep this after concrete LIFF routes to avoid route shadowing.
  // New shortest invite URL pattern under LIFF endpoint.
  app.get('/liff/:refUserId', requireLiffLogin, handleInviteLanding);
  // Backward compatibility for previously shared links.
  app.get('/liff/r/:refUserId', requireLiffLogin, handleInviteLanding);
}

module.exports = { registerLiffRoutes };
