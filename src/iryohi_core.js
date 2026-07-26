/**
 * 医療費控除の計算コア（DOM非依存・テスト対象）。
 * 「支払った医療費」「保険金などの補填」「所得（年収）」「所得税の税率」から、
 * 医療費控除の**控除額**と、戻ってくる税金の**軽減額（概算）**を出す。
 *
 * ★このコアは新しい税率表を1つも書き起こさない。
 *   - 年収 → 総所得金額等 の換算は juminzei_core の kyuyoShotoku（所法28条・別表第五）を**再利用**する
 *     （速算式ではなく別表第五で求めるのが法。正本を1つに保つ）。
 *     ★令和8年分・令和9年分は zeisei:'r8' を渡して kyuyoShotokuR8（措法29条の4）を使う。
 *       改正で給与所得控除の最低保障が65万→74万になったので、収入220万円未満の人だけ
 *       総所得金額等が下がる＝**足切り（5%側）が下がって控除額が増える**。R7規則のまま計算すると
 *       いちばん救われるべき低所得の人の控除額を最大4,500円ぶん過少に出す（黙って損をさせる）。
 *   - 足切り・上限・セルフメディの金額、所得税の速算表は iryohi_r08.json に持たせる。
 *
 * ★★このツールでいちばん嘘をつきやすい2点（ここを取り違えると黙って誤答する）:
 *
 *  1. **足切りの10万円は「上限（キャップ）」であって「下限」ではない。**（所法73条1項）
 *     足切り ＝ min(総所得金額等 × 5%, 10万円)。
 *     総所得金額等が200万円未満の人（給与収入およそ297万円以下）は5%側が効いて足切りが10万円より小さくなる。
 *     → 「医療費が10万円を超えないと使えない」は誤り。低所得の人ほど少ない医療費で使える。
 *     ここを「足切り＝一律10万円」と実装すると、いちばん救われるべき低所得の人が黙って控除を失う。
 *
 *  2. **軽減額は「控除額 × 課税所得の限界税率」の概算。**
 *     医療費控除は所得控除なので課税所得を上から減らす。控除で課税所得が一段下の税率帯にまたがると、
 *     実際の軽減はこの概算より少なくなる（正確には確定申告で計算される）。だから keigen は「目安」。
 *     ★所得税を1円も納めていない人（課税所得0・住宅ローン控除で所得税0など）は、
 *       所得控除を増やしても所得税は戻らない（住民税は課税されていれば戻る）。
 *
 * ★補填金は「その給付の目的となった医療費」を限度に引く（No.1125）。入院給付金が入院費を上回っても、
 *   はみ出した分を他の医療費（通院・薬代）からは引かない。hotenTaisho（補填がひも付く医療費）を渡すと
 *   その限度で引く。省略時は医療費全体から引く（＝多めに引く・控除額を小さめに出す保守側）。
 *
 * 一次情報: 所得税法73条・89条／復興財源確保法13条／租税特別措置法41条の17／
 *           国税庁 No.1120・No.1122・No.1125・No.1129・No.2260・No.1410。
 */

import { kyuyoShotoku, kyuyoShotokuR8 } from './juminzei_core.js';

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると控除額が丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 足切り額 ＝ min(総所得金額等 × 5%, 10万円)（所法73条1項）。★5%側が効くのが低所得の人。 */
export function ashikiriGaku(sotoShotoku, I) {
  if (!I) throw new Error('参照データ（iryohi_r08.json）が渡されていません');
  const K = I.iryohi_kojo;
  const gopct = Math.floor(yen(sotoShotoku) * K.ashikiri_rate_pct / 100);
  return Math.min(gopct, K.ashikiri_cap);
}

/**
 * 通常の医療費控除の控除額（所法73条1項）。
 *   控除額 ＝ min( max(0, (医療費 − 補填金) − 足切り), 200万円 )
 * @param hotenTaisho 補填金がひも付く医療費（省略時は医療費全体を対象＝補填を全体から引く保守側）
 */
export function iryohiKojo(iryohi, hoten, hotenTaisho, sotoShotoku, I) {
  if (!I) throw new Error('参照データ（iryohi_r08.json）が渡されていません');
  const K = I.iryohi_kojo;
  const hi = yen(iryohi);
  // 補填金は「その給付の目的となった医療費」を限度に引く。ひも付き医療費が不明なら医療費全体を限度とする。
  const taisho = hotenTaisho != null && hotenTaisho !== '' ? yen(hotenTaisho) : hi;
  const netHoten = Math.min(yen(hoten), taisho);
  const netIryohi = Math.max(0, hi - netHoten);
  const ashikiri = ashikiriGaku(sotoShotoku, I);
  const kojo = Math.min(Math.max(0, netIryohi - ashikiri), K.kojo_cap);
  return { kojo, netIryohi, netHoten, ashikiri, capped: netIryohi - ashikiri > K.kojo_cap };
}

/**
 * セルフメディケーション税制の控除額（措法41条の17）。
 *   控除額 ＝ min( max(0, 特定一般用医薬品等の購入費 − 12,000円), 88,000円 )
 * ★通常の医療費控除との選択（どちらか一方だけ）。
 */
export function selfmedKojo(purchase, I) {
  if (!I) throw new Error('参照データ（iryohi_r08.json）が渡されていません');
  const S = I.selfmed;
  const p = yen(purchase);
  const kojo = Math.min(Math.max(0, p - S.floor), S.cap);
  return { kojo, purchase: p, floor: S.floor, cap: S.cap };
}

