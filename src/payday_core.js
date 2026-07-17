/**
 * 支払サイト(締め日→支払日)計算の純ロジック(DOM非依存・テスト対象)。
 *
 * 用語: 「月末締め翌月末払い」= closing:"末", offsetMonths:1, payday:"末"
 * 銀行休業日 = 土日 + 祝日(内閣府CSV) + 年末年始(12/31〜1/3)
 * 日付はタイムゾーン事故を避けるため {y,m,d} の整数で扱う(mは1-12)。
 */

export function lastDayOfMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

export function resolveDay(y, m, day) {
  const last = lastDayOfMonth(y, m);
  if (day === "末") return last;
  return Math.min(Number(day), last);
}

export function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function dayOfWeek(y, m, d) {
  return new Date(y, m - 1, d).getDay(); // 0=日
}

export const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 祝日データの収録最終年。holidays が空(=読み込み失敗)なら -Infinity。
 * これを超える年の日付は「祝日を知らないまま営業日判定している」ことになるので、
 * 黙って答えず、呼び出し側で必ず断り書きを出す(下の beyondData)。
 */
export function coverageMaxYear(holidays) {
  let max = -Infinity;
  for (const k of Object.keys(holidays)) {
    const y = Number(k.slice(0, 4));
    if (y > max) max = y;
  }
  return max;
}

export function isBankHoliday(y, m, d, holidays) {
  const dow = dayOfWeek(y, m, d);
  if (dow === 0 || dow === 6) return true;
  if (m === 12 && d === 31) return true;
  if (m === 1 && d <= 3) return true;
  return Object.prototype.hasOwnProperty.call(holidays, iso(y, m, d));
}

function shiftDate(y, m, d, delta) {
  const t = new Date(y, m - 1, d + delta);
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
}

/** adjust: "prev"(前営業日) | "next"(翌営業日) | "none" */
export function adjustBusinessDay(y, m, d, adjust, holidays) {
  if (adjust === "none") return { y, m, d, moved: false };
  const delta = adjust === "prev" ? -1 : 1;
  let cur = { y, m, d };
  let moved = false;
  while (isBankHoliday(cur.y, cur.m, cur.d, holidays)) {
    cur = shiftDate(cur.y, cur.m, cur.d, delta);
    moved = true;
  }
  return { ...cur, moved };
}

function addMonths(y, m, n) {
  const total = y * 12 + (m - 1) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}

/**
 * スケジュール生成。
 * cond: { closing: "末"|number, offsetMonths: 0..3, payday: "末"|number, adjust }
 * 開始月から months ヶ月ぶんの [{closeY,closeM,closeD, periodFrom, periodTo, payY,payM,payD, payDow, moved, payIso}] を返す。
 */
export function schedule(cond, startY, startM, months, holidays) {
  const rows = [];
  const maxY = coverageMaxYear(holidays);
  for (let i = 0; i < months; i++) {
    const cm = addMonths(startY, startM, i);
    const closeD = resolveDay(cm.y, cm.m, cond.closing);
    // 締め期間 = 前回締め日の翌日 〜 今回締め日
    const prev = addMonths(cm.y, cm.m, -1);
    const prevCloseD = resolveDay(prev.y, prev.m, cond.closing);
    const from = shiftDate(prev.y, prev.m, prevCloseD, 1);
    const pm = addMonths(cm.y, cm.m, cond.offsetMonths);
    const payD = resolveDay(pm.y, pm.m, cond.payday);
    const adj = adjustBusinessDay(pm.y, pm.m, payD, cond.adjust, holidays);
    rows.push({
      closeY: cm.y, closeM: cm.m, closeD,
      periodFrom: iso(from.y, from.m, from.d),
      periodTo: iso(cm.y, cm.m, closeD),
      payY: adj.y, payM: adj.m, payD: adj.d,
      payIso: iso(adj.y, adj.m, adj.d),
      payDow: DOW_JA[dayOfWeek(adj.y, adj.m, adj.d)],
      rawPayIso: iso(pm.y, pm.m, payD),
      moved: adj.moved,
      // 祝日データの収録年を超えている = 土日と年末年始しか見ていない(祝日を見落としうる)。
      // 例: 2028年の祝日が未収録のまま 2028-05-05(こどもの日)を「営業日」と答えてしまう
      beyondData: Math.max(pm.y, adj.y) > maxY,
    });
  }
  return rows;
}

/**
 * iCal(.ics)のTEXT値はエスケープが要る(RFC5545 3.3.11)。特に**改行を素通しすると
 * 取引先名から任意のICSプロパティを注入できる**ので、必ずここを通す。
 */
export function icsText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** iCal(.ics)文字列を生成。終日イベント。 */
export function toICS(rows, label) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//keiri-tools.com//shiharai-site//JA",
  ];
  for (const r of rows) {
    const ymd = r.payIso.replaceAll("-", "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ymd}-${icsText(label).replace(/\s/g, "")}@keiri-tools.com`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `SUMMARY:支払日: ${icsText(label)}`,
      `DESCRIPTION:締め期間 ${r.periodFrom}〜${r.periodTo}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
