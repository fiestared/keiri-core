/**
 * 年次有給休暇の付与日数の計算（DOM非依存・テスト対象）。
 *
 * 一次ソース（労働基準法39条・厚生労働省リーフレット）:
 * - 一般労働者（週5日以上 または 週30時間以上）: 6ヶ月continuousで10日、以後1年ごとに増加、最大20日
 * - 比例付与（週4日以下 かつ 週30時間未満）: 所定労働日数に応じて按分
 * - 出勤率8割以上が要件（8割未満の年は付与されないが、勤続年数のカウントは進む）
 * - 年5日の時季指定義務: 10日以上付与された労働者が対象
 * - 時効2年（付与日から2年で消滅）
 */

/** 一般労働者（週5日以上または週30時間以上）: 勤続年数 → 付与日数 */
export const FULL_TABLE = [
  { years: 0.5, days: 10 },
  { years: 1.5, days: 11 },
  { years: 2.5, days: 12 },
  { years: 3.5, days: 14 },
  { years: 4.5, days: 16 },
  { years: 5.5, days: 18 },
  { years: 6.5, days: 20 },  // 以降は20日で固定
];

/**
 * 比例付与の表（週30時間未満）。
 * key = 週所定労働日数、値 = 勤続0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5年 の付与日数
 */
export const PRO_TABLE = {
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
};

/** 年間所定労働日数から週所定労働日数を推定（週日数が不明な場合の判定に使う） */
export const YEARLY_RANGES = [
  { weekly: 4, min: 169, max: 216 },
  { weekly: 3, min: 121, max: 168 },
  { weekly: 2, min: 73, max: 120 },
  { weekly: 1, min: 48, max: 72 },
];

export const STAGES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5];

/** 勤続年数（年）→ 段階のインデックス（0〜6）。6.5年以上は6で頭打ち */
export function stageIndex(years) {
  let idx = -1;
  for (let i = 0; i < STAGES.length; i++) {
    if (years >= STAGES[i]) idx = i;
  }
  return Math.min(idx, STAGES.length - 1);
}

/**
 * 付与日数を求める。
 * @param {number} years 勤続年数（年。0.5 = 6ヶ月）
 * @param {number} weeklyDays 週所定労働日数
 * @param {number} weeklyHours 週所定労働時間
 * @returns {{days:number, type:string, stage:number|null, needsWork8:boolean}}
 */
export function grantDays(years, weeklyDays, weeklyHours) {
  const idx = stageIndex(years);
  if (idx < 0) {
    return { days: 0, type: "not_yet", stage: null, needsWork8: false };
  }
  // 一般労働者: 週5日以上 または 週30時間以上
  const isFull = weeklyDays >= 5 || weeklyHours >= 30;
  if (isFull) {
    return { days: FULL_TABLE[idx].days, type: "full", stage: STAGES[idx], needsWork8: true };
  }
  const row = PRO_TABLE[Math.max(1, Math.min(4, Math.floor(weeklyDays)))];
  return { days: row[idx], type: "proportional", stage: STAGES[idx], needsWork8: true };
}

/** 年5日の時季指定義務の対象か（その年に10日以上付与された労働者） */
export function needsFiveDays(grantedDays) {
  return grantedDays >= 10;
}

const pad = (n) => String(n).padStart(2, "0");

/** ローカル時刻の「今日」を YYYY-MM-DD で返す。
 *  日付の比較に new Date("YYYY-MM-DD") を使ってはいけない（ISO日付形式はUTCとして解釈され、
 *  JST(+9)では付与日当日の 00:00〜09:00 が「まだ来ていない」と判定される）。
 *  日付どうしは YYYY-MM-DD の文字列比較で行う＝タイムゾーンの影響を受けない。 */
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 指定した年月の末日（28〜31） */
export function lastDayOfMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate();
}

/**
 * 入社日の Nヶ月後の「応当日」。
 * **応当する日がない月は、その月の末日**（民法143条2項ただし書き / 社労士実務）。
 * 例) 8/31入社の6ヶ月後は「2/31」が無いので **2/28**（閏年は2/29）。10/31入社 → 4/30。
 * JSの new Date(y, m + months, 31) は存在しない日を**翌月へ繰り越す**ため使えない
 * （2/31 → 3/3 になり、法定より遅い付与日を答えてしまう）。
 * @returns {{date:string, clamped:boolean}} clamped=末日に丸めた（＝応当日が無かった）
 */
export function addMonthsClamped(hireISO, months) {
  const [y, m, d] = hireISO.split("-").map(Number);
  const t = new Date(y, m - 1 + months, 1);        // 対象の「月」だけを求める（日は繰り越さない）
  const ty = t.getFullYear();
  const tm = t.getMonth() + 1;
  const last = lastDayOfMonth(ty, tm);
  const day = Math.min(d, last);
  return { date: `${ty}-${pad(tm)}-${pad(day)}`, clamped: day < d };
}

/** 入社日から今日までの勤続月数（応当日に達していなければ切り捨て。末日クランプと整合させる） */
export function elapsedMonths(hireISO, today = todayISO()) {
  const [hy, hm, hd] = hireISO.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let months = (ty - hy) * 12 + (tm - hm);
  const anniv = Math.min(hd, lastDayOfMonth(ty, tm)); // 今月に応当日が無ければ末日が応当日
  if (td < anniv) months -= 1;
  return Math.max(0, months);
}

/** 入社日から見た各段階の付与日と付与日数 */
export function schedule(hireISO, weeklyDays, weeklyHours, count = 8) {
  const rows = [];
  for (let i = 0; i < Math.min(count, 60); i++) {
    const years = 0.5 + i;   // 6ヶ月, 1年6ヶ月, ...
    const { date, clamped } = addMonthsClamped(hireISO, Math.round(years * 12));
    const g = grantDays(years, weeklyDays, weeklyHours);
    rows.push({ date, clamped, years, days: g.days, mustTakeFive: needsFiveDays(g.days) });
  }
  return rows;
}

/**
 * 「今日」時点の付与状況。**画面の見出しも表もこの1つの結果から描く**こと。
 * 以前は見出し（勤続月数からの逆算）と表（付与日の一覧）が別々の日付計算を持っていて、
 * 月末入社のとき「10日付与済み」と「初回付与は未来（予定）」を同時に表示していた。
 * @returns {{days, type, months, grantDate, clamped, current, next, rows}}
 */
export function currentGrant(hireISO, weeklyDays, weeklyHours, today = todayISO()) {
  const [hy] = hireISO.split("-").map(Number);
  const [ty] = today.split("-").map(Number);
  const count = Math.max(8, ty - hy + 3);           // 長期勤続でも「次回の付与」が必ず出る段数
  const all = schedule(hireISO, weeklyDays, weeklyHours, count);

  let current = null, next = null;
  for (const r of all) {
    if (r.date <= today) current = r;               // 文字列比較（タイムゾーン非依存）
    else { next = r; break; }
  }
  const months = elapsedMonths(hireISO, today);
  const type = grantDays(Math.max(0.5, months / 12), weeklyDays, weeklyHours).type;

  // 表は最大8行。長期勤続では「次回の付与」が必ず見えるよう末尾を窓で切る
  const nextIdx = next ? all.indexOf(next) : all.length - 1;
  const end = Math.min(all.length, Math.max(8, nextIdx + 1));
  const rows = all.slice(Math.max(0, end - 8), end);

  return {
    days: current ? current.days : 0,
    type, months,
    grantDate: current ? current.date : null,
    clamped: all.some((r) => r.clamped),
    current, next, rows,
  };
}
