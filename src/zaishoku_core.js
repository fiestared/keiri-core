/**
 * 在職老齢年金（厚生年金保険法46条）による支給停止額の純ロジック。DOM非依存。
 *
 * 条文の正本は assets/zaishoku_r08.json の _meta.source（e-Gov法令API v2 で逐語確認済み）。
 * 額（支給停止調整額）は全てデータ側に持たせる。**毎年度動くのはデータで、式ではない。**
 *
 * ★この計算で間違えやすい6点（どれも受け取る額が変わる）:
 *
 *  1. **令和8年4月から基準額が51万円→65万円に上がった。** 令和7年年金制度改正法
 *     （令和7年法律第74号）による。ネット上の解説の多くは51万円（またはさらに古い47万円・
 *     50万円）のままで、**同じ収入でも停止額が過大に出る**。基準額はデータに持たせ、
 *     どの年度の額で計算したかを必ず画面に出すこと。
 *
 *  2. **条文の「六十二万円」をそのまま使ってはいけない。** 46条3項の本則は62万円だが、
 *     同項ただし書が毎年度の改定を定めており、令和8年度の実額は**65万円**。
 *     条文の数字だけを見ると3万円低い基準で計算してしまう。
 *
 *  3. **基本月額に加給年金額を入れない。** 46条1項が「第四十四条第一項に規定する
 *     加給年金額……を除く」と明記している。加給年金を足した額で判定すると、
 *     停止額が過大になる。ただし**全額支給停止になるときは加給年金も止まる**
 *     （日本年金機構『在職老齢年金の計算方法』留意事項）。この2つは別の話。
 *
 *  4. **老齢基礎年金と経過的加算額は1円も止まらない。** 止まるのは老齢厚生年金の
 *     報酬比例部分だけ。合計の受取額を出すときに基礎年金まで減らすと過小になる。
 *
 *  5. **総報酬月額相当額は「標準報酬月額＋直近1年の標準賞与額÷12」。** 賞与を
 *     忘れると停止額を過小に出す。年収÷12でもなく、手取りでもなく、標準報酬月額
 *     （等級の額）が正しい。
 *
 *  6. **停止額は老齢厚生年金の額が上限。** 46条1項ただし書。式のままだと
 *     マイナスの年金額が出るので、必ず0で止める（マイナスを返すと画面に
 *     「▲◯◯円受け取る」という無意味な額が出る）。
 */

/** 0以上の数に（未入力・負・NaN は0）。NaN を素通しすると年金額が丸ごと NaN になる。 */
const nz = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 1円単位の四捨五入（厚生年金保険法35条／国民年金法17条1項）。
 * 50銭未満は切捨て、50銭以上1円未満は1円に切上げ。
 */
export function roundYen(n) {
  return Math.floor(n + 0.5);
}

/**
 * 総報酬月額相当額（厚生年金保険法46条1項）。
 * ＝ その月の標準報酬月額 ＋ その月以前1年間の標準賞与額の総額 ÷ 12
 *
 * ★「月給の手取り」でも「年収÷12」でもない。標準報酬月額は等級表の額。
 *
 * @param {number} hyojunHoshuGetsugakuYen 標準報酬月額（円）
 * @param {number} shoyoTotalYen 直近1年間の標準賞与額の合計（円）
 * @returns {number} 総報酬月額相当額（円・1円単位）
 */
export function calcSohoshuGetsugaku(hyojunHoshuGetsugakuYen, shoyoTotalYen) {
  return roundYen(nz(hyojunHoshuGetsugakuYen) + nz(shoyoTotalYen) / 12);
}

/**
 * データから支給停止調整額（基準額）を1つ選ぶ。
 * ★見つからないキーを渡されたら例外にする（勝手に既定値へ落ちると、
 *   どの年度で計算したのか画面と実際がずれる）。
 */
export function pickKijun(kijunKey, D) {
  const list = D?.kijun;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("支給停止調整額のデータがありません");
  }
  if (!kijunKey) return list.find((k) => k.current) ?? list[0];
  const hit = list.find((k) => k.key === kijunKey);
  if (!hit) throw new Error(`支給停止調整額のデータに ${kijunKey} がありません`);
  return hit;
}

/**
 * 在職老齢年金による支給停止額と、実際に受け取る額。
 *
 * @param {object} input
 *   @param {number} input.koseiNenkinYen  老齢厚生年金（報酬比例部分）の年額・加給年金額を除く
 *   @param {number} input.hyojunHoshuYen  標準報酬月額
 *   @param {number} input.shoyoTotalYen   直近1年間の標準賞与額の合計
 *   @param {number} input.kakyuYen        加給年金額（年額）。無ければ0
 *   @param {number} input.kisoNenkinYen   老齢基礎年金＋経過的加算（年額）。停止されない
 *   @param {string} input.hatarakikata    "hihokensha"（厚生年金の被保険者として在職）
 *                                       / "over70"（70歳以上で適用事業所に勤務）
 *                                       / "taishoku"（在職していない）
 *   @param {string} input.kijunKey        使う基準額のキー（既定は current）
 * @param {object} D assets/zaishoku_r08.json
 */
