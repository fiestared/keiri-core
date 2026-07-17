/**
 * 賞与（ボーナス）に対する源泉徴収税額の計算（DOM非依存・テスト対象）。令和8年分。
 *
 * 一次ソース（2026-07-13に実読）:
 * - 賞与に対する源泉徴収税額の算出率の表（令和8年分）
 *   https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/15-16.pdf
 *   → tools/extract_shoyo_table.py で gensen_shoyo_r08.json に機械抽出（手打ちしない）
 * - 税額表の使い方（同 19-22.pdf）… 令和8年分の使用例がある（テストのオラクル）
 * - タックスアンサー No.2523 賞与に対する源泉徴収 … 月額表による例外計算の算式
 *
 * ■ 月額表との違い（混同すると誤答する）
 *   1. 引くのは「税額」ではなく「率」。税額 = (賞与 − 社会保険料等) × 率
 *   2. 表を引く鍵は **前月の**社会保険料等控除後の給与等の金額（賞与の額ではない）
 *   3. 甲欄の最終列は「**7人以上**」。月額表の「7人 + 1人ごとに1,610円控除」は
 *      **賞与の算出率の表には無い**（表の見出しと備考のどちらにも書かれていない）。
 *      ただし後述の「月額表による例外計算」に入ったときは、月額表の規律なので1,610円控除が効く。
 *   4. 乙欄は21段の率のうち **5段しか使わない**（10.210/20.420/30.630/38.798/45.945%）
 *
 * ■ 例外: 算出率の表を使ってはいけない場合（表の備考4）
 *   ・前月中の給与等の支払がない
 *   ・前月中の給与等の金額 ≦ 前月中の社会保険料等の金額（＝控除後が0以下）
 *   ・賞与（社会保険料等控除後）が、前月の給与（社会保険料等控除後）の **10倍を超える**
 *   このときは「この表によらず、月額表を使って税額を計算します」。算式は No.2523 のとおり。
 *
 * ■ 端数処理
 *   ・税額の1円未満は切捨て（国税通則法119条4項）
 *   ・例外計算の「÷6（または12）」も1円未満切捨て（No.2523の計算例で確認）
 *   ・率は 0.001% 刻み。**浮動小数点で持たない**（0.02042 を掛けると1円ずれる入力がある。第8便の教訓）。
 *     JSONは「10万分率の整数」で持ち、割り算は最後に1回だけにする。
 */

/** 賞与の計算期間から除数を決める。6か月を超える場合は12（表の備考4／No.2523の注）。 */
export function divisorFor(months) {
  return Number(months) > 6 ? 12 : 6;
}

/** 帯（千円単位）に金額（円）が含まれるか。 */
function bandContains(band, yen) {
  const lo = band.min == null ? 0 : band.min * 1000;
  const hi = band.max == null ? null : band.max * 1000;
  return yen >= lo && (hi == null || yen < hi);
}

/**
 * 算出率の表から「賞与の金額に乗ずべき率」を引く。
 * @param {object} table gensen_shoyo_r08.json
 * @param {number} zengetsu 前月の社会保険料等控除後の給与等の金額（円）
 * @param {number} n 扶養親族等の数（障害者等の加算後）
 * @param {'kou'|'otsu'} kubun 甲欄／乙欄
 * @returns {{rate:number, band:object, ratePercent:number}} rate は10万分率の整数
 */
export function findRate(table, zengetsu, n, kubun = 'kou') {
  const A = Math.max(0, Math.floor(zengetsu || 0));
  if (kubun === 'otsu') {
    for (const row of table.rows) {
      if (row.otsu && bandContains(row.otsu, A)) {
        return { rate: row.rate, band: row.otsu, ratePercent: row.rate / table.rateScale };
      }
    }
    return null;
  }
  // 甲欄: 7人を超えても列は「7人以上」の1列（月額表のような1,610円控除は無い）
  const idx = Math.min(Math.max(0, Math.floor(n || 0)), 7);
  for (const row of table.rows) {
    const band = row.kou[idx];
    if (bandContains(band, A)) {
      return { rate: row.rate, band, ratePercent: row.rate / table.rateScale };
    }
  }
  return null;
}

/**
 * 通常の計算: (賞与 − 社会保険料等) × 率、1円未満切捨て。
 * @param {number} shoyoAfterIns 社会保険料等控除後の賞与の金額（円）
 * @param {number} rate 10万分率の整数（2.042% なら 2042）
 */
export function taxFromRate(shoyoAfterIns, rate) {
  const A = Math.max(0, Math.floor(shoyoAfterIns || 0));
  // 整数のまま掛けて最後に1回だけ割る（A×rate は最大でも約4.6e12 で安全に整数）
  return Math.floor((A * rate) / 100000);
}

/**
 * 算出率の表を使ってはいけない場合か（表の備考4）。
 * @returns {null | {reason:'no_prev'|'over_10x', detail:string}}
 */
