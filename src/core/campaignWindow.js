/**
 * 活動時間以 DB 的 TIMESTAMPTZ 儲存；後台表單以台北時間（datetime-local）輸入。
 */

function parseTaipeiDatetimeLocal(input) {
  if (input == null || (typeof input === 'string' && !input.trim())) {
    return { value: null };
  }
  if (typeof input !== 'string') {
    return { error: '時間格式不正確' };
  }
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) {
    return { error: '時間格式不正確（請使用 YYYY-MM-DDTHH:mm）' };
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { error: '時間無效' };
  }
  return { value: d };
}

function toTaipeiDatetimeLocalInput(value) {
  if (value == null) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false });
  const [datePart, timePart] = s.split(' ');
  if (!datePart || !timePart) return '';
  return `${datePart}T${timePart.slice(0, 5)}`;
}

/** @param {{ starts_at?: Date|string|null, ends_at?: Date|string|null }|null|undefined} row */
function getCampaignPhase(row, now = new Date()) {
  if (!row) return 'active';
  const t = now.getTime();
  const startMs = row.starts_at != null ? new Date(row.starts_at).getTime() : null;
  const endMs = row.ends_at != null ? new Date(row.ends_at).getTime() : null;
  if (startMs != null && Number.isFinite(startMs) && t < startMs) return 'not_started';
  if (endMs != null && Number.isFinite(endMs) && t > endMs) return 'ended';
  return 'active';
}

module.exports = {
  parseTaipeiDatetimeLocal,
  toTaipeiDatetimeLocalInput,
  getCampaignPhase
};
