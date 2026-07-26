/**
 * 小規模宅地等の特例（措法69条の4）の減額計算コア（DOM非依存・テスト対象）。
 *
 * 出すもの:
 *  ① 限度面積の枠内で「どの区分に何平方メートルを割り当てると減額が最大になるか」
 *  ② その配分での減額される金額と、特例適用後の宅地等の価額
 *
 * ★★このツールが黙って誤答しやすい急所（措法69条の4第2項・国税庁 No.4124）:
 *
 *  1. **限度面積の式は「貸付事業用宅地等を選ぶかどうか」で入れ替わる。**（2項1号2号 vs 3号）
 *     貸付事業用を1平方メートルも選ばなければ、特定事業用等400と特定居住用330が独立に働き
 *     合計730平方メートルまで完全に併用できる。貸付事業用を選んだ瞬間に3号の按分式
 *     （事業用×200/400 ＋ 居住用×200/330 ＋ 貸付用 ≦ 200）に切り替わり、730は使えなくなる。
 *     → 本コアは①貸付を選ばない案と②貸付を含めて按分する案を**両方**解いて有利な方を採る。
 *       片方だけを解く実装は、貸付があると必ず損な答えを出す（あるいは730を許して過大に減額する）。
 *
 *  2. **「自宅を優先」は最適とは限らない。**枠1単位あたりの減額額は
 *     特定事業用等＝単価×1.6／特定居住用＝単価×1.32／貸付事業用＝単価×0.5 で、
 *     単価（円/平方メートル）が違えば有利な区分も変わる。3号の式の下では分数ナップサックなので、
 *     枠あたりの減額額が大きい区分から順に割り当てるのが最適解になる。
 *
 *  3. **条文が定めているのは「減額割合」ではなく「課税価格に算入すべき割合」。**（1項）
 *     1号は百分の二十（＝80％減）、2号は百分の五十（＝50％減）。データはこの両方を持ち、
 *     算入割合＋減額割合＝100 を検査で固定する（片方だけ直して整合が崩れるのを防ぐ）。
 *
 *  4. **面積と評価額は区分ごとに独立。**単価は区分ごとに評価額÷面積で出す。
 *     全体を一つの単価で計算すると、単価の違う土地を持つ人の答えが丸ごと狂う。
 *
 *  5. **申告が要件。**（7項）特例で相続税が0円になる場合も期限内申告が必要。
 *     基礎控除以下かどうかの判定は特例適用「前」の課税価格で行う（国税庁 No.4205）。
 *
 * 一次情報: 租税特別措置法69条の4（e-Gov法令API v2 で逐語確認）／国税庁 No.4124。
 */

/** 0以上の数に（未入力・負・NaN は0）。NaN を素通しすると減額額が丸ごと NaN になる。 */
const nz = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 円に切り捨てる（減額される金額は円単位）。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 面積の表示用まるめ（小数第2位）。判定そのものには使わない。 */
export const roundM2 = (n) => Math.round(Number(n) * 100) / 100;

/** 浮動小数の比較で 200.0000000001 > 200 を誤検出しないための許容差（平方メートル）。 */
const EPS = 1e-9;

/**
 * 区分ごとの入力（面積と評価額）から単価などの基本量を作る。
 * @param {{area:number,value:number}} lot
 */
function prep(lot) {
  const area = nz(lot && lot.area);
  const value = nz(lot && lot.value);
  return { area, value, unit: area > 0 ? value / area : 0 };
}

/**
 * 選択面積から、その区分の減額される金額を出す。
 * 減額額 ＝ その宅地等の価額 × (選択面積 ÷ 総面積) × 減額割合。円未満切捨て。
 */
function genkaku(lot, selArea, genzokuPct) {
  if (lot.area <= 0 || selArea <= 0) return 0;
  const ratio = Math.min(selArea / lot.area, 1);
  return yen(lot.value * ratio * (genzokuPct / 100));
}

