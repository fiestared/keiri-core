/**
 * 消費税・端数処理の計算（DOM非依存・テスト対象）。
 *
 * 一次ソース（2026-07-13に国税庁で確認）:
 * - タックスアンサー No.6371「端数計算」（消法28〜30、通法118〜120、消令70の10、消基通1-8-15）
 *     ・適格請求書に記載する消費税額等の端数処理は「切上げ、切捨て、四捨五入など任意の方法」
 * - インボイス制度に関するQ&A 問57（令和6年4月改訂）
 *     ・適格請求書の消費税額等に1円未満の端数が生じる場合は、
 *       **一の適格請求書につき、税率ごとに1回** の端数処理を行う（消令70の10、基通1-8-15）
 *     ・(注) 一の適格請求書に記載されている **個々の商品ごとに** 消費税額等を計算し、
 *       1円未満の端数処理を行い、その合計額を消費税額等として記載することは **認められない**
 *     ・記載例: 税込100,000円 → 10%対象60,000円 × 10/110 ≒ 5,454円 /
 *                              8%対象 40,000円 ×  8/108 ≒ 2,962円（消費税 計8,416円）
 *
 * 実装上の注意（浮動小数点）:
 * 税率を 0.1 / 0.08 のような二進で表せない小数で持つと、端数処理の境界で1円ずれうる。
 * ここでは **整数の分子・分母** で持ち、割り算を1回だけ行う（整数どうしの除算は、
 * 真の商が整数なら IEEE754 でも正確に整数が返る）。
 */

/** 税率の定義。tax = 税抜 × num/den、税込からは incl × inNum/inDen で税額を直接出す。 */
export const RATES = {
  standard: { key: "standard", label: "10%（標準税率）", percent: 10, num: 10, den: 100, inNum: 10, inDen: 110 },
  reduced: { key: "reduced", label: "8%（軽減税率）", percent: 8, num: 8, den: 100, inNum: 8, inDen: 108 },
};

/** 端数処理の方法。適格請求書では3つとも認められる（No.6371）。 */
export const ROUNDINGS = {
  floor: { key: "floor", label: "切捨て", note: "最も多い。国税庁の記載例もこの方法" },
  ceil: { key: "ceil", label: "切上げ", note: "認められる" },
  round: { key: "round", label: "四捨五入", note: "認められる" },
};

/** 1円未満の端数を処理する。 */
export function applyRounding(value, mode = "floor") {
  if (mode === "ceil") return Math.ceil(value);
  if (mode === "round") return Math.round(value); // 正の金額なので .5 は切上げ＝四捨五入
  return Math.floor(value);
}

/** 税抜金額から消費税額を求める。 */
export function taxFromExcluded(excluded, rateKey = "standard", mode = "floor") {
  const r = RATES[rateKey];
  return applyRounding((excluded * r.num) / r.den, mode);
}

/** 税込金額から消費税額を求める（10%なら ×10/110、8%なら ×8/108）。 */
export function taxFromIncluded(included, rateKey = "standard", mode = "floor") {
  const r = RATES[rateKey];
  return applyRounding((included * r.inNum) / r.inDen, mode);
}

/**
 * 税抜⇔税込の相互変換。
 * 税抜は「税込 − 税額」で戻す（税額から逆算しないと、画面の3つの数字が合わなくなる）。
 */
export function convert(amount, rateKey = "standard", mode = "floor", input = "excluded") {
  if (!(amount > 0)) return { excluded: 0, tax: 0, included: 0 };
  if (input === "included") {
    const tax = taxFromIncluded(amount, rateKey, mode);
    return { excluded: amount - tax, tax, included: amount };
  }
  const tax = taxFromExcluded(amount, rateKey, mode);
  return { excluded: amount, tax, included: amount + tax };
}

/**
 * 適格請求書（インボイス）の消費税額を計算する。
 *
 * 正しい方法 = 税率ごとに金額を合計し、**その合計に対して1回だけ** 端数処理する。
 * 比較のため、認められていない「明細ごとに端数処理して合計する方法」も計算して返す
 * （両者の差が、そのまま請求書の消費税額の誤りになる）。
 *
 * @param {Array<{name?:string, amount:number, rate:string}>} lines 明細（amountは input が示す税抜/税込）
 * @param {string} mode 端数処理の方法
 * @param {string} input "excluded"（税抜で入力）または "included"（税込で入力）
 */
