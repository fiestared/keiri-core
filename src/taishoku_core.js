/**
 * 退職金の税金（退職所得）の計算ロジック。DOM非依存・テスト対象。
 *
 * 一次ソース（すべて条文・公表資料の原文を読んで実装した）:
 * - 所得税法（e-Gov法令API v2・令和8年4月1日施行版）
 *   30条1項 退職所得 / 30条2項 1/2課税・短期退職手当等の頭打ち / 30条3項 退職所得控除額 /
 *   30条4項 短期退職手当等の定義 / 30条5項 特定役員退職手当等の定義 /
 *   30条6項 控除額の最低80万円・障害退職の+100万円 / 89条1項 税率の表 / 201条 徴収税額
 * - 所得税法施行令69条2項（勤続年数に1年未満の端数があれば1年に切り上げる）
 * - 地方税法 50条の4（道府県民税4%）・328条の3（市町村民税6%）・20条の4の2（端数計算）
 * - 国税庁 No.1420 / No.2732（20.42%・計算例）
 *
 * ★ この実装でいちばん大事な事実（ここを取り違えると黙って間違える）:
 *
 * 1. **勤続年数は1年未満を切り上げる**（所令69条2項）。「年数×40万円」の年数がこれ。
 *    だから20年ちょうどの翌日に辞めると勤続21年になり、控除が70万円増える。
 *
 * 2. **1/2にするのは「収入−控除」であって、税額ではない**。
 *    そして 1/2 が効かない人が2種類いる（30条2項）:
 *      - 特定役員退職手当等（役員等勤続年数5年以下）… 1/2 が丸ごと無い
 *      - 短期退職手当等（役員等以外で勤続5年以下）… 300万円を超える部分にだけ 1/2 が無い
 *
 * 3. **端数の落とし方が3か所とも違う**:
 *      - 課税退職所得金額 … 1,000円未満切捨（所法201条1項1号イ）
 *      - 所得税＋復興特別所得税 … 1円未満切捨（国税庁 No.2732 の計算例）
 *      - 住民税 … 市町村民税6%・道府県民税4%を **別々に** 計算して、**それぞれ**100円未満切捨
 *        （地税20条の4の2第3項。合計してから切り捨てるのではない）
 *
 * 4. **税率表（89条）は超過累進**。速算表の「控除額」（427,500円 など）は、この超過累進を
 *    1回の掛け算に畳んだだけの近道にすぎない。ここでは区分ごとに積み上げて計算する
 *    （速算表の控除額をハードコードすると、税率が変わったときに黙って間違える）。
 *
 * 5. **金額は整数で計算する**。0.021 や 0.2042 を浮動小数で掛けると 1円ずれる（実際に踏んだ）。
 *    ×1.021 は ×1021/1000、×20.42% は ×2042/10000 と整数比で書く。
 */

/** 勤続年数（所令69条2項）。1年未満の端数は切り上げる。0年は1年として扱う（最低80万円の控除が付く） */
export function kinzokuNensu(years, months) {
  const y = Math.max(0, Math.floor(Number(years) || 0));
  const m = Math.max(0, Math.floor(Number(months) || 0));
  const n = m > 0 ? y + 1 : y; // 1年未満の端数（か月）があれば1年に切り上げ
  return Math.max(1, n);
}

/**
 * 退職所得控除額（所法30条3項・6項）。
 * 20年以下 = 40万円 × 年数 ／ 20年超 = 800万円 + 70万円 × (年数 - 20)
 * 80万円に満たなければ80万円。障害退職ならそのうえで +100万円。
 */
export function taishokuKojo(nensu, disabled, D) {
  let k = nensu <= 20
    ? D.kinzoku_20ika_per_year * nensu
    : D.kinzoku_20cho_base + D.kinzoku_20cho_per_year * (nensu - 20);
  if (k < D.kojo_min) k = D.kojo_min; // 30条6項2号
  if (disabled) k += D.shogai_add;    // 30条6項3号（80万円の下限を当てた「後」に加算する）
  return k;
}

/** 退職手当等の区分（30条4項・5項） */
export const KINDS = {
  ippan: "一般退職手当等",
  tanki: "短期退職手当等（勤続5年以下）",
  yakuin: "特定役員退職手当等（役員等として5年以下）",
};

/** 区分の判定。役員等勤続年数が5年以下なら特定役員、そうでなく勤続5年以下なら短期 */
export function kindOf(nensu, isOfficer) {
  if (isOfficer && nensu <= 5) return "yakuin";
  if (nensu <= 5) return "tanki";
  return "ippan";
}

