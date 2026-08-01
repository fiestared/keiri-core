/**
 * 再就職手当（雇用保険の就業促進手当）の計算ロジック。DOM非依存・テスト対象。
 *
 * 一次ソース（e-Gov法令API v2 の現行条文を読んで実装した。要約サイトは見ていない）:
 * - 雇用保険法56条の3第1項1号
 *     「厚生労働省令で定める安定した職業に就いた受給資格者であつて、当該職業に就いた日の
 *      前日における基本手当の支給残日数（…）が当該受給資格に基づく所定給付日数の
 *      **三分の一以上**であるもの」
 * - 雇用保険法56条の3第3項1号
 *     「第十六条の規定による基本手当の日額（その金額が…**一万二千九十円**（その額が第十八条の
 *      規定により変更されたときは、その変更された額）に**百分の五十**（受給資格に係る離職の日に
 *      おいて六十歳以上六十五歳未満である受給資格者にあつては、**百分の四十五**）を乗じて得た
 *      金額を超えるときは、当該金額。以下この条において「基本手当日額」という。）に
 *      支給残日数に相当する日数に**十分の六**（その職業に就いた日の前日における基本手当の
 *      支給残日数が当該受給資格に基づく所定給付日数の**三分の二以上**である者にあつては、
 *      **十分の七**）を乗じて得た数を乗じて得た額
 *      （同一の事業主の適用事業にその職業に就いた日から引き続いて六箇月以上雇用される者で
 *       あつて厚生労働省令で定めるものにあつては、当該額に、基本手当日額に支給残日数に
 *       相当する日数に**十分の二**を乗じて得た数を乗じて得た額を**限度として**厚生労働省令で
 *       定める額を加えて得た額）」  ← かっこ書きが就業促進定着手当
 * - 雇用保険法56条の3第2項（過去に就業促進手当を受けていると支給しない。期間は規則で3年）
 * - 厚生労働省 LL080731保01「雇用保険の基本手当（失業給付）を受給される皆さまへ」
 *   https://www.mhlw.go.jp/content/001726934.pdf
 *   「◆再就職手当・就業促進定着手当・常用就職支度手当の算定における基本手当日額の上限額」
 *     59歳以下 6,745円（変更前 6,570円）／ 60〜64歳 5,454円（変更前 5,310円）
 *
 * ★ この実装でいちばん間違えやすい事実:
 *   **再就職手当に使う「基本手当日額」には、失業保険そのものとは別の、低い上限がある。**
 *   45〜59歳の基本手当日額の上限は9,110円だが、再就職手当の計算では6,745円で頭打ちになる。
 *   この上限を無視すると、給料が高い人ほど大きく過大に見積もる（36万円ずれる例がある）。
 *
 * ★ 上限額をコードに焼かない。条文は実額を書かず「12,090円（18条で変更されたときはその額）に
 *   百分の五十」という形で書いている。その「変更された額」＝逓減帯の上端（band_taper_upper）
 *   なので、kihonteate_r07.json から導ける。**毎年8月1日の改定に自動で追随する。**
 */

/**
 * 再就職手当の計算に用いる基本手当日額の上限（法56条の3第3項1号かっこ書き）。
 * @param {number} age 離職時の年齢
 * @param {object} D kihonteate_r07.json
 */
export function saishushokuCap(age, D) {
  const senior = age >= 60 && age < 65;
  // 条文の「一万二千九十円（18条で変更されたときはその変更された額）」＝逓減帯の上端。
  // 60歳以上65歳未満は帯そのものが別（band_taper_upper_60_64）で、率も百分の四十五。
  return senior
    ? Math.floor((D.band_taper_upper_60_64 * 45) / 100)
    : Math.floor((D.band_taper_upper * 50) / 100);
}

/**
 * 支給率（法56条の3第3項1号）。**「十分の◯」の分子をそのまま整数で返す。**
 *
 * ★ 小数（0.7 / 0.6）を返してはいけない。金額の計算で 6,307×120×0.7 が 529,787.999… に
 *   なり、切り捨てで1円少ない額が出る（同型の桁落ちを記事の検算で実際に踏んでいる）。
 *   分子を整数で持ち回り、最後に /10 する。
 *
 * @returns {number} 7（3分の2以上）／ 6（3分の1以上3分の2未満）／ 0（3分の1未満＝不支給）
 */
export function supportTenths(remaining, prescribed) {
  if (!(prescribed > 0) || !(remaining > 0)) return 0;
  // ★ 分数の比較も整数で行う。remaining / prescribed >= 2/3 を割り算で書くと
  //   120日の3分の2＝80日ちょうどが 0.6666…66 < 0.6666…67 で落ちうる。
  //   「三分の二以上」＝ remaining*3 >= prescribed*2 と書けば、境目が必ず正しい側に入る。
  if (remaining * 3 < prescribed * 1) return 0; // 法56条の3第1項1号「三分の一以上」を満たさない
  if (remaining * 3 >= prescribed * 2) return 7;
  return 6;
}

/** 支給額（法56条の3第3項1号本文）。1円未満切捨。 */
export function payAmount(dailyCapped, remaining, tenths) {
  return Math.floor((dailyCapped * remaining * tenths) / 10);
}

/**
 * 就業促進定着手当の**上限**（法56条の3第3項1号かっこ書き）。
 *
 * ★ ここで出せるのは上限だけで、支給額ではない。条文は「基本手当日額 × 支給残日数 × 十分の二
 *   を**限度として**厚生労働省令で定める額」と書いており、実額は
 *   （離職前の賃金日額 − 再就職後6か月の賃金日額）× 賃金支払基礎日数 で決まる。
 *   再就職後の賃金が下がっていなければ0円。**入力が無い数字を推測で埋めない（fail closed）。**
 */
