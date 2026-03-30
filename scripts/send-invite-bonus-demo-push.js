#!/usr/bin/env node
/**
 * 手動模擬「第 2 位好友完成加好友」時發給邀請人的 LINE push（與 webhook 文案一致）。
 *
 * 用法（先 export 環境變數）：
 *   export DATABASE_URL="postgresql://..."
 *   export LINE_CHANNEL_ACCESS_TOKEN="..."
 *   export LINE_PUSH_PUBLIC_BASE_URL="https://你的正式網域"   # 選填，有則附 invite-bonus-granted.png
 *   export LIFF_ID="你的-LIFF-ID"   # 選填，有則文案附上刮刮樂永久連結（與正式 webhook 一致）
 *
 *   node scripts/send-invite-bonus-demo-push.js "Ice Chen" "某位好友"
 *
 * 第 1 個參數：在 users.line_display_name / users.username 模糊比對（ILIKE %字串%）
 * 第 2 個參數：推播文案裡「被邀請人」顯示名稱（預設：好友）
 */

const { Pool } = require('pg');
const { buildLiffPermanentUrl } = require('../src/core/liffPermalink');

function normalizeLinePushPublicBaseUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

async function main() {
  const matchName = (process.argv[2] || 'Ice Chen').trim();
  const inviteeInMessage = (process.argv[3] || '好友').trim().slice(0, 80);

  const databaseUrl = process.env.DATABASE_URL;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const baseUrl = normalizeLinePushPublicBaseUrl(
    process.env.LINE_PUSH_PUBLIC_BASE_URL || process.env.PUBLIC_SITE_URL || process.env.URL || ''
  );

  if (!databaseUrl) {
    console.error('請設定 DATABASE_URL');
    process.exit(1);
  }
  if (!token) {
    console.error('請設定 LINE_CHANNEL_ACCESS_TOKEN');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  const pattern = `%${matchName}%`;
  const rs = await pool.query(
    `SELECT id, username, line_display_name, line_user_id
     FROM users
     WHERE line_user_id IS NOT NULL
       AND line_user_id <> ''
       AND (line_display_name ILIKE $1 OR username ILIKE $1)
     ORDER BY id ASC
     LIMIT 5`,
    [pattern]
  );

  if (rs.rowCount === 0) {
    console.error(`找不到 line_user_id：比對「${matchName}」於 line_display_name / username`);
    await pool.end();
    process.exit(1);
  }
  if (rs.rowCount > 1) {
    console.warn('多筆符合，使用第一筆：');
    rs.rows.forEach((r, i) => {
      console.warn(`  [${i}] id=${r.id} username=${r.username} display=${r.line_display_name}`);
    });
  }

  const row = rs.rows[0];
  const lineUserId = row.line_user_id;
  const liffBuilt = buildLiffPermanentUrl(process.env.LIFF_ID || '', '/liff/lottery', '/liff/lottery');
  const liffLine =
    /^https:\/\/liff\.line\.me\//i.test(liffBuilt) ? `\n\n立即玩春日刮刮樂：\n${liffBuilt}` : '';
  const friendsPer = Math.max(1, Number.parseInt(process.env.LIFF_INVITE_FRIENDS_PER_DRAW || '2', 10) || 2);
  const text = `您的朋友「${inviteeInMessage}」已成功加入 OpenRice LINE@！已累計 ${friendsPer} 位好友完成任務，恭喜您獲得 1 次加碼刮刮樂次數！${liffLine}`;

  const messages = [{ type: 'text', text }];
  if (baseUrl) {
    const url = `${baseUrl}/images/invite-bonus-granted.png`;
    messages.push({ type: 'image', originalContentUrl: url, previewImageUrl: url });
  } else {
    console.warn('未設定 LINE_PUSH_PUBLIC_BASE_URL / PUBLIC_SITE_URL / URL，僅送文字');
  }

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ to: lineUserId, messages })
  });

  const bodyText = await res.text();
  if (!res.ok) {
    console.error('LINE push 失敗', res.status, bodyText);
    await pool.end();
    process.exit(1);
  }

  console.log('已推播至 line_user_id:', lineUserId);
  console.log('對應 user id:', row.id, 'username:', row.username, 'display:', row.line_display_name);
  console.log('訊息:', text);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