export function calcInvoice(lines, mode = "floor", input = "excluded") {
  const groups = [];
  for (const key of ["standard", "reduced"]) {
    const rows = lines.filter((l) => l.rate === key && l.amount > 0);
    if (rows.length === 0) continue;

    const subtotal = rows.reduce((s, l) => s + l.amount, 0);

    // 正: 税率ごとの合計に1回だけ端数処理（消令70の10）
    const tax = input === "included"
      ? taxFromIncluded(subtotal, key, mode)
      : taxFromExcluded(subtotal, key, mode);

    // 誤: 明細ごとに端数処理してから合計（Q&A 問57(注)で「認められません」）
    const perLineTax = rows.reduce(
      (s, l) => s + (input === "included"
        ? taxFromIncluded(l.amount, key, mode)
        : taxFromExcluded(l.amount, key, mode)),
      0
    );

    groups.push({
      rate: key,
      label: RATES[key].label,
      percent: RATES[key].percent,
      count: rows.length,
      subtotal,
      tax,
      perLineTax,
      excluded: input === "included" ? subtotal - tax : subtotal,
      included: input === "included" ? subtotal : subtotal + tax,
    });
  }

  const totalTax = groups.reduce((s, g) => s + g.tax, 0);
  const totalPerLineTax = groups.reduce((s, g) => s + g.perLineTax, 0);
  const totalExcluded = groups.reduce((s, g) => s + g.excluded, 0);
  const totalIncluded = groups.reduce((s, g) => s + g.included, 0);

  return {
    groups,
    totalTax,
    totalPerLineTax,
    // 明細ごとに端数処理した場合とのズレ（0でなければ、その請求書は端数処理の方法が誤り）
    diff: totalPerLineTax - totalTax,
    totalExcluded,
    totalIncluded,
    mixed: groups.length > 1,
  };
}

/* ==========================================================================
 * 申告（納付税額）の計算 — 割戻し計算 / 積上げ計算
 *
 * 一次ソース（2026-07-13に国税庁で確認）:
 * - No.6383「売上げに係る対価の返還等をした場合の消費税額の控除」系／売上税額の計算
 *     ・原則(割戻し): 税込売上 × 100/110（軽減 100/108）= 課税標準額 → × 7.8%（軽減 6.24%）
 *     ・特例(積上げ): 適格請求書等に記載した消費税額等の合計 × 78/100
 * - No.6391「課税仕入れに係る消費税額の計算」
 *     ・原則(積上げ): 請求書等積上げ = 交付を受けた適格請求書等の消費税額等の合計 × 78/100
 *                     帳簿積上げ   = 支払対価 × 10/110（軽減 8/108）を都度端数処理した合計 × 78/100
 *     ・特例(割戻し): 税率ごとの課税仕入れ(税込)の合計 × 7.8/110（軽減 6.24/108）
 *     ・**制約（原文）**「割戻し計算により仕入税額を計算できるのは、
 *        売上税額を割戻し計算している場合に限られます」
 *       → 売上=積上げ のとき 仕入=割戻し は選べない（組み合わせは4通りでなく3通り）
 * - No.6371「端数計算」: 課税標準額は**千円未満切捨て**、差引税額は**百円未満切捨て**
 * - 課税標準額の千円未満切捨ては**税率ごと**に行う（付表1-3が税率6.24%適用分/7.8%適用分の
 *   欄をそれぞれ千円未満切捨てで持つ）
 * - 地方消費税（譲渡割額）= 差引税額 × 22/78
 * ========================================================================== */

/** 国税分の税率。地方消費税を含む10%のうち国税は7.8%、軽減8%のうち国税は6.24%。 */
export const NATIONAL = {
  standard: { num: 78, den: 1000 },    // 7.8%
  reduced: { num: 624, den: 10000 },   // 6.24%
};

/** 税込 → 課税標準額（税抜）に戻すための分数。100/110 と 100/108。 */
const DEIMPOSE = {
  standard: { num: 10, den: 11 },      // 100/110
  reduced: { num: 25, den: 27 },       // 100/108
};

/** 仕入税額の割戻し計算に使う分数。7.8/110 と 6.24/108。 */
const PURCHASE_DIVIDE = {
  standard: { num: 78, den: 1100 },    // 7.8/110
  reduced: { num: 624, den: 10800 },   // 6.24/108
};

/** value を unit 未満切捨て（課税標準額=1000、差引税額=100）。 */
export function floorToUnit(value, unit) {
  return Math.floor(value / unit) * unit;
}

/**
 * 売上税額（国税）— 割戻し計算（原則）。
 * 税率ごとに「税込 × 100/110 → 千円未満切捨て = 課税標準額」→「× 7.8%」。
 */
export function salesTaxByDivide(salesIncluded) {
  const rows = [];
  for (const key of ["standard", "reduced"]) {
    const included = salesIncluded[key] || 0;
    if (included <= 0) continue;
    const d = DEIMPOSE[key];
    const base = floorToUnit((included * d.num) / d.den, 1000); // 課税標準額（千円未満切捨て）
    const n = NATIONAL[key];
    const tax = Math.floor((base * n.num) / n.den);
    rows.push({ rate: key, included, base, tax });
  }
  return { rows, tax: rows.reduce((s, r) => s + r.tax, 0) };
}

/**
 * 売上税額（国税）— 積上げ計算（特例）。
 * 交付した適格請求書に記載した消費税額等（地方分を含む10%/8%ベース）の合計 × 78/100。
 */
export function salesTaxByPileUp(invoiceTaxTotal) {
  const total = invoiceTaxTotal > 0 ? invoiceTaxTotal : 0;
  return { invoiceTaxTotal: total, tax: Math.floor((total * 78) / 100) };
}