export function getsugakuRequired({ zengetsuPaid, zengetsuAfterIns, shoyoAfterIns }) {
  if (zengetsuPaid === false) {
    return { reason: 'no_prev', detail: '前月中に給与の支払がないため' };
  }
  if (!(zengetsuAfterIns > 0)) {
    // 前月の給与 ≦ 前月の社会保険料等（控除後が0以下）も「前月に給与がない場合」と同じ扱い
    return {
      reason: 'no_prev',
      detail: '前月の給与が社会保険料等以下（控除後が0円以下）のため',
    };
  }
  if (shoyoAfterIns > zengetsuAfterIns * 10) {
    return {
      reason: 'over_10x',
      detail: '賞与（社会保険料等控除後）が前月の給与（同）の10倍を超えるため',
    };
  }
  return null;
}

/**
 * 例外の計算（月額表による）。No.2523の算式そのまま。
 *
 * 月額表の税額を求める関数を **外から渡す**（monthlyTax）。こうしておくと、
 * テストが「国税庁の計算例に載っている月額表の税額」をそのまま入れて、
 * 算式（÷6・+前月・−前月の税額・×6）だけを独立に検算できる。
 *
 * @param {object} p
 * @param {number} p.shoyoAfterIns 社会保険料等控除後の賞与の金額
 * @param {number} p.zengetsuAfterIns 前月の社会保険料等控除後の給与等の金額（無い場合は0）
 * @param {number} p.months 賞与の計算期間（月）。6を超えると12で割る
 * @param {(amount:number)=>number} p.monthlyTax 月額表の税額を返す関数
 * @returns {{tax:number, steps:object}}
 */
export function taxViaGetsugaku({ shoyoAfterIns, zengetsuAfterIns, months, monthlyTax }) {
  const d = divisorFor(months);
  const shoyo = Math.max(0, Math.floor(shoyoAfterIns || 0));
  const zen = Math.max(0, Math.floor(zengetsuAfterIns || 0));

  const perMonth = Math.floor(shoyo / d);        // ① 1円未満切捨て
  const combined = perMonth + zen;               // ② 前月の給与を足す（前月なしなら0）
  const taxCombined = monthlyTax(combined);      // ③ 月額表
  const taxZengetsu = zen > 0 ? monthlyTax(zen) : 0; // ④ 前月の給与に対する税額
  const diff = Math.max(0, taxCombined - taxZengetsu);
  const tax = diff * d;                          // ⑤ ×6（または12）

  return {
    tax,
    steps: { divisor: d, perMonth, combined, taxCombined, taxZengetsu, diff },
  };
}

/**
 * 入口。通常の計算と例外の計算を振り分ける。
 *
 * @param {object} p
 * @param {object} p.table 算出率の表（gensen_shoyo_r08.json）
 * @param {number} p.shoyo 賞与の支給額
 * @param {number} p.shoyoIns 賞与から控除する社会保険料等
 * @param {number} p.zengetsu 前月の給与等の金額
 * @param {number} p.zengetsuIns 前月の給与から控除された社会保険料等
 * @param {boolean} p.zengetsuPaid 前月に給与の支払があったか
 * @param {number} p.dependents 扶養親族等の数（障害者等の加算後）
 * @param {'kou'|'otsu'} p.kubun
 * @param {number} p.months 賞与の計算期間（月）
 * @param {(amount:number, kubun:string)=>number} p.monthlyTax 月額表の税額
 */
export function calcShoyo(p) {
  const shoyoAfterIns = Math.max(0, Math.floor((p.shoyo || 0) - (p.shoyoIns || 0)));
  const zengetsuAfterIns = Math.max(0, Math.floor((p.zengetsu || 0) - (p.zengetsuIns || 0)));

  const need = getsugakuRequired({
    zengetsuPaid: p.zengetsuPaid,
    zengetsuAfterIns,
    shoyoAfterIns,
  });

  if (need) {
    const r = taxViaGetsugaku({
      shoyoAfterIns,
      zengetsuAfterIns: need.reason === 'no_prev' ? 0 : zengetsuAfterIns,
      months: p.months,
      monthlyTax: (amount) => p.monthlyTax(amount, p.kubun),
    });
    return {
      method: 'getsugaku',
      reason: need.reason,
      detail: need.detail,
      shoyoAfterIns,
      zengetsuAfterIns,
      tax: r.tax,
      steps: r.steps,
    };
  }

  const hit = findRate(p.table, zengetsuAfterIns, p.dependents, p.kubun);
  if (!hit) return { method: 'error', shoyoAfterIns, zengetsuAfterIns, tax: 0 };

  return {
    method: 'rate',
    shoyoAfterIns,
    zengetsuAfterIns,
    rate: hit.rate,
    ratePercent: hit.ratePercent,
    band: hit.band,
    tax: taxFromRate(shoyoAfterIns, hit.rate),
  };
}