export function teichakuCap(dailyCapped, remaining) {
  return Math.floor((dailyCapped * remaining * 2) / 10);
}

/**
 * 支給要件（法56条の3第1項・第2項、施行規則82条）のうち、
 * **金額計算では表せず、本人にしか分からないもの**。画面のチェックに対応する。
 *
 * ★ すべて「満たしていること」が要件。既定を true にしない（未チェック＝不明を
 *   「満たしている」と読み替えると、出ない人に金額を見せてしまう）。
 */
export const CONDITIONS = [
  {
    key: "afterWaiting",
    label: "待期7日間が満了した後に就職・事業開始した",
    law: "施行規則82条1項2号（待期は法21条）",
  },
  {
    key: "overOneYear",
    label: "1年を超えて引き続き雇用されることが確実である（自営の場合は自立できると認められる）",
    law: "施行規則82条の2",
  },
  {
    key: "notPrevEmployer",
    label: "離職前の事業主（関連事業主を含む）に再び雇用されたものではない",
    law: "施行規則82条1項3号",
  },
  {
    key: "noRecentBenefit",
    label: "就職日前3年以内の就職について、再就職手当・常用就職支度手当を受けていない",
    law: "法56条の3第2項・施行規則82条1項4号",
  },
  {
    key: "notPreArranged",
    label: "受給資格の決定（求職申込み）より前から、採用が内定していた事業主ではない",
    law: "施行規則82条1項5号",
  },
  {
    key: "insured",
    label: "再就職先で雇用保険の被保険者になる（自営の場合はこの要件はない）",
    law: "施行規則82条1項1号",
  },
];

/**
 * 給付制限がある人だけに追加でかかる要件。
 * ★ 教育訓練で給付制限が解除された場合も外れない（厚労省リーフレットが明記）。
 *   「制限が消えたのだから紹介要件も消えた」と読むと間違える。
 */
export const RESTRICTED_CONDITION = {
  key: "introduced",
  label:
    "給付制限中の就職が、待期満了後1か月の期間内であれば、ハローワークまたは許可・届出のある" +
    "職業紹介事業者の紹介による就職である（1か月を過ぎていればこの要件はかからない）",
  law: "施行規則82条1項2号かっこ書き",
};

/**
 * 再就職手当の総合計算。
 *
 * @param {object} input
 *  - daily: 基本手当日額（円）。kihonteate_core.benefitDaily の値をそのまま渡す
 *  - age: 離職時の年齢（上限の年齢区分に使う。**60歳が境目**）
 *  - prescribed: 所定給付日数
 *  - remaining: 支給残日数（就職日の前日時点）
 *  - conditions: { [key]: boolean } CONDITIONS / RESTRICTED_CONDITION のキー
 *  - hasRestriction: 給付制限があるか（true のとき introduced を要件に加える）
 * @param {object} D kihonteate_r07.json
 */
export function calcSaishushoku(input, D) {
  const { daily, age, prescribed, remaining, conditions = {}, hasRestriction = false } = input;

  const cap = saishushokuCap(age, D);
  const capped = Math.min(daily, cap);
  const cappedApplied = daily > cap;

  const tenths = supportTenths(remaining, prescribed);

  // 満たしていない要件を集める。**1つでも欠ければ不支給**（金額を出さない）
  const required = hasRestriction ? [...CONDITIONS, RESTRICTED_CONDITION] : CONDITIONS;
  const unmet = required.filter((c) => !conditions[c.key]);

  // 「3分の1以上」を満たすために、あと何日残して就職すればよかったか
  const needForAny = Math.ceil(prescribed / 3);
  // 「3分の2以上」＝70%に届くのに必要な残日数
  const needFor70 = Math.ceil((prescribed * 2) / 3);

  const eligible = tenths > 0 && unmet.length === 0;
  const amount = eligible ? payAmount(capped, remaining, tenths) : 0;

  return {
    cap,
    daily,
    dailyUsed: capped,
    cappedApplied,
    prescribed,
    remaining,
    tenths,
    rateLabel: tenths === 7 ? "70%" : tenths === 6 ? "60%" : "—",
    eligible,
    /** 残日数が3分の1未満（法56条の3第1項1号の要件そのものを満たさない） */
    tooFewDays: tenths === 0,
    unmet,
    amount,
    needForAny,
    needFor70,
    /** 70%まであと何日残す必要があったか（既に70%なら0） */
    shortOf70: tenths === 7 ? 0 : Math.max(0, needFor70 - remaining),
    /**
     * 「あと1日早く就職していたら」の差額。3分の2の境目にできる崖を可視化する。
     * 残日数が1日増えると、率が60%→70%に変わる位置では手当が跳ねる。
     */
    teichakuCap: eligible ? teichakuCap(capped, remaining) : 0,
  };
}

/**
 * 3分の2の境目にできる「崖」。
 * 支給残日数が1日足りないだけで率が70%→60%に落ちるため、
 * **1日長く失業給付を受け取ると、基本手当1日分より大きな額を失うこと**がある。
 *
 * @returns {object|null} 崖が存在しないとき null
 */
export function cliffAt(dailyCapped, prescribed) {
  const need = Math.ceil((prescribed * 2) / 3);
  if (need < 1) return null;
  const above = payAmount(dailyCapped, need, 7);      // ちょうど3分の2 → 70%
  const below = payAmount(dailyCapped, need - 1, 6);  // 1日足りない → 60%
  const gap = above - below;
  return {
    /** 70%が確保できる最小の支給残日数 */
    threshold: need,
    above,
    below,
    /** 1日就職を遅らせたときに失う再就職手当の額 */
    gap,
    /** 差引の損（基本手当を1日分よけいに受け取れることを相殺した後） */
    netLoss: gap - dailyCapped,
  };
}
