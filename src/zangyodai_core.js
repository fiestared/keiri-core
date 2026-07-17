/**
 * 残業代（割増賃金）の計算ロジック。DOM非依存・テスト対象。
 *
 * 一次ソース（すべて条文の原文を読んで実装した）:
 * - 労働基準法37条（e-Gov法令API v2）
 *     1項     時間外・休日の割増賃金は「政令で定める率以上」
 *     1項ただし書  1か月60時間を超えた時間外労働は「五割以上」
 *     4項     深夜（午後10時〜午前5時）の労働は「二割五分以上」
 *     5項     割増賃金の基礎となる賃金に家族手当・通勤手当その他省令で定める賃金は算入しない
 * - 平成6年政令第5号（労基法37条1項の率の最低限度）… 時間外＝二割五分／休日＝三割五分
 * - 労働基準法施行規則
 *     19条1項4号  月給の1時間単価は「1年間における1月平均所定労働時間数」で除す
 *     20条1項     時間外が深夜に及ぶとき「五割以上」（60時間超なら「七割五分以上」）
 *     20条2項     休日労働が深夜に及ぶとき「六割以上」
 *     21条        除外できる賃金（別居手当・子女教育手当・住宅手当・臨時の賃金・1か月超ごとの賃金）
 *
 * ★ この実装でいちばん大事な事実（ここを取り違えると黙って間違える）:
 *
 * 1. **法・政令・規則が「割増賃金」と呼ぶのは“上乗せ分”だけ**であって、支払総額ではない。
 *    時間外労働1時間の支払額が単価の125%になるのは、上乗せ25%（37条1項）に加えて、
 *    その1時間の労働そのものの対価100%が別に発生するから。
 *    **所定労働時間内の深夜労働は、対価100%が月給に既に含まれているので上乗せ25%しか払わない**
 *    （ここを125%で計算すると、月給制の人の深夜手当を5倍に見積もる）。
 *
 * 2. **深夜の上乗せ25%は、時間外の段（25%か50%か）と独立に足し合わせる**。
 *    だから「60時間を超えた分のうち、何時間が深夜だったか」を知らなくても正しく計算できる。
 *    この読み方が正しいことは**労基則20条が直接書いている**:
 *      時間外×深夜  = 50%  = 25 + 25
 *      60時間超×深夜 = 75%  = 50 + 25
 *      休日×深夜    = 60%  = 35 + 25
 *    → `combinedPremiumPct()` がこの3つを再現することをテストで固定している（外部オラクル）。
 *
 * 3. **★60時間の数え方に、法定休日の労働は入らない**（37条1項ただし書が数えるのは
 *    「当該延長して労働させた時間」＝時間外労働であって、休日労働は「延長」ではない）。
 *    一方、**法定外休日（会社が決めた休み）の労働は、法定労働時間を超える限り時間外労働なので入る**。
 *
 * 4. **単価は「その月の所定労働時間」で割らない**（労基則19条1項4号は「1年間における1月平均」）。
 *    その月で割ると、営業日の少ない月ほど単価が上がり、月ごとに残業代が変わってしまう。
 *
 * 5. **基礎から除ける手当は7つの限定列挙だけ**（37条5項＋規則21条）。役職手当・資格手当・
 *    皆勤手当などは、どんな名前でも基礎に算入する。しかも列挙された手当でも**名前ではなく実態**で
 *    判断する（扶養家族の数に関係なく全員へ一律で払う“家族手当”は家族手当ではないので算入する）。
 *
 * 6. **金額は整数の分数で計算する**（浮動小数の1円落ちはこのプロジェクトで既に2回踏んでいる）。
 *    すべての層が同じ分母を共有するので、割り算は各層の丸めの瞬間だけにする。
 *
 * 7. **端数処理は「区分ごと」に行い、その合計を総額にする**（昭和63.3.14 基発150号）。
 *    通達が円未満の端数処理を認めるのは「時間外・休日・深夜の**各々の**割増賃金の総額」であって、
 *    全部を足した1つの数ではない。実装上も、こうしないと**画面の内訳が合計と1円合わない**
 *    （利用者は必ず縦に足し算して確かめるので、そこで嘘をつく）。
 */

/** 時間（小数可）を分（整数）にする。0.5時間 → 30分 */
export function toMinutes(hours) {
  const h = Number(hours);
  if (!isFinite(h) || h <= 0) return 0;
  return Math.round(h * 60);
}

/**
 * 1年間における1月平均所定労働時間数（労基則19条1項4号）。
 * （365日 − 年間所定休日日数）× 1日の所定労働時間 ÷ 12
 * うるう年でも365で計算するのが実務（労働時間の設定は年間カレンダーで決まる）。
 */
export function monthlyScheduledHours(annualHolidays, dailyHours, D) {
  const days = D.monthly_hours.days_in_year - Number(annualHolidays);
  return (days * Number(dailyHours)) / 12;
}

/**
 * 労基則20条が直接書いている「重なったときの割増率」を、上乗せ分の足し算で再現する。
 * テストがこの関数を規則20条の値（50 / 75 / 60）と照合する＝外部オラクル。
 */
