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
 *   同上 ... --apply                    # 真的寫入；未帶則僅列出候選
 *   同上 ... --apply --invite-ids=37,38 # 只處理指定 line_invites.id（仍須符合預設候選條件）
 *
 * 注意：不會發 LINE 推播；若需通知請另行處理。可重複執行：已 rewarded 的列會從候選消失。
 */

const { Pool } = require('pg');
const { applyInviteFollowReward } = require('../src/core/inviteReward');

function parseArgs() {
  const apply = process.argv.includes('--apply');
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
  return { apply, inviteIds: inviteIds && inviteIds.length ? inviteIds : null };
}

function buildCandidateSql(inviteIds) {
  const whereExtra =
    inviteIds && inviteIds.length
      ? `AND li.id = ANY($1::int[])`
      : '';
  const paramsNote = inviteIds && inviteIds.length ? 'params: [inviteIds]' : 'params: []';
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

  const { apply, inviteIds } = parseArgs();
  const { text, params } = buildCandidateSql(inviteIds);

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const { rows } = await pool.query(text, params);
    console.log(`候選筆數: ${rows.length}${apply ? '' : '（預覽，未寫入；若要執行請加 --apply）'}`);
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
      try {
        await client.query('BEGIN');
        const result = await applyInviteFollowReward(client, {
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
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => process.exit(1));
