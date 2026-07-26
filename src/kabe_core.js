/**
 * 年収の壁 計算機のコアロジック（DOM非依存・テスト対象）。
 *
 * このツールが答えるのは1つだけ:「社会保険の壁を超えて働くと、手取りはいくら逆転し、
 * 年収いくらまで働けば元に戻るか」。税金の壁（所得税・住民税・配偶者控除）は超えても
 * 手取りが逆転しないので計算しない（年収の壁の記事 /column/nenshu-no-kabe/ に委ねる）。
 *
 * ★このコアは新しい料率表を1つも持たない。検証済みの shaho_core.calcMonthly を合成するだけ:
 *   - 壁の手前（被扶養者・扶養内）= 社会保険料ゼロ → 手取り＝年収
 *   - 壁の以上（社会保険に加入）= 年収 − 社会保険料本人 → 手取りが一段下がる
 *
 * ★「手取り」の定義（＝当サイトの年収の壁記事と同じ・§ここを取り違えると記事と食い違う）:
 *     手取り ＝ 年収 − 社会保険料（本人・健保＋介護＋子育て支援金＋厚年）
 *   雇用保険は含めない。「年収の壁」で手取りが逆転する原因は健康保険・厚生年金への加入であり、
 *   雇用保険は週20時間で既に加入しているため壁の前後で増減しないから。所得税・住民税も
 *   このツールの「手取り」には含めない（税金の壁は逆転を起こさない別の話なので混ぜない）。
 *
 * ★オラクル（記事が本文に載せ、test_kabe.mjs が固定する値／東京都・30歳・介護なし）:
 *     年収129万（扶養内）→ 社保0 → 手取り 1,290,000
 *     年収131万（社保加入）→ 社保 187,296 → 手取り 1,122,704（年収2万増で16万7,296円減）
 *     元の手取り(1,290,000)に戻るのは 年収 1,505,000 まで働いたとき
 *   187,296 は calcMonthly(標準報酬月額110,000).selfTotal(=15,608)×12 に一致する。
 */

import { calcMonthly } from './shaho_core.js';

/** 壁の種類。tekiyoKakudai=約106万（適用拡大の5要件を満たす短時間労働者）, hifuyousha=130万（被扶養者認定） */
export const WALL_TYPES = ['tekiyoKakudai', 'hifuyousha'];

/**
 * 社会保険料（本人・年額）。健保＋介護＋子育て支援金＋厚年。★雇用保険は含めない（上のコメント参照）。
 * 年額は「月額の本人負担 × 12」。月額の本人負担は協会けんぽの保険料額表どおり各項目を端数処理して合算した額
 * （calcMonthly が令和8年度の額表を再現している）。
 */
export function shakaiHokenAnnual(annual, age, kenkoRate, S) {
  if (!S) throw new Error('参照データ（shaho_rates_r08.json）が渡されていません');
  if (!(kenkoRate > 0)) throw new Error('健康保険料率が特定できません（都道府県を確認してください）');
  const m = calcMonthly(annual / 12, kenkoRate, S.kaigo_rate, Number(age) || 0, S.kosei_nenkin_rate, S.kosodate_rate);
  return {
    monthly: m.selfTotal,
    annual: m.selfTotal * 12,
    standard: m.standard, grade: m.grade, kaigoApplies: m.kaigoApplies,
    kenkoKaigo: m.kenkoKaigo, kosodate: m.kosodate, kosei: m.kosei,
  };
}

/** 適用される壁の年収額。hifuyousha は60歳以上・障害者だと180万円。 */
export function wallAmount(K, wallType, age) {
  if (!K || !K.shakaiHoken) throw new Error('参照データ（kabe_thresholds_r08.json）が渡されていません');
  if (wallType === 'tekiyoKakudai') return K.shakaiHoken.tekiyoKakudai.amount;
  const h = K.shakaiHoken.hifuyousha;
  return (Number(age) >= 60) ? h.age60plus : h.amount;
}

