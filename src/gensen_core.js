/**
 * 報酬・料金等の源泉徴収税額の計算（DOM非依存・テスト対象）。
 *
 * 一次ソース（2026-07-13に国税庁タックスアンサーで確認）:
 * - No.2795 原稿料や講演料等 / No.2798 弁護士・税理士等:
 *     支払金額A ≦ 100万円 … A × 10.21%
 *     支払金額A > 100万円 … (A - 100万円) × 20.42% + 102,100円
 * - No.2801 司法書士等:
 *     (1回の支払額 - 10,000円) × 10.21%
 * - 求めた税額の1円未満の端数は切り捨て
 *
 * 消費税の扱い（重要・実務で最も間違えるところ）:
 * 原則は「消費税込みの金額」が源泉徴収の対象。ただし請求書等で
 * 報酬額と消費税額が明確に区分されている場合は、税抜の報酬額のみを対象にできる（所基通204-2）。
 */

export const RATE_LOW = 0.1021;   // 10.21%（所得税10% + 復興特別所得税0.21%）
export const RATE_HIGH = 0.2042;  // 20.42%
export const THRESHOLD = 1000000; // 100万円
export const FIXED_ADD = 102100;  // 100万円超のときの加算額
export const SHIHO_DEDUCTION = 10000; // 司法書士等: 1回の支払につき1万円控除

/** 報酬の種類 */
export const KINDS = {
  general: {
    label: "原稿料・講演料・デザイン料・弁護士・税理士など（一般）",
    note: "最も多いケース。100万円を超える部分は20.42%になります。",
  },
  shiho: {
    label: "司法書士・土地家屋調査士・海事代理士",
    note: "1回の支払額から1万円を差し引いた残額に10.21%（この3士業だけ計算式が違います）",
  },
  diagnosis: {
    label: "社会保険診療報酬支払基金が支払う診療報酬",
    note: "月額20万円を超える部分に10.21%（月20万円までは源泉徴収なし）",
  },
};
export const DIAGNOSIS_DEDUCTION = 200000; // 診療報酬: 月20万円控除

/**
 * 源泉徴収税額を計算する。
 * @param {number} amount 対象となる支払金額（消費税の扱いは呼び出し側で決めて渡す）
 * @param {string} kind KINDSのキー
 * @returns {{tax:number, base:number, formula:string, net:number}}
 */
export function calcWithholding(amount, kind = "general") {
  if (!(amount > 0)) return { tax: 0, base: 0, formula: "", net: 0 };

  if (kind === "shiho") {
    const base = Math.max(0, amount - SHIHO_DEDUCTION);
    const tax = Math.floor(base * RATE_LOW);
    return {
      tax, base, net: amount - tax,
      formula: `（${yen(amount)} − ${yen(SHIHO_DEDUCTION)}）× 10.21% = ${yen(tax)}`,
    };
  }

  if (kind === "diagnosis") {
    const base = Math.max(0, amount - DIAGNOSIS_DEDUCTION);
    const tax = Math.floor(base * RATE_LOW);
    return {
      tax, base, net: amount - tax,
      formula: base === 0
        ? `月額${yen(DIAGNOSIS_DEDUCTION)}以下のため源泉徴収なし`
        : `（${yen(amount)} − ${yen(DIAGNOSIS_DEDUCTION)}）× 10.21% = ${yen(tax)}`,
    };
  }

  // general
  if (amount <= THRESHOLD) {
    const tax = Math.floor(amount * RATE_LOW);
    return {
      tax, base: amount, net: amount - tax,
      formula: `${yen(amount)} × 10.21% = ${yen(tax)}`,
    };
  }
  const over = amount - THRESHOLD;
  const tax = Math.floor(over * RATE_HIGH + FIXED_ADD);
  return {
    tax, base: amount, net: amount - tax,
    formula: `（${yen(amount)} − ${yen(THRESHOLD)}）× 20.42% + ${yen(FIXED_ADD)} = ${yen(tax)}`,
  };
}

/**
 * 消費税の区分から、源泉徴収の対象額を決める。
 * @param {number} fee 報酬額（税抜）
 * @param {number} taxRate 消費税率（0.1など）
 * @param {boolean} separated 請求書で報酬と消費税が区分されているか
 * @returns {{target:number, total:number, explain:string}}
 */
export function withholdingTarget(fee, taxRate, separated) {
  const total = Math.floor(fee * (1 + taxRate));
  if (separated) {
    return {
      target: fee, total,
      explain: "請求書で報酬額と消費税額が区分されているため、税抜の報酬額のみが源泉徴収の対象です（所基通204-2）。",
    };
  }
  return {
    target: total, total,
    explain: "報酬額と消費税額が区分されていないため、税込金額の全体が源泉徴収の対象になります（原則）。",
  };
}

function yen(n) {
  return "¥" + Math.round(n).toLocaleString("ja-JP");
}
