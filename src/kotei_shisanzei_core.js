/**
 * 固定資産税・都市計画税（土地＋家屋）の年税額を出す計算コア（DOM非依存・テスト対象）。
 *
 * ★このツールが黙って誤答しやすい急所（すべて条文で確認済み。出典は下の SEIDO の各行）:
 *
 *  1. **小規模住宅用地の200平方メートルは「1戸あたり」**（法349条の3の2第2項2号）。
 *     アパート・二世帯住宅は 200×戸数 まで6分の1になる。戸数を無視して一律200で切ると、
 *     6戸のアパートで1,000平方メートル分の減額を丸ごと落とす（税額が数倍になる）。
 *
 *  2. **住宅用地は「家屋の床面積の10倍」まで**（令52条の11第2項1号）。
 *     広い土地に小さな家を建てても全部が特例の対象になるわけではない。
 *     10倍を超える部分は特例なし（＝評価額そのものが課税標準）。
 *
 *  3. **固定資産税と都市計画税で特例の割合が違う**（法349条の3の2 と 法702条の3）。
 *     固定＝小規模1/6・一般1/3、都計＝小規模1/3・一般2/3。同じ割合で計算すると都計税が半分になる。
 *
 *  4. **新築住宅の減額は固定資産税だけ**（法附則15条の6は「固定資産税額から減額する」）。
 *     都市計画税には及ばない。両方から引くと過小に答える。
 *     さらに減額されるのは**居住部分120平方メートル相当分まで**（令附則12条4項2号）。
 *
 *  5. **免税点の判定は特例を適用した後の課税標準額**（法351条）。土地30万円・家屋20万円。
 *     免税点未満なら都市計画税も課されない（法702条の8第1項＝固定資産税の賦課徴収の例による）。
 *
 *  6. **負担調整措置（法附則18条）は本コアの範囲外**。前年度の課税標準額が要るため、
 *     評価額だけからは決まらない。本コアは本則（評価額×特例割合）で計算し、`honsoku:true` を
 *     立てて申告する。**黙って本則の額を「あなたの税額」と言い切らないこと**。
 *
 * 端数処理は法20条の4の2（課税標準額は1,000円未満切捨て・確定税額は100円未満切捨て）。
 * 土地と家屋を別々に処理する（自治体により合算の順序が違うので数百円ずれうる＝画面で申告する）。
 *
 * 一次情報: 地方税法（昭和25年法律226号・2026-06-05施行版）／同施行令（同245号・2026-06-25施行版）を
 * e-Gov法令API v2 で逐語取得。裏取り＝東京都主税局「固定資産税・都市計画税（土地・家屋）」。
 */

/** 制度の定数。画面はここから描く（ページに数字を手書きしない）。 */
export const SEIDO = {
  /** 固定資産税の標準税率(%)。法350条1項「百分の一・四」。市町村が条例で変えられる。 */
  koteiStandardRate: 1.4,
  /** 都市計画税の制限税率(%)。法702条の4「百分の〇・三を超えることができない」。 */
  toshiMaxRate: 0.3,
  /** 小規模住宅用地の面積上限(平方メートル)。住居1戸あたり。法349条の3の2第2項。 */
  shoukiboM2PerUnit: 200,
  /** 小規模住宅用地の課税標準の割合。固定＝6分の1（法349条の3の2第2項）。 */
  shoukiboKotei: 1 / 6,
  /** 一般住宅用地の課税標準の割合。固定＝3分の1（法349条の3の2第1項）。 */
  ippanKotei: 1 / 3,
  /** 小規模住宅用地の都市計画税の割合＝3分の1（法702条の3第2項）。 */
  shoukiboToshi: 1 / 3,
  /** 一般住宅用地の都市計画税の割合＝3分の2（法702条の3第1項）。 */
  ippanToshi: 2 / 3,
  /** 住宅用地とされる面積の上限＝家屋の床面積の10倍（令52条の11第2項1号）。 */
  floorAreaMultiplier: 10,
  /** 免税点（法351条）。課税標準となるべき額がこれ未満なら課税されない。 */
  menzeitenLand: 300000,
  menzeitenHouse: 200000,
  /** 新築住宅の減額の対象になる居住部分の上限(平方メートル)（令附則12条4項2号）。 */
  shinchikuCapM2: 120,
  /** 新築住宅の減額の床面積要件(平方メートル)（令附則12条3項1号）。 */
  shinchikuMinM2: 40,
  shinchikuMaxM2: 240,
  /** 新築住宅の減額割合＝2分の1（法附則15条の6）。 */
  shinchikuRatio: 1 / 2,
  /** 新築住宅の減額が適用される新築の期限（法附則15条の6・15条の7）。 */
  shinchikuKigen: '令和13年3月31日',
  /** 課税標準額の切捨て単位（法20条の4の2第1項）。 */
  kazeiHyojunUnit: 1000,
  /** 確定税額の切捨て単位（法20条の4の2第3項）。 */
  zeigakuUnit: 100,
};

