/**
 * 失業保険（雇用保険の基本手当）の計算ロジック。DOM非依存・テスト対象。
 *
 * 一次ソース（すべて条文・公表資料の原文を読んで実装した）:
 * - 雇用保険法（e-Gov法令API v2・現行）
 *   13条 受給資格 / 14条 被保険者期間 / 16条 基本手当の日額 / 17条 賃金日額 /
 *   18条 自動変更 / 20条 受給期間 / 21条 待期 / 22条・23条 所定給付日数 / 33条 給付制限 /
 *   附則4条 特定理由離職者（契約更新なし）の暫定措置
 * - 雇用保険法施行規則28条の3（法16条1項の「厚生労働省令で定める率」＝給付率の式）
 * - 厚生労働省「基本手当日額の計算式及び金額（令和7年8月1日～）」
 *
 * ★ この実装でいちばん大事な事実:
 *   **雇用保険法16条・17条に書かれている金額は、どれ一つとして今日の実額ではない。**
 *   条文の額（4,920円・12,090円・上限13,370〜16,340円など）は平成27年度を基準にした原型で、
 *   18条の「自動変更対象額」として毎年8月1日に改定される。だから金額はコードに焼かず、
 *   kihonteate_r07.json（現に適用されている額）から渡す。**毎年8月1日に差し替えが要る。**
 *
 * ★ 年齢の区切りが2種類ある（取り違えると黙って間違える）:
 *   - 賃金日額の上限（17条4項）は 30 / 45 / 60 で切れる
 *   - 所定給付日数（23条）は     30 / 35 / 45 / 60 で切れる（**35歳の境目は日数にしかない**）
 */

/** 離職理由。所定給付日数・給付制限・受給資格の要件がこれで変わる */
export const REASONS = {
  /** 正当な理由がない自己都合（33条の給付制限あり・22条1項の日数） */
  jiko: "自己都合（正当な理由なし）",
  /** 特定受給資格者（倒産・解雇など。23条2項） */
  kaisha: "会社都合（倒産・解雇など）",
  /** 特定理由離職者①（契約期間満了・更新なし）。附則4条で日数は特定受給資格者と同じ */
  keiyaku: "契約期間満了・更新なし",
  /** 特定理由離職者②（病気・介護・配偶者の転勤などやむを得ない自己都合）。給付制限なし・日数は22条1項 */
  seito: "正当な理由のある自己都合",
  /** 定年退職。給付制限なしだが特定理由離職者ではない（受給資格は12か月要る） */
  teinen: "定年退職",
};

/** 23条2項の特定受給資格者、および附則4条でそれとみなされる者（＝所定給付日数が手厚い側） */
const TOKUTEI = new Set(["kaisha", "keiyaku"]);
/** 13条2項で受給資格が「1年間に被保険者期間6か月」に緩和される者（特定受給資格者＋特定理由離職者） */
const RELAXED = new Set(["kaisha", "keiyaku", "seito"]);

/** 算定基礎期間（22条3項）の区分 */
export const PERIODS = ["under1", "y1_5", "y5_10", "y10_20", "y20"];

/** 22条1項: 一般の受給資格者の所定給付日数（年齢に関係なく3段階しかない） */
const DAYS_IPPAN = { under1: 90, y1_5: 90, y5_10: 90, y10_20: 120, y20: 150 };

/**
 * 23条1項: 特定受給資格者の所定給付日数（年齢 × 算定基礎期間）。
 * 23条1項の柱書は「算定基礎期間が1年（30歳未満は5年）以上のものに限る」と自分を絞っているので、
 * そこから外れる人は22条1項に戻って90日になる（表の左下が90日で埋まっているのはこのため）。
 */
const DAYS_TOKUTEI = {
  under30: { under1: 90, y1_5: 90, y5_10: 120, y10_20: 180, y20: 180 },
  age30_34: { under1: 90, y1_5: 120, y5_10: 180, y10_20: 210, y20: 240 },
  age35_44: { under1: 90, y1_5: 150, y5_10: 180, y10_20: 240, y20: 270 },
  age45_59: { under1: 90, y1_5: 180, y5_10: 240, y10_20: 270, y20: 330 },
  age60_64: { under1: 90, y1_5: 150, y5_10: 180, y10_20: 210, y20: 240 },
};

/** 賃金日額の上限（17条4項2号）の年齢区分。**日数の区分とは切れ目が違う** */
export function wageAgeBand(age) {
  if (age < 30) return "under30";
  if (age < 45) return "age30_44";
  if (age < 60) return "age45_59";
  return "age60_64";
}

