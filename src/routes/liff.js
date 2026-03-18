const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function normalizeLiffNextPath(rawNextPath, fallbackPath = '/liff/lottery') {
  if (typeof rawNextPath !== 'string') return fallbackPath;
  if (!rawNextPath.startsWith('/liff')) return fallbackPath;
  if (rawNextPath.startsWith('//')) return fallbackPath;
  return rawNextPath;
}

function buildLiffPermanentUrl(liffId, routePath, fallbackPath = '/liff/lottery') {
  const safeLiffId = typeof liffId === 'string' ? liffId.trim() : '';
  const safeRoutePath = typeof routePath === 'string' && routePath.startsWith('/') ? routePath : fallbackPath;
  if (!safeLiffId) return safeRoutePath;
  return `https://liff.line.me/${encodeURIComponent(safeLiffId)}${safeRoutePath}`;
}

function registerLiffRoutes(app, deps) {
  const {
    query,
    pool,
    authCore,
    lotteryCore,
    viewStateCore,
    liffId,
    lineOfficialAddFriendUrl,
    lineUserPasswordHashRounds
  } = deps;
  const { pickPrizeByQuantity } = lotteryCore;
  const { signAuthToken, setAuthCookie, clearAuthCookie } = authCore;
  const hashRounds = Math.min(12, Math.max(4, Number(lineUserPasswordHashRounds || 6)));
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

  async function ensureInviteCode(userId) {
    const found = await query('SELECT invite_code FROM users WHERE id = $1', [userId]);
    if (found.rowCount === 0) return null;
    const current = found.rows[0]?.invite_code;
    if (current) return current;

    for (let i = 0; i < 8; i += 1) {
      const candidate = crypto.randomBytes(9).toString('base64url');
      try {
        const updated = await query(
          'UPDATE users SET invite_code = $1 WHERE id = $2 AND (invite_code IS NULL OR invite_code = \'\') RETURNING invite_code',
          [candidate, userId]
        );
        if (updated.rowCount > 0) return updated.rows[0].invite_code;
        const latest = await query('SELECT invite_code FROM users WHERE id = $1', [userId]);
        if (latest.rowCount > 0 && latest.rows[0]?.invite_code) return latest.rows[0].invite_code;
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

  app.get('/liff/r/:refUserId', requireLiffLogin, async (req, res, next) => {
    try {
      const refUserId = await resolveInviterUserId(req.params.refUserId);
      const bindResult = await bindInviteIntent(refUserId, Number(req.authUser.uid));
      if (bindResult === 'bound') {
        return res.render('liff_invite_confirm', {
          user: req.authUser.un,
          lineOfficialAddFriendUrl: lineOfficialAddFriendUrl || '',
          statusText: '綁定成功！下一步請手動點擊按鈕加入官方 LINE@ 完成任務。'
        });
      } else if (bindResult === 'self_ref') {
        setDrawResultCookie(res, '不能邀請自己。');
      } else if (bindResult === 'already_rewarded') {
        setDrawResultCookie(res, '你已完成過邀請任務。');
      } else if (bindResult === 'already_bound') {
        return res.render('liff_invite_confirm', {
          user: req.authUser.un,
          lineOfficialAddFriendUrl: lineOfficialAddFriendUrl || '',
          statusText: '你已綁定過此邀請關係。請手動點擊按鈕前往加入官方 LINE@。'
        });
      } else if (bindResult === 'bound_other') {
        setDrawResultCookie(res, '你已綁定其他邀請，無法重複綁定。');
      } else {
        setDrawResultCookie(res, '邀請連結無效或無法綁定。');
      }
      return res.redirect('/liff/lottery');
    } catch (err) {
      next(err);
    }
  });

  app.get('/liff/lottery', requireLiffLogin, async (req, res, next) => {
    try {
      const [userRs, availablePrizes, inviteStats] = await Promise.all([
        query('SELECT draws_left, extra_draws, line_user_id, line_display_name, username FROM users WHERE id = $1', [
          req.authUser.uid
        ]),
        getAvailablePrizes(),
        getInviteStats(req.authUser.uid)
      ]);
      const row = userRs.rows[0] || { draws_left: 0, extra_draws: 0 };
      const drawResult = consumeDrawResultCookie(req, res);
      const inviteCode = await ensureInviteCode(req.authUser.uid);
      const invitePath = inviteCode ? `/r/${encodeURIComponent(inviteCode)}` : '/lottery';
      const inviteLink = buildLiffPermanentUrl(liffId, invitePath, '/liff/lottery');
      res.render('liff_lottery', {
        user: req.authUser.un,
        result: drawResult,
        drawsLeft: row.draws_left || 0,
        extraDraws: row.extra_draws || 0,
        displayName: row.line_display_name || row.username || req.authUser.un,
        availablePrizes,
        inviteLink,
        rewardedInviteCount: inviteStats.rewarded_count || 0,
        pendingInviteCount: inviteStats.pending_count || 0,
        lineOfficialAddFriendUrl: lineOfficialAddFriendUrl || '',
        liffId: liffId || ''
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/liff/lottery/draw', requireLiffLogin, async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRs = await client.query('SELECT draws_left FROM users WHERE id = $1 FOR UPDATE', [req.authUser.uid]);
      if (userRs.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/liff/lottery');
      }

      const currentLeft = Number(userRs.rows[0].draws_left || 0);
      if (currentLeft <= 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '您的抽獎次數已用完');
        return res.redirect('/liff/lottery');
      }

      const prizeRs = await client.query(
        "SELECT id, name, quantity FROM prizes WHERE quantity > 0 AND name !~* '^\\s*test\\b' ORDER BY id ASC FOR UPDATE"
      );
      if (prizeRs.rowCount === 0) {
        await client.query('ROLLBACK');
        setDrawResultCookie(res, '目前沒有可抽獎品，請聯絡管理員補庫存');
        return res.redirect('/liff/lottery');
      }

      const picked = pickPrizeByQuantity(prizeRs.rows);
      await client.query('UPDATE prizes SET quantity = quantity - 1 WHERE id = $1 AND quantity > 0', [picked.id]);
      await client.query('UPDATE users SET draws_left = draws_left - 1 WHERE id = $1', [req.authUser.uid]);
      const message = `恭喜中獎！獲得：${picked.name}`;
      await client.query(
        'INSERT INTO draw_logs (user_id, is_win, prize_name, message) VALUES ($1, true, $2, $3)',
        [req.authUser.uid, picked.name, message]
      );
      await client.query('COMMIT');

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
}

module.exports = { registerLiffRoutes };