/**
 * 年収の壁の計算の入口。
 * @param input {
 *   annual,       // 現在の年収（円）
 *   age,          // 年齢（40〜64歳は介護保険が乗る／60歳以上は被扶養者の壁が180万に上がる）
 *   prefecture,   // 都道府県名（協会けんぽ健保料率のキー）
 *   wallType,     // 'tekiyoKakudai'（約106万・適用拡大対象）| 'hifuyousha'（130万・被扶養者）
 * }
 * @param refs { thresholds, shahoRates }
 */
export function calcKabe(input, refs) {
  const { thresholds: K, shahoRates: S } = refs || {};
  if (!K) throw new Error('参照データ（kabe_thresholds_r08.json）が渡されていません');
  if (!S) throw new Error('参照データ（shaho_rates_r08.json）が渡されていません');

  const annual = Math.max(0, Math.floor(Number(input.annual) || 0));
  const age = Number(input.age) || 0;
  const wallType = WALL_TYPES.includes(input.wallType) ? input.wallType : 'hifuyousha';
  const kenkoRate = S.kenko_rates[input.prefecture];
  if (!(kenkoRate > 0)) throw new Error('健康保険料率が特定できません（都道府県を確認してください）');

  const wall = wallAmount(K, wallType, age);
  // 「130万円未満が被扶養者」なので、130万円ちょうどは加入側（壁「以上」で加入）。
  const joins = annual >= wall;

  // いまの手取り（＝年収 − 社会保険料本人）。壁の手前は社保0。
  const shaho = joins ? shakaiHokenAnnual(annual, age, kenkoRate, S) : null;
  const shahoAnnual = joins ? shaho.annual : 0;
  const tedori = annual - shahoAnnual;

  // 基準となる手取り＝壁の手前で確保できる手取り。入力が壁未満なら入力額（社保0）、
  // 壁以上なら「壁−1円」まで働いた人の手取り（＝壁の手前の最大手取り）。
  const reference = annual < wall ? annual : (wall - 1);

  // 回復年収：壁以上で、手取りが reference 以上に戻り、**以後（掃引範囲内で）ずっと基準以上**で
  // あり続ける最小の年収（1,000円刻みで掃引）。
  // ★「最初に基準以上になった点」で止めてはいけない: 手取りは等級の境界で凹む
  //   （年収が1,000円増えると保険料が1万円以上増える帯がある）ので、最初の交差点の先で
  //   基準を再び割る可能性がある。「◯◯円以上を目指す」という助言が偽になる帯を作らないため、
  //   基準未満に落ちる**最後の点**を探し、その次を回復年収とする。
  //   （令和8年度の等級表・全47都道府県では両定義は同じ値になることを test_kabe.mjs が確認している。
  //     等級表・料率の改定でズレが生まれても、この定義なら助言は破れない）
  let recovery = null;
  for (let a = wall; a <= wall + 4000000; a += 1000) {
    const t = a - shakaiHokenAnnual(a, age, kenkoRate, S).annual;
    if (t >= reference) { if (recovery == null) recovery = a; }
    else recovery = null; // 基準を割ったらやり直し（以後ずっと基準以上、を保証する）
  }

  // 壁の底：壁ちょうどで加入した瞬間の手取り（年収は増えていないのに社保だけ引かれて一番凹む点）。
  const bottomShaho = shakaiHokenAnnual(wall, age, kenkoRate, S);
  const bottomTedori = wall - bottomShaho.annual;

  return {
    annual, age, wallType, wall,
    joins, shaho, shahoAnnual, tedori,
    tedoriRate: annual > 0 ? tedori / annual : 0,
    reference,
    recovery,
    recoveryGap: recovery == null ? null : recovery - reference,   // 元の手取りに戻すのに余分に稼ぐ額
    bottomTedori,                                                  // 壁ちょうどの手取り（底）
    bottomShahoAnnual: bottomShaho.annual,
    maxLoss: reference - bottomTedori,                             // 壁の手前 → 壁の底 の最大の落差
    year: K._meta?.year || '',
  };
}
