/**
 * 生前贈与シミュレーター（暦年贈与 vs 相続時精算課税 vs 何もしない）の計算コア（DOM非依存・テスト対象）。
 *
 * 出すもの: 「毎年いくらを・何人の子に・何年間」贈与する計画について、
 *   ①何もしない ②暦年課税で贈与 ③相続時精算課税で贈与 の3通りの
 *   「生前の贈与税 ＋ 相続時の相続税 − 還付」（実質の総負担）を並べて比較する。
 *
 * 計算そのものは既存の検証済みコアを使う（二重実装しない）:
 *   贈与税（暦年）= zoyozei_core.calcZoyozei / 相続税の総額の機構 = sozokuzei_core の各関数。
 *   本コアが足すのは「7年加算の窓」「精算課税の累積計算」「加算つきの各人課税価格の按分」だけ。
 *
 * ★★このツールが黙って誤答しやすい急所:
 *
 *  1. **年110万円以下の暦年贈与も、相続開始前7年以内なら加算される。**（相法19条1項）
 *     加算対象は「贈与税の課税価格計算の基礎に算入される財産」（21条の2〜21条の4）で、
 *     基礎控除（21条の5）は列挙に無い＝贈与税0円でも加算される。「110万円以下だから残らない」は誤り。
 *
 *  2. **加算は「相続又は遺贈により財産を取得した者」への贈与だけ。**（相法19条1項の主語）
 *     相続人でない孫など、相続でも遺贈でも財産を取得しない人への贈与は7年以内でも加算されない
 *     （代襲相続人・受遺者・生命保険金の受取人になった孫は加算される）。本コアは受贈者＝相続人の子が前提。
 *
 *  3. **3年超7年以内の贈与は「合計額から100万円を控除した残額」を加算。**（相法19条1項かっこ書き）
 *     100万円は受贈者ごと・その4年分の合計から1回（年100万円ずつではない）。
 *
 *  4. **精算課税の年110万円（措法70条の3の2）は加算されない。**（相法21条の15第1項が
 *     「21条の11の2第1項の規定による控除をした残額」を加算と明記。措法70条の3の2第2項が
 *     110万円控除を21条の11の2の控除とみなす）→ 同じ毎年110万円でも、暦年は7年分戻り、精算課税は戻らない。
 *
 *  5. **贈与税額控除の向きが違う。** 暦年（相法19条1項）は相続税から引き切れなくても還付なし。
 *     精算課税（相法21条の15第3項・33条の2）は引き切れなければ還付される。
 *
 *  6. **精算課税は要件と不可逆性。** 贈与年の1月1日に60歳以上の父母・祖父母 → 同18歳以上の
 *     推定相続人・孫（相法21条の9・措法70条の2の6）。届出は撤回できず（21条の9第6項）、
 *     その贈与者からの贈与は二度と暦年課税に戻れない。特別控除2,500万円は期限内申告が要件（21条の12第2項）。
 *
 *  7. **経過措置。** 7年加算は令和6年1月1日以後の贈与から（令和5年法律3号附則19条）。
 *     相続開始が令和8年12月31日までは「7年」を「3年」と読む。本コアは令和6年以後に始める贈与の
 *     設計用として7年ルールの完成形で計算する（2023年以前の過去の贈与を含む検討には使えない）。
 *
 * モデルの前提（画面にも明示する）:
 *   - 贈与は毎年同じ時期に1回・同額。相続開始は最後の贈与のgapYears年後（gapYears≧1。
 *     相続開始と同じ年の贈与は贈与税がかからず全額加算という別枠（相法21条の2第4項）のため対象外）。
 *     「相続開始前○年以内」は応当日基準の丸めで、境界の年（ちょうど3年前・7年前）は加算に含む（安全側）。
 *   - 財産は増えも減りもしない（消費・運用・評価変動は考慮しない）。贈与財産の価額も一定。
 *   - 残った財産は法定相続分どおりに分け、配偶者は税額軽減（相法19条の2）の枠内なので税額0。
 *   - 贈与税額控除の帯（3年超7年以内）への按分は価額比の比例計算（政令の細部の端数処理は反映しない）。
 *
 * 端数処理: 各人の課税価格・法定相続分に応ずる取得金額は1,000円未満切り捨て（通則法118条）、
 *   税額は100円未満切り捨て（通則法119条）。
 *
 * 一次情報: 相続税法19条・21条の9・21条の11の2・21条の12・21条の13・21条の15・21条の16・33条の2／
 *   租税特別措置法70条の2の4・70条の2の5・70条の2の6・70条の3の2／令和5年法律3号附則19条／
 *   国税庁 No.4161（贈与財産の加算）・No.4103（相続時精算課税）・No.4408。
 */

