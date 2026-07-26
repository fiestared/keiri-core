/**
 * 相続登記の登録免許税 計算コア（DOM非依存・テスト対象）。
 *
 * 出すもの: 相続する不動産（土地・建物）の固定資産税評価額と持分から、
 *   ①各不動産の課税標準への寄与と免税判定 ②合計の課税標準（端数処理後） ③登録免許税額
 *   ④相続登記の申請義務の期限（知った日から3年。施行日前の相続は読み替え）を計算する。
 *
 * ★★このツールが黙って誤答しやすい急所:
 *
 *  1. **端数処理は2回あり、それぞれに「下限」が別条で乗っている。**
 *     ①課税標準の合計 → 1,000円未満切捨て（通則法118条1項）。ただし全額が1,000円未満なら
 *       1,000円とする（登録免許税法15条）。切り捨てて0円にはしない。
 *     ②税率適用後 → 100円未満切捨て（通則法119条1項）。ただし税率を適用して計算した金額が
 *       1,000円未満なら税額は1,000円（登録免許税法19条＝定率課税の最低税額）。
 *     ★19条は「税率を適用して計算した金額」で判定する＝100円未満を切り捨てる前の額で見る。
 *
 *  2. **持分は「価額に持分割合を乗じる」（登録免許税法10条2項）。**
 *     全体の評価額をそのまま課税標準にすると、共有で相続した人に過大な税額を出す。
 *
 *  3. **少額の土地の免税（100万円以下）は「土地だけ」で、判定は1筆ごと。**（措法84条の2の2第2項）
 *     ・建物には適用がない（評価額100万円以下の古い建物でも課税される）
 *     ・申請全体の合計額ではなく不動産1個ごとに判定するので、100万円以下の土地が複数あれば全部免税
 *     ・持分の取得なら持分適用後の価額が「課税標準たる不動産の価額」（10条2項）なのでその額で判定する
 *
 *  4. **免税措置には適用期限がある（令和9年3月31日）。**（措法84条の2の2）
 *     期限を過ぎたのに免税と答えるのが最も危険な向きなので、データの status / kigen を見て
 *     期限後は免税判定そのものを行わない（beyondData を立てて申告する）。
 *
 *  5. **課税標準に使うのは固定資産税の「評価額（価格）」であって「課税標準額」ではない。**
 *     課税明細書には両方載っており、住宅用地の特例で課税標準額は評価額の1/6等に下がる。
 *     取り違えると税額を過少に出す（画面の入力欄でも明示する）。
 *
 *  6. **申請義務の期限は「相続開始の日」からではなく「知った日」から3年。**（不登法76条の2第1項）
 *     さらに施行日（令和6年4月1日）前に開始した相続は「知った日又は施行日のいずれか遅い日」から
 *     起算する（令和3年法律24号 附則5条6項）。相続開始日で数えると過去の相続を全部「期限切れ」と誤答する。
 *
 *  7. **税率0.4%が使えるのは登記の原因が「相続」のときだけ。**（別表第一 第一号（二）イ）
 *     贈与・売買など「その他の原因による移転」は1000分の20（同ハ）で5倍違う。
 *     相続人に対する遺贈は登記の原因が「相続」と異なり本コアでは扱わない（呼び出し側で案内する）。
 *
 * 日付は全て "YYYY-MM-DD" の文字列比較で扱う（new Date("YYYY-MM-DD") はUTC解釈でJSTの当日朝がずれるため）。
 *
 * 一次情報: 登録免許税法9条・10条・15条・19条・別表第一 第一号・附則7条／国税通則法118条・119条／
 *   租税特別措置法84条の2の2／不動産登記法76条の2・76条の3・164条／令和3年法律24号 附則1条・5条／
 *   国税庁 No.7191（登録免許税の税額表）・国税庁パンフレット「相続による土地の所有権の移転登記等に対する
 *   登録免許税の免税措置について」（令和8年4月）。
 */

/** 円に丸める（0未満・未入力・数値でないものは0）。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** n を unit の倍数へ切り捨てる。 */
const floorTo = (n, unit) => Math.floor(n / unit) * unit;

