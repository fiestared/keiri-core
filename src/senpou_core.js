/**
 * 振込手数料「先方負担」計算の純ロジック(DOM非依存・テスト対象)。
 *
 * 銀行実務の3方式(一次ソース: 北陸銀行 BIBUsersGuide.pdf、群馬銀行FAQ id=175):
 *  - sueoki      (据置型・当方有利):      基準額 30,000円         を請求額と比較して手数料区分を決定
 *  - mikan_kasan (未満手数料加算型):      基準額 30,000円+未満手数料
 *  - ijo_kasan   (以上手数料加算型・先方有利): 基準額 30,000円+以上手数料 (いわゆる差引後基準)
 *  + flat        (一律差引): 550円等の固定額を差し引く商慣行
 *
 * いずれも 請求額 >= 基準額 なら「3万円以上」の手数料、未満なら「3万円未満」の手数料を差し引く。
 * feeTable: { under30k: 手数料(税込円), over30k: 手数料(税込円) }
 */

export const THRESHOLD = 30000;

export const METHODS = {
  sueoki: {
    label: "据置型（差引前基準・当方有利）",
    desc: "請求額そのものを3万円と比較して手数料区分を決めます。多くの銀行の初期設定。",
  },
  mikan_kasan: {
    label: "未満手数料加算型",
    desc: "基準額を「3万円＋3万円未満の手数料」として比較します。",
  },
  ijo_kasan: {
    label: "以上手数料加算型（差引後基準・先方有利）",
    desc: "基準額を「3万円＋3万円以上の手数料」として比較します。差引後の振込額で判定する運用に相当。",
  },
  flat: {
    label: "一律差引",
    desc: "実際の手数料額にかかわらず固定額(550円等)を差し引く規程の会社向け。",
  },
};

export function basisAmount(method, feeTable) {
  if (method === "sueoki") return THRESHOLD;
  if (method === "mikan_kasan") return THRESHOLD + feeTable.under30k;
  if (method === "ijo_kasan") return THRESHOLD + feeTable.over30k;
  throw new Error("unknown method: " + method);
}

/** 3方式共通: 請求額と基準額の比較で手数料を決め、差引後の振込額を返す */
export function calc(method, invoice, feeTable) {
  const basis = basisAmount(method, feeTable);
  const fee = invoice >= basis ? feeTable.over30k : feeTable.under30k;
  return { method, basis, fee, transfer: invoice - fee };
}

export function calcFlat(invoice, flatFee) {
  return { method: "flat", fee: flatFee, transfer: invoice - flatFee };
}

/** 3方式の結果が分かれる帯かどうか(注意喚起用) */
export function methodsDisagree(invoice, feeTable) {
  const fees = ["sueoki", "mikan_kasan", "ijo_kasan"].map(
    (m) => calc(m, invoice, feeTable).fee
  );
  return new Set(fees).size > 1;
}

/**
 * 入金差額の判定: 請求額と入金額の差が「振込手数料の先方負担」で説明できるか。
 */
export function explainShortfall(invoice, received, commonFees = COMMON_FEES) {
  const diff = invoice - received;
  if (diff === 0) return { diff, verdict: "match", hits: [], near: [] };
  if (diff < 0) return { diff, verdict: "overpaid", hits: [], near: [] };
  const hits = commonFees.filter((f) => f === diff);
  const near = commonFees.filter((f) => Math.abs(f - diff) <= 5 && f !== diff);
  return {
    diff,
    verdict: hits.length ? "likely_fee" : near.length ? "near_fee" : "unknown",
    hits,
    near,
  };
}

/**
 * 代表的な振込手数料額(税込円)。2026-07-11に銀行公式ページで検証済みの
 * 他行宛手数料の実額(fee_table.json)と一律差引の商慣行(550/660)から構成。
 */
export const COMMON_FEES = [
  75, 77, 99, 110, 130, 145, 150, 154, 160, 165, 220, 229, 330, 385, 440,
  484, 495, 550, 605, 660, 770, 880,
];