import { calcZoyozei } from "./zoyozei_core.js";
import { houteiSozokunin, kisoKojo, sokusanZei, houteiBun } from "./sozokuzei_core.js";

/** 円に丸める（0未満・未入力・数値でないものは0）。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
/** 1以上の整数（回数・人数用）。 */
const cnt = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
const floor1000 = (v) => Math.floor(v / 1000) * 1000;
const floor100 = (v) => Math.floor(v / 100) * 100;

/**
 * 暦年課税: 7年加算の窓（相法19条1項）。
 * 贈与 j（j=1..giftYears、j=1が最後の贈与）は相続開始の m = gapYears + j − 1 年前。
 *   m ≦ 3 …… 全額加算 ／ 3 ＜ m ≦ 7 …… 合計から100万円控除の帯 ／ m ＞ 7 …… 加算なし。
 * @returns { nFull, nBand, nOut } それぞれの年数
 */
export function kanenKasanMado(giftYears, gapYears, R) {
  if (!R) throw new Error("参照データ（seizen_zoyo_r08.json の kanen_kasan）が渡されていません");
  const N = cnt(giftYears);
  const K = cnt(gapYears);
  const full = R.full_years;   // 3
  const total = R.total_years; // 7
  // m は K, K+1, ..., K+N-1 を動く
  const inRange = (lo, hi) => Math.max(0, Math.min(K + N - 1, hi) - Math.max(K, lo) + 1);
  const nFull = inRange(0, full);            // m ≦ 3
  const nBand = inRange(full + 1, total);    // 3 < m ≦ 7
  return { nFull, nBand, nOut: N - nFull - nBand };
}

/**
 * 暦年課税: 受贈者1人あたりの加算額（相法19条1項）。
 * 3年超7年以内の帯は「その合計額から100万円（受贈者ごと・帯全体で1回）を控除した残額」。
 */
export function kanenKasanGaku(annualGift, giftYears, gapYears, R) {
  const Y = yen(annualGift);
  const { nFull, nBand, nOut } = kanenKasanMado(giftYears, gapYears, R);
  const fullAmt = Y * nFull;
  const bandTotal = Y * nBand;
  const bandAdded = bandTotal > 0 ? Math.max(0, bandTotal - R.band_deduction) : 0;
  return { nFull, nBand, nOut, fullAmt, bandTotal, bandAdded, added: fullAmt + bandAdded };
}

/**
 * 相続時精算課税: 受贈者1人あたりの贈与税（累積）と相続時の加算額。
 *   毎年: 課税価格 − 基礎控除110万円（措法70条の3の2）→ 特別控除2,500万円の残り（相法21条の12・累積）
 *   → 残額×20%（相法21条の13）。相続時の加算は「基礎控除後の残額」の全年分（相法21条の15第1項・期間制限なし）。
 */
export function seisanZoyozei(annualGift, giftYears, S) {
  if (!S) throw new Error("参照データ（seizen_zoyo_r08.json の seisan_kazei）が渡されていません");
  const Y = yen(annualGift);
  const N = cnt(giftYears);
  let remaining = S.tokubetsu_kojo;
  let taxTotal = 0;
  let addedTotal = 0;
  const years = [];
  for (let i = 0; i < N; i++) {
    const afterKiso = Math.max(0, Y - S.kiso_kojo);          // 基礎控除110万円（年ごと）
    const use = Math.min(afterKiso, remaining);              // 特別控除（累積2,500万円まで）
    remaining -= use;
    const base = floor1000(afterKiso - use);                 // 課税標準は1,000円未満切り捨て
    const tax = floor100(base * S.rate_pct / 100);           // 一律20%・100円未満切り捨て
    taxTotal += tax;
    addedTotal += afterKiso;                                 // 加算は基礎控除後の残額（贈与時価額）
    years.push({ afterKiso, use, base, tax });
  }
  return { taxTotal, addedTotal, tokubetsuUsed: S.tokubetsu_kojo - remaining, years };
}

/**
 * 加算つきの相続税。
 *   相続税の総額（相法16条）は課税価格の合計から法定相続分按分で計算し、各人の税額は
 *   実際の課税価格（残り財産の法定相続分＋その人の加算額）の割合で按分（相法17条）。
 *   配偶者は法定相続分の取得＝税額軽減の枠内で税額0（相法19条の2・本ツールの前提）。
 * @param p { estate, hasSpouse, numChildren, numRecipients, addedPerRecipient }
 * @param DS sozokuzei_r08.json
 */
