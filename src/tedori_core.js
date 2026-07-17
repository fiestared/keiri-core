/**
 * 手取り計算機のコアロジック（DOM非依存・テスト対象）。額面月給から手取り月給を出す。
 *
 * ★このコアは新しい税率表を1つも持たない。**検証済みの3コアを合成するだけ**にしてある
 *   （ゼロから料率・税額表を書き起こすと事故面が広がるので、正本を1つに保つ）:
 *     - shaho_core.js        社会保険料（健保・介護・子育て支援金・厚年・雇用）本人負担
 *     - gensen_kyuyo_core.js 給与の源泉所得税（国税庁 月額表・甲欄）
 *     - juminzei_core.js     住民税（前年所得ベース。★当年の額面からは出ない）
 *
 *   手取り ＝ 額面 − 社会保険料(本人) − 所得税 − 住民税
 *
 * ★★ 住民税は「今の給料」からは決まらない（ここを取り違えると黙って間違える）:
 *   地方税法32条1項が所得割の課税標準を「**前年の所得**」と定め、321条の5第1項が
 *   税額の12分の1を「**6月から翌5月まで**」特別徴収すると定めている。だから当年の月給に
 *   料率を掛けて住民税を出すことはできない。このコアは住民税を3つのモードで扱う:
 *     - 'manual':   給与明細（住民税決定通知書）の月額をそのまま使う ＝ 唯一の正確な値
 *     - 'estimate': この年収が**前年も続いた**と仮定して概算する ＝ 2年目以降の目安
 *     - 'none':     住民税を含めない（新卒1年目・前年に所得がない人／額が不明なとき）
 *   estimate は juminzei_core に「年収×12」と「社会保険料の実額（本人・年額）」を渡して
 *   翌年度の住民税を計算し、12で割った月額。★扶養親族は一律「一般扶養（16歳以上）」として
 *   概算する（特定扶養や配偶者の状況で変わる）。正確な額は manual で上書きしてもらう。
 *
 * ★社会保険料の前提（＝概算になる理由。実態が違う人は給与明細で確かめる）:
 *   健保は協会けんぽの都道府県料率（組合健保・共済は料率が違う）。雇用保険は既定で一般の事業。
 *   賞与は含めない（月給のみ）。標準報酬月額は本来 定時決定/随時改定で決まるが、ここでは
 *   額面月給＝報酬月額として等級を引く（＝入社直後や大きな変動直後は実際とずれうる）。
 */

import { calcMonthly, calcKoyou } from './shaho_core.js';
import { kouTax, extraDependentCount } from './gensen_kyuyo_core.js';
import { calc as juminzeiCalc } from './juminzei_core.js';

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると手取りが丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

export const JUMINZEI_MODES = ['estimate', 'manual', 'none'];

/**
 * 社会保険料（本人負担・月額）。健保＋介護＋子育て支援金＋厚年＋雇用。
 * @param {number} gross    額面月給（＝報酬月額かつ賃金総額として扱う）
 * @param {number} age      年齢（40〜64歳は介護保険料が合算される）
 * @param {number} kenkoRate 健康保険料率(%)（都道府県別。呼び出し側が引いて渡す）
 * @param {string} gyoshu   雇用保険の業種キー（既定 general）
 * @param {object} S        shaho_rates_r08.json
 */
export function shakaiHokenMonthly(gross, age, kenkoRate, gyoshu, S) {
  if (!S) throw new Error('参照データ（shaho_rates_r08.json）が渡されていません');
  if (!(kenkoRate > 0)) throw new Error('健康保険料率が特定できません（都道府県を確認）');
  const g = gross;
  // 健保・介護・支援金・厚年は標準報酬月額（等級表）にかかる
  const m = calcMonthly(g, kenkoRate, S.kaigo_rate, Number(age) || 0, S.kosei_nenkin_rate, S.kosodate_rate);
  // 雇用保険だけは**標準報酬月額ではなく賃金総額（実額）**にかかる（徴収法11条1項）
  const gy = S.koyou.types[gyoshu] || S.koyou.types.general;
  const koyou = calcKoyou(g, gy.total_permille, gy.jigyo2_permille);
  return {
    self: m.selfTotal + koyou.self,
    kenkoKaigo: m.kenkoKaigo, kosodate: m.kosodate, kosei: m.kosei, koyou,
    standard: m.standard, grade: m.grade, koseiStandard: m.koseiStandard,
    kaigoApplies: m.kaigoApplies, kenkoRate, gyoshu: gy,
  };
}

