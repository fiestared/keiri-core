/**
 * 給与（月給）に対する源泉徴収税額の計算（DOM非依存・テスト対象）。令和8年分。
 *
 * ここは「報酬・料金」(gensen_core.js の 10.21%) とは全くの別物。
 * 給与は国税庁の「給与所得の源泉徴収税額表（月額表）」を引いて求める。
 *
 * 一次ソース（2026-07-13に実読）:
 * - 月額表 https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/01-07.pdf
 *   → tools/extract_gensen_table.py で gensen_getsugaku_r08.json に機械抽出（手打ちしない）
 * - 甲欄の電算機計算の特例 .../denshi_01.pdf
 * - No.2511 税額表の種類と使い方
 *
 * ■ 表の値と特例の値は一致しない（重要。denshi_01.pdf 3ページ目に明記）
 *   例: 社保控除後175,000円・扶養親族等2人 → 月額表 250円 / 特例 210円。
 *   どちらも適法で、差額は年末調整で精算される。
 *   実測（令和8年分・表の全1,848セル）: 375件が不一致、うち368件は±10円、最大100円。
 *   「表は階級の中間値で計算してある」は食い違いの *理由の説明* であって、
 *   **中間値を入れれば表と同じ値になるという意味ではない**（実際に成り立たない）。
 *   → このツールは「表を引くのが面倒」を解決するものなので **月額表の値を主** として出し、
 *     特例の値は「給与ソフトはこの額を出すことがある」という説明として併記する。
 *     特例の値だけを出すと、手元のPDFと違う数字になり、しかも低所得帯では表より高く出る。
 *
 * ■ 端数処理
 *   源泉徴収税額の1円未満は切捨て（国税通則法119条4項）。
 *   特例の税額は10円未満を四捨五入（第4表の注）。給与所得控除は1円未満切上げ（第1表の注）。
 */

/** 扶養親族等の数（＝源泉控除対象配偶者 + 源泉控除対象親族）に加算する人数を求める。
 * 月額表(備考)1(4): 本人が障害者・寡婦・ひとり親・勤労学生に該当するごとに1人、
 * 同一生計配偶者や扶養親族のうち障害者・同居特別障害者に該当するごとに1人を加算する。
 * @param {{shogaisha?:boolean, kafu?:boolean, hitorioya?:boolean, kinroGakusei?:boolean,
 *          shogaishaFuyoCount?:number}} opts
 */
export function extraDependentCount(opts = {}) {
  let n = 0;
  if (opts.shogaisha) n += 1;
  if (opts.kafu) n += 1;
  if (opts.hitorioya) n += 1;
  if (opts.kinroGakusei) n += 1;
  n += Math.max(0, Math.floor(opts.shogaishaFuyoCount || 0));
  return n;
}

/** 月額表の該当行を返す（社会保険料等控除後の給与等の金額 A）。表の範囲外なら null。 */
export function findRow(table, A) {
  if (A < table.otsuLowMax) return null;         // 105,000円未満は別扱い
  if (A >= table.tableMax) return null;          // 740,000円以上は算式
  // 表は連続した階段なので線形探索でよい（231行）
  return table.rows.find((r) => A >= r.min && A < r.max) || null;
}

/**
 * 甲欄（扶養控除等申告書の提出あり）の税額を月額表から求める。
 * @param {object} table gensen_getsugaku_r08.json
 * @param {number} A その月の社会保険料等控除後の給与等の金額
 * @param {number} n 扶養親族等の数（加算後）
 */
export function kouTax(table, A, n) {
  if (!(A > 0)) return 0;
  const nn = Math.max(0, Math.floor(n));
  // 7人を超える分は、7人の税額から1人ごとに1,610円を控除する（備考1(3)）
  const idx = Math.min(nn, 7);
  const over7 = Math.max(0, nn - 7) * table.over7Deduction;

  let base;
  if (A < table.otsuLowMax) {
    base = 0;                                     // 105,000円未満は甲欄すべて0円
  } else if (A < table.tableMax) {
    base = findRow(table, A).kou[idx];
  } else {
    // 740,000円以上: 「区分の基点の税額 + 基点を超える金額 × 率」
    const seg = [...table.kouSegments].reverse().find((s) => A >= s.from);
    base = Math.floor(seg.baseTax[idx] + (A - seg.from) * seg.rate);
  }
  return Math.max(0, base - over7);
}

/** 乙欄（扶養控除等申告書の提出なし）の税額を月額表から求める。 */
export function otsuTax(table, A, jutaruFuyoCount = 0) {
  if (!(A > 0)) return 0;
  let base;
  if (A < table.otsuLowMax) {
    base = Math.floor(A * table.otsuLowRate);     // 3.063%
  } else if (A < table.tableMax) {
    base = findRow(table, A).otsu;
  } else {
    const seg = [...table.otsuSegments].reverse().find((s) => A >= s.from);
    base = Math.floor(seg.base + (A - seg.from) * seg.rate);
  }
  // 「従たる給与についての扶養控除等申告書」がある場合のみ1人1,610円を控除（備考2）
  const ded = Math.max(0, Math.floor(jutaruFuyoCount)) * table.over7Deduction;
  return Math.max(0, base - ded);
}

// ─────────────────────────────────────────────────────────────
// 電算機計算の特例（denshi_01.pdf）。給与システムが使う、給与額そのものからの算式。
// 月額表とは値が食い違う（冒頭のコメント参照）。表の検算オラクルとしても使う。
// ─────────────────────────────────────────────────────────────

/** 第1表: 給与所得控除の額（1円未満切上げ） */
export function kyuyoShotokuKojo(A) {
  let v;
  if (A <= 158_333) v = 54_167;
  else if (A <= 299_999) v = A * 0.30 + 6_667;
  else if (A <= 549_999) v = A * 0.20 + 36_667;
  else if (A <= 708_330) v = A * 0.10 + 91_667;
  else v = 162_500;
  return Math.ceil(v);
}

/** 第3表: 基礎控除の額 */
export function kisoKojo(A) {
  if (A <= 2_120_833) return 48_334;
  if (A <= 2_162_499) return 40_000;
  if (A <= 2_204_166) return 26_667;
  if (A <= 2_245_833) return 13_334;
  return 0;
}

/** 第4表: 課税給与所得金額Bから税額（10円未満四捨五入） */
export function taxFromB(B) {
  if (B <= 0) return 0;
  let v;
  if (B <= 162_500) v = B * 0.05105;
  else if (B <= 275_000) v = B * 0.10210 - 8_296;
  else if (B <= 579_166) v = B * 0.20420 - 36_374;
  else if (B <= 750_000) v = B * 0.23483 - 54_113;
  else if (B <= 1_500_000) v = B * 0.33693 - 130_688;
  else if (B <= 3_333_333) v = B * 0.40840 - 237_893;
  else v = B * 0.45945 - 408_061;
  if (v <= 0) return 0;
  return Math.round(v / 10) * 10;
}

/** 第2表: 配偶者控除・扶養控除は1人あたり31,667円 */
export const KOJO_PER_PERSON = 31_667;

/**
 * 甲欄の電算機計算の特例による税額。
 * @param {number} A その月の社会保険料等控除後の給与等の金額
 * @param {number} n 扶養親族等の数（源泉控除対象配偶者を含む。加算後）
 */
export function denshiKouTax(A, n) {
  if (!(A > 0)) return 0;
  const nn = Math.max(0, Math.floor(n));
  const B = A - kyuyoShotokuKojo(A) - KOJO_PER_PERSON * nn - kisoKojo(A);
  return taxFromB(B);
}