/** 速算表から、課税される所得金額に対応する限界税率(%)を引く（No.2260）。 */
export function rateFromKazei(kazei, I) {
  const B = I.keigen.shotokuzei_brackets;
  const v = yen(kazei);
  for (const b of B) {
    if (b.kazei_upto === null || b.kazei_upto === undefined || v <= b.kazei_upto) return b.rate_pct;
  }
  return B[B.length - 1].rate_pct;
}

/** 渡された税率(%)が速算表の税率のどれかに一致するか（＝正しく選ばれたか）。 */
export function isValidRate(rate, I) {
  const r = Number(rate);
  return I.keigen.shotokuzei_brackets.some((b) => b.rate_pct === r);
}

/**
 * 軽減額（概算）＝ 所得税の軽減 ＋ 復興特別所得税 ＋ 住民税の軽減。
 *   所得税の軽減 ＝ round(控除額 × 限界税率)
 *   復興特別所得税 ＝ round(所得税の軽減 × 2.1%)
 *   住民税の軽減 ＝ round(控除額 × 10%)
 * ★rate が速算表の税率でなければ null（＝税率が選ばれていない。黙って0円で答えない）。
 */
export function keigenGaku(kojo, rate, I) {
  if (!I) throw new Error('参照データ（iryohi_r08.json）が渡されていません');
  if (!isValidRate(rate, I)) return null;
  const K = I.keigen;
  const k = yen(kojo);
  const r = Number(rate);
  const shotokuzei = Math.round(k * r / 100);
  const fukko = Math.round(shotokuzei * K.fukko_pct / 100);
  const jumin = Math.round(k * K.juminzei_pct / 100);
  return { shotokuzei, fukko, jumin, total: shotokuzei + fukko + jumin, rate: r };
}

/**
 * 入口。
 * input = {
 *   iryohi,          // 支払った医療費の合計（円）
 *   hoten,           // 保険金などで補填される金額（円）
 *   hotenTaisho,     // （任意）補填金がひも付く医療費（円）
 *   kyuyoShunyu,     // 給与収入（年収）→ 総所得金額等の算出（足切りの5%に使う）
 *   sotoShotoku,     // （任意）総所得金額等を直接指定。あれば kyuyoShunyu より優先
 *   shotokuzeiRate,  // 所得税の限界税率（%）— 課税所得帯のドロップダウンから
 *   selfmedPurchase, // （任意）セルフメディケーション：特定一般用医薬品等の購入費（円）
 * }
 * refs = { iryohiData, juminzeiData }
 */
export function calcIryohi(input, refs) {
  const { iryohiData: I, juminzeiData: D } = refs || {};
  if (!I) throw new Error('参照データ（iryohi_r08.json）が渡されていません');
  const i = input || {};

  // ── 総所得金額等（足切りの5%に使う） ──────────────────────────────
  // ★渡し忘れ対策: 年収も総所得も渡されなければ、足切りが0になって控除額を過大に出す。黙って答えない。
  const hasSoto = i.sotoShotoku != null && i.sotoShotoku !== '';
  const hasShunyu = Number(i.kyuyoShunyu) > 0;
  if (!hasSoto && !hasShunyu) {
    throw new Error('総所得金額等（または給与収入）が渡されていません。足切りは総所得金額等の5%と10万円の低いほうなので、所得なしに控除額は出せません');
  }
  let sotoShotoku;
  if (hasSoto) {
    sotoShotoku = yen(i.sotoShotoku);
  } else {
    if (!D) throw new Error('参照データ（juminzei_r08.json）が渡されていません（年収→総所得金額等の換算に必要）');
    // ★zeisei:'r8' ＝ 令和8年分・令和9年分（措法29条の4）。データが無ければ例外＝黙ってR7で答えない。
    sotoShotoku = i.zeisei === 'r8'
      ? kyuyoShotokuR8(yen(i.kyuyoShunyu), D)
      : kyuyoShotoku(yen(i.kyuyoShunyu), D);
  }

  const ashikiri = ashikiriGaku(sotoShotoku, I);
  const rate = i.shotokuzeiRate;
  const rateValid = isValidRate(rate, I);

  // ── 通常の医療費控除 ──────────────────────────────────────────────
  const nk = iryohiKojo(i.iryohi, i.hoten, i.hotenTaisho, sotoShotoku, I);
  const normal = {
    kojo: nk.kojo, netIryohi: nk.netIryohi, netHoten: nk.netHoten,
    capped: nk.capped, keigen: keigenGaku(nk.kojo, rate, I),
  };

  // ── セルフメディケーション税制（購入費が入っていれば） ────────────────
  let selfmed = null;
  const hasSelf = i.selfmedPurchase != null && i.selfmedPurchase !== '' && yen(i.selfmedPurchase) > 0;
  if (hasSelf) {
    const sk = selfmedKojo(i.selfmedPurchase, I);
    selfmed = { kojo: sk.kojo, purchase: sk.purchase, keigen: keigenGaku(sk.kojo, rate, I) };
  }

  // 控除額の大きい方を推奨（通常とセルフメディは選択＝どちらか一方だけ）
  const recommended = selfmed && selfmed.kojo > normal.kojo ? 'selfmed' : 'normal';

  return {
    sotoShotoku,
    ashikiri,
    ashikiriCapped: ashikiri >= I.iryohi_kojo.ashikiri_cap, // 5%側でなく10万円で頭打ちか
    rate: rateValid ? Number(rate) : null,
    rateValid,
    normal,
    selfmed,
    recommended,
    year: I._meta?.year || '',
  };
}
