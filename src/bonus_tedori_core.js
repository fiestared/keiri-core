/**
 * ボーナス（賞与）手取り計算機のコアロジック（DOM非依存・テスト対象）。
 * 額面の賞与から、社会保険料（本人負担）と源泉所得税を引いた手取りを出す。
 *
 * ★このコアは新しい税率表を1つも持たない。**検証済みの3コアを合成するだけ**にしてある
 *   （tedori_core と同じ設計。ゼロから料率・税額表を書き起こすと事故面が広がる）:
 *     - shaho_core.calcBonus   賞与の社会保険料（健保・介護・支援金・厚年）。標準賞与額
 *                              （1,000円未満切捨）にかかり、健保は年度累計573万円・
 *                              厚年は1回150万円で頭打ち
 *     - shaho_core.calcKoyou   雇用保険。**標準賞与額ではなく賞与の実額**にかかる
 *                              （徴収法11条1項の「賃金総額」。切捨も上限もない）
 *     - gensen_shoyo_core.calcShoyo  賞与の源泉所得税（国税庁 算出率の表・甲欄）
 *
 *   手取り ＝ 額面の賞与 − 社会保険料(本人) − 源泉所得税
 *
 * ★★ 源泉所得税の率を決めるのは賞与の額ではなく「**前月の**社会保険料等控除後の給与」
 *   （ここがいちばん誤解される）。前月の給与は額面で受け取り、その月の社会保険料を
 *   tedori_core.shakaiHokenMonthly で概算して控除後の額を作る（＝定時決定とのずれで
 *   実際と数円ずれうる。正確を期すなら給与明細の「社会保険料合計」を引いた額で確かめる）。
 *
 * ★★ 住民税は賞与から特別徴収されない。地方税法321条の5第1項が「特別徴収税額の
 *   十二分の一の額を六月から翌年五月まで…毎月徴収」と定めており、月割は**毎月の給与**
 *   から引かれる。だからこの計算機は住民税を引かない（0円の行として画面に明示する）。
 *   ※ 賞与も前年の所得には入るので、**翌年度の**住民税(給与からの天引き)は増える。
 *
 * ★ 例外（算出率の表を使えない場合・表の備考4）は calcShoyo が判定して月額表による
 *   計算（No.2523）に切り替える。月額表の税額は gensen_kyuyo_core.kouTax を渡す。
 */

import { calcBonus, calcKoyou } from './shaho_core.js';
import { calcShoyo } from './gensen_shoyo_core.js';
import { kouTax } from './gensen_kyuyo_core.js';
import { shakaiHokenMonthly } from './tedori_core.js';

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると手取りが丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 賞与の手取り計算の入口。
 * @param input {
 *   bonus,          // 額面の賞与（円）
 *   age,            // 年齢（40〜64歳は介護保険料が合算される）
 *   prefecture,     // 都道府県名（協会けんぽ健保料率のキー）
 *   dependents,     // 扶養親族等の数（源泉控除対象配偶者＋控除対象扶養親族）
 *   gyoshu,         // （任意）雇用保険の業種キー。既定 general
 *   zengetsuPaid,   // 前月に給与の支払があったか（既定 true）
 *   zengetsu,       // 前月の額面給与（円）。zengetsuPaid のとき必須
 *   monthsOver6,    // 賞与の計算期間が6か月を超えるか（既定 false。超えると例外計算の除数が12）
 *   yearPaidKenko,  // （任意）今年度すでに支給された賞与の標準賞与額の累計（健保573万円上限の判定用）
 * }
 * @param refs { shahoRates, shoyoTable, gensenTable }
 *   gensenTable（月額表）は例外計算のときだけ使うが、例外に入るかは計算するまで
 *   分からないので**常に必須**にする（fail closed。無いまま例外に入ると答えられない）。
 */
