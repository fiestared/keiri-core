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
 * 8. **70歳以上は表も計算の順序も別**（2026-08-02 第5便で実装。それまでは fail closed だった）。
 *    施行令42条3項（世帯単位＝入院を含む）と5項（外来だけを個人ごとに見る上限）の**二段階**で、
 *    ①個人ごとの外来を外来上限で頭打ち → ②その後の外来分＋入院分を世帯合算して世帯上限で頭打ち。
 *    → calcOver70()。**70歳未満の表を当てはめない**（区分ウの人なら80,100円と57,600円で22,500円ずれる）。
 *    ★**21,000円の足切りは70歳未満だけ**の規律で、70歳以上は自己負担額をすべて合算できる（協会けんぽ）。
 *    流用すると少額の受診が全部こぼれて支給額を過小に答える。
 *    ★**現役並みかどうかを標準報酬月額だけで決めない**（over70.genekinami_note）。
 *    標報28万円以上でも収入要件（520万円未満／1人世帯383万円未満）で一般扱いになる人がいる。
 *
 * 9. **食事療養・生活療養の自己負担と、保険がきかない費用（差額ベッド等）は入らない**
 *    （41条1項が明文で除いている）。窓口で払った総額をそのまま入れると支給額が過大に出る。
 *
 * 10. ★**限度額の表には「使える期間」がある**（2026-08-02 追加）。高額療養費は
 *    「療養のあった月」の表で決まるので、**診療年月で表を選ぶ**（申請日でも支給日でもない）。
 *    このコアは表を3つ持っている（data.tables）: ～令和8年7月診療分 / 令和8年8月～令和9年7月 /
 *    令和9年8月～（13区分・予定）。
 *    区分ウ・医療費100万円の月で 87,430円 と 92,940円（**5,510円**）違うので、取り違えると黙って間違える。
 *    **診療年月が無い／data.supported_through を超える場合は額を出さない**
 *    （supported:false / reason:"no_shinryo_ym" | "period"）。近い数字を出さないこと。
 *    ★**区分の境界をこの関数に書かない**（2026-08-02）。令和9年8月から所得区分が5段階→13段階に
 *    細分化され、標報の刻みが全く別の切り方になる。境界を関数に持つと、表を足したときに
 *    標報44万円の人へ 85,800＋1% と答える（正しくは 110,400＋1%）。
 *    → classify() は**表の各区分が持つ std_min／std_max の半開区間**で引く。表が増えても関数は変えない。
 *
 * 10b. ★**まだ政令で確認できていない表は「予定」と申告する**（2026-08-02）。
 *    令和9年8月からの13区分は厚労省が公表した見直し後の表で、e-Gov の施行令にはまだ無い
 *    （table.enacted === false）。額は出すが、結果に `planned:true` を立てて画面で断らせる。
 *    **黙って確定額として出さないこと**（同種の見直しが撤回・延期された前例がある）。
 *
 * 11. ★**年間上限（令和8年8月新設）は月額の限度額を下げない**（2026-08-02 追加）。
 *    年間上限は「窓口で引かれる」仕組みではなく、**1年（8月診療分〜翌年7月診療分）が終わったあとに
 *    保険者へ申請して、超えた分が償還払いされる**もの（協会けんぽの「年間の高額療養費支給申請書兼
 *    自己負担額証明書交付申請書」／標報15万円以下の区分は「令和9年8月以降に償還払い」と明記／
 *    先行する70歳以上の外来年間合算も「7月31日を基準日として…事後的に償還払い」）。
 *    → **その月の限度額の計算に年間上限を混ぜてはいけない**（混ぜると窓口で払う額を過小に答える）。
 *    → 逆に、**年間上限の存在を画面に出さないのも不足**（申請しないと戻らない金がある）。
 *    このコアは額と期間の区切りを `annual` として返すだけで、**利用者の年間累計は計算しない**
 *    （合計を数える単位が世帯か個人か、対象になる自己負担の範囲を一次情報でまだ読めていないため。
 *    kogaku_r08.json の annual.unverified）。
 */

