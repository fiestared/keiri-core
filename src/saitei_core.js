/**
 * 最低賃金の判定コア（DOM非依存・テスト対象）。
 *
 * 出すもの: 都道府県と自分の賃金から、地域別最低賃金を下回っていないかを判定し、
 *   下回っている場合の不足額（時給・月・年）を出す。
 *
 * ★★このツールが黙って誤答しやすい急所:
 *
 *  1. **月給制は「時間額に換算してから」比べる（最低賃金法施行規則2条）。**
 *     月給 ÷ 1か月平均所定労働時間 で時間額にする。1か月平均所定労働時間は
 *     「年間所定労働日数 × 1日の所定労働時間 ÷ 12」であって、単純な「月の暦日数×8」ではない。
 *     ここを間違えると、実際は違反なのに「クリア」と出す。**安全側に倒さず正しく出す**。
 *
 *  2. **最低賃金に算入しない賃金がある（最低賃金法4条3項・施行規則1条）。**
 *     ①臨時に支払われる賃金（結婚手当など）②1か月を超える期間ごとに支払われる賃金（賞与など）
 *     ③時間外・休日・深夜の割増賃金 ④精皆勤手当・通勤手当・家族手当。
 *     **残業代や通勤手当を足した額で比べると、違反を見逃す。** 入力段階で除外させる。
 *
 *  3. **発効日をまたぐ月がある。** 令和7年度は発効日が都道府県ごとにバラバラで、
 *     2025-10-01〜2026-03-31 と半年も開いている。「今日時点で有効な額」を出すには
 *     発効日と判定日を比べる必要がある。発効前なら改定前の額が有効。
 *
 *  4. **端数処理。** 月給からの時間額換算は円未満を切り捨てず、**そのまま比較**する
 *     （切り捨てると、わずかに下回っているケースを「ちょうど」と誤判定する）。
 *     表示のときだけ丸める。
 *
 *  5. **特定（産業別）最低賃金は別にある。** 地域別より高い産業別最低賃金が適用される
 *     場合がある。このツールは地域別のみを扱う旨を画面で明示する（誤って「クリア」と
 *     言い切らない）。
 */

/** 年間所定労働日数と1日の所定労働時間から、1か月平均所定労働時間を出す。 */
export function monthlyHours(daysPerYear, hoursPerDay) {
  const d = Number(daysPerYear), h = Number(hoursPerDay);
  if (!(d > 0) || !(h > 0)) return null;
  if (d > 366) return null; // 年間日数が366を超えるのは入力誤り
  return (d * h) / 12;
}

/** 判定日時点で有効な最低賃金額を返す。発効日前なら改定前の額（急所3）。 */
export function effectiveWage(pref, onDate) {
  if (!pref) return null;
  if (!onDate) return { wage: pref.wage, applied: "current", effective: pref.effective };
  const on = String(onDate).slice(0, 10);
  if (on >= pref.effective) return { wage: pref.wage, applied: "current", effective: pref.effective };
  return { wage: pref.prev, applied: "previous", effective: pref.effective };
}

/**
 * 最低賃金を満たしているか判定する。
 *
 * input:
 *   prefCode  … 都道府県名（データの pref と一致する短い名前。例 "東京"）
 *   wageType  … "hourly" | "monthly"
 *   amount    … 時給、または月給（※急所2の除外後の金額）
 *   daysPerYear, hoursPerDay … 月給制のときだけ使う
 *   onDate    … 判定日 "YYYY-MM-DD"（省略時は発効日を考慮せず現行額で判定）
 * D … saitei_chingin_r07.json
 */
export function judgeSaitei(input, D) {
  const notes = [];
  const pref = (D.prefectures || []).find((p) => p.pref === input.prefCode);
  if (!pref) return { ok: false, error: "都道府県が選ばれていません。" };

  const eff = effectiveWage(pref, input.onDate);
  if (eff.applied === "previous") {
    notes.push(`${pref.full}の令和7年度額（${pref.wage}円）の発効日は${pref.effective_wa}です。判定日はそれより前のため、改定前の${pref.prev}円で判定しました。`);
  }
  const minWage = eff.wage;

  const amount = Number(input.amount);
  if (!(amount > 0)) return { ok: false, error: "賃金額を入力してください。" };

  let hourly, hours = null;
  if (input.wageType === "monthly") {
    hours = monthlyHours(input.daysPerYear, input.hoursPerDay);
    if (hours == null) return { ok: false, error: "年間所定労働日数と1日の所定労働時間を入力してください。" };
    hourly = amount / hours; // 急所4: ここでは丸めない
    notes.push(`1か月平均所定労働時間は ${input.daysPerYear}日 × ${input.hoursPerDay}時間 ÷ 12 = ${round1(hours)}時間 として計算しました。`);
  } else {
    hourly = amount;
  }

  const diff = hourly - minWage;              // 正なら上回り、負なら不足
  const clears = diff >= 0;
  const shortPerHour = clears ? 0 : minWage - hourly;

  // 不足額の月・年換算（月給制なら実際の所定時間、時給制なら仮に月の所定時間を使う）
  const hoursForMonth = hours != null ? hours : monthlyHours(input.daysPerYear || 0, input.hoursPerDay || 0);
  const shortPerMonth = hoursForMonth ? shortPerHour * hoursForMonth : null;

  return {
    ok: true,
    pref: pref.full,
    minWage,
    appliedPrevious: eff.applied === "previous",
    effective: pref.effective,
    effectiveWa: pref.effective_wa,
    hourly,                                   // 生の値（丸めない）
    hourlyRounded: Math.round(hourly * 100) / 100,
    monthlyHours: hours,
    clears,
    diff,
    shortPerHour,
    shortPerMonth,
    shortPerYear: shortPerMonth == null ? null : shortPerMonth * 12,
    notes,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;

/** 全国順位（高い順・同額は同順位）。 */
export function rankOf(prefCode, D) {
  const list = (D.prefectures || []).slice().sort((a, b) => b.wage - a.wage);
  const me = list.find((p) => p.pref === prefCode);
  if (!me) return null;
  return { rank: list.filter((p) => p.wage > me.wage).length + 1, total: list.length, wage: me.wage };
}

/** 全国最高・最低との差。 */
export function spread(D) {
  const list = (D.prefectures || []);
  if (!list.length) return null;
  const hi = list.reduce((a, b) => (b.wage > a.wage ? b : a));
  const lo = list.reduce((a, b) => (b.wage < a.wage ? b : a));
  return { hi, lo, gap: hi.wage - lo.wage };
}
