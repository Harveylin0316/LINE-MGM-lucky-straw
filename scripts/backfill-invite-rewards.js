#!/usr/bin/env node
/**
 * 補發「曾經 follow 但因 RLS 等因素寫成 no_matching_invite」的邀請加碼。
 *
 * 候選條件（預設）：
 *   line_invites.status = pending
 *   且曾有一筆 line_webhook_events：event_type=follow、result=no_matching_invite、line_user_id = invitee_line_user_id
 *
 * 處理順序：依該 follow 事件時間（無則用 webhook 列 created_at）由早到晚，與實際事件順序接近。
 *
 * 用法：
 *   DATABASE_URL=... LIFF_INVITE_BONUS_MAX=20 LIFF_INVITE_FRIENDS_PER_DRAW=2 node scripts/backfill-invite-rewards.js
 *   同上 ... --apply                              # 真的寫入 DB
 *   同上 ... --apply --with-push                  # 補發成功且 result=rewarded 時，發與 Webhook 相同的 LINE 給邀請人
 *   同上 ... --apply --invite-ids=37,38
 *
 * --with-push 需 LINE_CHANNEL_ACCESS_TOKEN；圖片與 LIFF 連結與正式站相同，請一併設定：
 *   LINE_PUSH_PUBLIC_BASE_URL 或 PUBLIC_SITE_URL（https）、LIFF_ID
 *
 * 可重複執行：已 rewarded 的列會從候選消失。
 */

const { Pool } = require('pg');
const { applyInviteFollowReward } = require('../src/core/inviteReward');
const { createLinePushService } = require('../src/core/linePush');
const { buildInviteRewardPushMessages } = require('../src/core/inviteRewardPushMessages');
const { buildPushImageBaseCandidates } = require('../src/core/linePushImageResolve');
const { buildLiffPermanentUrl } = require('../src/core/liffPermalink');

function parseArgs() {
  const apply = process.argv.includes('--apply');
  const withPush = process.argv.includes('--with-push');
  let inviteIds = null;
  for (const a of process.argv) {
    if (a.startsWith('--invite-ids=')) {
      const raw = a.slice('--invite-ids='.length).trim();
      inviteIds = raw
        .split(/[, ]+/)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n));
    }
  }
  return { apply, withPush, inviteIds: inviteIds && inviteIds.length ? inviteIds : null };
}

function buildCandidateSql(inviteIds) {
  const whereExtra =
    inviteIds && inviteIds.length
      ? `AND li.id = ANY($1::int[])`
      : '';
  return {
    text: `
SELECT li.id AS invite_id,
       li.invitee_line_user_id,
       li.inviter_user_id,
       (MIN(COALESCE(EXTRACT(EPOCH FROM e.event_timestamp), EXTRACT(EPOCH FROM e.created_at))) * 1000)::float8 AS event_ms
FROM line_invites li
INNER JOIN line_webhook_events e
  ON e.line_user_id = li.invitee_line_user_id
 AND e.event_type = 'follow'
 AND e.result = 'no_matching_invite'
WHERE li.status = 'pending'
${whereExtra}
GROUP BY li.id, li.invitee_line_user_id, li.inviter_user_id
ORDER BY MIN(COALESCE(EXTRACT(EPOCH FROM e.event_timestamp), EXTRACT(EPOCH FROM e.created_at))) ASC NULLS LAST,
         li.id ASC
`.trim(),
    params: inviteIds && inviteIds.length ? [inviteIds] : []
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('請設定 DATABASE_URL');
    process.exit(1);
  }

  const inviteBonusMax = Number.parseInt(process.env.LIFF_INVITE_BONUS_MAX || '20', 10);
  const inviteFriendsPerDraw = Math.max(
    1,
    Number.parseInt(process.env.LIFF_INVITE_FRIENDS_PER_DRAW || '2', 10) || 2
  );

  const { apply, withPush, inviteIds } = parseArgs();
  const { text, params } = buildCandidateSql(inviteIds);

  if (withPush && !apply) {
    console.error('請同時加上 --apply；僅預覽時不會發推播。');
    process.exit(1);
  }
  if (withPush && !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error('使用 --with-push 時請設定 LINE_CHANNEL_ACCESS_TOKEN');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  const linePushImageBaseCandidates = buildPushImageBaseCandidates();
  const liffId = String(process.env.LIFF_ID || '').trim();
  const liffLotteryBuilt = buildLiffPermanentUrl(liffId, '/liff/lottery', '/liff/lottery');
  const liffLotteryPushUrl = /^https:\/\/liff\.line\.me\//i.test(liffLotteryBuilt) ? liffLotteryBuilt : '';

  const linePush = withPush
    ? createLinePushService({
        query: (q, p) => pool.query(q, p),
        lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
      })
    : null;

  try {
    const { rows } = await pool.query(text, params);
    const pushNote = withPush ? '；成功補發為 rewarded 時會發 LINE' : '';
    console.log(
      `候選筆數: ${rows.length}${apply ? pushNote : '（預覽：加 --apply 寫入；加 --apply --with-push 另發 LINE）'}`
    );
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      const lineUserId = row.invitee_line_user_id;
      const eventMs = Number(row.event_ms) || Date.now();
      if (!apply) {
        console.log(
          `[dry-run] invite_id=${row.invite_id} invitee=${lineUserId} inviter_user_id=${row.inviter_user_id} event_ms=${eventMs}`
        );
        continue;
      }

      const client = await pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await applyInviteFollowReward(client, {
          lineUserId,
          eventTimestamp: eventMs,
          inviteBonusMax,
          inviteFriendsPerDraw
        });
        await client.query('COMMIT');
        console.log(
          `[apply] invite_id=${row.invite_id} invitee=${lineUserId} -> ${result.result}` +
            (result.grantDraws != null ? ` grantDraws=${result.grantDraws}` : '')
        );
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[error] invite_id=${row.invite_id} invitee=${lineUserId}: ${err.message}`);
        throw err;
      } finally {
        client.release();
      }

      if (withPush && linePush && result?.result === 'rewarded') {
        const payload = await buildInviteRewardPushMessages({
          rewardResult: result,
          friendsPerDraw: inviteFriendsPerDraw,
          liffLotteryPushUrl,
          linePushImageBaseCandidates
        });
        if (payload) {
          const ok = await linePush.pushLineMessages(
            payload.inviterLineUserId,
            payload.messages,
            payload.pushExtras
          );
          console.log(`[push] invite_id=${row.invite_id} -> ${ok ? 'success' : 'failed_or_skipped'}`);
        } else {
          console.log(`[push] invite_id=${row.invite_id} -> skipped_no_template`);
        }
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => process.exit(1));