/**
 * 仕入税額（国税）— 積上げ計算（原則・請求書等積上げ）。
 * 交付を受けた適格請求書等に記載された消費税額等の合計 × 78/100。
 */
export function purchaseTaxByPileUp(invoiceTaxTotal) {
  const total = invoiceTaxTotal > 0 ? invoiceTaxTotal : 0;
  return { invoiceTaxTotal: total, tax: Math.floor((total * 78) / 100) };
}

/**
 * 仕入税額（国税）— 割戻し計算（特例）。
 * 税率ごとの課税仕入れ(税込)の合計 × 7.8/110（軽減 6.24/108）。
 * ※これを選べるのは売上税額も割戻し計算にしている場合だけ（No.6391）。
 */
export function purchaseTaxByDivide(purchasesIncluded) {
  const rows = [];
  for (const key of ["standard", "reduced"]) {
    const included = purchasesIncluded[key] || 0;
    if (included <= 0) continue;
    const p = PURCHASE_DIVIDE[key];
    const tax = Math.floor((included * p.num) / p.den);
    rows.push({ rate: key, included, tax });
  }
  return { rows, tax: rows.reduce((s, r) => s + r.tax, 0) };
}

/** 売上=積上げ かつ 仕入=割戻し は認められない（No.6391）。 */
export function isAllowedCombination(salesMethod, purchaseMethod) {
  return !(salesMethod === "pileup" && purchaseMethod === "divide");
}

/**
 * 納付税額を試算する。
 *
 * 前提（この計算が成り立つ範囲。外れる場合は答えない＝呼び出し側で申告する）:
 * 本則課税・全額控除（課税売上割合95%以上）・中間納付なし・貸倒れ／返還等なし。
 *
 * @param {{standard:number, reduced:number}} salesIncluded   課税売上（税込・税率ごと）
 * @param {number} salesInvoiceTax      交付した適格請求書の消費税額等の合計（積上げ用）
 * @param {{standard:number, reduced:number}} purchasesIncluded 課税仕入れ（税込・税率ごと）
 * @param {number} purchaseInvoiceTax   受領した適格請求書の消費税額等の合計（積上げ用）
 * @param {"divide"|"pileup"} salesMethod
 * @param {"divide"|"pileup"} purchaseMethod
 */
export function calcDeclaration({
  salesIncluded = {},
  salesInvoiceTax = 0,
  purchasesIncluded = {},
  purchaseInvoiceTax = 0,
  salesMethod = "divide",
  purchaseMethod = "pileup",
}) {
  if (!isAllowedCombination(salesMethod, purchaseMethod)) {
    return {
      allowed: false,
      reason:
        "売上税額を積上げ計算にした場合、仕入税額に割戻し計算は選べません（国税庁 No.6391）。",
    };
  }

  const sales = salesMethod === "pileup"
    ? salesTaxByPileUp(salesInvoiceTax)
    : salesTaxByDivide(salesIncluded);
  const purchase = purchaseMethod === "pileup"
    ? purchaseTaxByPileUp(purchaseInvoiceTax)
    : purchaseTaxByDivide(purchasesIncluded);

  // 差引税額（国税）は百円未満切捨て。控除不足（マイナス＝還付）のときは切り捨てない。
  const rawNational = sales.tax - purchase.tax;
  const national = rawNational >= 0 ? floorToUnit(rawNational, 100) : rawNational;

  // 地方消費税（譲渡割額）= 差引税額 × 22/78。こちらも百円未満切捨て。
  const rawLocal = (national * 22) / 78;
  const local = rawLocal >= 0 ? floorToUnit(rawLocal, 100) : -floorToUnit(-rawLocal, 100);

  return {
    allowed: true,
    salesMethod,
    purchaseMethod,
    sales,
    purchase,
    national,      // 消費税（国税）差引税額
    local,         // 地方消費税
    total: national + local, // 納付税額（還付のときは負）
    refund: rawNational < 0,
  };
}

/** 認められる3通りの組み合わせを全て計算し、納付税額が少ない順に並べる。 */
export function compareDeclarationMethods(input) {
  const combos = [
    { salesMethod: "divide", purchaseMethod: "pileup", label: "売上=割戻し × 仕入=積上げ", note: "原則どうしの組み合わせ" },
    { salesMethod: "divide", purchaseMethod: "divide", label: "売上=割戻し × 仕入=割戻し", note: "仕入は特例（売上が割戻しのときだけ選べる）" },
    { salesMethod: "pileup", purchaseMethod: "pileup", label: "売上=積上げ × 仕入=積上げ", note: "売上は特例。適格請求書の写しの保存が必要" },
  ];
  const results = combos.map((c) => ({
    ...c,
    ...calcDeclaration({ ...input, salesMethod: c.salesMethod, purchaseMethod: c.purchaseMethod }),
  }));
  const best = results.reduce((a, b) => (b.total < a.total ? b : a));
  return {
    results,
    best,
    spread: Math.max(...results.map((r) => r.total)) - Math.min(...results.map((r) => r.total)),
  };
}

/** 表示用（テストでは使わない）。 */
export function yen(n) {
  return "¥" + Math.round(n).toLocaleString("ja-JP");
}