export function combinedPremiumPct(kind, isNight, D) {
  const p = D.premium_pct;
  let pct = 0;
  if (kind === "overtime") pct = p.overtime.value;
  else if (kind === "overtime_over60") pct = p.overtime_over60.value;
  else if (kind === "holiday") pct = p.holiday.value;
  else if (kind === "night_only") return p.night.value;
  else throw new Error("unknown kind: " + kind);
  if (isNight) pct += p.night.value;
  return pct;
}

/**
 * 残業代の計算。
 *
 * input:
 *   base            … 割増賃金の基礎となる賃金（月額・除外手当を抜いたあと）
 *   annualHolidays  … 年間所定休日日数
 *   dailyHours      … 1日の所定労働時間
 *   overtimeHours   … 時間外労働の合計（法定外休日の労働も含む。深夜だった分もここに含めて数える）
 *   holidayHours    … 法定休日に労働した時間
 *   nightHours      … 深夜（22時〜5時）に労働した時間の合計（所定内・時間外・休日を問わない）
 *   fixedAmount     … 固定残業代（みなし残業手当）の月額。無ければ0
 */
export function calcZangyodai(input, D) {
  const base = Math.max(0, Math.floor(Number(input.base) || 0));
  const dailyMin = toMinutes(input.dailyHours);
  const workDays = D.monthly_hours.days_in_year - Number(input.annualHolidays);

  // 単価が定義できない（所定労働時間が0）なら答えない
  if (!(dailyMin > 0) || !(workDays > 0) || !(base > 0)) return null;

  const otMin = toMinutes(input.overtimeHours);
  const holMin = toMinutes(input.holidayHours);
  const nightMin = toMinutes(input.nightHours);

  // 60時間の線を引く。★休日労働は数えない（37条1項ただし書）
  const thresholdMin = D.over60_threshold_hours.value * 60;
  const otNormalMin = Math.min(otMin, thresholdMin);
  const otOver60Min = Math.max(0, otMin - thresholdMin);

  const p = D.premium_pct;

  // すべての層が共有する分母（labor則19条1項4号の単価を約分せずに持ち回る）
  //   単価 = base ÷ ((365-休日)×1日所定 ÷ 12) = base × 12 × 60 ÷ ((365-休日) × dailyMin)
  //   金額 = 単価 × (分 ÷ 60) × pct ÷ 100
  //        = base × 12 × 分 × pct ÷ ((365-休日) × dailyMin × 100)
  const den = workDays * dailyMin * 100;
  const K = base * 12;

  // 各層の「支払う率」。時間外・休日は労働そのものの対価100%が別に発生する（上記★1）。
  // 深夜は上乗せ25%だけ（対価は月給か、上の時間外・休日の層に既に入っている）。
  const layers = [
    { key: "overtime", min: otNormalMin, pct: 100 + p.overtime.value },
    { key: "overtime_over60", min: otOver60Min, pct: 100 + p.overtime_over60.value },
    { key: "holiday", min: holMin, pct: 100 + p.holiday.value },
    { key: "night", min: nightMin, pct: p.night.value },
  ];

  // ★端数処理は「区分ごと」に行い、その合計を総額にする（昭和63.3.14 基発150号）。
  //   通達が円未満の端数処理を認めるのは「1か月における時間外労働・休日労働・深夜労働の
  //   **各々の**割増賃金の総額」であって、全部を足した1つの数ではない。
  //   実装上も、こうしないと**画面の内訳が合計と1円合わない**（利用者は必ず縦に足し算して確かめる）。
  let total = 0;
  const breakdown = {};
  for (const l of layers) {
    const amount = roundYen(K * l.min * l.pct, den);
    total += amount;
    breakdown[l.key] = { hours: l.min / 60, pct: l.pct, amount };
  }
  const fixed = Math.max(0, Math.floor(Number(input.fixedAmount) || 0));
  const shortfall = Math.max(0, total - fixed);

  // ★「60時間超を25%のままで払われていたら、いくら足りないか」。
  //   率が上がったことに気づかないまま25%で計算されるのが、この制度でいちばん多い取りこぼし。
  //   150%で払うべきところを125%で払えば、差は上乗せ25%分＝支払額の1/6（1/3ではない）。
  //   ページ側で割り算をすると単体テストが1行も届かないので、ここで整数演算のまま求める。
  const over60Extra = roundYen(
    K * otOver60Min * (p.overtime_over60.value - p.overtime.value), den);

  return {
    base,
    hourlyRate: (base * 12 * 60) / (workDays * dailyMin), // 単価（丸めない値。表示側で丸める）
    monthlyHours: (workDays * dailyMin) / (12 * 60),
    over60Extra,
    overtimeHours: otMin / 60,
    over60Hours: otOver60Min / 60,
    holidayHours: holMin / 60,
    nightHours: nightMin / 60,
    breakdown,
    total,
    fixed,
    shortfall,
    /** 固定残業代が実際の残業代に足りていない（差額の支払いが要る）か */
    fixedIsShort: fixed > 0 && shortfall > 0,
    /** 60時間を超えて50%が発生しているか */
    hasOver60: otOver60Min > 0,
  };
}

/**
 * 1円未満の端数は50銭未満切捨・50銭以上切上げ（昭和63.3.14 基発150号が認める処理）。
 * 整数の分数のまま四捨五入する（浮動小数に落とさない）。
 */
export function roundYen(num, den) {
  return Math.floor((2 * num + den) / (2 * den));
}