export function souzokuzeiKasan(p, DS) {
  if (!DS) throw new Error("参照データ（sozokuzei_r08.json）が渡されていません");
  const estate = yen(p.estate); // 0円（全部贈与済み）も正しい入力
  const numChildren = cnt(p.numChildren);
  const numRecipients = Math.min(cnt(p.numRecipients), numChildren);
  const added = yen(p.addedPerRecipient);
  if (numChildren <= 0) throw new Error("子の人数を1人以上にしてください（本ツールは子への贈与が前提です）");

  const family = { hasSpouse: !!p.hasSpouse, numChildrenReal: numChildren };
  const sozokunin = houteiSozokunin(family, DS);
  const frac = houteiBun(sozokunin);

  // ── 各人の課税価格（実際の取得: 残り財産は法定相続分どおり ＋ 受贈者の子は加算額）──
  const spouseShareRaw = frac.spouse ? estate * frac.spouse[0] / frac.spouse[1] : 0;
  const childShareRaw = frac.blood ? estate * frac.blood[0] / frac.blood[1] : 0;
  const spouseKazei = frac.spouse ? floor1000(spouseShareRaw) : null;
  const childKazeiRecipient = floor1000(childShareRaw + added);
  const childKazeiOther = floor1000(childShareRaw);
  const totalKazei = (spouseKazei || 0)
    + childKazeiRecipient * numRecipients
    + childKazeiOther * (numChildren - numRecipients);

  // ── 相続税の総額（課税価格の合計 → 基礎控除 → 法定相続分按分 → 速算表）──
  const kiso = kisoKojo(sozokunin.count, DS);
  const belowKiso = totalKazei <= kiso;
  const kazeiIsan = Math.max(0, totalKazei - kiso);
  let sum = 0;
  if (frac.spouse) sum += sokusanZei(floor1000(kazeiIsan * frac.spouse[0] / frac.spouse[1]), DS).zei;
  if (frac.blood) {
    const each = sokusanZei(floor1000(kazeiIsan * frac.blood[0] / frac.blood[1]), DS).zei;
    sum += each * numChildren;
  }
  const sogaku = belowKiso ? 0 : floor100(sum);

  // ── 各人の算出税額 ＝ 総額 × その人の課税価格 ÷ 合計（配偶者は軽減で0） ──
  const arazeiRecipient = totalKazei > 0 ? Math.round(sogaku * childKazeiRecipient / totalKazei) : 0;
  const arazeiOther = totalKazei > 0 ? Math.round(sogaku * childKazeiOther / totalKazei) : 0;

  return {
    estate, totalKazei, kiso, belowKiso, kazeiIsan, sogaku,
    spouseKazei, childKazeiRecipient, childKazeiOther,
    arazeiRecipient, arazeiOther,
    houteiCount: sozokunin.count,
  };
}

/**
 * 入口。
 * input = {
 *   assets,          // 現在の財産総額（円）
 *   hasSpouse,       // 配偶者の有無
 *   numChildren,     // 子の人数（1以上・全員相続人）
 *   numRecipients,   // 贈与する子の人数（1〜numChildren）
 *   annualGift,      // 毎年の贈与額（子1人あたり・円）
 *   giftYears,       // 贈与を続ける年数（1以上）
 *   gapYears,        // 最後の贈与から相続開始までの年数（1以上）
 *   isAdult,         // 受贈者は各年1月1日に18歳以上（特例税率・精算課税の要件）
 *   donor60,         // 贈与者は各年1月1日に60歳以上（精算課税の要件）
 * }
 * D = seizen_zoyo_r08.json ／ DZ = zoyozei_r08.json ／ DS = sozokuzei_r08.json
 */