/**
 * 手取り計算の入口。
 * @param input {
 *   gross,           // 額面月給（円）
 *   age,             // 年齢
 *   prefecture,      // 都道府県名（協会けんぽ健保料率のキー）
 *   dependents,      // 扶養親族等の数（源泉控除対象配偶者＋控除対象扶養親族）— 甲欄と住民税概算に使う
 *   extra,           // （任意）本人の障害者・寡婦・ひとり親等（gensen_kyuyo_core.extraDependentCount の引数）
 *   gyoshu,          // （任意）雇用保険の業種キー。既定 general
 *   juminzeiMode,    // 'estimate' | 'manual' | 'none'（既定 estimate）
 *   juminzeiManual,  // manual のとき：給与明細の住民税（月額）
 * }
 * @param refs { shahoRates, gensenTable, juminzeiData }
 */
export function calcTedori(input, refs) {
  const { shahoRates: S, gensenTable: T, juminzeiData: D } = refs || {};
  if (!S) throw new Error('参照データ（shaho_rates_r08.json）が渡されていません');
  if (!T) throw new Error('参照データ（gensen_getsugaku_r08.json）が渡されていません');

  const gross = yen(input.gross);
  const age = Number(input.age) || 0;
  const dependents = Math.max(0, Math.floor(Number(input.dependents) || 0));
  const gyoshu = input.gyoshu || 'general';
  const kenkoRate = S.kenko_rates[input.prefecture];

  // ── ① 社会保険料（本人・月額） ──────────────────────────────
  const shaho = shakaiHokenMonthly(gross, age, kenkoRate, gyoshu, S);

  // ── ② 社保控除後 → 源泉所得税（月額・甲欄） ──────────────────
  const afterShaho = gross - shaho.self;
  const n = dependents + extraDependentCount(input.extra || {});
  const shotokuzei = kouTax(T, afterShaho, n);

  // ── ③ 住民税（月額） ──────────────────────────────────────
  const mode = JUMINZEI_MODES.includes(input.juminzeiMode) ? input.juminzeiMode : 'estimate';
  let juminzeiMonthly = 0, juminzeiAnnual = null, juminzeiDetail = null;
  if (mode === 'manual') {
    juminzeiMonthly = yen(input.juminzeiManual);
  } else if (mode === 'estimate') {
    if (!D) throw new Error('参照データ（juminzei_r08.json）が渡されていません');
    // この年収が前年も続いたと仮定。社会保険料は**実額（①で出した本人負担の年額）**を渡す
    // （社会保険料は全額が所得控除なので、住民税額にそのまま効く）。
    juminzeiDetail = juminzeiCalc({
      kyuyoShunyu: gross * 12,
      shakaiHoken: shaho.self * 12,
      family: { fuyoIppan: dependents }, // ★扶養は一律「一般扶養」として概算（上のコメント参照）
    }, D);
    juminzeiAnnual = juminzeiDetail.juminzeiTotal;
    // 特別徴収は年税額を12等分し端数を6月に寄せるが、月額の目安としては四捨五入した平均月額を出す
    juminzeiMonthly = Math.round(juminzeiAnnual / 12);
  }

  const totalDeduction = shaho.self + shotokuzei + juminzeiMonthly;
  const tedori = gross - totalDeduction;

  return {
    gross,
    shakaiHoken: shaho,
    afterShaho,
    shotokuzei,
    dependents: n,
    juminzeiMode: mode,
    juminzeiMonthly,
    juminzeiAnnual,
    juminzeiDetail,
    totalDeduction,
    tedori,
    tedoriRate: gross > 0 ? tedori / gross : 0,
    year: S._meta?.year || '',
  };
}