/**
 * 課税退職所得金額（1,000円未満切捨の“前”の額）。所法30条2項。
 * - 一般 … (収入 − 控除) × 1/2
 * - 特定役員 … 収入 − 控除（1/2しない）
 * - 短期 … 残額300万円以下なら ×1/2、超えるなら 150万円 + {収入 −（300万円 + 控除）}
 */
export function taxableRaw(amount, kojo, kind, D) {
  const rem = amount - kojo;
  if (rem <= 0) return 0;
  if (kind === "yakuin") return rem;
  if (kind === "tanki") {
    if (rem <= D.tanki_half_limit) return rem / 2;
    return D.tanki_half_of_limit + (amount - (D.tanki_half_limit + kojo));
  }
  return rem / 2;
}

/** 1,000円未満切捨（所法201条1項1号イ） */
export const floor1000 = (n) => Math.floor(n / 1000) * 1000;
/** 100円未満切捨（地税20条の4の2第3項） */
export const floor100 = (n) => Math.floor(n / 100) * 100;

/**
 * 所得税額（復興特別所得税を含まない）。所法89条1項の表を超過累進で積み上げる。
 * 速算表の控除額は使わない（表そのものから計算する）。
 */
export function shotokuzei(taxable, D) {
  let tax = 0;
  let lower = 0;
  for (const b of D.brackets) {
    const upper = b.upto === null ? Infinity : b.upto;
    if (taxable <= lower) break;
    const slice = Math.min(taxable, upper) - lower;
    // 整数のまま計算する（課税退職所得金額は1,000円単位・税率は整数%なので割り切れる）
    tax += (slice * b.rate_pct) / 100;
    lower = upper;
  }
  return tax;
}

/** 所得税＋復興特別所得税（1円未満切捨）。×1.021 を整数比で書く（浮動小数だと1円ずれる） */
export function shotokuzeiWithFukko(shotoku, D) {
  const num = 1000 + Math.round(D.fukko_pct * 10); // 2.1% → 1021/1000
  return Math.floor((shotoku * num) / 1000);
}

/**
 * 退職金の税額を計算する。
 * input: { amount, years, months, isOfficer, disabled, filed }
 *   filed = 「退職所得の受給に関する申告書」を提出しているか（未提出なら一律20.42%・所法201条3項）
 */
export function calcTaishoku(input, D) {
  const amount = Math.max(0, Math.floor(Number(input.amount) || 0));
  const nensu = kinzokuNensu(input.years, input.months);
  const disabled = !!input.disabled;
  const filed = input.filed !== false;

  const kojo = taishokuKojo(nensu, disabled, D);
  const kind = kindOf(nensu, !!input.isOfficer);

  const raw = taxableRaw(amount, kojo, kind, D);
  const taxable = floor1000(Math.max(0, raw)); // 課税退職所得金額

  // 住民税は「受給に関する申告書」の提出とは関係なく、退職金の支払時に分離課税で特別徴収される
  // （地税50条の2・328条）。市町村民税と道府県民税を別々に計算し、それぞれ100円未満を切り捨てる。
  const shichoson = floor100((taxable * D.juminzei_shichoson_pct) / 100);
  const dofuken = floor100((taxable * D.juminzei_dofuken_pct) / 100);
  const juminzei = shichoson + dofuken;

  let shotoku, incomeTax;
  if (filed) {
    shotoku = shotokuzei(taxable, D);
    incomeTax = shotokuzeiWithFukko(shotoku, D);
  } else {
    // 申告書を出していない場合は、控除も1/2も使わずに支給額そのものへ20.42%（所法201条3項）
    const num = Math.round(D.mishinkoku_pct * 100); // 20.42% → 2042/10000
    shotoku = null;
    incomeTax = Math.floor((amount * num) / 10000);
  }

  const total = incomeTax + juminzei;
  return {
    amount, nensu, kojo, kind, kindLabel: KINDS[kind], filed, disabled,
    taxable, shotoku, incomeTax, shichoson, dofuken, juminzei,
    total, tedori: amount - total,
    /** 控除だけで退職金を吸収しきって、税金が1円もかからない状態か */
    taxFree: taxable === 0 && filed,
    /** 1/2課税が効いていない（＝重く課税されている）区分か */
    halfApplied: kind === "ippan" || (kind === "tanki" && amount - kojo <= D.tanki_half_limit),
  };
}

/**
 * 「あと1か月長く勤めたら」の差額。勤続年数が1年未満切上げなので、
 * 20年0か月と20年1か月では控除が70万円変わる（＝この計算機のいちばんの見どころ）。
 */
export function oneMonthLater(input, D) {
  const now = calcTaishoku(input, D);
  const later = calcTaishoku({ ...input, months: (Number(input.months) || 0) + 1 }, D);
  return { now, later, saved: now.total - later.total, kojoUp: later.kojo - now.kojo };
}
