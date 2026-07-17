/**
 * 自動車税（種別割）・軽自動車税（種別割）判定コア（DOM非依存・テスト対象）。
 *
 * 出すもの: 自家用乗用車の年額（標準税率）と、13年超（ディーゼルは11年超）の重課、
 *   年度の途中に新規登録した年度の月割を、令和8年度の税額表（jidoshazei_r08.json）で計算する。
 *
 * ★★このツールが黙って誤答しやすい急所:
 *
 *  1. **新旧税率の境界（登録車＝令和元年10月1日／軽＝平成27年4月1日）。** 自家用乗用車は
 *     令和元年10月1日以後に初度登録された車から税率が引き下げられた。同じ排気量でも
 *     初度登録日で税額が違う。境界は「登録車」と「軽自動車」で日付そのものが違う。
 *
 *  2. **重課はハイブリッド・電気を対象外にする（最大の急所）。** 13年超でも、
 *     電気・天然ガス・メタノール・**ガソリンを燃料とするハイブリッド車**、一般乗合バス・
 *     スクールバス・被けん引車は重課の対象外。ここを一律に重課すると、いちばん台数の多い
 *     ハイブリッド車の所有者に約15%多い税額を答えてしまう。ディーゼルだけ11年超で重課。
 *
 *  3. **軽自動車税に月割はない。** 登録車（自動車税）は年度途中の新規登録で月割になるが、
 *     軽自動車税（種別割）は4月1日現在の所有者に年額課税で、買った年度分はかからない。
 *     登録車の月割ロジックを軽に当てるのは誤答。
 *
 *  4. **月割は「登録した月の翌月から3月まで」。** 4月登録なら5月〜3月＝11か月、
 *     2月登録なら3月＝1か月、3月登録は0か月（＝その年度は課税されない）。
 *     月割額＝年額×月数÷12の100円未満切捨（東京都の月割税額表と一致を確認済）。
 *     月割は新規登録した年度の話なので、必ず標準税率（重課でない）に対して行う。
 *
 *  5. **軽自動車税は市区町村税・自動車税は都道府県税で、そもそも別の税。** 排気量で普通車か
 *     軽かが分かれ、税額の体系ごと違う（軽の自家用乗用は排気量によらず定額）。
 *
 * 一次情報: 東京都主税局『自動車税』税率表・重課の月割税額表・『自動車税のグリーン化』／
 *   大阪市『軽自動車税の税率（年額）』。全数値を 2026-07-17 に curl 生読みで転記。
 */

