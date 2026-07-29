/**
 * 老齢年金（老齢基礎年金・付加年金・老齢厚生年金の報酬比例部分）の
 * 受給見込額を計算するコア（DOM非依存・テスト対象）。
 *
 * 数値は一切ここに書かない。満額・乗率・減額率はすべて nenkin_r08.json から
 * 引数で受け取る（年度改定でコードを触らずに済ませるため／推測で埋めないため）。
 *
 * ★★このツールが黙って誤答しやすい急所:
 *
 *  1. **免除期間の反映は「率を掛ける」だけでは足りない。号ごとに上限がある。**
 *     国民年金法27条ただし書は 1号（納付済）→2号（4分の1免除）→4号（半額免除）
 *     →6号（4分の3免除）→8号（全額免除）の順に、それぞれ
 *     「480 −（自分より前の号の“もとの”月数の合計）」を限度と定める。
 *     限度を超えた分は捨てられるのではなく、**3号・5号・7号が一段低い率で拾う**
 *     （8分の7に対して8分の3、というように、ちょうど国庫負担の2分の1を除いた率）。
 *     ただし**全額免除（8号）にだけ超過分の号が無い**＝保険料を1円も納めていないので
 *     上限を超えた全額免除月数は年金額に一切反映されない。
 *     ★上限の計算に使うのは「前の号で実際に採用された月数」ではなく
 *     「前の号のもとの月数」（条文が「保険料四分の一免除期間の月数」と書いており、
 *     限度を適用したあとの月数とは書いていない）。ここを取り違えると
 *     免除の多い人で年金額が過大に出る。
 *
 *  2. **合算した月数そのものにも480の上限がある。**（27条ただし書のかっこ書）
 *     率を掛けたあとの合計が480を超えたら480で頭打ち。免除期間が長い人では
 *     号ごとの上限と合計の上限が両方効くので、片方だけの実装は誤る。
 *
 *  3. **満額は生年月日で2つある。**（新規裁定者と既裁定者で改定率が別）
 *     昭和31年4月2日以後生まれと、それ以前とで額が違う。1つしか持たない実装は
 *     どちらかの利用者に必ず誤った額を出す。
 *
 *  4. **報酬比例部分は平成15年4月で乗率も基礎も変わる。**（平成12年改正法附則20条1項）
 *     以前は「平均標準報酬月額」×7.125/1000（賞与は反映されない）、
 *     以後は賞与を含む「平均標準報酬額」×5.481/1000。片方の乗率で通すと
 *     平成15年をまたいで働いた人の額がずれる。
 *
 *  5. **繰上げ・繰下げは付加年金にもかかる。**（施行令12条2項・4条の5第2項）
 *     付加年金だけ定額のまま据え置く実装をよく見るが、条文は法44条の額に
 *     減額率・増額率を乗じると明記している。
 *
 *  6. **繰下げの増額率には120月の上限があるが、繰上げの減額率に上限の定めは無い。**
 *     （施行令4条の5第1項のかっこ書 vs 12条1項）繰上げは60歳＝60月が事実上の最大。
 *     繰下げに上限を入れ忘れると76歳以降で青天井に増える。
 *
 *  7. **老齢厚生年金は繰上げでも繰下げでも老齢基礎年金と同時にしか請求できない。**
 *     （国民年金法附則9条の2第1項／厚年法附則7条の3）＝片方だけ繰り下げる入力は
 *     制度上ありえないので、このコアは1つの受給開始月から両方を計算する。
 *
 *  8. **端数処理は1円単位の四捨五入。**（国民年金法17条1項＝50銭未満切捨て・
 *     50銭以上切上げ）切り捨てで実装すると毎年わずかに少なく出る。
 *
 * ★扱わないもの（データの out_of_scope を参照。画面にも必ず列挙する）:
 *   加給年金額／振替加算／経過的加算／特別支給の老齢厚生年金／在職老齢年金の支給停止／
 *   平成21年3月以前の免除期間／昭和37年4月1日以前生まれの繰上げ（0.5%）／
 *   昭和27年4月1日以前生まれの繰下げ（上限70歳）／昭和16年4月1日以前生まれの加入可能年数／
 *   第3種被保険者の特例／厚生年金基金の代行部分／合算対象期間。
 *
 * 一次情報: 国民年金法27条・44条・17条・28条／厚生年金保険法43条／
 * 平成12年改正法附則20条／国民年金法施行令4条の5・12条（すべて e-Gov法令API v2 で
 * 2026-07-29に逐語確認）。満額の実額は日本年金機構の公式計算式（画像）で確認。
 */