export function calcSeizenZoyo(input, D, DZ, DS) {
  if (!D) throw new Error("参照データ（seizen_zoyo_r08.json）が渡されていません");
  if (!DZ) throw new Error("参照データ（zoyozei_r08.json）が渡されていません");
  if (!DS) throw new Error("参照データ（sozokuzei_r08.json）が渡されていません");
  const i = input || {};
  const assets = yen(i.assets);
  const numChildren = cnt(i.numChildren);
  const numRecipients = cnt(i.numRecipients);
  const annualGift = yen(i.annualGift);
  const giftYears = cnt(i.giftYears);
  const gapYears = cnt(i.gapYears);

  if (assets <= 0) throw new Error("現在の財産総額を入力してください");
  if (numChildren <= 0) throw new Error("子の人数を1人以上にしてください（本ツールは子への贈与の比較です）");
  if (numRecipients <= 0 || numRecipients > numChildren) throw new Error("贈与する子の人数は1〜子の人数の範囲で入力してください");
  if (annualGift <= 0) throw new Error("毎年の贈与額を入力してください");
  if (giftYears <= 0) throw new Error("贈与を続ける年数を1年以上にしてください");
  if (gapYears <= 0) throw new Error("最後の贈与から相続開始までの年数は1年以上にしてください（相続開始と同じ年の贈与は贈与税がかからず全額加算という別枠のため、本ツールでは扱いません）");

  const giftsTotal = annualGift * giftYears * numRecipients;
  if (giftsTotal > assets) throw new Error("贈与の合計額が現在の財産総額を超えています。贈与額・年数・人数を見直してください");
  const estateAfter = assets - giftsTotal;

  // ── ① 何もしない ─────────────────────────────────────────────
  const baseS = souzokuzeiKasan({ estate: assets, hasSpouse: i.hasSpouse, numChildren, numRecipients: 0, addedPerRecipient: 0 }, DS);
  const basePayEach = floor100(baseS.arazeiOther);
  const base = {
    souzoku: baseS,
    souzokuTax: basePayEach * numChildren,
    burden: basePayEach * numChildren,
  };

  // ── ② 暦年課税で贈与 ─────────────────────────────────────────
  // 毎年の贈与税（受贈者1人あたり・毎年同額）。特例税率＝直系尊属→18歳以上（両方満たすときだけ）。
  const zy = calcZoyozei(i.isAdult ? { tokurei: annualGift } : { ippan: annualGift }, DZ);
  const zeiYear = zy.zei;
  const giftTaxRekinen = zeiYear * giftYears * numRecipients;
  const mado = kanenKasanGaku(annualGift, giftYears, gapYears, D.kanen_kasan);
  const rekS = souzokuzeiKasan({ estate: estateAfter, hasSpouse: i.hasSpouse, numChildren, numRecipients, addedPerRecipient: mado.added }, DS);
  // 贈与税額控除（相法19条1項・還付なし）: 加算された財産に対応する贈与税。
  //   全額加算の年はその年の贈与税全額、100万円控除の帯は加算された価額の割合で按分。
  const creditRekinen = Math.floor(
    zeiYear * mado.nFull + (mado.bandTotal > 0 ? zeiYear * mado.nBand * mado.bandAdded / mado.bandTotal : 0)
  );
  const rekPayRecipient = floor100(Math.max(0, rekS.arazeiRecipient - creditRekinen));
  const rekPayOther = floor100(rekS.arazeiOther);
  const rekSouzokuTax = rekPayRecipient * numRecipients + rekPayOther * (numChildren - numRecipients);
  const rekinen = {
    zeiYear, giftTax: giftTaxRekinen, mado,
    credit: creditRekinen,
    souzoku: rekS,
    payRecipient: rekPayRecipient, payOther: rekPayOther,
    souzokuTax: rekSouzokuTax,
    burden: giftTaxRekinen + rekSouzokuTax,
  };

  // ── ③ 相続時精算課税で贈与 ───────────────────────────────────
  let seisan = null;
  if (!i.isAdult) {
    seisan = { unavailable: "受贈者が贈与年の1月1日に18歳未満のため、相続時精算課税は選択できません（相法21条の9）" };
  } else if (!i.donor60) {
    seisan = { unavailable: "贈与者が贈与年の1月1日に60歳未満のため、相続時精算課税は選択できません（相法21条の9）" };
  } else {
    const sz = seisanZoyozei(annualGift, giftYears, D.seisan_kazei);
    const giftTaxSeisan = sz.taxTotal * numRecipients;
    const seiS = souzokuzeiKasan({ estate: estateAfter, hasSpouse: i.hasSpouse, numChildren, numRecipients, addedPerRecipient: sz.addedTotal }, DS);
    // 贈与税額控除（相法21条の15第3項）: 全額。引き切れなければ還付（相法33条の2）。
    const net = seiS.arazeiRecipient - sz.taxTotal;
    const seiPayRecipient = net >= 0 ? floor100(net) : 0;
    const refundEach = net < 0 ? -net : 0;
    const seiPayOther = floor100(seiS.arazeiOther);
    const seiSouzokuTax = seiPayRecipient * numRecipients + seiPayOther * (numChildren - numRecipients);
    seisan = {
      sz, giftTax: giftTaxSeisan,
      souzoku: seiS,
      payRecipient: seiPayRecipient, payOther: seiPayOther,
      refundEach, refundTotal: refundEach * numRecipients,
      souzokuTax: seiSouzokuTax,
      burden: giftTaxSeisan + seiSouzokuTax - refundEach * numRecipients,
    };
  }

  // ── 判定 ─────────────────────────────────────────────────────
  const candidates = [["base", base.burden], ["rekinen", rekinen.burden]];
  if (seisan && !seisan.unavailable) candidates.push(["seisan", seisan.burden]);
  candidates.sort((a, b) => a[1] - b[1]);
  const best = candidates[0][0];

  return {
    assets, numChildren, numRecipients, annualGift, giftYears, gapYears,
    isAdult: !!i.isAdult, donor60: !!i.donor60,
    giftsTotal, estateAfter,
    base, rekinen, seisan, best,
    year: D._meta?.year || "",
  };
}