/** 所定給付日数（23条1項）の年齢区分。**35歳の境目はこちらにしかない** */
export function daysAgeBand(age) {
  if (age < 30) return "under30";
  if (age < 35) return "age30_34";
  if (age < 45) return "age35_44";
  if (age < 60) return "age45_59";
  return "age60_64";
}

/**
 * 17条1項: 賃金日額 ＝ 離職前6か月に支払われた賃金の総額 ÷ 180。
 * 賞与（3か月を超える期間ごとに支払われる賃金）は総額に含めない。
 */
export function wageDaily(total6m) {
  return total6m / 180;
}

/**
 * 17条4項: 賃金日額に上限・下限を当てる。上限は年齢で変わり、下限は全年齢共通。
 * @returns {{value:number, capped:null|"min"|"max", rawValue:number, cap:number}}
 */
export function applyWageCaps(w, age, D) {
  const max = D.chingin_nichigaku_max[wageAgeBand(age)];
  const min = D.chingin_nichigaku_min;
  if (w < min) return { value: min, capped: "min", rawValue: w, cap: min };
  if (w > max) return { value: max, capped: "max", rawValue: w, cap: max };
  return { value: w, capped: null, rawValue: w, cap: max };
}

/**
 * 給付率（法16条＋規則28条の3）。**率は50〜80%（60〜64歳は45〜80%）**。
 *
 * 規則28条の3第1項: 率 ＝ 80% − 30% × (w − A) / (B − A)   … A=80%帯の上端, B=逓減帯の上端
 * 同2項（60〜64歳）: 「30%」を「35%」に、Bを 60〜64歳用のB' に読み替えたうえで、
 *   **かっこ書きで「基本手当日額が 5%×w + 40%×B' を超えるならその額を上限とする」**と定める。
 *   → 60〜64歳だけ計算式が2本あるのはこのため。厚労省の公表式が「いずれか低い方の額」と
 *     書いているのは、この読み替えのかっこ書きをそのまま式にしたもの。
 */
export function benefitAmountRaw(w, age, D) {
  const senior = age >= 60 && age < 65;
  const A = D.band80_upper;
  const B = senior ? D.band_taper_upper_60_64 : D.band_taper_upper;
  const K = senior ? 0.35 : 0.30;
  const base = senior ? 0.45 : 0.50;

  if (w < A) return 0.8 * w;
  if (w <= B) {
    const taper = 0.8 * w - K * ((w - A) / (B - A)) * w;
    if (senior) return Math.min(taper, 0.05 * w + 0.40 * B); // 規則28条の3第2項のかっこ書き
    return taper;
  }
  return base * w;
}

/** 給付率（表示用）。**金額の計算に使ってはいけない**（下の benefitDaily を参照） */
export function benefitRate(w, age, D) {
  return benefitAmountRaw(w, age, D) / w;
}

/**
 * 基本手当の日額（16条）。端数は1円未満切捨（厚労省の計算式PDFの注2）。
 *
 * ★ 金額は **率に割り戻さず、式から直接** 求める。
 *   率（= 金額 ÷ w）を経由して w を掛け直すと、浮動小数点で 5,160円が 5,159.999… になり、
 *   切り捨てで **1円少ない額**が出る（実際に60〜64歳・賃金日額8,800円で外部オラクルが捕まえた）。
 *   さらに、数学的にちょうど整数になる額（13,140円 → 6,570円 など）が 6,569.999… と表現される
 *   可能性に備えて、切り捨ての前に微小量を足す。**1円未満を切り捨てる制度に、桁落ちで負ける道理はない。**
 */
export function benefitDaily(w, age, D) {
  return Math.floor(benefitAmountRaw(w, age, D) + 1e-9);
}

/**
 * 所定給付日数（22条・23条・附則4条）。
 * 就職困難者（22条2項）は離職理由に関係なくこちらが優先される（23条は22条2項の受給資格者を除く）。
 */
export function prescribedDays(age, period, reason, konnan) {
  if (konnan) {
    if (period === "under1") return 150;
    return age < 45 ? 300 : 360;
  }
  if (TOKUTEI.has(reason)) return DAYS_TOKUTEI[daysAgeBand(age)][period];
  return DAYS_IPPAN[period];
}

/**
 * 受給期間（20条1項）＝離職日の翌日から1年。所定給付日数が長い2つの類型だけ延びる。
 * - 22条2項1号（就職困難・45歳以上65歳未満＝360日）… 1年＋60日
 * - 23条1項2号イ（特定受給資格者・45〜59歳・20年以上＝330日）… 1年＋30日
 */