/** 0以上の数に（未入力・負・NaN は0）。NaN を素通しすると年金額が丸ごと NaN になる。 */
const nz = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 国民年金法17条1項の端数処理＝1円単位の四捨五入。
 * （50銭未満は切捨て、50銭以上1円未満は1円に切上げ）
 */
export function roundYen(n) {
  return Math.floor(n + 0.5);
}

/**
 * 生年月日から満額（新規裁定／既裁定）を選ぶ。
 * 日付どうしは 'YYYY-MM-DD' の文字列比較で行う（new Date は UTC 解釈で JST の当日朝がずれる）。
 *
 * @returns {{yen:number, key:string, label:string}} 該当する満額
 */
export function pickMangaku(birthDate, data) {
  const list = data.kiso.mangaku_yen;
  const shinki = list.find((m) => m.key === 'shinki');
  const kisai = list.find((m) => m.key === 'kisai');
  if (typeof birthDate === 'string' && birthDate && birthDate <= kisai.born_to) {
    return { yen: kisai.yen, key: kisai.key, label: kisai.label };
  }
  return { yen: shinki.yen, key: shinki.key, label: shinki.label };
}

/**
 * 老齢基礎年金の額（繰上げ・繰下げの調整前）。国民年金法27条。
 *
 * months は {paid, menjo_1_4, menjo_half, menjo_3_4, menjo_full} の月数。
 * 号の順（納付済 → 4分の1免除 → 半額 → 4分の3 → 全額）に上限を消費していく。
 *
 * @returns {{yen:number, creditedMonths:number, capped:boolean, breakdown:Array}}
 */
export function calcKiso(months, data) {
  const limit = data.kiso.kanyu_kano_months;
  const mangaku = nz(months.mangakuYen) || 0;
  const defs = data.kiso.menjo;

  let used = 0;          // 上限の消費に使う「もとの月数」の累計（採用後の月数ではない）
  let credited = 0;      // 率を掛けたあとの合計月数
  const breakdown = [];

  for (const def of defs) {
    const raw = nz(months[def.key]);
    if (raw <= 0) {
      used += raw;
      continue;
    }
    // 27条ただし書: 各号の限度は「480 − それより前の号のもとの月数の合計」。
    const room = Math.max(0, limit - used);
    const within = Math.min(raw, room);
    const over = raw - within;

    let add = within * def.rate;
    // 3号・5号・7号: 限度を超えた分は一段低い率で拾う（8号にはこの号が無い）。
    if (over > 0 && def.excess_rate != null) add += over * def.excess_rate;

    credited += add;
    used += raw;
    breakdown.push({
      key: def.key,
      label: def.label,
      rawMonths: raw,
      withinMonths: within,
      overMonths: over,
      rate: def.rate,
      excessRate: def.excess_rate,
      creditedMonths: add,
    });
  }

  // 27条ただし書のかっこ書: 合算した月数も480を限度とする。
  const capped = credited > limit;
  if (capped) credited = limit;

  return {
    yen: roundYen((mangaku * credited) / limit),
    creditedMonths: credited,
    capped,
    breakdown,
  };
}

/** 付加年金の額（調整前）。国民年金法44条＝200円×付加保険料納付月数。 */
export function calcFuka(fukaMonths, data) {
  return roundYen(data.fuka.yen_per_month * nz(fukaMonths));
}

/**
 * 老齢厚生年金の報酬比例部分（調整前）。
 * 厚年法43条1項／平成12年改正法附則20条1項（平成15年4月で乗率と基礎が変わる）。
 *
 * @param {{preAvgYen:number, preMonths:number, postAvgYen:number, postMonths:number}} input
 */
