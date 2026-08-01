/**
 * 高額療養費（70歳未満）の自己負担限度額と支給額の計算。DOM非依存・テスト対象。
 *
 * 一次ソース（e-Gov法令API v2 の生条文を読んで実装した。要約サイトは見ていない）:
 * - 健康保険法施行令 第42条第1項1号〜5号（高額療養費算定基準額と多数回該当）
 * - 健康保険法施行令 第41条第1項第1号 かっこ書き（世帯合算は21,000円以上に限る）
 * - 施行中の版: 215IO0000000243_20260801_508CO0000000219（令和8年8月1日 施行）
 *
 * ★ ここを取り違えると黙って間違える、という事実:
 *
 * 1. **区分を決めるのは年収ではなく「療養のあった月の標準報酬月額」**（42条1項2号〜4号）。
 *    条文に「年収」も「報酬月額」も出てこない。標準報酬月額は等級表の階段なので、
 *    報酬月額が1円増えて等級が1つ上がるだけで区分が変わる（報酬月額514,999円＝区分ウ /
 *    515,000円＝区分イ。医療費100万円の月の限度額が87,430円と171,820円で84,390円違う）。
 *    → 報酬月額から区分を出すときは shaho_core.js の kenkoGrade() を使う（等級表を二重実装しない）。
 *
 * 2. **1%の起点額には「下限としての読替え」がある**（42条1項各号のかっこ書き）。
 *    条文は「その額が二十六万七千円に満たないときは、二十六万七千円」と書いている。
 *    素直に (医療費 − 267,000) × 1% と実装すると、**医療費が267,000円未満の月に
 *    1%部分がマイナスになり、限度額が80,100円より低く出る**（利用者に有利な向きの嘘だが嘘は嘘で、
 *    「限度額を超えたのに支給されない」という逆の結論を生む）。→ excess は 0 でクランプする。
 *
 * 3. **1%部分の端数は四捨五入**。「五十銭未満であるときは、これを切り捨て、五十銭以上であるときは、
 *    これを一円に切り上げた額」＝ Math.floor(x + 0.5)。単純な切り捨てだと1円ずつ安く出る。
 *    ★丸めるのは**1%部分だけ**で、基準額を足した後ではない（条文が1%部分のかっこ書きで丸めている）。
 *
 * 4. **世帯合算は21,000円未満を1円も拾わない**（41条1項1号かっこ書き）。
 *    「21,000円を超えた部分だけを合算する」ではない。**21,000円未満の自己負担はまるごと対象外**。
 *    家族3人が別々の病院で20,000円ずつ払っても、合算される額は0円。
 *    この21,000円は「ひとつの病院等ごと・ひとりごと・ひと月ごと」に見る。
 *
 * 5. **1%を掛ける「医療費」は、合算対象になった療養の10割の費用の合計**
 *    （42条1項各号が「第四十一条第一項第一号及び第二号に掲げる額を合算した額に係る療養につき…
 *    算定した当該療養に要した費用の額」と書いている）。
 *    → **世帯合算で行が増えると、限度額そのものも上がる**。自己負担だけを足して医療費を
 *    据え置くと、支給額が過大に出る。**合算対象から外れた行は、医療費の側にも入れない。**
 *
 * 6. **区分オ（市町村民税非課税）は区分エより優先する**。4号が「次号に掲げる者を除く」と
 *    書いているため。標準報酬月額が28万円未満かつ非課税なら、35,400円（エの57,600円ではない）。
 *
 * 7. **区分ウは「ア・イ・エ・オ以外」という catch-all**（1項1号）。
 *    標準報酬月額が分からない人を黙ってウに落とさないこと（このコアは区分を必ず明示的に決める）。
 *
 * 8. **70歳以上はこのコアの対象外**。施行令42条3項（世帯単位）と5項（外来だけの個人単位）で
 *    表が全く別で、外来には年間上限もある。→ supported:false を返して**額を出さない**（fail closed）。
 *    「70歳未満の表で近い数字を出す」ことは絶対にしない（区分ウの人なら80,100円と57,600円で
 *    22,500円ずれる。しかも70歳以上の一般区分には外来だけの18,000円という別の上限がある）。
 *
 * 9. **食事療養・生活療養の自己負担と、保険がきかない費用（差額ベッド等）は入らない**
 *    （41条1項が明文で除いている）。窓口で払った総額をそのまま入れると支給額が過大に出る。
 */

/** 1%部分の端数処理: 50銭未満は切り捨て、50銭以上は1円に切り上げる（施行令42条1項各号かっこ書き） */
export function roundPercentPart(x) {
  return Math.floor(x + 0.5);
}

