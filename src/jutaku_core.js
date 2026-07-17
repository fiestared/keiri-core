/**
 * 住宅ローン控除（住宅借入金等特別控除）の計算ロジック。
 * DOM非依存・テスト対象。借入限度額・控除率・控除期間は jutaku_r07.json に持たせる（ページに手書きしない）。
 *
 * 一次ソース（すべて生テキストを curl で読んで実装した。政府サイトに WebFetch は使わない）:
 * - 国税庁タックスアンサー No.1211-1『住宅の新築等をし、令和4年以降に居住の用に供した場合
 *   （住宅借入金等特別控除）』（令和7年4月1日現在法令等）
 *   https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1211-1.htm
 * - 根拠条文：租税特別措置法41条
 *
 * ★★ ここを取り違えると「黙って間違える」点（この計算のいちばん危ない所）:
 *
 * 1. **控除率は0.7％。1％ではない。**（令和4年以降入居）
 *    平成26年〜令和3年入居は1％だった。1％のまま作ると控除額を約1.4倍に過大表示する。
 *    → 率は JSON の koujo_ritsu_permille（=7/1000）だけを正本にし、コードに 0.01 も 0.007 も書かない。
 *
 * 2. **「その他の住宅」を令和6年・令和7年に新築入居した人は、原則1円も控除されない（借入限度額0円）。**
 *    省エネ基準を満たさない新築は令和6年以降ゼロになった。ところが利用者は
 *    「住宅ローンを組んだのだから当然控除される」と思っている。ここで 3,000万円のままにすると
 *    もらえない21万円/年を「もらえる」と嘘をつく。
 *    → 経過措置（令和5年末までに建築確認、または令和6年6月末までに建築）に該当するときだけ
 *      2,000万円・10年で復活する。該当を尋ねてからでないと0とも14万とも言えない。
 *
 * 3. **各年の控除額は「その年の年末残高」で決まり、毎年減っていく。**
 *    借入限度額 × 0.7％ は“天井”であって、実際の控除額は min(年末残高, 取得対価等, 借入限度額) × 0.7％。
 *    総控除額を「年間控除額 × 控除期間」で出すのは**上限の概算**にすぎない（残高が減るぶん実際は少ない）。
 *    → soKoujoGaisan は必ず「上限の概算」と申告する。
 *
 * 4. **合計所得2,000万円を超える年は、その年は控除を受けられない。**（令和4年改正で3,000万→2,000万）
 *    さらに床面積40〜50㎡の「特例居住用家屋」は所得要件が1,000万円以下と厳しい。
 *    所得を入力されたときだけ判定し、未入力なら判定せず注意喚起する（黙って対象と決めつけない）。
 *
 * 5. **控除しきれない分は所得税額が上限。**（＝「借入残高 × 0.7％ が満額戻る」とは限らない）
 *    年間控除額がその年の所得税額を上回ると、上回った分は翌年度の個人住民税から一定額まで引かれ、
 *    それでも余ると切り捨てられる（還付されない）。残高が大きい人ほどこの天井に当たる。
 *    → juminzeiKoujo() で計算する（総務省の一次情報で上限を確かめた）。
 *      控除額(A) = 年間控除額（住宅ローン控除可能額）− 住宅ローン控除“適用前”の所得税額。
 *      住民税の控除限度額(B) = min(課税総所得金額等 × 5％, 97,500円)。住民税控除 = min(A, B)、残りは切り捨て。
 *      ★令和4〜令和7年入居はすべて 5％・97,500円（7％・136,500円は平成26〜令和3年の特定取得のみ＝本ツール範囲外）。
 *      所得税額は源泉徴収票・確定申告で分かるので入力させる。未入力なら“上限概算”のまま（黙って満額戻ると言わない）。
 *
 * 6. **中古（既存住宅）は新築・買取再販と別レジーム（No.1211-3）。混ぜると桁で間違える。**
 *    ★新築と違い『その他の住宅』でも令和6・7年入居で0円にならない（一律2,000万・10年）。
 *    控除期間は一律10年（新築13年より短い）。子育て特例の上乗せは無い。床面積は50㎡以上
 *    （新築の40〜50㎡の特例＝小規模居住用家屋は中古に無い）。借入限度額は認定住宅等（認定・ZEH・
 *    省エネをまとめて）3,000万・その他2,000万。→ 中古は D.chuko を使い、type='chuko' で分岐する。
 *    ★増改築等（No.1211-4）は計算方法がまるごと違う → beyondData を立てて「黙って答えない」（fail closed）。
 */

