/**
 * 遺族年金（遺族基礎年金・遺族厚生年金・中高齢寡婦加算）の純ロジック。DOM非依存。
 *
 * 条文の正本は assets/izoku_r08.json の _meta.source（e-Gov法令API v2 で逐語確認済み）。
 * ここには「条文をどう読んだか」だけを書く。額は全てデータ側に持たせる（年度が動くのはデータ）。
 *
 * ★この計算で間違えやすい5点（どれも実際の受給額が変わる）:
 *
 *  1. **300月みなしは短期要件のときだけ。** 厚年法60条1項1号ただし書は「第五十八条第一項
 *     第一号から第三号までのいずれかに該当することにより支給される遺族厚生年金については」と
 *     主語を絞っている。長期要件（58条1項4号）に300月みなしを効かせると、加入期間の短い人の
 *     額を**過大に**出す。
 *
 *  2. **子の加算は「2人まで」が高い額で、3人目から下がる。** 国年法39条1項は本文で全員を
 *     74,900円×改定率とし、かっこ書で「そのうち二人までについては」224,700円×改定率に
 *     読み替える構造。全員を高い額で足すと3人目以降で過大になる。
 *
 *  3. **遺族基礎年金は「18歳年度末までの子」がいないと出ない。** 子がいない配偶者は
 *     遺族厚生年金だけになる。ここを混ぜると子のない妻の額が倍近くずれる。
 *
 *  4. **中高齢寡婦加算は、遺族基礎年金を受け取れるあいだは支給停止**（厚年法65条）。
 *     子がいるあいだ両方を足すと過大になる。子が18歳年度末を過ぎてから65歳までの加算。
 *
 *  5. **端数処理が2種類ある。** 遺族基礎年金・子の加算・中高齢寡婦加算は**100円単位**
 *     （50円未満切捨て・50円以上100円未満切上げ＝国年法38条/39条・厚年法62条）。
 *     報酬比例から出す遺族厚生年金は**1円単位**の四捨五入（国年法17条1項）。
 *     どちらか一方で通すと公表額と合わなくなる。
 */

/** 0以上の数に（未入力・負・NaN は0）。NaN を素通しすると年金額が丸ごと NaN になる。 */
const nz = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 0以上の整数に（人数・月数用）。 */
const nzInt = (n) => Math.floor(nz(n));

/**
 * 1円単位の四捨五入（国民年金法17条1項／厚生年金保険法35条）。
 * 50銭未満は切捨て、50銭以上1円未満は1円に切上げ。
 */
export function roundYen(n) {
  return Math.floor(n + 0.5);
}

/**
 * 100円単位の丸め（国民年金法38条・39条1項、厚生年金保険法62条1項）。
 * 「50円未満の端数は切捨て、50円以上100円未満の端数は100円に切上げ」。
 */
export function round100(n) {
  const v = Number(n) || 0;
  const rem = v % 100;
  return rem < 50 ? Math.round(v - rem) : Math.round(v - rem + 100);
}

/**
 * 遺族基礎年金の額（国民年金法38条・39条1項）。
 *
 * ★子が0人なら0を返す（配偶者に遺族基礎年金は支給されない）。
 * ★加算は「2人まで」が高い額、3人目以降が低い額。
 *
 * @param {number} koCount 18歳年度末までの子（または20歳未満で障害1級2級の子）の人数
 * @returns {{yen:number, baseYen:number, kasanYen:number, eligible:boolean,
 *            breakdown:Array<{label:string, count:number, unitYen:number, yen:number}>}}
 */