export function receivePeriodDays(age, period, reason, konnan) {
  if (konnan && age >= 45 && age < 65 && period !== "under1") return 365 + 60;
  if (TOKUTEI.has(reason) && age >= 45 && age < 60 && period === "y20") return 365 + 30;
  return 365;
}

/**
 * 給付制限（33条）。
 * ★ 法律が定めているのは「待期の満了後、**1か月以上3か月以内**で公共職業安定所長の定める期間」という
 *   幅だけで、「2か月」も「1か月」も条文には書かれていない（33条2項の「厚生労働大臣の定める基準」で決まる）。
 *   令和7年4月1日から原則1か月になったのは**通達の改正**であって、法改正ではない
 *   （厚労省・雇用保険部会資料「令和6年雇用保険制度改正（令和7年4月1日施行分）について」）。
 *   5年間で3回以上の自己都合離職は3か月。
 * ★ 法律のほうで変わったのは「教育訓練を受けた場合は給付制限をかけない」という但し書き（33条1項2号・3号）。
 */
export function restrictionMonths(reason, repeated, training) {
  if (reason !== "jiko") return 0;
  if (training) return 0; // 33条1項ただし書2号・3号
  return repeated ? 3 : 1;
}

/** 13条: 受給資格。自己都合・定年は「離職前2年に被保険者期間12か月」、それ以外は「1年に6か月」 */
export function eligibility(period, reason) {
  const relaxed = RELAXED.has(reason);
  if (period === "under1" && !relaxed) {
    return {
      ok: false,
      reason:
        "自己都合・定年での離職は「離職日以前2年間に被保険者期間が通算12か月以上」が必要です（雇用保険法13条1項）。" +
        "働いた期間が1年未満なら被保険者期間は12か月に届かないため、原則として基本手当は受け取れません。",
    };
  }
  if (period === "under1" && relaxed) {
    return {
      ok: true,
      note:
        "会社都合・契約更新なし・正当な理由のある自己都合の場合は「離職日以前1年間に被保険者期間が通算6か月以上」で受給できます（13条2項）。" +
        "6か月に満たない場合は受給できません。",
    };
  }
  return { ok: true, note: null };
}

/**
 * 失業保険（基本手当）の総合計算。
 * @param {object} input
 *  - age: 離職時の年齢
 *  - total6m: 離職前6か月の賃金総額（円）。省略時は monthly×6
 *  - monthly: 毎月の賃金（総支給・平均）
 *  - period: 算定基礎期間（PERIODS）
 *  - reason: 離職理由（REASONS のキー）
 *  - konnan: 就職が困難な方（22条2項）
 *  - repeated: 5年間で3回以上の自己都合離職
 *  - training: 教育訓練を受けた／受ける（給付制限の解除）
 * @param {object} D kihonteate_r07.json
 */
export function calcKihonteate(input, D) {
  const { age, period, reason, konnan = false, repeated = false, training = false } = input;

  if (!(age >= 15) || age >= 65) {
    return {
      supported: false,
      message:
        "65歳以上で離職した方は、基本手当ではなく「高年齢求職者給付金」（一時金）の対象です（雇用保険法37条の4）。この計算機の対象外です。",
    };
  }

  const total6m = input.total6m > 0 ? input.total6m : (input.monthly || 0) * 6;
  const elig = eligibility(period, reason);

  const raw = wageDaily(total6m);
  const capped = applyWageCaps(raw, age, D);
  const w = capped.value;
  const rate = benefitRate(w, age, D);
  const daily = benefitDaily(w, age, D);

  const days = prescribedDays(age, period, reason, konnan);
  const restriction = restrictionMonths(reason, repeated, training);
  const periodDays = receivePeriodDays(age, period, reason, konnan);

  return {
    supported: true,
    eligible: elig.ok,
    eligibilityMessage: elig.ok ? elig.note : elig.reason,
    total6m,
    wageDailyRaw: raw,
    wageDaily: w,
    capped: capped.capped,
    cap: capped.cap,
    rate,
    daily,
    days,
    total: elig.ok ? daily * days : 0,
    waitDays: 7, // 21条
    restrictionMonths: restriction,
    receivePeriodDays: periodDays,
    /** 待期7日 ＋ 給付制限（あれば）。実際の初回振込はさらに認定日の分だけ後になる */
    startDelayNote:
      restriction > 0
        ? `待期7日（21条）のあと、さらに給付制限${restriction}か月（33条）が明けてからの分が支給対象になります。`
        : "待期7日（21条）が明けた日から支給対象になります（給付制限はありません）。",
  };
}