/**
 * 新築住宅の減額の区分。
 * ★「該当しない」を含めて**全部を画面に出す**こと（CLAUDE.md: 法の列挙を「など」で丸めない）。
 * 認定長期優良住宅は**申告が要件**（法附則15条の7第3項・新築から翌年1月31日まで）で、
 * 一般の新築住宅（15条の6）には申告要件の定めが無い、という違いがある。
 */
export const SHINCHIKU_KUBUN = [
  { key: 'none', label: '該当しない（新築から年数が経っている・要件を満たさない）', years: 0, moushide: false, ne: '' },
  { key: 'ippan', label: '一般の新築住宅', years: 3, moushide: false, ne: '法附則15条の6第1項' },
  { key: 'chukoso', label: '3階建て以上の中高層耐火建築物', years: 5, moushide: false, ne: '法附則15条の6第2項' },
  { key: 'chouki', label: '認定長期優良住宅', years: 5, moushide: true, ne: '法附則15条の7第1項' },
  { key: 'chouki_chukoso', label: '認定長期優良住宅かつ3階建て以上の中高層耐火建築物', years: 7, moushide: true, ne: '法附則15条の7第2項' },
];

/** 0以上の数に正規化（未入力・負・NaN は0）。NaN を素通しすると税額が丸ごと NaN になる。 */
const nz = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 円未満を切り捨てる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 単位未満を切り捨てる（法20条の4の2）。 */
export const truncTo = (amount, unit) => {
  const a = nz(amount);
  const u = nz(unit) || 1;
  return Math.floor(a / u) * u;
};

/** 面積の表示用まるめ（小数第2位）。判定には使わない。 */
export const roundM2 = (n) => Math.round(Number(n) * 100) / 100;

/** 区分キーから定義を引く。未知のキーは「該当しない」に倒す（黙って減額しない）。 */
export function shinchikuOf(key) {
  return SHINCHIKU_KUBUN.find((k) => k.key === key) || SHINCHIKU_KUBUN[0];
}

/**
 * 住宅用地の特例で、土地の課税標準を出す。
 *
 * @param {object} p
 * @param {number} p.landValue 土地の固定資産税評価額(円)
 * @param {number} p.landArea 土地の面積(平方メートル)
 * @param {boolean} p.isResidential 住宅の敷地か
 * @param {number} p.units 住居の数(戸)
 * @param {number} p.houseFloorArea 家屋の床面積(平方メートル)
 */
export function calcLandBase(p) {
  const landValue = nz(p.landValue);
  const landArea = nz(p.landArea);
  const units = Math.max(1, Math.floor(nz(p.units)) || 1);
  const floor = nz(p.houseFloorArea);
  // 単価は「評価額 ÷ 総面積」。面積0なら特例の按分ができないので全額を非住宅扱いにする。
  const unit = landArea > 0 ? landValue / landArea : 0;

  if (!p.isResidential || landArea <= 0) {
    return {
      shoukiboM2: 0, ippanM2: 0, hijutakuM2: roundM2(landArea),
      koteiBase: yen(landValue), toshiBase: yen(landValue),
      cappedByFloorArea: false, jutakuM2: 0, units,
    };
  }

  // 住宅用地は家屋の床面積の10倍まで（令52条の11第2項1号）。超えた分は特例なし。
  const cap = floor * SEIDO.floorAreaMultiplier;
  const jutakuM2 = floor > 0 ? Math.min(landArea, cap) : 0;
  const hijutakuM2 = landArea - jutakuM2;

  // 小規模住宅用地は「200平方メートル×戸数」まで（法349条の3の2第2項2号）。
  const shoukiboM2 = Math.min(jutakuM2, SEIDO.shoukiboM2PerUnit * units);
  const ippanM2 = jutakuM2 - shoukiboM2;

  const koteiBase = unit * (shoukiboM2 * SEIDO.shoukiboKotei + ippanM2 * SEIDO.ippanKotei + hijutakuM2);
  const toshiBase = unit * (shoukiboM2 * SEIDO.shoukiboToshi + ippanM2 * SEIDO.ippanToshi + hijutakuM2);

  return {
    shoukiboM2: roundM2(shoukiboM2),
    ippanM2: roundM2(ippanM2),
    hijutakuM2: roundM2(hijutakuM2),
    jutakuM2: roundM2(jutakuM2),
    cappedByFloorArea: floor > 0 && landArea > cap,
    koteiBase: yen(koteiBase),
    toshiBase: yen(koteiBase === 0 ? 0 : toshiBase),
    units,
  };
}

/**
 * 新築住宅の減額が使えるかを判定する。
 * 使えない理由は文字列で返す（画面に理由を出すため。黙って0円にしない）。
 */