/**
 * 参照データから区分の定義を引く（キーが無ければ例外＝黙って0で計算しない）。
 */
function kubunOf(D, key) {
  const k = (D.kubun || []).find((x) => x.key === key);
  if (!k) throw new Error(`参照データに区分「${key}」がありません`);
  return k;
}

/**
 * 案①: 貸付事業用宅地等を選ばない（措法69条の4第2項1号・2号がそれぞれ独立に働く）。
 * 特定事業用等は400平方メートルまで、特定居住用は330平方メートルまで、合計730まで完全併用。
 */
function scenarioNoRental(lots, D) {
  const kJigyo = kubunOf(D, 'jigyo');
  const kJutaku = kubunOf(D, 'jutaku');
  const sel = {
    jigyo: Math.min(lots.jigyo.area, kJigyo.limit_m2),
    jutaku: Math.min(lots.jutaku.area, kJutaku.limit_m2),
    kashitsuke: 0,
  };
  const breakdown = {
    jigyo: genkaku(lots.jigyo, sel.jigyo, kJigyo.genzoku_pct),
    jutaku: genkaku(lots.jutaku, sel.jutaku, kJutaku.genzoku_pct),
    kashitsuke: 0,
  };
  return {
    pattern: 'no_rental',
    select: sel,
    breakdown,
    reduction: breakdown.jigyo + breakdown.jutaku,
    // 2項1号・2号の枠をそれぞれどれだけ使ったか
    usage: { jigyo: sel.jigyo, jigyoLimit: kJigyo.limit_m2, jutaku: sel.jutaku, jutakuLimit: kJutaku.limit_m2 },
    budgetUsed: null,
  };
}

/**
 * 案②: 貸付事業用宅地等を含めて選ぶ（措法69条の4第2項3号の按分式）。
 *   事業用×(200/400) ＋ 居住用×(200/330) ＋ 貸付用 ≦ 200
 * 枠200を予算とし、枠1単位あたりの減額額が大きい区分から順に割り当てる（分数ナップサック）。
 */
function scenarioWithRental(lots, D) {
  const H = D.heiyo;
  if (!H) throw new Error('参照データに限度面積の併用ルール（heiyo）がありません');
  const budget = H.budget_m2;
  const kJigyo = kubunOf(D, 'jigyo');
  const kJutaku = kubunOf(D, 'jutaku');
  const kKashi = kubunOf(D, 'kashitsuke');

  // cost = その区分の1平方メートルが 200 の枠を消費する量（2項3号イ・ロ・ハ）
  const items = [
    { key: 'jigyo', lot: lots.jigyo, cost: H.jigyo_coef[0] / H.jigyo_coef[1], pct: kJigyo.genzoku_pct },
    { key: 'jutaku', lot: lots.jutaku, cost: H.jutaku_coef[0] / H.jutaku_coef[1], pct: kJutaku.genzoku_pct },
    { key: 'kashitsuke', lot: lots.kashitsuke, cost: 1, pct: kKashi.genzoku_pct },
  ].map((it) => ({
    ...it,
    // 枠1単位あたりの減額額。これが大きい順に枠を使うのが最大の減額になる。
    eff: it.cost > 0 ? (it.lot.unit * (it.pct / 100)) / it.cost : 0,
  }));

  items.sort((a, b) => b.eff - a.eff);

  const sel = { jigyo: 0, jutaku: 0, kashitsuke: 0 };
  let left = budget;
  for (const it of items) {
    if (left <= EPS || it.lot.area <= 0 || it.eff <= 0) continue;
    const take = Math.min(it.lot.area, left / it.cost);
    sel[it.key] = take;
    left -= take * it.cost;
  }

  const breakdown = {
    jigyo: genkaku(lots.jigyo, sel.jigyo, kJigyo.genzoku_pct),
    jutaku: genkaku(lots.jutaku, sel.jutaku, kJutaku.genzoku_pct),
    kashitsuke: genkaku(lots.kashitsuke, sel.kashitsuke, kKashi.genzoku_pct),
  };
  const used = budget - left;
  return {
    pattern: 'with_rental',
    select: sel,
    breakdown,
    reduction: breakdown.jigyo + breakdown.jutaku + breakdown.kashitsuke,
    usage: null,
    budgetUsed: used,
    budget,
    // 効率の順位（画面で「なぜこの配分か」を説明するために返す）
    order: items.map((it) => ({ key: it.key, eff: it.eff })),
  };
}

