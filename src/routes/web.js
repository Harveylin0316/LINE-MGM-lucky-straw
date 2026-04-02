const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parseTaipeiDatetimeLocal, toTaipeiDatetimeLocalInput } = require('../core/campaignWindow');
const { computeInviteLimit } = require('../core/inviteBonusConfig');
const { buildInviteRewardPushMessages } = require('../core/inviteRewardPushMessages');
const { validateFlexPushMessage, cloneFlexForPush } = require('../core/lineFlexMessage');

async function logPrizeChange(client, payload) {
  await client.query(
    `INSERT INTO prize_change_logs
      (action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      payload.action,
      payload.prizeId || null,
      payload.beforeName || null,
      typeof payload.beforeQuantity === 'number' ? payload.beforeQuantity : null,
      payload.afterName || null,
      typeof payload.afterQuantity === 'number' ? payload.afterQuantity : null,
      payload.adminUsername
    ]
  );
}

function normalizeNextPath(rawNextPath, fallbackPath = '/admin/prizes') {
  if (typeof rawNextPath !== 'string') return fallbackPath;
  if (!rawNextPath.startsWith('/admin')) return fallbackPath;
  if (rawNextPath.startsWith('//')) return fallbackPath;
  return rawNextPath;
}

function escapeCsvField(val) {
  const s = String(val == null ? '' : val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escapeHtmlForTextareaContent(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlLite(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isUuidParam(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ''));
}

function registerWebRoutes(app, deps) {
  const {
    query,
    pool,
    authCore,
    lotteryCore,
    viewStateCore,
    adminLoginPath,
    adminLoginThrottle,
    linePush,
    lineChannelAccessToken,
    inviteBonusMax,
    inviteFriendsPerDraw,
    liffLotteryPushUrl,
    linePushImageBaseCandidates = [],
    resolvePublicSiteOrigin = () => ''
  } = deps;

  const { requireAdmin, signAuthToken, setAuthCookie, clearAuthCookie } = authCore;
  const { enrichPrizesWithHitRate } = lotteryCore;
  const {
    invalidateAvailablePrizesCache,
    parsePage
  } = viewStateCore;

  const hiddenAdminLoginPath = typeof adminLoginPath === 'string' && adminLoginPath.startsWith('/') ? adminLoginPath : '/admin/login';

  const uploadPushImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
        cb(null, true);
      } else {
        cb(new Error('INVALID_PUSH_IMAGE_TYPE'));
      }
    }
  });

  const inviteLimitForAdmin = computeInviteLimit(inviteBonusMax);
  const friendsPerForAdmin = Math.max(
    1,
    Number.isFinite(Number(inviteFriendsPerDraw)) ? Number(inviteFriendsPerDraw) : 2
  );

  async function loadInvitePushSettings() {
    const rs = await query(
      `SELECT message_text, image_media_id, flex_json FROM admin_push_settings WHERE slug = 'invite_reminder'`
    );
    if (rs.rowCount === 0) {
      await query(
        `INSERT INTO admin_push_settings (slug, message_text) VALUES ('invite_reminder', '') ON CONFLICT (slug) DO NOTHING`
      );
      return { messageText: '', imageMediaId: null, flexJson: null };
    }
    let flexJson = rs.rows[0].flex_json;
    if (flexJson != null && typeof flexJson === 'string') {
      try {
        flexJson = JSON.parse(flexJson);
      } catch {
        flexJson = null;
      }
    }
    if (flexJson != null && typeof flexJson !== 'object') {
      flexJson = null;
    }
    return {
      messageText: String(rs.rows[0].message_text || ''),
      imageMediaId: rs.rows[0].image_media_id || null,
      flexJson
    };
  }

  async function buildInviteReminderMessages(req, { messageFromForm, attachSavedImage }) {
    const inviteSettings = await loadInvitePushSettings();
    const publicOrigin = String(resolvePublicSiteOrigin(req) || '').replace(/\/+$/, '');
    let imagePushUrl = '';
    if (
      attachSavedImage &&
      inviteSettings.imageMediaId &&
      /^https:\/\//i.test(publicOrigin)
    ) {
      imagePushUrl = `${publicOrigin}/p/line-media/${inviteSettings.imageMediaId}`;
    }
    const flexStored = inviteSettings.flexJson;
    const flexBaseOk = flexStored && validateFlexPushMessage(flexStored).ok;
    const messages = [];
    if (flexBaseOk) {
      const liffUrl = typeof liffLotteryPushUrl === 'string' ? liffLotteryPushUrl.trim() : '';
      const flexMsg = cloneFlexForPush(flexStored, liffUrl);
      const flexSendOk = validateFlexPushMessage(flexMsg);
      if (!flexSendOk.ok) {
        return { ok: false, err: 'flex_invalid', messages: [] };
      }
      messages.push(flexMsg);
    } else {
      const message = typeof messageFromForm === 'string' ? messageFromForm.trim() : '';
      if (message.length > 5000) {
        return { ok: false, err: 'bad_message', messages: [] };
      }
      if (!message && !imagePushUrl) {
        return { ok: false, err: 'bad_message', messages: [] };
      }
      if (imagePushUrl) {
        messages.push({
          type: 'image',
          originalContentUrl: imagePushUrl,
          previewImageUrl: imagePushUrl
        });
      }
      if (message) {
        messages.push(message);
      }
    }
    return { ok: true, err: null, messages };
  }

  app.get('/p/line-media/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!isUuidParam(id)) {
        return res.status(404).type('text/plain').send('Not found');
      }
      const rs = await query('SELECT mime_type, body FROM line_push_media WHERE id = $1', [id]);
      if (rs.rowCount === 0) {
        return res.status(404).type('text/plain').send('Not found');
      }
      const row = rs.rows[0];
      const buf = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body);
      res.setHeader('Content-Type', row.mime_type);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Length', String(buf.length));
      return res.send(buf);
    } catch (e) {
      return next(e);
    }
  });

  function renderAdminLogin(res, error = null, nextPath = '/admin/prizes') {
    return res.render('login', {
      error,
      isAdmin: false,
      nextPath,
      loginAction: hiddenAdminLoginPath,
      title: '管理員登入',
      hint: '此入口僅提供管理員登入。'
    });
  }

  app.get('/', (req, res) => {
    if (req.authUser && req.authUser.adm) return res.redirect('/admin/prizes');
    return res.status(404).send('Not found');
  });

  app.get('/register', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.post('/register', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get(hiddenAdminLoginPath, (req, res) => {
    const nextPath = normalizeNextPath(req.query.next, '/admin/prizes');
    return renderAdminLogin(res, null, nextPath);
  });

  app.get('/admin/login', (_req, res) => {
    return res.status(404).send('Not found');
  });

  app.get('/login', (_req, res) => {
    return res.status(404).send('Not found');
  });

  async function handleAdminLogin(req, res, next) {
    const nextPath = normalizeNextPath(req.body.nextPath, '/admin/prizes');
    try {
      const ipKey = adminLoginThrottle.ipKeyFromReq(req);
      if (await adminLoginThrottle.isBlocked(ipKey)) {
        return renderAdminLogin(res, '登入嘗試過於頻繁，請稍後再試。', nextPath);
      }

      const { username, password } = req.body;
      if (!username || !password) {
        return renderAdminLogin(res, '請輸入帳號與密碼', nextPath);
      }

      const found = await query('SELECT id, username, password_hash, is_admin FROM users WHERE username = $1', [username]);
      if (found.rowCount === 0) {
        await adminLoginThrottle.recordFailure(ipKey);
        return renderAdminLogin(res, '帳號或密碼錯誤', nextPath);
      }
      const user = found.rows[0];
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        await adminLoginThrottle.recordFailure(ipKey);
        return renderAdminLogin(res, '帳號或密碼錯誤', nextPath);
      }
      if (!(user.is_admin === true || user.is_admin === 1)) {
        await adminLoginThrottle.recordFailure(ipKey);
        clearAuthCookie(res);
        return renderAdminLogin(res, '此入口僅提供管理員登入', nextPath);
      }
      await adminLoginThrottle.clearFailures(ipKey);
      const token = signAuthToken(user);
      setAuthCookie(res, token);
      return res.redirect(nextPath);
    } catch (err) {
      return next(err);
    }
  }

  app.post(hiddenAdminLoginPath, handleAdminLogin);
  app.post('/admin/login', (_req, res) => res.status(404).send('Not found'));
  app.post('/login', (_req, res) => res.status(404).send('Not found'));

  app.post('/logout', (_req, res) => {
    clearAuthCookie(res);
    res.redirect(hiddenAdminLoginPath);
  });

  app.get('/lottery', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.post('/lottery/draw', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get('/lottery/draw', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get('/my-draws', (_req, res) => {
    return res.status(404).send('網頁版功能已關閉，請使用 LINE 活動頁。');
  });

  app.get('/admin/campaign', requireAdmin, async (req, res, next) => {
    try {
      const rs = await query('SELECT starts_at, ends_at, updated_at FROM campaign_settings WHERE id = 1');
      const row = rs.rows[0] || {};
      res.render('admin_campaign', {
        user: req.authUser.un,
        isAdmin: true,
        error: null,
        startsAtInput: toTaipeiDatetimeLocalInput(row.starts_at),
        endsAtInput: toTaipeiDatetimeLocalInput(row.ends_at),
        updatedAtText: row.updated_at ? String(row.updated_at) : ''
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/campaign', requireAdmin, async (req, res, next) => {
    const startsParsed = parseTaipeiDatetimeLocal(req.body.starts_at);
    const endsParsed = parseTaipeiDatetimeLocal(req.body.ends_at);
    if (startsParsed.error || endsParsed.error) {
      return res.render('admin_campaign', {
        user: req.authUser.un,
        isAdmin: true,
        error: startsParsed.error || endsParsed.error,
        startsAtInput: typeof req.body.starts_at === 'string' ? req.body.starts_at : '',
        endsAtInput: typeof req.body.ends_at === 'string' ? req.body.ends_at : '',
        updatedAtText: ''
      });
    }
    const startsAt = startsParsed.value;
    const endsAt = endsParsed.value;
    if (startsAt && endsAt && startsAt.getTime() > endsAt.getTime()) {
      return res.render('admin_campaign', {
        user: req.authUser.un,
        isAdmin: true,
        error: '開始時間不可晚於結束時間',
        startsAtInput: typeof req.body.starts_at === 'string' ? req.body.starts_at : '',
        endsAtInput: typeof req.body.ends_at === 'string' ? req.body.ends_at : '',
        updatedAtText: ''
      });
    }
    try {
      await query(
        `INSERT INTO campaign_settings (id, starts_at, ends_at, updated_at)
         VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET
           starts_at = EXCLUDED.starts_at,
           ends_at = EXCLUDED.ends_at,
           updated_at = NOW()`,
        [startsAt, endsAt]
      );
      return res.redirect('/admin/campaign');
    } catch (err) {
      next(err);
    }
  });

  async function findUserForAdminBonus(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const asNum = Number.parseInt(s, 10);
    if (String(asNum) === s && asNum > 0) {
      const rs = await query(
        'SELECT id, username, line_display_name, draws_left, extra_draws, is_admin FROM users WHERE id = $1',
        [asNum]
      );
      return rs.rowCount ? rs.rows[0] : null;
    }
    const rs = await query(
      'SELECT id, username, line_display_name, draws_left, extra_draws, is_admin FROM users WHERE username = $1',
      [s]
    );
    return rs.rowCount ? rs.rows[0] : null;
  }

  app.get('/admin/users/bonus', requireAdmin, async (req, res, next) => {
    try {
      res.render('admin_user_bonus', {
        user: req.authUser.un,
        isAdmin: true,
        inviteLimit: inviteLimitForAdmin,
        error: null,
        success: null,
        preserveTargetAttr: '',
        preserveCount: 1,
        adjustExtraChecked: true
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/users/bonus', requireAdmin, async (req, res, next) => {
    try {
      const rawTarget = typeof req.body.target_user === 'string' ? req.body.target_user : '';
      const bonusRaw = Number.parseInt(String(req.body.bonus_count ?? '1'), 10);
      const bonusCount = Number.isFinite(bonusRaw) ? Math.min(20, Math.max(1, bonusRaw)) : 1;
      const adjustExtra =
        req.body.adjust_extra === '1' || req.body.adjust_extra === 'on' || req.body.adjust_extra === 'true';

      const rerenderForm = (payload = {}) => {
        res.render('admin_user_bonus', {
          user: req.authUser.un,
          isAdmin: true,
          inviteLimit: inviteLimitForAdmin,
          error: payload.error || null,
          success: null,
          preserveTargetAttr: escapeHtmlLite(rawTarget),
          preserveCount: bonusCount,
          adjustExtraChecked: payload.adjustExtraChecked != null ? payload.adjustExtraChecked : adjustExtra
        });
      };

      const target = await findUserForAdminBonus(rawTarget);
      if (!target) {
        return rerenderForm({ error: '找不到此用戶（請輸入正整數 ID 或 username）。' });
      }
      if (target.is_admin === true || target.is_admin === 1) {
        return rerenderForm({ error: '不可對管理員帳號補發。' });
      }

      const upd = await query(
        `UPDATE users SET
           draws_left = draws_left + $1,
           extra_draws = CASE WHEN $4::boolean THEN LEAST(extra_draws + $1, $3) ELSE extra_draws END
         WHERE id = $2 AND (is_admin IS NOT TRUE)
         RETURNING id, username, draws_left, extra_draws, line_user_id`,
        [bonusCount, target.id, inviteLimitForAdmin, adjustExtra]
      );
      if (upd.rowCount === 0) {
        return rerenderForm({ error: '更新失敗（用戶可能為管理員）。' });
      }
      const row = upd.rows[0];

      let pushNoteClass = '';
      let pushNoteEscaped = '';
      if (adjustExtra && bonusCount > 0) {
        const lineUid = row.line_user_id ? String(row.line_user_id).trim() : '';
        if (!lineChannelAccessToken || !linePush || typeof linePush.pushLineMessages !== 'function') {
          pushNoteClass = 'error-banner';
          pushNoteEscaped = escapeHtmlLite(
            '已同步加碼紀錄，但伺服器未設定 LINE_CHANNEL_ACCESS_TOKEN 或推播模組不可用，無法發送 LINE。'
          );
        } else if (!lineUid) {
          pushNoteClass = 'error-banner';
          pushNoteEscaped = escapeHtmlLite(
            '已同步加碼紀錄，但此用戶無 line_user_id（未以 LINE 綁定），無法發送 LINE 推播。'
          );
        } else {
          try {
            const rewardResult = {
              result: 'rewarded',
              inviteId: null,
              inviterUserId: row.id,
              inviterLineUserId: lineUid,
              inviteeDisplayName: '您的好友',
              grantDraws: 1,
              isFirstRewardedFriend: false
            };
            const payload = await buildInviteRewardPushMessages({
              rewardResult,
              friendsPerDraw: friendsPerForAdmin,
              liffLotteryPushUrl,
              linePushImageBaseCandidates
            });
            if (!payload) {
              pushNoteClass = 'error-banner';
              pushNoteEscaped = escapeHtmlLite(
                '已同步加碼紀錄，但無法組出推播內容（請檢查圖片網域環境變數）。請查看 line_push_logs。'
              );
            } else {
              const ok = await linePush.pushLineMessages(
                payload.inviterLineUserId,
                payload.messages,
                payload.pushExtras
              );
              if (ok) {
                pushNoteClass = 'ok-banner';
                pushNoteEscaped = escapeHtmlLite(
                  '已發送 LINE 給該用戶，文案與圖片與 Webhook「累計好友完成任務、獲得加碼刮次」相同。'
                );
              } else {
                pushNoteClass = 'error-banner';
                pushNoteEscaped = escapeHtmlLite(
                  '已同步加碼紀錄，但 LINE 推播未成功（可能 API 錯誤）。請至「活動成效報表」查看 line_push_logs。'
                );
              }
            }
          } catch (pushErr) {
            pushNoteClass = 'error-banner';
            pushNoteEscaped = escapeHtmlLite(
              `已同步加碼紀錄，但推播時發生例外：${String(pushErr.message || pushErr).slice(0, 200)}`
            );
          }
        }
      }

      return res.render('admin_user_bonus', {
        user: req.authUser.un,
        isAdmin: true,
        inviteLimit: inviteLimitForAdmin,
        error: null,
        success: {
          userId: row.id,
          usernameEscaped: escapeHtmlLite(row.username),
          added: bonusCount,
          drawsLeftAfter: row.draws_left,
          extraDrawsAfter: row.extra_draws,
          pushNoteClass,
          pushNoteEscaped
        },
        preserveTargetAttr: '',
        preserveCount: 1,
        adjustExtraChecked: true
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/prizes', requireAdmin, async (req, res, next) => {
    try {
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: null,
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/prizes/logs', requireAdmin, async (req, res, next) => {
    try {
      const pageSize = 50;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const [rows, total] = await Promise.all([
        query(
          `SELECT id, action, prize_id, before_name, before_quantity, after_name, after_quantity, admin_username, created_at
           FROM prize_change_logs
           ORDER BY id DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset]
        ),
        query('SELECT COUNT(*)::int AS total FROM prize_change_logs')
      ]);
      const totalCount = total.rows[0]?.total || 0;
      res.render('admin_prize_logs', {
        user: req.authUser.un,
        isAdmin: true,
        records: rows.rows || [],
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (rows.rows || []).length < totalCount
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/line/webhooks', requireAdmin, async (req, res, next) => {
    try {
      const pageSize = 50;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const [rows, total] = await Promise.all([
        query(
          `SELECT id, event_type, line_user_id, invite_id, inviter_user_id, result, detail, event_timestamp, created_at
           FROM line_webhook_events
           ORDER BY id DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, offset]
        ),
        query('SELECT COUNT(*)::int AS total FROM line_webhook_events')
      ]);
      const totalCount = total.rows[0]?.total || 0;
      res.render('admin_line_webhooks', {
        user: req.authUser.un,
        isAdmin: true,
        records: rows.rows || [],
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (rows.rows || []).length < totalCount
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/invite-reminders', requireAdmin, async (req, res, next) => {
    try {
      const pageSize = 100;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const onlyPending =
        req.query.only_pending === '1' || req.query.only_pending === 'true' || req.query.only_pending === 'on';
      const pushOk = req.query.push_ok != null ? String(req.query.push_ok) : '';
      const pushFail = req.query.push_fail != null ? String(req.query.push_fail) : '';
      const pushSkip = req.query.push_skip != null ? String(req.query.push_skip) : '';
      const queryErr = typeof req.query.err === 'string' ? req.query.err : '';
      const liffUrlStr = typeof liffLotteryPushUrl === 'string' ? liffLotteryPushUrl : '';
      const defaultReminderText = liffUrlStr
        ? `【春日野餐祭】您還有邀請加碼刮刮樂次數尚未領取！\n邀請尚未加入 OpenRice LINE@ 的好友完成加好友，累計 ${friendsPerForAdmin} 人即可加碼。\n立即開啟活動：\n${liffUrlStr}`
        : `【春日野餐祭】您還有邀請加碼刮刮樂次數尚未領取！\n邀請尚未加入 OpenRice LINE@ 的好友完成加好友，累計 ${friendsPerForAdmin} 人即可加碼。\n請從 OpenRice LINE@ 選單再次進入刮刮樂，分享您的專屬邀請連結給好友。`;
      const defaultReminderTextEscaped = escapeHtmlForTextareaContent(defaultReminderText);

      if (req.query.export === 'csv') {
        const baseWhereCsv = `
        u.line_user_id IS NOT NULL
        AND BTRIM(u.line_user_id) <> ''
        AND (u.is_admin IS NOT TRUE)
        AND u.extra_draws < $1
      `;
        const pendingClauseCsv = onlyPending
          ? `AND EXISTS (
            SELECT 1 FROM line_invites li
            WHERE li.inviter_user_id = u.id AND li.status = 'pending'
          )`
          : '';
        const exportSql = `
        SELECT
          u.id,
          u.username,
          u.line_display_name,
          u.line_user_id,
          u.extra_draws,
          (SELECT COUNT(*)::int FROM line_invites li
           WHERE li.inviter_user_id = u.id AND li.status = 'rewarded') AS invite_rewarded_count,
          (SELECT COUNT(*)::int FROM line_invites li
           WHERE li.inviter_user_id = u.id AND li.status = 'pending') AS invite_pending_count
        FROM users u
        WHERE ${baseWhereCsv}
        ${pendingClauseCsv}
        ORDER BY u.id ASC
        LIMIT 5000
      `;
        const exportRs = await query(exportSql, [inviteLimitForAdmin]);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="invite-incomplete-users.csv"');
        res.write('\ufeff');
        res.write(
          'id,username,line_display_name,line_user_id,extra_draws,invite_rewarded,invite_pending\n'
        );
        for (const r of exportRs.rows || []) {
          const line = [
            r.id,
            escapeCsvField(r.username),
            escapeCsvField(r.line_display_name),
            escapeCsvField(r.line_user_id),
            r.extra_draws ?? 0,
            r.invite_rewarded_count ?? 0,
            r.invite_pending_count ?? 0
          ].join(',');
          res.write(`${line}\n`);
        }
        return res.end();
      }

      const inviteSettings = await loadInvitePushSettings();
      const publicOrigin = String(resolvePublicSiteOrigin(req) || '').replace(/\/+$/, '');
      const imageHttpsOk = /^https:\/\//i.test(publicOrigin);
      const imagePreviewUrl =
        inviteSettings.imageMediaId && publicOrigin
          ? `${publicOrigin}/p/line-media/${inviteSettings.imageMediaId}`
          : '';
      const savedMessageEscaped = escapeHtmlForTextareaContent(inviteSettings.messageText);
      const pushDraftMessage = inviteSettings.messageText.trim() ? inviteSettings.messageText : defaultReminderText;
      const pushMessageEscaped = escapeHtmlForTextareaContent(pushDraftMessage);
      const settingsSaved = req.query.settings_saved === '1';
      const flexV = inviteSettings.flexJson ? validateFlexPushMessage(inviteSettings.flexJson) : null;
      const hasFlexSaved = Boolean(flexV && flexV.ok);
      const flexMessageJsonEscaped = hasFlexSaved
        ? escapeHtmlForTextareaContent(JSON.stringify(inviteSettings.flexJson, null, 2))
        : '';
      const flexHintEscaped = escapeHtmlLite(
        typeof req.query.flex_hint === 'string' ? req.query.flex_hint : ''
      );
      const adminLinkRs = await query('SELECT line_user_id FROM users WHERE id = $1', [req.authUser.uid]);
      const adminLineLinked = Boolean(String(adminLinkRs.rows[0]?.line_user_id || '').trim());
      const testPushOk = req.query.test_push_ok === '1';

      if (inviteLimitForAdmin <= 0) {
        return res.render('admin_invite_reminders', {
          user: req.authUser.un,
          isAdmin: true,
          rows: [],
          page: 1,
          hasPrevPage: false,
          hasNextPage: false,
          totalCount: 0,
          onlyPending,
          inviteLimit: inviteLimitForAdmin,
          friendsPerDraw: friendsPerForAdmin,
          liffLotteryPushUrl: liffUrlStr,
          defaultReminderText,
          defaultReminderTextEscaped,
          savedMessageEscaped,
          pushMessageEscaped,
          imageMediaId: inviteSettings.imageMediaId,
          imagePreviewUrl,
          imageHttpsOk,
          settingsSaved,
          hasLineToken: Boolean(linePush && lineChannelAccessToken),
          pushOk,
          pushFail,
          pushSkip,
          err: queryErr,
          flexHintEscaped,
          hasFlexSaved,
          flexMessageJsonEscaped,
          adminLineLinked,
          testPushOk,
          disabledReason: '目前活動設定為「邀請加碼」次數上限 0，因此沒有需要提醒的名單。若需使用本功能，請調整活動相關設定後再試。'
        });
      }

      const baseWhere = `
        u.line_user_id IS NOT NULL
        AND BTRIM(u.line_user_id) <> ''
        AND (u.is_admin IS NOT TRUE)
        AND u.extra_draws < $1
      `;
      const pendingClause = onlyPending
        ? `AND EXISTS (
            SELECT 1 FROM line_invites li
            WHERE li.inviter_user_id = u.id AND li.status = 'pending'
          )`
        : '';

      const listSql = `
        SELECT
          u.id,
          u.username,
          u.line_display_name,
          u.line_user_id,
          u.extra_draws,
          (SELECT COUNT(*)::int FROM line_invites li
           WHERE li.inviter_user_id = u.id AND li.status = 'rewarded') AS invite_rewarded_count,
          (SELECT COUNT(*)::int FROM line_invites li
           WHERE li.inviter_user_id = u.id AND li.status = 'pending') AS invite_pending_count
        FROM users u
        WHERE ${baseWhere}
        ${pendingClause}
        ORDER BY u.id ASC
        LIMIT $2 OFFSET $3
      `;
      const countSql = `
        SELECT COUNT(*)::int AS total FROM users u
        WHERE ${baseWhere}
        ${pendingClause}
      `;

      const [rowsRs, countRs] = await Promise.all([
        query(listSql, [inviteLimitForAdmin, pageSize, offset]),
        query(countSql, [inviteLimitForAdmin])
      ]);
      const totalCount = countRs.rows[0]?.total || 0;

      return res.render('admin_invite_reminders', {
        user: req.authUser.un,
        isAdmin: true,
        rows: rowsRs.rows || [],
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (rowsRs.rows || []).length < totalCount,
        totalCount,
        onlyPending,
        inviteLimit: inviteLimitForAdmin,
        friendsPerDraw: friendsPerForAdmin,
        liffLotteryPushUrl: liffUrlStr,
        defaultReminderText,
        defaultReminderTextEscaped,
        savedMessageEscaped,
        pushMessageEscaped,
        imageMediaId: inviteSettings.imageMediaId,
        imagePreviewUrl,
        imageHttpsOk,
        settingsSaved,
        hasLineToken: Boolean(linePush && lineChannelAccessToken),
        pushOk,
        pushFail,
        pushSkip,
        err: queryErr,
        flexHintEscaped,
        hasFlexSaved,
        flexMessageJsonEscaped,
        adminLineLinked,
        testPushOk,
        disabledReason: ''
      });
    } catch (handlerErr) {
      next(handlerErr);
    }
  });

  app.post(
    '/admin/invite-reminders/settings',
    requireAdmin,
    (req, res, next) => {
      uploadPushImage.single('push_image')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.redirect('/admin/invite-reminders?err=upload_too_large');
        }
        return res.redirect('/admin/invite-reminders?err=upload_invalid');
      });
    },
    async (req, res, next) => {
      try {
        const pendingQs = req.body.only_pending_echo === '1' ? '&only_pending=1' : '';
        const msg = typeof req.body.message_text === 'string' ? req.body.message_text.trim().slice(0, 5000) : '';
        const flexRaw = typeof req.body.flex_message_json === 'string' ? req.body.flex_message_json.trim() : '';
        let flexJsonDb = null;
        if (flexRaw !== '') {
          let parsed;
          try {
            parsed = JSON.parse(flexRaw);
          } catch {
            return res.redirect(`/admin/invite-reminders?err=bad_flex${pendingQs}`);
          }
          const v = validateFlexPushMessage(parsed);
          if (!v.ok) {
            return res.redirect(
              `/admin/invite-reminders?err=bad_flex&flex_hint=${encodeURIComponent(v.error)}${pendingQs}`
            );
          }
          flexJsonDb = parsed;
        }
        const removeImage = req.body.remove_image === '1' || req.body.remove_image === 'on';
        const file = req.file;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO admin_push_settings (slug, message_text, flex_json) VALUES ('invite_reminder', $1, $2::jsonb)
             ON CONFLICT (slug) DO UPDATE SET
               message_text = EXCLUDED.message_text,
               flex_json = EXCLUDED.flex_json,
               updated_at = NOW()`,
            [msg, flexJsonDb]
          );
          const cur = await client.query(
            `SELECT image_media_id FROM admin_push_settings WHERE slug = 'invite_reminder' FOR UPDATE`
          );
          let mediaId = cur.rows[0]?.image_media_id || null;
          if (removeImage && mediaId) {
            await client.query('DELETE FROM line_push_media WHERE id = $1', [mediaId]);
            await client.query(
              `UPDATE admin_push_settings SET image_media_id = NULL, updated_at = NOW() WHERE slug = 'invite_reminder'`
            );
            mediaId = null;
          }
          if (file && file.buffer && file.mimetype) {
            const newId = crypto.randomUUID();
            await client.query(`INSERT INTO line_push_media (id, mime_type, body) VALUES ($1, $2, $3)`, [
              newId,
              file.mimetype,
              file.buffer
            ]);
            if (mediaId) {
              await client.query('DELETE FROM line_push_media WHERE id = $1', [mediaId]);
            }
            await client.query(
              `UPDATE admin_push_settings SET image_media_id = $1, updated_at = NOW() WHERE slug = 'invite_reminder'`,
              [newId]
            );
          }
          await client.query('COMMIT');
        } catch (e) {
          try {
            await client.query('ROLLBACK');
          } catch (_rb) {
            /* ignore */
          }
          throw e;
        } finally {
          client.release();
        }
        return res.redirect(`/admin/invite-reminders?settings_saved=1${pendingQs}`);
      } catch (e) {
        next(e);
      }
    }
  );

  app.post('/admin/invite-reminders/test-push', requireAdmin, async (req, res, next) => {
    try {
      const pendingQs = req.body.only_pending_echo === '1' ? '&only_pending=1' : '';
      if (!lineChannelAccessToken) {
        return res.redirect(`/admin/invite-reminders?err=no_line_token${pendingQs}`);
      }
      const liffUrlStr = typeof liffLotteryPushUrl === 'string' ? liffLotteryPushUrl : '';
      const defaultReminderText = liffUrlStr
        ? `【春日野餐祭】您還有邀請加碼刮刮樂次數尚未領取！\n邀請尚未加入 OpenRice LINE@ 的好友完成加好友，累計 ${friendsPerForAdmin} 人即可加碼。\n立即開啟活動：\n${liffUrlStr}`
        : `【春日野餐祭】您還有邀請加碼刮刮樂次數尚未領取！\n邀請尚未加入 OpenRice LINE@ 的好友完成加好友，累計 ${friendsPerForAdmin} 人即可加碼。\n請從 OpenRice LINE@ 選單再次進入刮刮樂，分享您的專屬邀請連結給好友。`;

      const inviteSettings = await loadInvitePushSettings();
      const publicOrigin = String(resolvePublicSiteOrigin(req) || '').replace(/\/+$/, '');
      const imageHttpsOk = /^https:\/\//i.test(publicOrigin);
      const draftMsg = inviteSettings.messageText.trim() ? inviteSettings.messageText : defaultReminderText;
      const attachSaved = Boolean(inviteSettings.imageMediaId && imageHttpsOk);

      const built = await buildInviteReminderMessages(req, {
        messageFromForm: draftMsg,
        attachSavedImage: attachSaved
      });
      if (!built.ok) {
        return res.redirect(`/admin/invite-reminders?err=${built.err}${pendingQs}`);
      }

      const rawTestId = typeof req.body.test_line_user_id === 'string' ? req.body.test_line_user_id.trim() : '';
      const rawMemberName =
        typeof req.body.test_member_name === 'string' ? req.body.test_member_name.trim().slice(0, 200) : '';
      let lineTo = '';
      let testPushUserId = Number(req.authUser.uid) || null;
      if (/^U[0-9a-f]{32}$/i.test(rawTestId)) {
        lineTo = rawTestId;
      } else if (rawTestId !== '') {
        return res.redirect(`/admin/invite-reminders?err=test_bad_line_id${pendingQs}`);
      } else if (rawMemberName !== '') {
        const nameRs = await query(
          `SELECT id, line_user_id FROM users
           WHERE COALESCE(BTRIM(line_user_id), '') <> ''
           AND (
             LOWER(TRIM(COALESCE(line_display_name, ''))) = LOWER(TRIM($1::text))
             OR LOWER(TRIM(username)) = LOWER(TRIM($1::text))
           )
           ORDER BY id ASC
           LIMIT 2`,
          [rawMemberName]
        );
        if (nameRs.rowCount === 0) {
          return res.redirect(`/admin/invite-reminders?err=test_name_not_found${pendingQs}`);
        }
        if (nameRs.rowCount > 1) {
          return res.redirect(`/admin/invite-reminders?err=test_name_ambiguous${pendingQs}`);
        }
        lineTo = String(nameRs.rows[0].line_user_id || '').trim();
        testPushUserId = nameRs.rows[0].id;
      } else {
        const uRs = await query('SELECT line_user_id FROM users WHERE id = $1', [req.authUser.uid]);
        lineTo = String(uRs.rows[0]?.line_user_id || '').trim();
      }
      if (!lineTo) {
        return res.redirect(`/admin/invite-reminders?err=test_no_recipient${pendingQs}`);
      }

      const pushed = await linePush.pushLineMessages(lineTo, built.messages, {
        userId: testPushUserId,
        pushType: 'admin_invite_reminder_test'
      });
      if (!pushed) {
        return res.redirect(`/admin/invite-reminders?err=test_push_failed${pendingQs}`);
      }
      return res.redirect(`/admin/invite-reminders?test_push_ok=1${pendingQs}`);
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/invite-reminders/push', requireAdmin, async (req, res, next) => {
    try {
      const pendingQs = req.body.only_pending_filter === '1' ? '&only_pending=1' : '';

      if (!lineChannelAccessToken) {
        return res.redirect(`/admin/invite-reminders?err=no_line_token${pendingQs}`);
      }
      const rawIds = typeof req.body.userIds === 'string' ? req.body.userIds : '';
      const ids = rawIds
        .split(/[,\s]+/)
        .map(s => parseInt(String(s).trim(), 10))
        .filter(n => Number.isInteger(n) && n > 0);
      const uniqueIds = [...new Set(ids)].slice(0, 50);

      const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
      if (message.length > 5000) {
        return res.redirect(`/admin/invite-reminders?err=bad_message${pendingQs}`);
      }

      const attachSavedImage = req.body.attach_saved_image === '1';
      const built = await buildInviteReminderMessages(req, { messageFromForm: message, attachSavedImage });
      if (!built.ok) {
        return res.redirect(`/admin/invite-reminders?err=${built.err}${pendingQs}`);
      }
      const messages = built.messages;

      if (uniqueIds.length === 0) {
        return res.redirect(`/admin/invite-reminders?err=no_selection${pendingQs}`);
      }

      if (inviteLimitForAdmin <= 0) {
        return res.redirect('/admin/invite-reminders');
      }

      let ok = 0;
      let fail = 0;
      let skip = 0;

      for (const userId of uniqueIds) {
        const uRs = await query(
          `SELECT id, line_user_id, extra_draws, is_admin
           FROM users WHERE id = $1`,
          [userId]
        );
        if (uRs.rowCount === 0) {
          skip += 1;
          continue;
        }
        const u = uRs.rows[0];
        const lineUid = String(u.line_user_id || '').trim();
        if (!lineUid || u.is_admin === true || u.is_admin === 1) {
          skip += 1;
          continue;
        }
        if (Number(u.extra_draws || 0) >= inviteLimitForAdmin) {
          skip += 1;
          continue;
        }

        const pushed = await linePush.pushLineMessages(lineUid, messages, {
          userId: u.id,
          pushType: 'admin_invite_reminder'
        });
        if (pushed) ok += 1;
        else fail += 1;
      }

      const q = new URLSearchParams({
        push_ok: String(ok),
        push_fail: String(fail),
        push_skip: String(skip)
      });
      if (req.body.only_pending_filter === '1') q.set('only_pending', '1');
      return res.redirect(`/admin/invite-reminders?${q.toString()}`);
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/reports', requireAdmin, async (req, res, next) => {
    try {
      const pageSize = 50;
      const page = parsePage(req.query.page);
      const offset = (page - 1) * pageSize;
      const rawKeyword = typeof req.query.q === 'string' ? req.query.q : '';
      const keyword = rawKeyword.trim();

      const summaryQueries = Promise.all([
        query('SELECT COUNT(*)::int AS total FROM users'),
        query('SELECT COUNT(*)::int AS total FROM draw_logs'),
        query('SELECT COUNT(*)::int AS total FROM draw_logs WHERE is_win = true'),
        query("SELECT COUNT(*)::int AS total FROM draw_logs WHERE created_at >= NOW() - INTERVAL '24 hours'"),
        query("SELECT COUNT(DISTINCT user_id)::int AS total FROM draw_logs WHERE created_at >= NOW() - INTERVAL '7 days'"),
        query(
          "SELECT COUNT(*) FILTER (WHERE status = 'rewarded')::int AS rewarded, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending FROM line_invites"
        ),
        query(
          `SELECT COUNT(*)::int AS total
           FROM (
             SELECT user_id
             FROM draw_logs
             WHERE created_at >= NOW() - INTERVAL '24 hours'
             GROUP BY user_id
             HAVING COUNT(*) >= 20
           ) t`
        ),
        query("SELECT COUNT(*)::int AS total FROM line_push_logs WHERE status = 'success'"),
        query("SELECT COUNT(*)::int AS total FROM line_push_logs WHERE status = 'failed'"),
        query("SELECT COUNT(*)::int AS total FROM line_push_logs WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours'")
      ]);

      const userStatsBaseParams = [];
      let userFilterSql = '';
      if (keyword) {
        userStatsBaseParams.push(`%${keyword}%`);
        userFilterSql = 'WHERE (u.username ILIKE $1 OR COALESCE(u.line_display_name, \'\') ILIKE $1)';
      }

      const countSql = `SELECT COUNT(*)::int AS total FROM users u ${userFilterSql}`;
      const countRs = await query(countSql, userStatsBaseParams);
      const totalUsersForPage = countRs.rows[0]?.total || 0;

      const listParams = [...userStatsBaseParams];
      const limitPlaceholder = `$${listParams.length + 1}`;
      const offsetPlaceholder = `$${listParams.length + 2}`;
      listParams.push(pageSize, offset);

      const userStatsSql = `
        SELECT
          u.id,
          u.username,
          u.line_display_name,
          u.draws_left,
          u.extra_draws,
          COALESCE((
            SELECT COUNT(*)::int FROM line_invites li
            WHERE li.inviter_user_id = u.id AND li.status = 'rewarded'
          ), 0) AS invite_rewarded_count,
          COALESCE(COUNT(d.id), 0)::int AS draws_used,
          COALESCE(COUNT(*) FILTER (WHERE d.is_win = true), 0)::int AS wins,
          MAX(d.created_at) AS last_draw_at,
          COALESCE(COUNT(*) FILTER (WHERE d.created_at >= NOW() - INTERVAL '24 hours'), 0)::int AS draws_24h,
          COALESCE(COUNT(*) FILTER (WHERE d.created_at >= NOW() - INTERVAL '7 days'), 0)::int AS draws_7d
        FROM users u
        LEFT JOIN draw_logs d ON d.user_id = u.id
        ${userFilterSql}
        GROUP BY u.id, u.username, u.line_display_name, u.draws_left, u.extra_draws
        ORDER BY draws_used DESC, u.id ASC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `;
      const usersRs = await query(userStatsSql, listParams);

      const drawPageSize = 50;
      const drawPage = parsePage(req.query.draw_page);
      const drawOffset = (drawPage - 1) * drawPageSize;
      const [pushLogsRs, drawLogsRs, drawLogsCountRs] = await Promise.all([
        query(
          `SELECT id, user_id, line_user_id, push_type, status, http_status, detail, created_at
           FROM line_push_logs
           ORDER BY id DESC
           LIMIT 30`
        ),
        query(
          `SELECT d.id, d.user_id, d.is_win, d.prize_name, d.message, d.created_at,
                  u.username, u.line_display_name
           FROM draw_logs d
           LEFT JOIN users u ON u.id = d.user_id
           ORDER BY d.id DESC
           LIMIT $1 OFFSET $2`,
          [drawPageSize, drawOffset]
        ),
        query('SELECT COUNT(*)::int AS total FROM draw_logs')
      ]);
      const drawLogsTotal = drawLogsCountRs.rows[0]?.total || 0;
      const drawLogsForView = (drawLogsRs.rows || []).map(r => ({
        id: r.id,
        user_id: r.user_id,
        is_win: r.is_win,
        created_at: r.created_at,
        usernameEsc: escapeHtmlLite(r.username || ''),
        lineNameEsc: escapeHtmlLite(r.line_display_name || ''),
        prizeEsc: escapeHtmlLite(r.prize_name || ''),
        messageEsc: escapeHtmlLite(r.message || '')
      }));

      const [
        totalUsersRs,
        totalDrawsRs,
        totalWinsRs,
        draws24hRs,
        activeUsers7dRs,
        inviteStatsRs,
        suspiciousUsersRs,
        pushSuccessRs,
        pushFailedRs,
        pushFailed24hRs
      ] = await summaryQueries;

      const totalDraws = totalDrawsRs.rows[0]?.total || 0;
      const totalWins = totalWinsRs.rows[0]?.total || 0;
      const winRatePct = totalDraws > 0 ? ((totalWins / totalDraws) * 100).toFixed(2) : '0.00';

      return res.render('admin_reports', {
        user: req.authUser.un,
        isAdmin: true,
        keyword,
        users: usersRs.rows || [],
        pushLogs: pushLogsRs.rows || [],
        drawLogs: drawLogsForView,
        drawPage,
        drawLogsTotal,
        hasPrevDrawPage: drawPage > 1,
        hasNextDrawPage: drawOffset + drawLogsForView.length < drawLogsTotal,
        page,
        hasPrevPage: page > 1,
        hasNextPage: offset + (usersRs.rows || []).length < totalUsersForPage,
        summary: {
          totalUsers: totalUsersRs.rows[0]?.total || 0,
          totalDraws,
          totalWins,
          winRatePct,
          draws24h: draws24hRs.rows[0]?.total || 0,
          activeUsers7d: activeUsers7dRs.rows[0]?.total || 0,
          rewardedInvites: inviteStatsRs.rows[0]?.rewarded || 0,
          pendingInvites: inviteStatsRs.rows[0]?.pending || 0,
          suspiciousUsers24h: suspiciousUsersRs.rows[0]?.total || 0,
          pushSuccess: pushSuccessRs.rows[0]?.total || 0,
          pushFailed: pushFailedRs.rows[0]?.total || 0,
          pushFailed24h: pushFailed24hRs.rows[0]?.total || 0
        }
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/prizes/:id/edit', requireAdmin, async (req, res, next) => {
    try {
      const row = await query('SELECT id, name, quantity, created_at FROM prizes WHERE id = $1', [req.params.id]);
      if (row.rowCount === 0) return res.redirect('/admin/prizes');
      res.render('admin_prize_edit', {
        user: req.authUser.un,
        isAdmin: true,
        error: null,
        prize: row.rows[0]
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/admin/prizes', requireAdmin, async (req, res) => {
    const { name, quantity } = req.body;
    const qty = Number(quantity);
    if (!name || Number.isNaN(qty) || qty < 0) {
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      return res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: '請輸入正確的獎品名稱與數量',
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query('INSERT INTO prizes (name, quantity) VALUES ($1, $2) RETURNING id', [name, qty]);
      await logPrizeChange(client, {
        action: 'create',
        prizeId: inserted.rows[0].id,
        afterName: name,
        afterQuantity: qty,
        adminUsername: req.authUser.un
      });
      await client.query('COMMIT');
      invalidateAvailablePrizesCache();
      return res.redirect('/admin/prizes');
    } catch (_err) {
      await client.query('ROLLBACK');
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      return res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: '新增獎品失敗',
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    } finally {
      client.release();
    }
  });

  app.post('/admin/prizes/:id/update', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, quantity } = req.body;
    const qty = Number(quantity);
    if (!name || Number.isNaN(qty) || qty < 0) {
      const row = await query('SELECT id, name, quantity, created_at FROM prizes WHERE id = $1', [id]);
      if (row.rowCount === 0) return res.redirect('/admin/prizes');
      return res.render('admin_prize_edit', {
        user: req.authUser.un,
        isAdmin: true,
        error: '修改失敗，請輸入正確的獎品名稱與數量',
        prize: { ...row.rows[0], name, quantity: Number.isNaN(qty) ? row.rows[0].quantity : qty }
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT id, name, quantity FROM prizes WHERE id = $1 FOR UPDATE', [id]);
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/admin/prizes');
      }
      await client.query('UPDATE prizes SET name = $1, quantity = $2 WHERE id = $3', [name, qty, id]);
      await logPrizeChange(client, {
        action: 'update',
        prizeId: Number(id),
        beforeName: existing.rows[0].name,
        beforeQuantity: Number(existing.rows[0].quantity),
        afterName: name,
        afterQuantity: qty,
        adminUsername: req.authUser.un
      });
      await client.query('COMMIT');
      invalidateAvailablePrizesCache();
      return res.redirect('/admin/prizes');
    } catch (_err) {
      await client.query('ROLLBACK');
      const row = await query('SELECT id, name, quantity, created_at FROM prizes WHERE id = $1', [id]);
      if (row.rowCount === 0) return res.redirect('/admin/prizes');
      return res.render('admin_prize_edit', {
        user: req.authUser.un,
        isAdmin: true,
        error: '修改獎品失敗',
        prize: row.rows[0]
      });
    } finally {
      client.release();
    }
  });

  app.post('/admin/prizes/:id/delete', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT id, name, quantity FROM prizes WHERE id = $1 FOR UPDATE', [id]);
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.redirect('/admin/prizes');
      }
      await client.query('DELETE FROM prizes WHERE id = $1', [id]);
      await logPrizeChange(client, {
        action: 'delete',
        prizeId: existing.rows[0].id,
        beforeName: existing.rows[0].name,
        beforeQuantity: Number(existing.rows[0].quantity),
        adminUsername: req.authUser.un
      });
      await client.query(`
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS new_id
          FROM prizes
        )
        UPDATE prizes p
        SET id = ordered.new_id
        FROM ordered
        WHERE p.id = ordered.id
      `);
      await client.query(`SELECT setval('prizes_id_seq', COALESCE((SELECT MAX(id) FROM prizes), 1), true)`);
      await client.query('COMMIT');
      invalidateAvailablePrizesCache();
      return res.redirect('/admin/prizes');
    } catch (_err) {
      await client.query('ROLLBACK');
      const rows = await query('SELECT id, name, quantity, created_at FROM prizes ORDER BY id ASC');
      return res.render('admin_prizes', {
        user: req.authUser.un,
        isAdmin: true,
        error: '刪除獎品失敗',
        prizes: enrichPrizesWithHitRate(rows.rows || [])
      });
    } finally {
      client.release();
    }
  });
}

module.exports = { registerWebRoutes };