/** 円に丸める（0未満・未入力・数値でないものは0）。undefined を素通しすると結果が NaN になり画面が全損する。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 住宅区分・入居年・特例対象個人・経過措置から、借入限度額（万円）・控除期間（年）を引く。
 * 収録範囲外（不明な区分・入居年）は null を返す（＝呼び出し側で beyondData にする）。
 */
export function resolveGendo(kubun, year, tokurei, keikaSochi, D, type) {
  type = type || 'shinchiku';

  // 中古（既存住宅・No.1211-3）… 令和4〜令和7年入居で一律。区分は認定住宅等（認定/ZEH/省エネ）3,000万・
  // その他2,000万、控除期間はどちらも10年。★子育て特例の上乗せも経過措置も無い（新築と違う）ので
  // tokurei・keikaSochi は素通しにする（フラグが立っていても無視）。
  if (type === 'chuko') {
    const C = D.chuko;
    if (!C || !C.years_valid.includes(String(year))) return null;
    const K = C.kubun[kubun];
    if (!K) return null;
    return { gendoMan: K.gendo_man, kikan: K.kikan, keika: false, tokureiApplied: false, zero: false };
  }

  const K = D.kubun[kubun];
  if (!K) return null;
  const y = K.years[String(year)];
  if (!y) return null;

  // 「その他の住宅」令和6・7年入居 … 原則0円。経過措置に該当するときだけ 2,000万・10年で復活。
  if (y.gendo_man === 0) {
    if (keikaSochi && y.keika_gendo_man) {
      return { gendoMan: y.keika_gendo_man, kikan: y.keika_kikan, keika: true, tokureiApplied: false, zero: false };
    }
    return { gendoMan: 0, kikan: 0, keika: false, tokureiApplied: false, zero: true };
  }

  // 子育て世帯・若者夫婦世帯（特例対象個人）の上乗せは令和6・7年入居にだけ効く。
  // 令和4・5年入居や「その他の住宅」には tokurei_gendo_man が無いので、フラグが立っていても素通しになる。
  let gendoMan = y.gendo_man;
  let tokureiApplied = false;
  if (tokurei && y.tokurei_gendo_man) {
    gendoMan = y.tokurei_gendo_man;
    tokureiApplied = true;
  }
  return { gendoMan, kikan: y.kikan, keika: false, tokureiApplied, zero: false };
}

/**
 * 所得税から引ききれなかった住宅ローン控除を、翌年度の個人住民税から控除する額を計算する。
 * 一次ソース：総務省「所得税から住宅ローン控除額を引ききれなかった方」
 *   個人住民税の住宅ローン控除額(A) ＝ 住宅ローン控除可能額 − 住宅ローン控除“適用前”の前年の所得税額。
 *   ただし A が上限(B)＝「前年分の所得税の課税総所得金額等の5％（97,500円を限度）」を超えるときは B が控除額。
 *   （率・上限は JSON の juminzei に持たせる。★令和4〜令和7年入居はすべて5％・97,500円）
 *
 * @param nenkanKoujo  その年の住宅ローン控除可能額（＝calc の nenkanKoujo。所得税＋住民税に配分される総枠）
 * @param shotokuzei   住宅ローン控除“適用前”のその年分の所得税額（円）。源泉徴収票・確定申告で分かる
 * @param kazeiSotoku  （任意）課税総所得金額等（円）。5％上限の判定に使う。未入力なら5％判定を省き上限97,500円で概算する
 * @returns 所得税から控除された額・住民税から控除された額・切り捨て額・実際の軽減税額の内訳
 */