/** "YYYY-MM-DD" として妥当か（存在しない日付も弾く）。 */
export function isDateStr(s) {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

/** その年月の末日。 */
export function daysInMonth(y, m) {
  return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/**
 * "YYYY-MM-DD" の n年後の応当日（末日クランプ付き）を返す。
 * 民法140条（初日不算入）・143条2項により、「知った日から3年以内」の満了日は
 * 知った日の3年後の同月同日になる（応当日がない場合はその月の末日）。
 */
export function addYearsClamped(dateStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const y = +m[1] + n, mo = +m[2];
  const d = Math.min(+m[3], daysInMonth(y, mo));
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * 相続登記の申請義務の期限を求める（不登法76条の2第1項／令和3年法律24号 附則5条6項）。
 *
 * @param {string} knownDate 自己のために相続の開始があったことを知り、かつ所有権を取得したことを知った日
 * @param {object} data      toroku_menkyo_r08.json
 * @returns {{start:string, deadline:string, usedShikoBi:boolean}|null}
 */
export function calcGimuKigen(knownDate, data) {
  const g = data?.gimuka;
  if (!g || !isDateStr(knownDate) || !isDateStr(g.shiko_bi)) return null;
  // 施行日前に開始した相続は「知った日又は施行日のいずれか遅い日」から起算する（附則5条6項）。
  const usedShikoBi = knownDate < g.shiko_bi;
  const start = usedShikoBi ? g.shiko_bi : knownDate;
  const years = Number(g.kigen_years) || 3;
  return { start, deadline: addYearsClamped(start, years), usedShikoBi };
}

/**
 * 相続登記の登録免許税を計算する。
 *
 * @param {object} input
 *   @param {Array<{kind:'land'|'building', value:number, shareNum:number, shareDen:number}>} input.properties
 *          kind: 土地 'land' / 建物 'building'
 *          value: 固定資産税評価額（価格）。持分適用前の、その不動産全体の評価額
 *          shareNum/shareDen: 相続する持分（全部なら 1/1）
 *   @param {string} [input.applyDate] 登記を申請する日 "YYYY-MM-DD"（免税措置の期限判定に使う）
 * @param {object} data toroku_menkyo_r08.json
 * @returns {object}
 */
export function calcTorokuMenkyozei(input, data) {
  if (!data || !data.zeiritsu || !data.hasu || !data.kazei_hyojun) {
    throw new Error("参照データがありません");
  }
  const rate = Number(data.zeiritsu.sozoku_iten);
  const H = data.hasu;
  const M = data.menzei || {};
  const S = M.shogaku || {};
  const list = Array.isArray(input?.properties) ? input.properties : [];

  // --- 免税措置が使える期間か（措法84条の2の2）。期限後に「免税」と答えないための門 ---
  const applyDate = isDateStr(input?.applyDate) ? input.applyDate : null;
  const menzeiActive = M.status === "active" && isDateStr(M.kigen) &&
    (applyDate === null || applyDate <= M.kigen);
  // 申請日が期限より後 → 免税判定を行わない。申請日が未指定 → データの status に従う。
  const menzeiExpired = M.status === "active" && isDateStr(M.kigen) &&
    applyDate !== null && applyDate > M.kigen;

  const limit = yen(S.limit);
  const items = list.map((p, i) => {
    const kind = p?.kind === "building" ? "building" : "land";
    const full = yen(p?.value);
    const num = Number(p?.shareNum), den = Number(p?.shareDen);
    const okShare = Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0 && num <= den;
    const ratio = okShare ? num / den : 1;
    // 登録免許税法10条2項: 持分の取得は「不動産の価額に持分割合を乗じて計算した金額」。
    const share = Math.floor(full * ratio);
    // 措法84条の2の2第2項: 土地のみ・1筆ごとに100万円以下で免税。
    const exempt = menzeiActive && kind === "land" && limit > 0 && share > 0 && share <= limit;
    return {
      index: i, kind, fullValue: full, shareNum: okShare ? num : 1, shareDen: okShare ? den : 1,
      shareValue: share, exempt,
      exemptReason: exempt ? "少額の土地（100万円以下）の免税（措法84条の2の2第2項）" : "",
      invalidShare: !okShare && (p?.shareNum !== undefined || p?.shareDen !== undefined),
    };
  });

  const taxableItems = items.filter((it) => !it.exempt && it.shareValue > 0);
  const exemptItems = items.filter((it) => it.exempt);
  const sumRaw = taxableItems.reduce((a, it) => a + it.shareValue, 0);
  const hasAnyValue = items.some((it) => it.shareValue > 0);

  // --- 課税標準 ---
  // 通則法118条1項: 1,000円未満切捨て。登録免許税法15条: 全額が1,000円未満なら1,000円。
  let kazeiHyojun = 0;
  if (sumRaw > 0) {
    const floored = floorTo(sumRaw, yen(H.kazei_hyojun_kirisute) || 1000);
    kazeiHyojun = floored > 0 ? floored : (yen(H.kazei_hyojun_min) || 1000);
  }

  // --- 税額 ---
  // 通則法119条1項: 100円未満切捨て。登録免許税法19条: 税率適用後が1,000円未満なら1,000円。
  const rawTax = kazeiHyojun * rate;
  let tax = 0;
  let minApplied = false;
  if (kazeiHyojun > 0) {
    if (rawTax < (yen(H.zeigaku_min) || 1000)) {
      tax = yen(H.zeigaku_min) || 1000;
      minApplied = true;
    } else {
      tax = floorTo(rawTax, yen(H.zeigaku_kirisute) || 100);
    }
  }

  // 全部が免税 → 課税標準も税額も生じない（最低税額1,000円は課税される登記の話）。
  const allExempt = hasAnyValue && taxableItems.length === 0 && exemptItems.length > 0;

  return {
    year: data._meta?.year || "",
    rate,
    rateLabel: data.zeiritsu.sozoku_iten_hyoji || "",
    items,
    taxableCount: taxableItems.length,
    exemptCount: exemptItems.length,
    sumRaw,                 // 持分適用後の合計（端数処理前）
    kazeiHyojun,            // 課税標準（端数処理後）
    rawTax,                 // 税率適用後・切捨て前
    tax,                    // 登録免許税額
    minApplied,             // 最低税額1,000円（登録免許税法19条）が働いたか
    allExempt,
    hasAnyValue,
    menzeiActive,
    menzeiExpired,          // 申請日が免税措置の期限より後 → 免税判定を行っていない
    menzeiKigen: M.kigen_hyoji || M.kigen || "",
    exemptSaved: exemptItems.reduce((a, it) => a + it.shareValue, 0),
  };
}
