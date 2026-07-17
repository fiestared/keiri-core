/**
 * 日数・営業日・営業日加算の計算（DOM非依存・テスト対象）。
 * 祝日データは holidays_jp.json（内閣府CSV由来）を使う。
 * 日付は {y,m,d} かISO文字列で扱い、タイムゾーン事故を避ける。
 */

export const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

export function parseISO(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return { y, m, d };
}
export function iso({ y, m, d }) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function dow(dt) {
  return new Date(dt.y, dt.m - 1, dt.d).getDay();
}
export function shift(dt, days) {
  const t = new Date(dt.y, dt.m - 1, dt.d + days);
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
}

/** 2日付の差（日数）。end - start */
export function diffDays(a, b) {
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86400000);
}

/** 祝日名（祝日でなければnull） */
export function holidayName(dt, holidays) {
  return holidays[iso(dt)] || null;
}

/**
 * 休業日の判定。
 * @param {object} opt {sat:bool 土曜を休みにする, sun:bool, holiday:bool 祝日, yearEnd:bool 年末年始12/31-1/3}
 */
export function isClosed(dt, holidays, opt = {}) {
  const o = { sat: true, sun: true, holiday: true, yearEnd: false, ...opt };
  const w = dow(dt);
  if (o.sun && w === 0) return true;
  if (o.sat && w === 6) return true;
  if (o.holiday && holidayName(dt, holidays)) return true;
  if (o.yearEnd) {
    if (dt.m === 12 && dt.d === 31) return true;
    if (dt.m === 1 && dt.d <= 3) return true;
  }
  return false;
}

/**
 * 期間の日数を数える。
 * @returns {{total, business, closed, holidays: [{date,name}], weekdays: number[]}}
 */
export function countDays(from, to, holidays, opt = {}, includeEnd = true) {
  if (diffDays(from, to) < 0) [from, to] = [to, from];
  const end = includeEnd ? diffDays(from, to) : diffDays(from, to) - 1;
  let total = 0, business = 0, closed = 0;
  const hs = [];
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i <= end; i++) {
    const dt = shift(from, i);
    total++;
    weekdays[dow(dt)]++;
    const hn = holidayName(dt, holidays);
    if (hn) hs.push({ date: iso(dt), name: hn });
    if (isClosed(dt, holidays, opt)) closed++;
    else business++;
  }
  return { total, business, closed, holidays: hs, weekdays };
}

/**
 * 営業日を加算する。「3営業日後」の計算。
 * n=0 なら、その日が休業日でなければ当日、休業日なら次の営業日を返す。
 */
export function addBusinessDays(from, n, holidays, opt = {}) {
  let cur = { ...from };
  if (n === 0) {
    while (isClosed(cur, holidays, opt)) cur = shift(cur, 1);
    return cur;
  }
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    cur = shift(cur, step);
    if (!isClosed(cur, holidays, opt)) left--;
  }
  return cur;
}

/** 暦日を加算（休業日は考慮しない） */
export function addDays(from, n) {
  return shift(from, n);
}

/** 営業日調整: 休業日なら前/翌の営業日へずらす */
export function adjust(dt, mode, holidays, opt = {}) {
  if (mode === "none") return { ...dt, moved: false };
  const step = mode === "prev" ? -1 : 1;
  let cur = { ...dt };
  let moved = false;
  while (isClosed(cur, holidays, opt)) {
    cur = shift(cur, step);
    moved = true;
  }
  return { ...cur, moved };
}