export function juminzeiKoujo(nenkanKoujo, shotokuzei, kazeiSotoku, D) {
  if (!D || !D.juminzei) throw new Error('参照データ（jutaku_r07.json の juminzei）が渡されていません');
  const J = D.juminzei;
  const koujoKanou = yen(nenkanKoujo);   // その年の控除可能額（住宅ローン控除枠）
  const zei = yen(shotokuzei);           // 適用前の所得税額

  // 所得税から控除される額（所得税額を上限に食う）と、引ききれなかった額 A
  const shotokuzeiKoujo = Math.min(koujoKanou, zei);
  const hikikirenai = Math.max(0, koujoKanou - zei);   // A

  // 住民税の控除限度額 B = min(課税総所得金額等 × 5％, 97,500円)。
  // 課税総所得が未入力のときは 5％判定ができないので、上限（97,500円）で概算し capUnknown を立てる
  //（実際は課税総所得×5％でさらに下がりうる＝黙って多めに言わない）。
  const flatCap = J.gendo_cap_yen;
  let capB = flatCap;
  let capUnknown = false;
  const kazei = kazeiSotoku != null && kazeiSotoku !== '' ? yen(kazeiSotoku) : null;
  if (kazei != null) {
    const pctCap = Math.floor(kazei * J.gendo_rate_permille / 1000); // 5％ = 50/1000
    capB = Math.min(pctCap, flatCap);
  } else {
    capUnknown = true;
  }

  const juminzeiKoujoGaku = Math.min(hikikirenai, capB);        // 住民税から控除された額
  const kirisute = Math.max(0, hikikirenai - juminzeiKoujoGaku); // 住民税上限も超えて消える分（還付されない）

  return {
    koujoKanou,               // その年の控除可能額
    shotokuzeiGaku: zei,      // 適用前の所得税額
    shotokuzeiKoujo,          // 所得税から控除された額
    hikikirenai,              // 所得税で引ききれなかった額 A
    juminzeiCapB: capB,       // 住民税の控除限度額 B
    juminzeiCapUnknown: capUnknown, // 課税総所得未入力で 5％判定を省いたか（true なら実額はさらに下がりうる）
    juminzeiKoujoGaku,        // 住民税から控除された額
    kirisute,                 // 切り捨て（どちらの税からも引けず還付されない額）
    jitsuGenzei: shotokuzeiKoujo + juminzeiKoujoGaku, // 実際に軽減された税額（＝実質の“戻り”）
  };
}

/**
 * 入口。
 * input = {
 *   type,               // 'shinchiku'(新築・買取再販／既定) | 'chuko'(中古) | 'zokaichiku'(増改築)
 *   kubun,              // 'nintei' | 'zeh' | 'shoene' | 'sonota'
 *   year,               // 入居（居住開始）年（西暦 2022〜2025）
 *   nenmatsuZandaka,    // その年の年末借入残高（円）
 *   shutokuTaika,       // （任意）住宅の取得対価等（円）。年末残高より少なければこちらが控除対象になる
 *   kosodateTokurei,    // （任意・真偽）特例対象個人（子育て世帯・若者夫婦世帯）か
 *   keikaSochi,         // （任意・真偽）その他の住宅の経過措置に該当するか
 *   goukeiShotoku,      // （任意）その年の合計所得金額（円）。所得要件の判定に使う
 *   menseki,            // （任意）床面積（㎡）。床面積・所得要件の判定に使う
 *   shotokuzeiGaku,     // （任意）住宅ローン控除“適用前”の所得税額（円）。渡すと juminzeiKoujo で実還付額を出す
 *   kazeiSotokugaku     // （任意）課税総所得金額等（円）。住民税の5％上限の判定に使う
 * }
 */