/**
 * 2項3号の式を満たしているかを、選択面積から独立に検算する。
 * （最適化の結果を信じず、条文の式そのものに当てて確かめるための関数。テストからも使う）
 */
export function checkGendoMenseki(select, D) {
  const H = D.heiyo;
  const s = { jigyo: nz(select.jigyo), jutaku: nz(select.jutaku), kashitsuke: nz(select.kashitsuke) };
  const kJigyo = kubunOf(D, 'jigyo');
  const kJutaku = kubunOf(D, 'jutaku');
  if (s.kashitsuke <= 0) {
    // 貸付事業用を選ばない → 2項1号・2号がそれぞれ独立に働く
    return {
      rule: 'no_rental',
      ok: s.jigyo <= kJigyo.limit_m2 + EPS && s.jutaku <= kJutaku.limit_m2 + EPS,
      value: s.jigyo + s.jutaku,
      limit: kJigyo.limit_m2 + kJutaku.limit_m2,
    };
  }
  // 貸付事業用を選ぶ → 2項3号の按分式
  const v =
    s.jigyo * (H.jigyo_coef[0] / H.jigyo_coef[1]) +
    s.jutaku * (H.jutaku_coef[0] / H.jutaku_coef[1]) +
    s.kashitsuke;
  return { rule: 'with_rental', ok: v <= H.budget_m2 + EPS, value: v, limit: H.budget_m2 };
}

/**
 * 小規模宅地等の特例の減額を計算する。
 *
 * @param {{jigyo:{area,value}, jutaku:{area,value}, kashitsuke:{area,value}}} input
 * @param {object} D 参照データ（shokibo_takuchi_r08.json）
 */
export function calcShokibo(input, D) {
  if (!D) throw new Error('参照データ（shokibo_takuchi_r08.json）が渡されていません');
  const i = input || {};
  const lots = {
    jigyo: prep(i.jigyo),
    jutaku: prep(i.jutaku),
    kashitsuke: prep(i.kashitsuke),
  };

  const totalArea = lots.jigyo.area + lots.jutaku.area + lots.kashitsuke.area;
  const totalValue = lots.jigyo.value + lots.jutaku.value + lots.kashitsuke.value;
  if (totalArea <= 0 || totalValue <= 0) {
    return { ok: false, reason: 'no_input', lots, totalArea, totalValue };
  }

  const a = scenarioNoRental(lots, D);
  const b = scenarioWithRental(lots, D);

  // 有利な方を採る。同額なら、枠の制約がゆるい「貸付を選ばない」案を採る。
  const best = b.reduction > a.reduction ? b : a;
  const other = best === b ? a : b;

  // 「貸付事業用を選ぶと、80％減の枠をどれだけ削るか」を実額で出す（このツールの中心）。
  const kashitsukeCost = a.reduction - b.reduction;

  return {
    ok: true,
    lots,
    totalArea,
    totalValue,
    scenarios: { noRental: a, withRental: b },
    best,
    other,
    // 条文の式に当てた独立検算（画面にも出す）
    check: checkGendoMenseki(best.select, D),
    reduction: best.reduction,
    afterValue: totalValue - best.reduction,
    breakdown: best.breakdown,
    select: best.select,
    pattern: best.pattern,
    kashitsukeCost,
    // 貸付事業用の土地を持っているか（持っていない人には比較を見せない）
    hasKashitsuke: lots.kashitsuke.area > 0 && lots.kashitsuke.value > 0,
  };
}