/**
 * 区分を決める。
 * @param {object} p
 * @param {boolean} p.hikazei  市町村民税非課税者か（エより優先する）
 * @param {number|null} p.standardMonthly 療養のあった月の標準報酬月額（円）
 * @param {object} data kogaku_r08.json
 * @returns {{key,label,item,criteria,base,threshold,rate,tasukai}|null}
 */
export function classify({ hikazei, standardMonthly }, data) {
  const by = (k) => data.kubun.find((x) => x.key === k) || null;
  if (hikazei) return by("o");
  if (!(standardMonthly > 0)) return null;   // 分からないものを黙ってウに落とさない
  if (standardMonthly >= 830000) return by("a");
  if (standardMonthly >= 530000) return by("i");
  if (standardMonthly >= 280000) return by("u");
  return by("e");
}

/**
 * 区分と「合算対象になった療養の医療費合計（10割）」から、その月の自己負担限度額を出す。
 * @param {object} kubun classify() の戻り
 * @param {number} totalMedical 合算対象の医療費（10割）の合計
 * @param {boolean} tasukai 多数回該当か（直近12か月で4回目以降）
 */
export function limitFor(kubun, totalMedical, tasukai) {
  if (tasukai) return kubun.tasukai;
  if (!kubun.threshold) return kubun.base;          // 区分エ・オは定額（1%部分が無い）
  // ★条文の「その額が◯円に満たないときは、◯円」＝ excess は負にならない
  const excess = Math.max(0, totalMedical - kubun.threshold);
  return kubun.base + roundPercentPart(excess * kubun.rate);
}

/**
 * 高額療養費（70歳未満）を計算する。
 *
 * @param {object} input
 * @param {"under70"|"over70"} input.ageGroup
 * @param {boolean} input.hikazei                市町村民税非課税者か
 * @param {number|null} input.standardMonthly    標準報酬月額（円）
 * @param {boolean} input.tasukai                多数回該当か
 * @param {Array<{label?:string, medical:number, ratio:number}>} input.items
 *        ひとつの病院等・ひとり・ひと月ごとの行。medical=10割の医療費、ratio=窓口負担割合(0.3等)
 * @param {object} data kogaku_r08.json
 */
export function calcKogaku(input, data) {
  const { ageGroup, hikazei = false, standardMonthly = null, tasukai = false, items = [] } = input;

  // 8. 70歳以上は表が別。額を出さない（fail closed）
  if (ageGroup === "over70") {
    return {
      supported: false,
      reason: "over70",
      message:
        "70歳以上の方は自己負担限度額の表が別です（健康保険法施行令42条3項・5項）。" +
        "世帯単位の限度額に加えて、外来だけを個人ごとに見る上限と、その年間の上限があり、" +
        "70歳未満の表を当てはめると誤った額になります。このツールはまだ70歳以上に対応していないため、" +
        "額を出していません。加入先の健康保険にご確認ください。",
    };
  }

  const kubun = classify({ hikazei, standardMonthly }, data);
  if (!kubun) {
    return {
      supported: true,
      determined: false,
      reason: "no_standard_monthly",
      message:
        "区分を決めるには「療養のあった月の標準報酬月額」が要ります（施行令42条1項）。" +
        "標準報酬月額を入力するか、市町村民税非課税にチェックしてください。",
    };
  }

  const min = data.gassan_min;
  const rows = items
    .filter((it) => Number(it.medical) > 0)
    .map((it) => {
      const medical = Math.round(Number(it.medical));
      const ratio = Number(it.ratio);
      const self = Math.round(medical * ratio);       // 窓口で払う自己負担（10円未満の端数処理は保険者側の処理なので四捨五入で近似）
      return { label: it.label || "", medical, ratio, self, counted: self >= min };
    });

  const counted = rows.filter((r) => r.counted);
  const excluded = rows.filter((r) => !r.counted);

  // 5. 合算対象から外れた行は、医療費の側にも入れない
  const totalMedical = counted.reduce((s, r) => s + r.medical, 0);
  const totalSelf = counted.reduce((s, r) => s + r.self, 0);
  const excludedSelf = excluded.reduce((s, r) => s + r.self, 0);

  const limit = limitFor(kubun, totalMedical, tasukai);
  const refund = Math.max(0, totalSelf - limit);

  // 多数回該当になったら（＝次に4回目を迎えたら）いくらになるか
  const limitIfTasukai = kubun.tasukai;
  const limitNormal = limitFor(kubun, totalMedical, false);

  return {
    supported: true,
    determined: true,
    kubun,
    rows,
    counted,
    excluded,
    gassanMin: min,
    totalMedical,
    totalSelf,
    excludedSelf,
    limit,
    refund,
    tasukai,
    limitNormal,
    limitIfTasukai,
    // 実際に自分の手元に残る負担（合算対象外の自己負担は戻ってこない）
    finalBurden: Math.min(totalSelf, limit) + excludedSelf,
  };
}