export function calc(input, D) {
  if (!D) throw new Error('参照データ（jutaku_r07.json）が渡されていません');
  const type = input.type || 'shinchiku';
  const base = { type, eligible: true, beyondData: false, warnings: [], year: input.year };

  // 増改築等（No.1211-4）は計算方法がまるごと違う → 黙って答えない（fail closed）。
  // 想定外の type も同様に beyondData（新築の数字を誤って当てない）。中古（chuko）は下で計算する。
  if (type !== 'shinchiku' && type !== 'chuko') {
    return {
      ...base, beyondData: true, eligible: false,
      reason: type === 'zokaichiku'
        ? '増改築等は借入限度額も控除額の計算方法も異なります（国税庁 No.1211-4）。このツール（新築・買取再販・中古）では扱えません。'
        : 'この取得のしかたには対応していません。',
    };
  }

  const isChuko = type === 'chuko';
  const yearNum = Math.floor(Number(input.year));
  const g = resolveGendo(input.kubun, yearNum, !!input.kosodateTokurei, !!input.keikaSochi, D, type);
  if (!g) {
    return {
      ...base, beyondData: true, eligible: false,
      reason: isChuko
        ? `入居年（${input.year}）または住宅区分が、中古（既存住宅）の収録範囲（令和4〜令和7年入居）の外です。`
        : `入居年（${input.year}）または住宅区分が、このツールの収録範囲（令和4〜令和7年に新築・買取再販へ入居）の外です。`,
    };
  }

  // ── 所得要件・床面積要件（入力があるときだけ判定。無ければ判定せず注意喚起する）──
  // ★中古は床面積50㎡以上が要件（新築の40〜50㎡＝小規模居住用家屋の特例は中古に無い）。
  //   新築は floor=40（40〜50㎡は小規模）／中古は floor=full=50（40〜50㎡でも対象外）。
  const Y = D.shotoku_yoken;
  const mensekiFloor = isChuko ? D.chuko.menseki_min : Y.shokibo_menseki_min; // 中古50・新築40
  const mensekiFull = isChuko ? D.chuko.menseki_min : Y.menseki_min;          // どちらも50
  const menseki = input.menseki != null && input.menseki !== '' ? Number(input.menseki) : null;
  let mensekiStatus = 'unknown'; // 'unknown' | 'ok' | 'shokibo'(新築のみ40〜50㎡未満) | 'too_small'
  if (menseki != null && Number.isFinite(menseki)) {
    if (menseki < mensekiFloor) mensekiStatus = 'too_small';
    else if (menseki < mensekiFull) mensekiStatus = 'shokibo'; // 中古は floor==full なので立たない
    else mensekiStatus = 'ok';
  }
  const shotokuLimit = mensekiStatus === 'shokibo' ? Y.shokibo_goukei_shotoku_limit : Y.goukei_shotoku_limit;
  const goukeiShotoku = input.goukeiShotoku != null && input.goukeiShotoku !== '' ? yen(input.goukeiShotoku) : null;
  const incomeOver = goukeiShotoku != null && goukeiShotoku > shotokuLimit;

  const eligible = !g.zero && mensekiStatus !== 'too_small' && !incomeOver;

  // ── 控除額 ──
  const koujoRitsuPermille = D.koujo_ritsu_permille; // 7（=0.7％）
  const trunc = D.hyaku_yen_truncate;                // 100（円未満切捨）
  const gendoEn = g.gendoMan * 10000;                 // 借入限度額（円）
  const koujoGendoEn = Math.floor(gendoEn * koujoRitsuPermille / 1000); // 各年の控除限度額（＝天井）

  const zandaka = yen(input.nenmatsuZandaka);
  const taika = input.shutokuTaika != null && input.shutokuTaika !== '' ? yen(input.shutokuTaika) : null;
  // 控除対象額 = min(年末残高, 取得対価等, 借入限度額)
  let koujoTaisho = Math.min(zandaka, gendoEn);
  if (taika != null) koujoTaisho = Math.min(koujoTaisho, taika);
  koujoTaisho = Math.max(0, koujoTaisho);

  // 年間控除額 = 控除対象額 × 0.7％、100円未満切り捨て（対象外なら0）
  const nenkanKoujo = eligible
    ? Math.floor(koujoTaisho * koujoRitsuPermille / (1000 * trunc)) * trunc
    : 0;
  // 総控除額は「年間控除額 × 控除期間」の“上限概算”（残高が毎年減るぶん実際は少ない）
  const soKoujoGaisan = nenkanKoujo * g.kikan;

  // 所得税額が渡されたときだけ、実際の軽減額（所得税から＋住民税から）を出す。
  // 渡されなければ juminzei は null＝「上限概算のまま」（黙って満額戻ると言わない）。
  const shotokuzeiGivenRaw = input.shotokuzeiGaku;
  const juminzei = (eligible && shotokuzeiGivenRaw != null && shotokuzeiGivenRaw !== '')
    ? juminzeiKoujo(nenkanKoujo, shotokuzeiGivenRaw, input.kazeiSotokugaku, D)
    : null;

  return {
    ...base,
    eligible,
    kubun: input.kubun,
    kubunLabel: D.kubun[input.kubun].label,
    shakunyuGendoMan: g.gendoMan,
    shakunyuGendoEn: gendoEn,
    koujoGendoEn,             // 各年の控除限度額（天井）
    kikan: g.kikan,
    koujoTaisho,
    nenkanKoujo,
    soKoujoGaisan,
    juminzei,                 // 所得税額を渡したときだけ非null＝実還付額の内訳（所得税から/住民税から/切り捨て）
    koujoRitsuPct: koujoRitsuPermille / 10, // 表示用（0.7）
    // 状態フラグ（ページが文言・警告を出すのに使う）
    isChuko,                  // 中古（既存住宅）か（ページが中古専用の注意書きを出すのに使う）
    tokureiApplied: g.tokureiApplied,
    keikaApplied: g.keika,
    sonotaZero: g.zero,
    mensekiStatus,
    mensekiFloor,             // 対象外になる床面積の下限（新築40／中古50）＝画面のしきい値表示に使う
    incomeOver,
    shotokuLimit,
    goukeiShotokuGiven: goukeiShotoku,
  };
}