export function shinchikuEligibility(kubunKey, floorArea) {
  const k = shinchikuOf(kubunKey);
  if (k.years <= 0) return { ok: false, kubun: k, reason: '' };
  const f = nz(floorArea);
  if (f < SEIDO.shinchikuMinM2) {
    return { ok: false, kubun: k, reason: `床面積が${SEIDO.shinchikuMinM2}平方メートル未満のため減額の対象外です（令附則12条3項1号）。` };
  }
  if (f > SEIDO.shinchikuMaxM2) {
    return { ok: false, kubun: k, reason: `床面積が${SEIDO.shinchikuMaxM2}平方メートルを超えるため減額の対象外です（令附則12条3項1号）。` };
  }
  return { ok: true, kubun: k, reason: '' };
}

/**
 * 固定資産税・都市計画税の年税額を計算する。
 *
 * @param {object} input
 * @param {number} input.landValue 土地の評価額(円)
 * @param {number} input.landArea 土地の面積(平方メートル)
 * @param {boolean} input.isResidential 住宅の敷地か
 * @param {number} input.units 住居の数(戸)
 * @param {number} input.houseValue 家屋の評価額(円)
 * @param {number} input.houseFloorArea 家屋の床面積(平方メートル)
 * @param {number} [input.residentialFloorArea] 居住部分の床面積(平方メートル。既定は床面積と同じ)
 * @param {string} input.shinchiku 新築住宅の区分キー
 * @param {number} input.koteiRate 固定資産税の税率(%)
 * @param {number} input.toshiRate 都市計画税の税率(%。市街化区域外は0)
 */
export function calcKoteiShisanzei(input) {
  const land = calcLandBase(input);
  const houseValue = yen(input.houseValue);
  const floor = nz(input.houseFloorArea);
  const koteiRate = nz(input.koteiRate);
  const toshiRate = nz(input.toshiRate);

  // 免税点は「課税標準となるべき額」で見る＝住宅用地の特例を適用した後の額（法351条）。
  const landTaxable = land.koteiBase >= SEIDO.menzeitenLand;
  const houseTaxable = houseValue >= SEIDO.menzeitenHouse;

  // 課税標準額（1,000円未満切捨て・法20条の4の2第1項）。免税点未満は0。
  const landKoteiBase = landTaxable ? truncTo(land.koteiBase, SEIDO.kazeiHyojunUnit) : 0;
  const landToshiBase = landTaxable ? truncTo(land.toshiBase, SEIDO.kazeiHyojunUnit) : 0;
  const houseBase = houseTaxable ? truncTo(houseValue, SEIDO.kazeiHyojunUnit) : 0;

  // 税額（100円未満切捨て・同条3項）。土地と家屋を分けて出す（新築減額が家屋だけに掛かるため）。
  const landKotei = truncTo(landKoteiBase * koteiRate / 100, SEIDO.zeigakuUnit);
  const landToshi = truncTo(landToshiBase * toshiRate / 100, SEIDO.zeigakuUnit);
  const houseKoteiBefore = truncTo(houseBase * koteiRate / 100, SEIDO.zeigakuUnit);
  const houseToshi = truncTo(houseBase * toshiRate / 100, SEIDO.zeigakuUnit);

  // 新築住宅の減額（法附則15条の6・15条の7）。固定資産税だけ・居住部分120平方メートル相当分まで。
  const elig = shinchikuEligibility(input.shinchiku, floor);
  const livingArea = nz(input.residentialFloorArea) > 0 ? nz(input.residentialFloorArea) : floor;
  const capped = Math.min(livingArea, SEIDO.shinchikuCapM2);
  const share = floor > 0 ? Math.min(capped / floor, 1) : 0;
  const genkaku = elig.ok && houseTaxable
    ? truncTo(houseKoteiBefore * share * SEIDO.shinchikuRatio, 1)
    : 0;
  const houseKotei = Math.max(0, houseKoteiBefore - genkaku);

  const koteiTotal = landKotei + houseKotei;
  const toshiTotal = landToshi + houseToshi;
  const total = koteiTotal + toshiTotal;

  return {
    land, landTaxable, houseTaxable,
    landKoteiBase, landToshiBase, houseBase,
    landKotei, landToshi, houseKoteiBefore, houseToshi, houseKotei,
    genkaku, shinchiku: elig,
    shinchikuShare: share,
    koteiTotal, toshiTotal, total,
    /** 本則（評価額×特例割合）で出した額であり、負担調整措置は反映していない。 */
    honsoku: true,
  };
}

/**
 * 年税額を納期の数で分割する。
 * ★1,000円未満の端数は**すべて第1期に合算する**（法20条の4の2第6項）。
 * 均等割りにすると第1期が実際より安く出る（通知書と合わない）。
 */
export function splitByTerms(total, terms) {
  const t = Math.max(1, Math.floor(nz(terms)) || 1);
  const amount = nz(total);
  const each = truncTo(amount / t, SEIDO.kazeiHyojunUnit);
  const first = amount - each * (t - 1);
  return { first: yen(first), other: yen(each), terms: t };
}