/** "YYYY-MM" として比較可能か（診療年月。文字列比較で足りるのでTZに依存しない） */
export function isYearMonth(s) {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** 1%部分の端数処理: 50銭未満は切り捨て、50銭以上は1円に切り上げる（施行令42条1項各号かっこ書き） */
export function roundPercentPart(x) {
  return Math.floor(x + 0.5);
}

/**
 * 診療年月に適用される限度額の表を選ぶ（10）。
 * @param {string} shinryoYM "YYYY-MM"
 * @param {object} data kogaku_r08.json
 * @returns {object|null} data.tables の要素。該当が無ければ null（＝答えない）
 */
export function tableFor(shinryoYM, data) {
  if (!isYearMonth(shinryoYM)) return null;
  const hit = (data.tables || []).filter(
    (t) => (!t.applies_from || shinryoYM >= t.applies_from) &&
           (!t.applies_through || shinryoYM <= t.applies_through)
  );
  // 期間が重なる表を置いてしまったら、どちらを使うか黙って決めない
  return hit.length === 1 ? hit[0] : null;
}

/**
 * 区分を決める。
 * @param {object} p
 * @param {boolean} p.hikazei  市町村民税非課税者か（エより優先する）
 * @param {number|null} p.standardMonthly 療養のあった月の標準報酬月額（円）
 * @param {object} table tableFor() が返した表（data ではない）
 * @returns {{key,label,item,criteria,base,threshold,rate,tasukai}|null}
 */
export function classify({ hikazei, standardMonthly }, table) {
  const kubun = table.kubun || [];
  // 非課税の区分は標準報酬月額にかかわらず優先する（施行令42条1項4号「次号に掲げる者を除く」）。
  // ★この行は std_min/std_max を持たないので、下の区間検索からは必ず外す（外さないと全員に当たる）。
  const hikazeiRow = kubun.find((x) => x.hikazei === true) || null;
  if (hikazei) return hikazeiRow;
  if (!(standardMonthly > 0)) return null;   // 分からないものを黙って真ん中の区分に落とさない

  // 10. 境界は表の側（std_min 以上・std_max 未満の半開区間）。関数に境界を書かない。
  const hit = kubun.filter(
    (x) => x.hikazei !== true &&
           (x.std_min == null || standardMonthly >= x.std_min) &&
           (x.std_max == null || standardMonthly < x.std_max)
  );
  // 区間が重なる／どこにも当たらない表を置いてしまったら、どれを使うか黙って決めない
  return hit.length === 1 ? hit[0] : null;
}

/**
 * その区分の年間上限（11）。**月額の限度額には影響しない**（償還払い）。
 * @param {string} kubunKey
 * @param {number|null} standardMonthly 区分エの軽減判定（標報15万円以下→41万円）に使う
 * @param {string} shinryoYM 年間上限は令和8年8月診療分から。それ以前は null を返す
 * @param {object} data kogaku_r08.json
 */
export function annualCapFor(kubunKey, standardMonthly, shinryoYM, data) {
  const a = data.annual;
  if (!a || !isYearMonth(shinryoYM) || shinryoYM < a.applies_from) return null;
  const row = (a.caps || []).find((c) => c.key === kubunKey);
  if (!row) return null;
  const reduced = row.reduced_cap != null && standardMonthly != null &&
                  standardMonthly <= row.reduced_if_std_max;
  return {
    cap: reduced ? row.reduced_cap : row.cap,
    reduced,
    reducedNote: reduced ? row.reduced_note : null,
    // その年の区切り（8月診療分〜翌年7月診療分）。診療年月がどの期間に入るかで決まる
    period: annualPeriodOf(shinryoYM, a.period_start_month),
    settlement: a.settlement,
    settlementNote: a.settlement_note,
    periodNote: a.period_note,
  };
}

/** 年間上限の1年（8月〜翌7月）のうち、その診療年月が属する期間を返す */
export function annualPeriodOf(shinryoYM, startMonth) {
  const y = Number(shinryoYM.slice(0, 4));
  const m = Number(shinryoYM.slice(5, 7));
  const from = m >= startMonth ? y : y - 1;
  const pad = (n) => String(n).padStart(2, "0");
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  return { from: `${from}-${pad(startMonth)}`, through: `${from + 1}-${pad(endMonth)}` };
}

/**
 * 区分と「合算対象になった療養の医療費合計（10割）」から、その月の自己負担限度額を出す。
 * @param {object} kubun classify() の戻り
 * @param {number} totalMedical 合算対象の医療費（10割）の合計
 * @param {boolean} tasukai 多数回該当か（直近12か月で4回目以降）
 */
export function limitFor(kubun, totalMedical, tasukai) {
  // ★tasukai が null の区分がある（70歳以上の低所得者Ⅰなど。施行令42条3項6号にただし書が無い）。
  //   そこで多数回該当を選ばれても限度額は下がらない。null を返して NaN を撒かないこと。
  if (tasukai && kubun.tasukai != null) return kubun.tasukai;
  if (!kubun.threshold) return kubun.base;          // 区分エ・オは定額（1%部分が無い）
  // ★条文の「その額が◯円に満たないときは、◯円」＝ excess は負にならない
  const excess = Math.max(0, totalMedical - kubun.threshold);
  return kubun.base + roundPercentPart(excess * kubun.rate);
}

/* ============================ 70歳以上（施行令42条3項・5項） ============================ */

/** 診療年月に適用される70歳以上の表を選ぶ。該当が無ければ null（＝答えない） */
export function tableFor70(shinryoYM, data) {
  if (!isYearMonth(shinryoYM)) return null;
  const t70 = (data.over70 && data.over70.tables) || [];
  const hit = t70.filter(
    (t) => (!t.applies_from || shinryoYM >= t.applies_from) &&
           (!t.applies_through || shinryoYM <= t.applies_through)
  );
  return hit.length === 1 ? hit[0] : null;
}

/**
 * 70歳以上の区分を決める。
 * ★現役並みかどうかは**標準報酬月額だけでは決まらない**（over70.genekinami_note）。
 *   標報28万円以上でも収入要件（520万円未満・1人世帯383万円未満）で一般扱いになる人がいるので、
 *   incomeKind を画面から受け取る。標報から自動で現役並みに落とさない。
 * @param {"genekinami"|"ippan"|"teishotoku2"|"teishotoku1"} incomeKind
 * @param {number|null} standardMonthly 現役並みのときだけ使う（3区分の切り分け）
 */
export function classify70({ incomeKind, standardMonthly }, table) {
  const by = (k) => (table.kubun || []).find((x) => x.key === k) || null;
  if (incomeKind === "teishotoku1") return by("teishotoku1");
  if (incomeKind === "teishotoku2") return by("teishotoku2");
  if (incomeKind === "ippan") return by("ippan");
  if (incomeKind === "genekinami") {
    if (!(standardMonthly > 0)) return null;        // 分からないものを黙ってどれかに落とさない
    if (standardMonthly >= 830000) return by("genekinami3");
    if (standardMonthly >= 530000) return by("genekinami2");
    return by("genekinami1");
  }
  return null;
}

/** 70歳以上の年間上限（世帯・外来）。**その月の限度額には影響しない**（償還払い） */
export function annualCapFor70(kubun, standardMonthly, shinryoYM, data) {
  const hasHousehold = kubun.household_annual != null;
  const hasGairai = kubun.gairai_annual != null;
  if (!hasHousehold && !hasGairai) return null;
  const reduced = kubun.household_annual_reduced != null && standardMonthly != null &&
                  standardMonthly <= kubun.household_annual_reduced_if_std_max;
  return {
    household: hasHousehold ? (reduced ? kubun.household_annual_reduced : kubun.household_annual) : null,
    householdReduced: reduced,
    householdReducedNote: reduced ? kubun.household_annual_reduced_note : null,
    gairai: hasGairai ? kubun.gairai_annual : null,
    period: annualPeriodOf(shinryoYM, 8),           // 施行令41条の2「毎年八月一日から翌年七月三十一日までの期間」
    settlement: "retrospective",
    settlementNote: (data.over70 && data.over70.annual_note) || null,
  };
}

/**
 * 高額療養費（70歳以上）を計算する。**二段階**（over70.structure_note）:
 *   ① 外来（通院）だけを**個人ごと**に見て、その人の外来自己負担を外来上限で頭打ちにする（5項）
 *   ② ①の後の外来分と入院分を**世帯で合算**し、世帯上限で頭打ちにする（3項）
 * 現役並み所得者には外来特例が無い（gairai=null）ので①を飛ばす。
 * ★70歳未満と違い、**21,000円の足切りは無い**（自己負担額をすべて合算できる）。
 */
function calcOver70(input, data) {
  const { shinryoYM, incomeKind = null, standardMonthly = null, tasukai = false, items = [] } = input;

  const table = tableFor70(shinryoYM, data);
  if (!table) {
    return {
      supported: false,
      reason: "no_table70",
      shinryoYM,
      message:
        `${shinryoYM} の診療分に適用される70歳以上の自己負担限度額の表を、この計算機は持っていません。` +
        "近い期間の表で代用することはせず、計算を止めています。",
    };
  }

  const kubun = classify70({ incomeKind, standardMonthly }, table);
  if (!kubun) {
    return {
      supported: true,
      determined: false,
      reason: incomeKind === "genekinami" ? "no_standard_monthly" : "no_income_kind",
      message:
        incomeKind === "genekinami"
          ? "現役並み所得者の限度額は3つに分かれます（標準報酬月額 83万円以上／53万〜79万円／28万〜50万円）。" +
            "療養のあった月の標準報酬月額を入力してください。"
          : "70歳以上の区分（現役並み所得者／一般／低所得者Ⅱ／低所得者Ⅰ）を選んでください。" +
            "区分によって限度額が 15,700円から 270,300円＋1％まで大きく変わるため、推測では計算しません。",
    };
  }

  // 行を作る。★70歳以上は足切りが無いので、全ての行が合算対象になる
  const rows = items
    .filter((it) => Number(it.medical) > 0)
    .map((it) => {
      const medical = Math.round(Number(it.medical));
      const ratio = Number(it.ratio);
      const self = Math.round(medical * ratio);
      const kind = it.kind === "nyuin" ? "nyuin" : "gairai";   // 既定は外来
      const person = it.person || "本人";
      return { label: it.label || "", person, kind, medical, ratio, self };
    });

  const totalSelf = rows.reduce((s, r) => s + r.self, 0);
  const totalMedical = rows.reduce((s, r) => s + r.medical, 0);

  // ① 外来（個人ごと）の頭打ち。現役並みは外来特例が無いので飛ばす
  const gairaiLimit = kubun.gairai;
  const persons = [];
  let gairaiRefund = 0;
  if (gairaiLimit != null) {
    const names = [];
    rows.forEach((r) => { if (r.kind === "gairai" && !names.includes(r.person)) names.push(r.person); });
    names.forEach((name) => {
      const mine = rows.filter((r) => r.kind === "gairai" && r.person === name);
      const before = mine.reduce((s, r) => s + r.self, 0);
      const after = Math.min(before, gairaiLimit);
      gairaiRefund += before - after;
      persons.push({ person: name, gairaiSelf: before, gairaiCapped: after, refund: before - after, capped: before > after });
    });
  }

  // ② 世帯合算（①の後の外来分＋入院分）
  const nyuinSelf = rows.filter((r) => r.kind === "nyuin").reduce((s, r) => s + r.self, 0);
  const gairaiSelfRaw = rows.filter((r) => r.kind === "gairai").reduce((s, r) => s + r.self, 0);
  const gairaiSelfCapped = gairaiLimit != null ? gairaiSelfRaw - gairaiRefund : gairaiSelfRaw;
  const householdBase = gairaiSelfCapped + nyuinSelf;

  // 多数回該当が無い区分がある（低所得者Ⅰ等）。黙って据え置かず、申告する
  const tasukaiAvailable = kubun.tasukai != null;
  const tasukaiApplied = tasukai && tasukaiAvailable;
  const limit = limitFor(kubun, totalMedical, tasukaiApplied);
  const householdRefund = Math.max(0, householdBase - limit);

  const annual = annualCapFor70(kubun, standardMonthly, shinryoYM, data);

  return {
    supported: true,
    determined: true,
    ageGroup: "over70",
    // 10b. enacted === false の表（＝公表されただけで政令で確認できていない）は planned を立てる。
    //      画面はこれを見て「予定」と断る。false でない限り立てない（未記載の表は従来どおり確定扱い）。
    planned: table.enacted === false,
    table: { id: table.id, label: table.label, appliesFrom: table.applies_from, appliesThrough: table.applies_through, enacted: table.enacted !== false },
    kubun,
    annual,
    rows,
    persons,
    gairaiLimit,
    gairaiSelfRaw,
    gairaiSelfCapped,
    gairaiRefund,
    nyuinSelf,
    householdBase,
    totalMedical,
    totalSelf,
    limit,
    householdRefund,
    refund: gairaiRefund + householdRefund,
    tasukai,
    tasukaiAvailable,
    tasukaiApplied,
    limitNormal: limitFor(kubun, totalMedical, false),
    limitIfTasukai: kubun.tasukai,
    // 手元に残る負担＝世帯上限で頭打ちにした後の額
    finalBurden: Math.min(householdBase, limit),
  };
}

/**
 * 高額療養費（70歳未満）を計算する。
 *
 * @param {object} input
 * @param {"under70"|"over70"} input.ageGroup
 * @param {string} input.shinryoYM               ★療養のあった年月 "YYYY-MM"（必須。表の期間判定に使う）
 * @param {boolean} input.hikazei                市町村民税非課税者か
 * @param {number|null} input.standardMonthly    標準報酬月額（円）
 * @param {boolean} input.tasukai                多数回該当か
 * @param {Array<{label?:string, medical:number, ratio:number}>} input.items
 *        ひとつの病院等・ひとり・ひと月ごとの行。medical=10割の医療費、ratio=窓口負担割合(0.3等)
 * @param {object} data kogaku_r08.json
 */
export function calcKogaku(input, data) {
  const { ageGroup, hikazei = false, standardMonthly = null, tasukai = false, items = [], shinryoYM = null } = input;

  // 10. 診療年月が無い／表の期間を超えている場合は額を出さない（fail closed）。
  //     ★診療年月を省略したときに「とりあえず手元の表で計算」してはいけない。
  //     それは利用者が8月の入院を入れたときに黙って旧額を返す経路そのもの。
  if (!isYearMonth(shinryoYM)) {
    return {
      supported: false,
      reason: "no_shinryo_ym",
      message:
        "自己負担限度額は「療養のあった月」の表で決まるため、診療年月（YYYY-MM）が要ります。" +
        "診療を受けた年月を指定してください。",
    };
  }
  if (data.supported_through && shinryoYM > data.supported_through) {
    const [sy, sm] = data.supported_through.split("-");
    return {
      supported: false,
      reason: "period",
      shinryoYM,
      supportedThrough: data.supported_through,
      message:
        `この計算機が持っている自己負担限度額の表は${sy}年${Number(sm)}月診療分までです。` +
        "それより後の限度額は、まだ公表された表で確かめられていません。" +
        "近い期間の表で代用した数字をお出しすることはせず、計算を止めています。" +
        "加入先の健康保険（協会けんぽの「高額療養費について」など）でご確認ください。",
    };
  }

  // 8. 70歳以上は表も計算の順序も別（施行令42条3項・5項）。専用の関数へ渡す。
  if (ageGroup === "over70") return calcOver70(input, data);

  // 10. 診療年月に適用される表を選ぶ。選べなければ答えない（黙ってどちらかを使わない）
  const table = tableFor(shinryoYM, data);
  if (!table) {
    return {
      supported: false,
      reason: "no_table",
      shinryoYM,
      message:
        `${shinryoYM} の診療分に適用される自己負担限度額の表を、この計算機は持っていません。` +
        "限度額は「療養のあった月」の表で決まるため、近い期間の表で代用することはせず、計算を止めています。",
    };
  }

  const kubun = classify({ hikazei, standardMonthly }, table);
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

  // 11. 年間上限は**この月の限度額に影響しない**（償還払い）。額と期間を添えるだけ。
  const annual = annualCapFor(kubun.key, standardMonthly, shinryoYM, data);

  return {
    supported: true,
    determined: true,
    // 10b. enacted === false の表（＝公表されただけで政令で確認できていない）は planned を立てる。
    //      画面はこれを見て「予定」と断る。false でない限り立てない（未記載の表は従来どおり確定扱い）。
    planned: table.enacted === false,
    table: { id: table.id, label: table.label, appliesFrom: table.applies_from, appliesThrough: table.applies_through, enacted: table.enacted !== false },
    annual,
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
