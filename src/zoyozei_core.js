/**
 * 贈与税（暦年課税）の計算コア（DOM非依存・テスト対象）。
 *
 * 出すもの: その年（1/1〜12/31）に受けた贈与財産の合計額から、暦年課税の贈与税額を計算する。
 *   贈与税額 ＝（その年に受けた贈与財産の合計額 − 基礎控除110万円）を「基礎控除後の課税価格」とし、
 *   速算表（金額×税率 − 控除額）を当てた額。国税庁 No.4408 の計算そのもの。
 *
 * ★★このツールが黙って誤答しやすい急所（国税庁 No.4408）:
 *
 *  1. **一般税率と特例税率の速算表を取り違えない。**（最大の急所）
 *     特例税率（負担が軽い）は「直系尊属（父母・祖父母）から」かつ「受贈者が贈与を受けた年の
 *     1月1日に18歳以上」の**両方**を満たす贈与にだけ使う。片方でも欠ければ一般税率。
 *     → 本コアは分類済みの金額を受け取る（ippan＝一般贈与財産、tokurei＝特例贈与財産）。
 *       黙って有利な特例表を当てない（画面が2条件を尋ねて分類する）。
 *
 *  2. **基礎控除110万円は受贈者ごと・1年ごとに1回だけ。**（相法21条の5・措法70条の2の4）
 *     複数の人からもらっても、110万円は贈与者ごとではなく合計額から1回だけ差し引く。
 *     → 本コアは ippan＋tokurei の合計から110万円を1回だけ引く（贈与者ごとに引かない）。
 *
 *  3. **一般と特例の両方を同じ年に受けた場合は按分計算。**（No.4408 (3)）
 *     ①合計額を全額一般として計算した税額×一般の割合 ＋ ②合計額を全額特例として計算した税額×特例の割合。
 *     基礎控除110万円は合計額から1回だけ引く。
 *
 *  4. **暦年課税と相続時精算課税を混同しない。** 本コアは暦年課税。相続時精算課税
 *     （特別控除2,500万＋令和6年〜の年110万基礎控除）は別制度で対象外（画面で明言）。
 *
 *  5. **合計110万円以下は非課税・申告不要。** 「贈与税はかかりません」と明言し、税額を出さない。
 *
 * 端数処理: 課税標準（基礎控除後の課税価格）は1,000円未満切り捨て、確定した贈与税額は
 *   100円未満切り捨て（国税通則法118条・119条）。
 *
 * 一次情報: 相続税法21条の5・21条の7／租税特別措置法70条の2の4・70条の2の5／
 *   国税庁 No.4408（贈与税の計算と税率〈暦年課税〉）。
 */

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると税額が丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 速算表から、基礎控除後の課税価格に対応する税額 ＝ 金額×税率 − 控除額（No.4408）。
 * @param base 基礎控除後の課税価格（円）
 * @param table D.ippan または D.tokurei
 */
export function sokusanZoyo(base, table) {
  if (!table || !table.brackets) throw new Error('速算表（zoyozei_r08.json）が渡されていません');
  const v = yen(base);
  const B = table.brackets;
  for (const b of B) {
    if (b.upto === null || b.upto === undefined || v <= b.upto) {
      return { zei: Math.max(0, v * b.rate_pct / 100 - b.deduction), rate_pct: b.rate_pct, deduction: b.deduction, label: b.label };
    }
  }
  const last = B[B.length - 1];
  return { zei: Math.max(0, v * last.rate_pct / 100 - last.deduction), rate_pct: last.rate_pct, deduction: last.deduction, label: last.label };
}

/**
 * 入口。
 * input = {
 *   ippan,    // 一般贈与財産の合計額（円）…… 直系尊属以外から / 18歳未満で受けた贈与
 *   tokurei,  // 特例贈与財産の合計額（円）…… 直系尊属から、18歳以上で受けた贈与
 * }
 * D = zoyozei_r08.json
 */
export function calcZoyozei(input, D) {
  if (!D) throw new Error('参照データ（zoyozei_r08.json）が渡されていません');
  const i = input || {};
  const ippan = yen(i.ippan);
  const tokurei = yen(i.tokurei);
  const total = ippan + tokurei; // その年に受けた贈与財産の課税価格の合計
  if (total <= 0) throw new Error('その年に受けた贈与財産の合計額を入力してください');

  const kiso = yen(D.kiso_kojo?.amount);
  if (kiso <= 0) throw new Error('基礎控除額（zoyozei_r08.json）が読み取れません');

  const below = total <= kiso; // 急所5: 合計110万円以下は非課税
  // 課税標準は1,000円未満切り捨て（国税通則法118条）。入力が万円単位でも安全側に落とす。
  const baseAfter = Math.floor(Math.max(0, total - kiso) / 1000) * 1000;

  let zeiRaw = 0;
  let mode = 'below';
  let breakdown = null;

  if (!below) {
    if (ippan > 0 && tokurei > 0) {
      // 急所3: 一般＋特例の混在 → 合計を基に全額一般/全額特例で計算し割合で按分（No.4408 (3)）
      const g = sokusanZoyo(baseAfter, D.ippan);
      const s = sokusanZoyo(baseAfter, D.tokurei);
      const gPart = g.zei * ippan / total;
      const sPart = s.zei * tokurei / total;
      zeiRaw = gPart + sPart;
      mode = 'mixed';
      breakdown = {
        general: { ...g, amount: ippan, part: gPart, ratio: [ippan, total] },
        special: { ...s, amount: tokurei, part: sPart, ratio: [tokurei, total] },
      };
    } else if (tokurei > 0) {
      const s = sokusanZoyo(baseAfter, D.tokurei);
      zeiRaw = s.zei;
      mode = 'tokurei';
      breakdown = { special: { ...s, amount: tokurei } };
    } else {
      const g = sokusanZoyo(baseAfter, D.ippan);
      zeiRaw = g.zei;
      mode = 'ippan';
      breakdown = { general: { ...g, amount: ippan } };
    }
  }

  // 確定した贈与税額は100円未満切り捨て（国税通則法119条）
  const zei = below ? 0 : Math.floor(zeiRaw / 100) * 100;

  return {
    ippan,
    tokurei,
    total,
    kiso,
    baseAfter,
    below,
    mode,       // 'below' | 'ippan' | 'tokurei' | 'mixed'
    zei,        // 贈与税額（円・100円未満切り捨て）
    breakdown,  // 内訳（速算表の帯・税率・控除額。mixed は general/special の按分）
    year: D._meta?.year || '',
  };
}