export function calcBonusTedori(input, refs) {
  const { shahoRates: S, shoyoTable: ST, gensenTable: GT } = refs || {};
  if (!S) throw new Error('参照データ（shaho_rates_r08.json）が渡されていません');
  if (!ST) throw new Error('参照データ（gensen_shoyo_r08.json）が渡されていません');
  if (!GT) throw new Error('参照データ（gensen_getsugaku_r08.json）が渡されていません');

  const bonus = yen(input.bonus);
  const age = Number(input.age) || 0;
  const dependents = Math.max(0, Math.floor(Number(input.dependents) || 0));
  const gyoshu = input.gyoshu || 'general';
  const zengetsuPaid = input.zengetsuPaid !== false;
  const kenkoRate = S.kenko_rates[input.prefecture];
  if (!(kenkoRate > 0)) throw new Error('健康保険料率が特定できません（都道府県を確認）');

  // ── ① 賞与の社会保険料（本人・標準賞与額にかかる4つ＋実額にかかる雇用保険） ──
  const sb = calcBonus(bonus, kenkoRate, S.kaigo_rate, age,
                       S.kosei_nenkin_rate, yen(input.yearPaidKenko), S.kosodate_rate);
  const gy = S.koyou.types[gyoshu] || S.koyou.types.general;
  // 雇用保険だけは標準賞与額ではなく**賞与の実額**にかかる（切捨前の bonus を渡す）
  const koyou = calcKoyou(bonus, gy.total_permille, gy.jigyo2_permille);
  const shahoSelf = sb.selfTotal + koyou.self;

  // ── ② 前月の給与（社会保険料等控除後）。源泉の率を決める鍵はこちら ──────────
  const zengetsu = zengetsuPaid ? yen(input.zengetsu) : 0;
  const zenShaho = zengetsuPaid && zengetsu > 0
    ? shakaiHokenMonthly(zengetsu, age, kenkoRate, gyoshu, S).self
    : 0;

  // ── ③ 賞与の源泉所得税（算出率の表。例外は月額表 = kouTax を渡す） ──────────
  const shoyo = calcShoyo({
    table: ST,
    shoyo: bonus,
    shoyoIns: shahoSelf,
    zengetsu,
    zengetsuIns: zenShaho,
    zengetsuPaid,
    dependents,
    kubun: 'kou',
    months: input.monthsOver6 ? 12 : 6,
    monthlyTax: (amount) => kouTax(GT, amount, dependents),
  });

  const tedori = bonus - shahoSelf - shoyo.tax;

  return {
    bonus,
    // 社会保険料の内わけ（本人負担）
    shakaiHoken: {
      self: shahoSelf,
      standardBonus: sb.standardBonus,        // 標準賞与額（1,000円未満切捨）
      kenkoStandard: sb.kenkoStandard,        // 健保にかけた額（年度573万円上限後）
      koseiStandard: sb.koseiStandard,        // 厚年にかけた額（1回150万円上限後）
      capped: sb.capped,                      // { kenko, kosei } 上限に当たったか
      kaigoApplies: sb.kaigoApplies,
      kenkoKaigo: sb.kenkoKaigo, kosodate: sb.kosodate, kosei: sb.kosei, koyou,
      kenkoRate, gyoshu: gy,
    },
    afterShaho: bonus - shahoSelf,            // 社会保険料等控除後の賞与
    zengetsu, zengetsuShaho: zenShaho,
    zengetsuAfterIns: shoyo.zengetsuAfterIns, // 前月の社会保険料等控除後の給与
    shoyo,                                    // method/rate/tax/steps（calcShoyo の返り値）
    shotokuzei: shoyo.tax,
    dependents,
    juminzei: 0,                              // 住民税は賞与から天引きされない（コメント参照）
    totalDeduction: shahoSelf + shoyo.tax,
    tedori,
    tedoriRate: bonus > 0 ? tedori / bonus : 0,
    year: S._meta?.year || '',
    taxYear: ST.year || '',
  };
}