export function calcKiso(koCount, data) {
  const n = nzInt(koCount);
  const breakdown = [];
  if (n <= 0) {
    return { yen: 0, baseYen: 0, kasanYen: 0, eligible: false, breakdown };
  }
  const base = data.kiso.yen;
  breakdown.push({ label: '基本額', count: 1, unitYen: base, yen: base });

  const defs = data.kiso.kasan;
  const first = defs.find((d) => d.key === 'ko_1_2');
  const rest = defs.find((d) => d.key === 'ko_3plus');

  const firstCount = Math.min(n, first.max_count);
  const restCount = Math.max(0, n - first.max_count);

  let kasan = 0;
  if (firstCount > 0) {
    const yen = first.yen * firstCount;
    kasan += yen;
    breakdown.push({ label: first.label, count: firstCount, unitYen: first.yen, yen });
  }
  if (restCount > 0) {
    const yen = rest.yen * restCount;
    kasan += yen;
    breakdown.push({ label: rest.label, count: restCount, unitYen: rest.yen, yen });
  }
  return { yen: base + kasan, baseYen: base, kasanYen: kasan, eligible: true, breakdown };
}

/**
 * 遺族厚生年金の額（厚生年金保険法60条1項1号）＝報酬比例部分 × 3/4。
 *
 * 報酬比例部分は厚年法43条1項／平成12年改正法附則20条1項（平成15年4月で乗率と基礎が変わる）
 * ＝ nenkin_core.calcHoshuHirei と同じ式。**二重実装を避けるため、月数あたりの単価に
 * 割り戻してから300月みなしを当てる**（みなしは「被保険者期間の月数を300とする」ものなので、
 * 額に定数を掛けるのではなく、月数を置き換えて計算し直すのが条文どおり）。
 *
 * @param {{preAvgYen:number, preMonths:number, postAvgYen:number, postMonths:number,
 *          yokenKey:'tanki'|'choki'}} input
 * @returns {{yen:number, hoshuHireiYen:number, months:number, countedMonths:number,
 *            minimumApplied:boolean}}
 */
export function calcKosei(input, data) {
  const yoken = data.kosei.yoken.find((y) => y.key === input.yokenKey)
    || data.kosei.yoken.find((y) => y.key === 'choki');

  const preMonths = nzInt(input.preMonths);
  const postMonths = nzInt(input.postMonths);
  const months = preMonths + postMonths;

  // 平成15年3月以前／4月以後で乗率も基礎も違う（nenkin_r08.json と同じ 7.125／5.481）。
  const PRE_PER_MILLE = 7.125;
  const POST_PER_MILLE = 5.481;
  const rawYen =
    (nz(input.preAvgYen) * PRE_PER_MILLE / 1000) * preMonths
    + (nz(input.postAvgYen) * POST_PER_MILLE / 1000) * postMonths;

  // 60条1項1号ただし書: 短期要件で300月に満たないときは300月として計算する。
  const minimum = yoken.minimum_months;
  const minimumApplied = minimum != null && months > 0 && months < minimum;
  const countedMonths = minimumApplied ? minimum : months;
  // 月数を置き換えて計算し直す＝実質「1月あたりの額 × 300月」。
  const scaledYen = months > 0 ? rawYen * (countedMonths / months) : 0;

  const hoshuHireiYen = roundYen(scaledYen);
  return {
    yen: roundYen(scaledYen * data.kosei.ritsu),
    hoshuHireiYen,
    months,
    countedMonths,
    minimumApplied,
  };
}

/**
 * 65歳以降、自分の老齢厚生年金の受給権がある配偶者の遺族厚生年金（厚年法60条1項2号）。
 * ①1号の額 と ②（1号の額×2/3 ＋ 自分の老齢厚生年金×1/2）の**いずれか多い額**。
 *
 * ★同項ただし書により、遺族基礎年金の支給を受けるときは①1号の額になる。
 * ★②で決まっても自分の老齢厚生年金は全額出るので、遺族厚生年金として上乗せされるのは
 *   （選ばれた額 − 自分の老齢厚生年金）。マイナスにはならない。
 *
 * @returns {{yen:number, chosenKey:'go1'|'go2', go1Yen:number, go2Yen:number,
 *            uwanoseYen:number, applied:boolean}}
 */