/** 100円未満切捨（負・NaNは0）。月割の端数処理。 */
function floorTo100(n) {
  const v = Math.floor(Number(n) / 100) * 100;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 月割の月数を返す。登録した月（1〜12）の翌月から翌年3月まで。
 *  4月→11 / 12月→3 / 1月→2 / 2月→1 / 3月→0
 * 年度（4月〜翌3月）の考え方: 登録月が4〜12月なら 15−月、1〜3月なら 3−月。
 */
export function prorationMonths(regMonth) {
  const m = Math.floor(Number(regMonth));
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  return m >= 4 ? 15 - m : 3 - m;
}

/**
 * 入口。
 * input = {
 *   vehicle,       // 'passenger'（登録車 自家用乗用車）| 'kei'（軽自動車 自家用乗用）
 *   cc,            // passenger のとき: brackets のキー（'ev','le1000',…'gt6000'）
 *   firstReg,      // 'YYYY-MM'（初度登録／軽は最初の新規検査 の年月）。新旧税率の判定に使う
 *   fuel,          // 'gasoline'（ガソリン・LPG）| 'diesel' | 'hybrid' | 'ev_other'
 *   jyuka,         // true = 初度登録から13年（ディーゼルは11年）超が経過している（重課年数）
 *   prorateMonth,  // 1〜12 = その月に新規登録した年度の月割を出す（登録車のみ）／null=年額のみ
 * }
 * D = jidoshazei_r08.json
 *
 * 返り値 = {
 *   vehicleName, taxKind, ccLabel,
 *   rateType,        // 'new' | 'old'
 *   rateTypeLabel,   // 例 '令和元年10月1日以後の初度登録（新税率）'
 *   standard,        // 標準税率（年額）
 *   annual,          // 実際の年額（重課適用なら重課額・そうでなければ standard）
 *   isJyuka,         // true = 重課を適用した
 *   jyukaBlocked,    // true = 重課年数だが燃料が対象外（ハイブリッド・電気等）で適用しなかった
 *   proration,       // { month, months, amount } or null（軽自動車は常に null）
 *   dueThisYear,     // その年度に実際に納める額（月割があれば月割額・なければ annual）
 *   notes: [],
 * }
 */
export function calcJidoshazei(input, D) {
  if (!D || !D.passenger || !D.kei) throw new Error('参照データ（jidoshazei_r08.json）が渡されていません');
  const i = input || {};
  const notes = [];

  if (i.vehicle !== 'passenger' && i.vehicle !== 'kei') {
    throw new Error('車種（登録車／軽自動車）を選んでください');
  }

  // 新旧税率の判定に使う初度登録年月（'YYYY-MM'）。省略時は境界以後（新）とみなさず必須にする
  const firstReg = typeof i.firstReg === 'string' ? i.firstReg.slice(0, 7) : '';
  if (!/^\d{4}-\d{2}$/.test(firstReg)) {
    throw new Error('初度登録（軽自動車は最初の新規検査）の年月を入力してください');
  }

  // ── 軽自動車（自家用乗用・定額。市区町村税・月割なし）───────────────────────────
  if (i.vehicle === 'kei') {
    const k = D.kei;
    const rateType = firstReg >= k.boundary ? 'new' : 'old';
    const standard = rateType === 'new' ? k.new : k.old;
    const rateTypeLabel = rateType === 'new'
      ? `${k.boundary_label}以後の最初の新規検査（新税率）`
      : `${k.boundary_label}より前の最初の新規検査（旧税率）`;

    // 重課: 軽の対象外燃料はハイブリッド・電気等。ディーゼルの区別は無く一律13年超
    const jyukaExcluded = i.fuel === 'hybrid' || i.fuel === 'ev_other';
    let annual = standard, isJyuka = false, jyukaBlocked = false;
    if (i.jyuka) {
      if (jyukaExcluded) {
        jyukaBlocked = true;
        notes.push('電気・ハイブリッド等の軽自動車は重課の対象外です。標準税率で計算しました。');
      } else {
        annual = k.jyuka;
        isJyuka = true;
        notes.push('最初の新規検査から13年を超えた軽自動車（自家用乗用）は重課で12,900円です。');
      }
    }
    if (i.prorateMonth) notes.push('軽自動車税（種別割）に月割はありません。4月1日現在の所有者に年額が課税されます。');
    notes.push('軽自動車税（種別割）は市区町村税です。標準税率はほぼ全国共通ですが、詳しくはお住まいの市区町村でご確認ください。');

    return {
      vehicleName: k.label, taxKind: k.tax_kind, ccLabel: '三輪以上・660cc以下',
      rateType, rateTypeLabel, standard, annual, isJyuka, jyukaBlocked,
      proration: null, dueThisYear: annual, notes,
    };
  }

  // ── 登録車（自家用乗用車）─────────────────────────────────────────────────────
  const P = D.passenger;
  const b = (P.brackets || []).find((x) => x.key === i.cc);
  if (!b) throw new Error('総排気量の区分を選んでください');

  // 電気自動車の区分を選んだら燃料は電気扱い（重課対象外）に寄せる
  const isEvBracket = b.key === 'ev';
  const fuel = isEvBracket ? 'ev_other' : i.fuel;

  const rateType = firstReg >= P.boundary ? 'new' : 'old';
  const standard = rateType === 'new' ? b.new : b.old;
  const rateTypeLabel = rateType === 'new'
    ? `${P.boundary_label}以後の初度登録（新税率）`
    : `${P.boundary_label}より前の初度登録（旧税率）`;

  // 重課: ガソリン・LPGは13年超／ディーゼルは11年超。ハイブリッド・電気・その他は対象外（急所2）
  const jyukaEligibleFuel = fuel === 'gasoline' || fuel === 'diesel';
  let annual = standard, isJyuka = false, jyukaBlocked = false;
  if (i.jyuka) {
    if (!jyukaEligibleFuel || b.jyuka == null) {
      jyukaBlocked = true;
      notes.push('電気・天然ガス・メタノール・ハイブリッド車、一般乗合バス・被けん引車は重課の対象外です。標準税率で計算しました。');
    } else {
      annual = b.jyuka;
      isJyuka = true;
      const yrs = fuel === 'diesel' ? D.jyuka_rule.diesel_years : D.jyuka_rule.gasoline_years;
      notes.push(`初度登録から${yrs}年を超えた${fuel === 'diesel' ? 'ディーゼル' : 'ガソリン・LPG'}車は重課（${D.jyuka_rule.rate_note}）です。`);
    }
  }

  // 月割（急所4）: その月に新規登録した年度の月割。必ず標準税率に対して行う（新車なので重課でない）
  let proration = null;
  if (i.prorateMonth) {
    const months = prorationMonths(i.prorateMonth);
    if (months == null) throw new Error('登録した月（1〜12）を選んでください');
    if (months === 0) {
      proration = { month: Math.floor(Number(i.prorateMonth)), months: 0, amount: 0 };
      notes.push('3月に新規登録した場合、その年度分の自動車税はかかりません（翌年度から年額）。');
    } else {
      const amount = floorTo100(standard * months / 12);
      proration = { month: Math.floor(Number(i.prorateMonth)), months, amount };
      notes.push('月割は登録した月の翌月から翌年3月までの月数で計算し、翌年度からは年額になります。');
    }
  }

  const dueThisYear = proration ? proration.amount : annual;

  return {
    vehicleName: P.label, taxKind: P.tax_kind, ccLabel: b.label,
    rateType, rateTypeLabel, standard, annual, isJyuka, jyukaBlocked,
    proration, dueThisYear, notes,
  };
}