export function calcZaishoku(input, D) {
  const kijun = pickKijun(input?.kijunKey, D);
  const bunbo = D?.shiki?.bunbo;
  if (!(bunbo > 0)) throw new Error("計算式のデータ（shiki.bunbo）がありません");

  const koseiYen = nz(input?.koseiNenkinYen);
  const kakyuYen = nz(input?.kakyuYen);
  const kisoYen = nz(input?.kisoNenkinYen);
  const hatarakikata = input?.hatarakikata ?? "hihokensha";

  const sohoshu = calcSohoshuGetsugaku(input?.hyojunHoshuYen, input?.shoyoTotalYen);
  // ★基本月額は「加給年金額を除いた」老齢厚生年金の月額（46条1項）。
  const kihonGetsugaku = koseiYen / 12;
  const goukeiGetsugaku = kihonGetsugaku + sohoshu;

  // ★在職していない人には、そもそも46条1項が働かない（支給停止の対象になる「日」がない）。
  //   ここで一律に式を通すと、退職済みの人に停止額を出してしまう。
  const zaishoku = hatarakikata === "hihokensha" || hatarakikata === "over70";

  // ★条文は2つの額を区別している。混ぜると検算が合わなくなる:
  //   ・**支給停止基準額**（46条1項本文）＝式がそのまま出す額。頭打ちしない。
  //     日本年金機構の『在職老齢年金早見表』が載せているのはこちら（表は基本月額と無関係に式を引く）。
  //   ・**実際に止まる額**（同項ただし書）＝老齢厚生年金の額が上限。
  //   早見表の「基本月額5万円・総報酬月額相当額66万円で停止額10万円」は前者で、
  //   5万円しかない年金から10万円は止まらない（全部停止で終わり）。
  let teishiKijunYen = 0; // 支給停止基準額（年額・頭打ち前）
  let kaFull = false; // 全額支給停止か

  if (zaishoku && goukeiGetsugaku > kijun.yen) {
    teishiKijunYen = roundYen(((goukeiGetsugaku - kijun.yen) / bunbo) * 12);
  }

  // ★46条1項ただし書: 支給停止基準額が老齢厚生年金の額以上のときは全部停止。
  //   式のまま引くとマイナスの年金額が出るので、ここで必ず頭打ちにする。
  let teishiYen = teishiKijunYen;
  if (teishiYen >= koseiYen && koseiYen > 0) {
    teishiYen = koseiYen;
    kaFull = true;
  }

  const shikyuKoseiYen = Math.max(0, koseiYen - teishiYen);

  // ★加給年金額は基本月額に入れないが、全額支給停止のときは加給年金も止まる
  //   （日本年金機構『在職老齢年金の計算方法』留意事項）。この2つは別の規律。
  const shikyuKakyuYen = kaFull ? 0 : kakyuYen;

  // ★老齢基礎年金・経過的加算は1円も止まらない。
  const totalYen = shikyuKoseiYen + shikyuKakyuYen + kisoYen;
  const totalIfNoTeishiYen = koseiYen + kakyuYen + kisoYen;

  return {
    kijun: { key: kijun.key, label: kijun.label, yen: kijun.yen },
    sohoshuGetsugaku: sohoshu,
    kihonGetsugaku: roundYen(kihonGetsugaku),
    goukeiGetsugaku: roundYen(goukeiGetsugaku),
    zaishoku,
    hatarakikata,
    /** 基準額を超えているか（超えていなければ全額支給） */
    over: zaishoku && goukeiGetsugaku > kijun.yen,
    /** 支給停止基準額（46条1項本文の式がそのまま出す額。頭打ち前。早見表と突き合わせる用） */
    teishiKijunYen,
    teishiKijunGetsugaku: roundYen(teishiKijunYen / 12),
    /** 実際に止まる額（46条1項ただし書で老齢厚生年金の額が上限） */
    teishiYen,
    teishiGetsugaku: roundYen(teishiYen / 12),
    /** ただし書の頭打ちが効いたか（式の額より実際に止まる額が少ない） */
    capped: teishiKijunYen > teishiYen,
    zengakuTeishi: kaFull,
    shikyuKoseiYen,
    shikyuKoseiGetsugaku: roundYen(shikyuKoseiYen / 12),
    shikyuKakyuYen,
    kisoYen,
    totalYen,
    totalGetsugaku: roundYen(totalYen / 12),
    /** 在職していなければいくら受け取れたか（停止によりいくら減ったか） */
    totalIfNoTeishiYen,
    genShouYen: totalIfNoTeishiYen - totalYen,
    year: D?._meta?.year ?? null,
    nextReview: D?._meta?.next_review ?? null,
  };
}

/**
 * 複数の基準額で計算して比べる（改正前後でいくら変わったかを出すため）。
 * ★このツールの一番の見どころ。令和8年4月に51万円→65万円へ上がったので、
 *   同じ収入でも受け取れる額が変わっている。
 *
 * @returns {Array<{kijun:object, result:object}>} データの kijun の順（新しい年度が先頭）
 */
export function compareKijun(input, D) {
  const list = D?.kijun;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("支給停止調整額のデータがありません");
  }
  return list.map((k) => ({
    kijun: k,
    result: calcZaishoku({ ...input, kijunKey: k.key }, D),
  }));
}