export function calcHoshuHirei(input, data) {
  const defs = data.kosei.joritsu;
  const pre = defs.find((d) => d.key === 'pre_h15');
  const post = defs.find((d) => d.key === 'post_h15');
  const preYen = (nz(input.preAvgYen) * pre.rate_per_mille) / 1000 * nz(input.preMonths);
  const postYen = (nz(input.postAvgYen) * post.rate_per_mille) / 1000 * nz(input.postMonths);
  return {
    yen: roundYen(preYen + postYen),
    preYen: roundYen(preYen),
    postYen: roundYen(postYen),
    months: nz(input.preMonths) + nz(input.postMonths),
  };
}

/**
 * 受給開始月（65歳を0とした前後の月数）から、繰上げ減額率／繰下げ増額率を出す。
 *
 * @param {number} offsetMonths 65歳到達を0とし、繰上げは負・繰下げは正の月数
 * @returns {{kind:'kuriage'|'normal'|'kurisage', months:number, rate:number, factor:number}}
 *   rate は減額率／増額率（正の数）、factor は年金額に掛ける倍率。
 */
export function calcAdjust(offsetMonths, data) {
  const m = Math.round(Number(offsetMonths) || 0);
  if (m < 0) {
    const months = -m;
    const rate = data.kuriage.rate_per_month * months;
    return { kind: 'kuriage', months, rate, factor: 1 - rate };
  }
  if (m > 0) {
    // 施行令4条の5第1項のかっこ書: 月数が120を超えるときは120。
    const months = Math.min(m, data.kurisage.max_months);
    const rate = data.kurisage.rate_per_month * months;
    return { kind: 'kurisage', months, rate, factor: 1 + rate };
  }
  return { kind: 'normal', months: 0, rate: 0, factor: 1 };
}

/**
 * 生年月日と受給開始月から、当ツールの収録範囲外に当たるものを列挙する。
 * **黙って別の率で計算しない**（fail closed）。呼び出し側は空でなければ金額を出さない。
 *
 * @returns {Array<{key:string, label:string, why:string}>}
 */
export function checkOutOfScope(input, data) {
  const hits = [];
  const birth = typeof input.birthDate === 'string' ? input.birthDate : '';
  const adjust = calcAdjust(input.offsetMonths, data);
  const find = (key) => data.out_of_scope.find((o) => o.key === key);

  if (birth && adjust.kind === 'kuriage' && birth <= data.kuriage.keika_sochi.born_to) {
    hits.push(find('kuriage_05'));
  }
  if (birth && adjust.kind === 'kurisage' && birth <= data.kurisage.keika_sochi.born_to) {
    hits.push(find('kurisage_70'));
  }
  if (birth && birth <= '1941-04-01') {
    hits.push(find('kanyu_kano_tanshuku'));
  }
  if (nz(input.menjoPreH21Months) > 0) {
    hits.push(find('menjo_pre_h21'));
  }
  return hits.filter(Boolean);
}

/**
 * 老齢年金の受給見込額をまとめて出す。
 *
 * 繰上げ・繰下げの率は老齢基礎年金・付加年金・老齢厚生年金の**すべて**に掛ける
 * （施行令12条1項2項・4条の5第1項2項／厚年法附則7条の3・44条の3）。
 *
 * @returns {{ok:boolean, outOfScope:Array, ...}} ok=false のときは金額を出さないこと。
 */
export function calcNenkin(input, data) {
  const outOfScope = checkOutOfScope(input, data);
  if (outOfScope.length > 0) {
    return { ok: false, outOfScope };
  }

  const mangaku = pickMangaku(input.birthDate, data);
  const kiso = calcKiso({ ...input.months, mangakuYen: mangaku.yen }, data);
  const fuka = calcFuka(input.fukaMonths, data);
  const kosei = calcHoshuHirei(input.kosei || {}, data);
  const adjust = calcAdjust(input.offsetMonths, data);

  const kisoAdj = roundYen(kiso.yen * adjust.factor);
  const fukaAdj = roundYen(fuka * adjust.factor);
  const koseiAdj = roundYen(kosei.yen * adjust.factor);
  const total = kisoAdj + fukaAdj + koseiAdj;

  return {
    ok: true,
    outOfScope: [],
    mangaku,
    adjust,
    before: { kiso: kiso.yen, fuka, kosei: kosei.yen, total: kiso.yen + fuka + kosei.yen },
    kiso: kisoAdj,
    fuka: fukaAdj,
    kosei: koseiAdj,
    yearly: total,
    monthly: Math.floor(total / 12),
    detail: { kiso, kosei },
  };
}