export function calcHeikyu65(go1Yen, ownRoureiYen, receivesKiso, data) {
  const go1 = nz(go1Yen);
  const own = nz(ownRoureiYen);
  const cfg = data.kosei.heikyu_65;

  if (own <= 0 || receivesKiso) {
    // 60条1項2号は「老齢厚生年金の受給権を有する配偶者」が対象。
    // 遺族基礎年金を受けるときは同項ただし書で1号の額。
    return {
      yen: go1,
      chosenKey: 'go1',
      go1Yen: go1,
      go2Yen: 0,
      uwanoseYen: Math.max(0, go1 - own),
      applied: false,
    };
  }
  const go2 = roundYen(go1 * cfg.ratio_izoku + own * cfg.ratio_rourei);
  const chosen = go2 > go1 ? go2 : go1;
  return {
    yen: chosen,
    chosenKey: go2 > go1 ? 'go2' : 'go1',
    go1Yen: go1,
    go2Yen: go2,
    uwanoseYen: Math.max(0, chosen - own),
    applied: true,
  };
}

/**
 * 中高齢寡婦加算（厚生年金保険法62条1項）が付くかを判定する。
 *
 * ★4つの門を全部通らないと付かない。どれか1つでも落ちたら理由を返す（黙って0にしない）。
 *   ①妻であること ②40歳以上65歳未満 ③遺族基礎年金を受けていない（厚年法65条で支給停止）
 *   ④長期要件なら被保険者期間240月以上（62条1項かっこ書）
 *
 * @returns {{yen:number, eligible:boolean, reasonKey:string|null, reason:string|null}}
 */
export function calcChukoreikafu(input, data) {
  const cfg = data.chukoreikafu;
  const age = nz(input.age);
  const no = (reasonKey, reason) => ({ yen: 0, eligible: false, reasonKey, reason });

  if (input.isWife !== true) {
    return no('not_wife', '中高齢寡婦加算は「妻」に加算されるものです（厚年法62条1項）。');
  }
  if (age < cfg.age_from || age >= cfg.age_to) {
    return no(
      'age',
      `加算されるのは${cfg.age_from}歳以上${cfg.age_to}歳未満のあいだです（厚年法62条1項）。`
    );
  }
  if (input.receivesKiso === true) {
    return no(
      'kiso',
      '遺族基礎年金を受け取っているあいだは支給停止です（厚年法65条）。'
        + '子が18歳年度末を過ぎて遺族基礎年金が終わったあと、65歳になるまで加算されます。'
    );
  }
  if (input.yokenKey === 'choki' && nzInt(input.months) < cfg.choki_minimum_months) {
    return no(
      'choki_months',
      `長期要件のときは、厚生年金の被保険者期間が${cfg.choki_minimum_months}月（20年）以上で`
        + 'ないと加算されません（厚年法62条1項かっこ書）。'
    );
  }
  return { yen: cfg.yen, eligible: true, reasonKey: null, reason: null };
}

/**
 * 遺族年金の合計を出す。画面はこの1つの結果だけから描くこと
 * （見出しと表を別々に計算すると food と表示が食い違う）。
 *
 * @param {{koCount:number, isWife:boolean, age:number, yokenKey:'tanki'|'choki',
 *          preAvgYen:number, preMonths:number, postAvgYen:number, postMonths:number,
 *          ownRoureiYen:number}} input
 */
export function calcIzoku(input, data) {
  const kiso = calcKiso(input.koCount, data);
  const kosei = calcKosei(input, data);

  const age = nz(input.age);
  const is65plus = age >= 65;
  const heikyu = calcHeikyu65(kosei.yen, is65plus ? input.ownRoureiYen : 0, kiso.eligible, data);

  const chukorei = calcChukoreikafu(
    {
      isWife: input.isWife,
      age: input.age,
      receivesKiso: kiso.eligible,
      yokenKey: input.yokenKey,
      months: kosei.months,
    },
    data
  );

  const koseiYen = heikyu.yen;
  const totalYen = kiso.yen + koseiYen + chukorei.yen;

  return {
    kiso,
    kosei,
    heikyu,
    chukorei,
    koseiYen,
    totalYen,
    monthlyYen: Math.floor(totalYen / 12),
    is65plus,
  };
}
