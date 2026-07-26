/**
 * 所得控除・必要経費による節税額のコアロジック（DOM非依存・テスト対象）。
 *
 * iDeCo・小規模企業共済 など「掛金の全額が所得控除になる」制度は、節税額の出し方が共通:
 *   節税額 ＝ 所得税の減少（速算表の差）＋ 復興特別所得税の減少 ＋ 住民税の減少
 * ※倒産防止共済は所得控除ではなく**事業所得の必要経費**（措法28条1項2号）。課税所得を
 *   減らす向きの税額計算は同じ式だが、出口（解約手当金＝事業所得の収入）まで見ないと
 *   嘘になるので tosanBoshiKyosai() が入口と出口を必ず両方返す。
 *
 * ★所得税は速算表（国税庁 No.2260）で**超過累進**を厳密に扱う（単純に「掛金×税率」だと
 *   控除で税率ブラケットをまたぐ人の額がずれる）。住民税所得割は一律10%として概算する
 *   （住民税は課税所得の算定が所得税と少し違うので、掛金×10%の概算にとどめる）。
 *
 * 参照データ（setsuzei_r08.json）を呼び出し側が渡す。ページに税率・上限を手書きしない。
 */

/** 円に丸める（floor・0未満/非数は0）。NaN を素通しすると節税額が丸ごと NaN になる。 */
const yen0 = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 課税所得（所得税）に対する所得税額（復興特別所得税を含まない）。
 * 課税所得は1,000円未満切捨て（通則）。速算表で税率×課税所得−控除額。
 * @param {number} kazeiShotoku 課税される所得金額（円）
 * @param {object} D setsuzei_r08.json
 */
export function shotokuzei(kazeiShotoku, D) {
  if (!D || !Array.isArray(D.shotokuzei_brackets)) {
    throw new Error('参照データ（setsuzei_r08.json）が渡されていません');
  }
  const x = Math.floor(Math.max(0, Number(kazeiShotoku) || 0) / 1000) * 1000; // 千円未満切捨て
  if (x <= 0) return 0;
  for (const b of D.shotokuzei_brackets) {
    if (b.upto == null || x <= b.upto) {
      return Math.floor(x * b.rate - b.deduct);
    }
  }
  return 0; // 到達しない（最後の bracket は upto:null）
}

/**
 * 「掛金の全額が所得控除」の制度の節税額。
 * @param input {
 *   kazeiShotoku,   // 控除前の課税所得（所得税ベース。年収でなく課税所得）
 *   annualDeduction // 年間の掛金（＝所得控除額）
 * }
 * @param D setsuzei_r08.json
 * @returns { shotokuGen, fukkoGen, juminGen, total, effectiveRate, taxBefore, taxAfter,
 *            usedDeduction, kazeiShotoku, year }
 */
export function taxSaving(input, D) {
  if (!D) throw new Error('参照データ（setsuzei_r08.json）が渡されていません');
  const kazei = yen0(input.kazeiShotoku);
  const deduction = yen0(input.annualDeduction);

  // 控除は課税所得を下回る範囲でしか効かない（課税所得0の人は節税額0）。
  const used = Math.min(deduction, kazei);

  const taxBefore = shotokuzei(kazei, D);
  const taxAfter = shotokuzei(kazei - deduction, D); // 速算表の差＝超過累進を厳密に反映
  const shotokuGen = Math.max(0, taxBefore - taxAfter);                 // 所得税の減少
  const fukkoGen = Math.floor(shotokuGen * (D.fukko_rate || 0));        // 復興特別所得税の減少(2.1%)
  const juminGen = Math.floor(used * (D.juminzei_shotokuwari_rate || 0)); // 住民税の減少(概算・一律10%)
  const total = shotokuGen + fukkoGen + juminGen;

  return {
    kazeiShotoku: kazei,
    usedDeduction: used,
    taxBefore, taxAfter,
    shotokuGen, fukkoGen, juminGen,
    total,
    effectiveRate: deduction > 0 ? total / deduction : 0, // 掛金に対する節税率
    year: D._meta?.year || '',
  };
}

/**
 * 年間掛金（月額×12）から節税額を出すヘルパ。上限の超過は beyondLimit で申告（黙って丸めない）。
 * @param input { kazeiShotoku, monthly, annualLimit }
 */
export function taxSavingByMonthly(input, D) {
  const monthly = yen0(input.monthly);
  const limit = Number(input.annualLimit) || null;
  const annual = monthly * 12;
  const beyondLimit = limit != null && annual > limit;
  const r = taxSaving({ kazeiShotoku: input.kazeiShotoku, annualDeduction: annual }, D);
  return { ...r, monthly, annual, annualLimit: limit, beyondLimit };
}

/**
 * 所得税と住民税で控除額が異なる所得控除（扶養控除・配偶者控除など「人的控除」）の節税額。
 * 扶養控除は所得税38万円に対し住民税33万円のように別額なので、taxSaving（同額前提）を使うと
 * 住民税の減少を過大に出す。こちらは両方の控除額を受け取る。
 * @param input { kazeiShotoku, shotokuKojo(所得税の控除額), juminKojo(住民税の控除額) }
 */
export function taxSavingSplit(input, D) {
  if (!D) throw new Error('参照データ（setsuzei_r08.json）が渡されていません');
  const kazei = yen0(input.kazeiShotoku);
  const sKojo = yen0(input.shotokuKojo);
  const jKojo = yen0(input.juminKojo);

  // 控除は課税所得を下回る範囲でしか効かない（住民税側も同じ概算の考え方でクランプする）。
  const usedShotoku = Math.min(sKojo, kazei);
  const usedJumin = Math.min(jKojo, kazei);

  const taxBefore = shotokuzei(kazei, D);
  const taxAfter = shotokuzei(kazei - sKojo, D); // 速算表の差＝超過累進を厳密に反映
  const shotokuGen = Math.max(0, taxBefore - taxAfter);
  const fukkoGen = Math.floor(shotokuGen * (D.fukko_rate || 0));
  const juminGen = Math.floor(usedJumin * (D.juminzei_shotokuwari_rate || 0));
  const total = shotokuGen + fukkoGen + juminGen;

  return {
    kazeiShotoku: kazei,
    shotokuKojo: sKojo, juminKojo: jKojo,
    usedShotoku, usedJumin,
    taxBefore, taxAfter,
    shotokuGen, fukkoGen, juminGen,
    total,
    year: D._meta?.year || '',
  };
}

/**
 * 配偶者控除・配偶者特別控除: 本人の合計所得金額・配偶者の合計所得金額・配偶者の年齢(70歳以上か)から
 * 所得税・住民税それぞれの控除額を出す（額の表は参照データが正本。ページに手書きしない）。
 * 本人1,000万円超・配偶者133万円超は「適用なし」を type で申告する（黙って0で答えない）。
 * @param input { honninShotoku(本人の合計所得金額), haiguShotoku(配偶者の合計所得金額), rojin(70歳以上か) }
 * @returns { type: 'haigusha'|'tokubetsu'|'none', reason?, tier, tierLabel, shotoku, jumin, bandLabel }
 */
export function haigushaKojo(input, D) {
  if (!D?.haigu?.honnin_tiers) throw new Error('参照データ（setsuzei_r08.json の haigu）が渡されていません');
  const H = D.haigu;
  const honnin = yen0(input.honninShotoku);
  const haigu = yen0(input.haiguShotoku);
  const rojin = !!input.rojin;
  const tier = H.honnin_tiers.findIndex((t) => honnin <= t.upto);
  if (tier < 0) {
    return { type: 'none', reason: 'honnin_over', tier: null, tierLabel: '', shotoku: 0, jumin: 0, bandLabel: '' };
  }
  const tierLabel = H.honnin_tiers[tier].label;
  if (haigu <= H.income_limit) {
    const k = rojin ? H.kojo.rojin : H.kojo.ippan;
    return { type: 'haigusha', rojin, tier, tierLabel,
             shotoku: k.shotoku[tier], jumin: k.jumin[tier], bandLabel: k.label };
  }
  const band = H.tokubetsu_bands.find((b) => haigu > b.over && haigu <= b.upto);
  if (!band) {
    return { type: 'none', reason: 'haigu_over', tier, tierLabel, shotoku: 0, jumin: 0, bandLabel: '' };
  }
  return { type: 'tokubetsu', tier, tierLabel,
           shotoku: band.shotoku[tier], jumin: band.jumin[tier], bandLabel: band.label };
}

/**
 * 給与収入だけの人の合計所得金額への換算。令和8・9年分は措法29条の4（給与所得控除の
 * 最低控除額等の特例）により収入220万円以下の給与所得控除が定額74万円。収入74.1万円未満は
 * 給与所得なし（同条2項1号）、74.1万円以上219.1万円未満は「収入−74万円」（同2号）。
 * 参照データの kyuyo_kojo_min_limit（219万円）以下だけ換算し、超えたら換算しない（fail closed —
 * 219.1万円以上220万円未満は量子化帯・220万円超は控除が収入で変わるため、このデータでは答えられない）。
 * @returns { ok: true, shotoku } | { ok: false, reason: 'over_limit' }
 */
export function kyuyoToGokeiShotoku(shunyu, D) {
  if (!D?.haigu) throw new Error('参照データ（setsuzei_r08.json の haigu）が渡されていません');
  const s = yen0(shunyu);
  if (s > D.haigu.kyuyo_kojo_min_limit) return { ok: false, reason: 'over_limit' };
  if (s < (D.haigu.kyuyo_kojo_zero_below ?? 0)) return { ok: true, shotoku: 0 };
  return { ok: true, shotoku: Math.max(0, s - D.haigu.kyuyo_kojo_min) };
}

/**
 * 生命保険料控除の1区分ぶんの控除額（帯の表は参照データが正本）。
 * 帯は条文の書き方（「◯円と、合計額から△円を控除した金額のn分の1に相当する金額との合計額」）を
 * そのまま base + (x − minus) / div で持つ。1円未満の端数は**切り上げ**
 * （国税庁 令和8年分 給与所得者の保険料控除申告書の注記）。
 */
function seihoBand(x, bands) {
  for (const b of bands) {
    if (b.upto == null || x <= b.upto) {
      if (b.flat != null) return b.flat;
      return Math.ceil(b.base + (x - b.minus) / b.div);
    }
  }
  return 0;
}

/**
 * 生命保険料控除の1区分（一般／介護医療／個人年金）の控除額。
 * 新契約・旧契約の両方を払っている場合は、条文どおり「旧のみで計算した額」と
 * 「新＋旧の合算（上限あり）」の**大きい方**を採る（所法76条1項1〜3号）。
 * @param T その税（所得税 or 住民税）の帯データ
 * @param useTokurei 措法41条の15の5（年齢23歳未満の扶養親族がいる場合の一般の特例）を使うか
 */
function seihoCategory(shin, kyu, T, useTokurei) {
  const bandsShin = useTokurei && T.shin_tokurei ? T.shin_tokurei : T.shin;
  const heiyoMax = useTokurei && T.heiyo_max_tokurei != null ? T.heiyo_max_tokurei : T.heiyo_max;
  const dShin = shin > 0 ? seihoBand(shin, bandsShin) : 0;
  const dKyu = kyu > 0 ? seihoBand(kyu, T.kyu) : 0;

  if (shin > 0 && kyu > 0) {
    const heiyo = Math.min(dShin + dKyu, heiyoMax);
    // 旧契約だけで計算した方が大きくなることがある（旧の上限5万円 > 合算の上限4万円）。
    if (dKyu > heiyo) return { amount: dKyu, method: 'kyu_only', shin: dShin, kyu: dKyu };
    return { amount: heiyo, method: 'heiyo', shin: dShin, kyu: dKyu };
  }
  if (kyu > 0) return { amount: dKyu, method: 'kyu_only', shin: 0, kyu: dKyu };
  if (shin > 0) return { amount: dShin, method: 'shin_only', shin: dShin, kyu: 0 };
  return { amount: 0, method: 'none', shin: 0, kyu: 0 };
}

/**
 * 生命保険料控除（所得税法76条／地方税法34条1項5号・314条の2第1項5号）。
 * ★住民税は「5号」。5号の2は損害保険料控除の廃止跡で「削除」、5号の3は地震保険料控除。
 * 3区分（一般・介護医療・個人年金）それぞれの新契約・旧契約の年間支払保険料から、
 * 所得税・住民税の控除額を出す。介護医療は新制度のみ（旧契約の区分が無い）。
 *
 * ★年齢23歳未満の扶養親族がいる場合、令和8年分・令和9年分に限り**一般の新契約だけ**
 *   帯の表が1.5倍になる（措法41条の15の5。上限4万円→6万円）。住民税に同じ特例は無い。
 *   合計の上限（所得税12万円・住民税7万円）は特例でも変わらない。
 *
 * @param input {
 *   ippan_shin, ippan_kyu, kaigo, nenkin_shin, nenkin_kyu, // 年間支払保険料（円）
 *   tokurei // 年齢23歳未満の扶養親族がいるか
 * }
 * @returns { shotoku:{items,sum,total,capped}, jumin:{...}, tokureiApplied, year }
 */
export function seimeiHokenryoKojo(input, D) {
  if (!D?.seiho?.shotoku) throw new Error('参照データ（setsuzei_r08.json の seiho）が渡されていません');
  const S = D.seiho;
  const tokurei = !!input?.tokurei;

  const pays = {
    ippan: { shin: yen0(input?.ippan_shin), kyu: yen0(input?.ippan_kyu) },
    kaigo: { shin: yen0(input?.kaigo), kyu: 0 },
    nenkin: { shin: yen0(input?.nenkin_shin), kyu: yen0(input?.nenkin_kyu) },
  };

  const side = (T) => {
    const items = S.kubun.map((k) => {
      const p = pays[k.key];
      const r = seihoCategory(p.shin, p.kyu, T, tokurei && !!k.tokurei);
      return { key: k.key, label: k.label, paidShin: p.shin, paidKyu: p.kyu, ...r };
    });
    const sum = items.reduce((a, i) => a + i.amount, 0);
    const total = Math.min(sum, T.total_max);
    return { items, sum, total, capped: sum > T.total_max, totalMax: T.total_max };
  };

  return {
    shotoku: side(S.shotoku),
    jumin: side(S.jumin),
    tokureiApplied: tokurei,
    year: D._meta?.year || '',
  };
}

/**
 * 青色申告特別控除（租税特別措置法25条の2）。
 *
 * 他の控除と違い**所得控除ではなく「所得金額の計算上の控除」**なので、
 *  ・地方税法32条2項により**住民税にも同額**が流入する（人的控除のように額が変わらない）
 *  ・控除額は所得の額が限度（黒字の所得の合計額より大きくは引けない）
 * という2点が効く。
 *
 * ★限度額の「合計額」は**損益通算前の黒字の所得金額の合計額**（国税庁 No.2072 注2）。
 *   赤字の所得は「無いもの」として合計する（差し引かない）。マイナスで相殺すると控除を過少に出す。
 * ★55万円・65万円は不動産所得・事業所得だけが対象で**山林所得を含まない**（3項）。
 *   10万円は山林所得も対象（1項）。
 *
 * @param input {
 *   jigyo, fudosan, sanrin,   // 各所得の金額（青色申告特別控除を引く前・赤字はマイナスで渡してよい）
 *   jigyoteki,   // 不動産所得/事業所得を生ずべき「事業」を営んでいるか（3項の要件）
 *   fukushiki,   // 正規の簿記の原則（複式簿記）で記帳しているか
 *   kigennai,    // 貸借対照表等を添付し期限内(翌年3/15)に申告するか
 *   etaxOrYuryo, // e-Tax送信 または 優良な電子帳簿（4項1号・2号）
 *   genkinShugi  // 現金主義の特例（所法67条1項）を選んでいるか
 * }
 * @returns { key, amount, cap, deduction, label, law, missing, nextKubun, nextGain, year }
 */
export function aoiroKojo(input, D) {
  if (!D?.aoiro?.kubun) throw new Error('参照データ（setsuzei_r08.json の aoiro）が渡されていません');
  const A = D.aoiro;

  // 黒字だけを合計する（赤字は0として扱う＝損益通算前）。
  const plus = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const income = { jigyo: plus(input?.jigyo), fudosan: plus(input?.fudosan), sanrin: plus(input?.sanrin) };

  const has = {
    jigyo: !!input?.jigyoteki,
    fukushiki: !!input?.fukushiki,
    kigennai: !!input?.kigennai,
    etax_or_yuryo: !!input?.etaxOrYuryo,
  };
  const genkin = !!input?.genkinShugi;

  const met = (k) => {
    // 現金主義の特例を選ぶと3項の対象外＝55万・65万は受けられない（所法67条1項・No.2072 注1）。
    if (genkin && (A.genkin_shugi_excludes || []).includes(k.key)) return false;
    return (k.requires || []).every((r) => has[r]);
  };

  // 額の大きい順に並んでいるので、要件を満たす最初の区分を採る。
  const idx = A.kubun.findIndex(met);
  const k = idx >= 0 ? A.kubun[idx] : null;
  if (!k) {
    return { key: null, amount: 0, cap: 0, deduction: 0, label: '', law: '', missing: [],
             nextKubun: null, nextGain: 0, year: D._meta?.year || '' };
  }

  // 限度＝その区分が対象とする所得（黒字のみ）の合計額。
  const cap = (k.target || []).reduce((a, t) => a + (income[t] || 0), 0);
  const deduction = Math.min(k.amount, cap);

  // 1つ上の区分に届いていないとき、何が足りないかを申告する（黙って下の区分で答えない）。
  let missing = [];
  let nextKubun = null;
  let nextGain = 0;
  if (idx > 0) {
    const up = A.kubun[idx - 1];
    missing = (up.requires || []).filter((r) => !has[r]);
    if (genkin && (A.genkin_shugi_excludes || []).includes(up.key)) missing.push('genkin_shugi');
    const upCap = (up.target || []).reduce((a, t) => a + (income[t] || 0), 0);
    nextKubun = up;
    nextGain = Math.max(0, Math.min(up.amount, upCap) - deduction);
  }

  return {
    key: k.key, amount: k.amount, cap, deduction,
    label: k.label, law: k.law,
    capped: deduction < k.amount,
    missing, nextKubun, nextGain,
    year: D._meta?.year || '',
  };
}

/**
 * 倒産防止共済（経営セーフティ共済・中小企業倒産防止共済法）の「入口と出口の両側」の計算。
 *
 * ★掛金は所得控除ではなく**事業所得の必要経費**（措法28条1項2号。事業所得限定＝不動産所得は不可）。
 *   課税所得を減らす向きの計算は所得控除と同じなので税額は同じ式で出せるが、
 *   **解約手当金は全額が事業所得の収入金額**（SMRJ公式FAQ ID:22）になる＝**課税の繰延べ**。
 *   入口の節税額だけを出すと嘘になるので、このコアは必ず出口（解約時の増税）まで返す。
 *
 * 前提（画面にも申告する）: 掛金を払う各年の課税所得は一定・解約年は掛金を払わない。
 * 解約手当金の額 ＝ 掛金総額 × 支給率（納付月数と解約の種類で決まる。施行令4条）。
 * 納付12か月未満は解約手当金なし（法11条1項）＝掛金全額が掛け捨て。
 *
 * @param input {
 *   kazeiShotoku,        // 掛金を経費にする前の課税所得（拠出する各年で同じと仮定）
 *   monthly,             // 掛金月額（5,000〜200,000円・5,000円刻み）
 *   months,              // 掛金を納付する月数
 *   kaiyakuKazeiShotoku, // 解約年の課税所得（解約手当金を入れる前）。null/undefined なら拠出時と同じ
 *   kaiyakuType          // 'nini'（既定）| 'minashi' | 'kiko'
 * }
 * @returns { monthlyValid, monthsPaid, paidTotal, capReached, years,
 *            setsuzeiPerYearFirst, setsuzeiTotal,
 *            rate, rateBand, teate, kakesute,
 *            zouzei: { shotokuInc, fukkoInc, juminInc, total },
 *            net, kaiyakuBase, type, year }
 */
export function tosanBoshiKyosai(input, D) {
  if (!D?.tosan?.shikyu_ritsu?.types) throw new Error('参照データ（setsuzei_r08.json の tosan）が渡されていません');
  const T = D.tosan;
  const monthly = Math.floor(Number(input?.monthly) || 0);
  const months = Math.floor(Number(input?.months) || 0);

  // 掛金月額の範囲は法4条2項（5,000円以上・5,000円の整数倍・上限20万円）。範囲外は黙って丸めず申告する。
  const monthlyValid = monthly >= T.monthly_min && monthly <= T.monthly_max && monthly % T.monthly_step === 0;
  if (!monthlyValid || months <= 0) {
    return { monthlyValid, monthsPaid: 0, paidTotal: 0, capReached: false, years: 0,
             setsuzeiPerYearFirst: 0, setsuzeiTotal: 0, rate: 0, rateBand: null, teate: 0, kakesute: 0,
             zouzei: { shotokuInc: 0, fukkoInc: 0, juminInc: 0, total: 0 },
             net: 0, kaiyakuBase: 0, type: null, year: D._meta?.year || '' };
  }

  // 掛金総額は800万円が限度（法14条3項）。到達後の月は納付できない（掛止め＝納付月数に数えない）。
  // 最後の月は限度までの残額だけ納付できる（同項は「超えることとなる額につき」納付不可とする）。
  const capMonths = Math.ceil(T.total_limit / monthly);
  const monthsPaid = Math.min(months, capMonths);
  const paidTotal = Math.min(monthly * monthsPaid, T.total_limit);
  const capReached = monthly * months > T.total_limit;

  // 入口: 各年の掛金（月額×12・最終年は端数）を必要経費にしたときの税の減少を年ごとに積む。
  // 経費は課税所得を減らす向きなので taxSaving と同じ式（速算表の差＋復興2.1%＋住民10%概算）。
  const kazei = yen0(input.kazeiShotoku);
  let setsuzeiTotal = 0;
  let setsuzeiPerYearFirst = 0;
  let years = 0;
  let remaining = paidTotal;
  while (remaining > 0) {
    const thisYear = Math.min(monthly * 12, remaining);
    const s = taxSaving({ kazeiShotoku: kazei, annualDeduction: thisYear }, D).total;
    if (years === 0) setsuzeiPerYearFirst = s;
    setsuzeiTotal += s;
    remaining -= thisYear;
    years += 1;
  }

  // 出口: 支給率（施行令4条）。納付12か月未満は不支給（法11条1項）＝支給率0。
  const type = T.shikyu_ritsu.types.find((t) => t.key === (input?.kaiyakuType || 'nini'));
  if (!type) throw new Error('解約の種類が不正です');
  let rate = 0, rateBand = null;
  if (monthsPaid >= T.min_months_for_teate) {
    for (const b of type.bands) {
      if (monthsPaid >= b.from && (b.upto == null || monthsPaid <= b.upto)) { rate = b.rate; rateBand = b; break; }
    }
  }
  const teate = Math.floor(paidTotal * rate);
  const kakesute = paidTotal - teate;

  // 解約手当金は全額が解約年の事業所得の収入金額。解約年の課税所得に上乗せしたときの増税を出す。
  const kaiyakuBase = input?.kaiyakuKazeiShotoku == null || input.kaiyakuKazeiShotoku === ''
    ? kazei : yen0(input.kaiyakuKazeiShotoku);
  const shotokuInc = Math.max(0, shotokuzei(kaiyakuBase + teate, D) - shotokuzei(kaiyakuBase, D));
  const fukkoInc = Math.floor(shotokuInc * (D.fukko_rate || 0));
  const juminInc = Math.floor(teate * (D.juminzei_shotokuwari_rate || 0));
  const zouzei = { shotokuInc, fukkoInc, juminInc, total: shotokuInc + fukkoInc + juminInc };

  // 差引 ＝ 入口の節税 − 出口の増税 − 掛け捨て。プラスなら得、マイナスなら「節税したつもりで損」。
  const net = setsuzeiTotal - zouzei.total - kakesute;

  return { monthlyValid, monthsPaid, paidTotal, capReached, years,
           setsuzeiPerYearFirst, setsuzeiTotal,
           rate, rateBand, teate, kakesute, zouzei, net, kaiyakuBase,
           type: { key: type.key, label: type.label },
           year: D._meta?.year || '' };
}

/**
 * 扶養控除: 区分ごとの人数から所得税・住民税の控除額合計を出す（区分の額は参照データが正本）。
 * @param counts { ippan, tokutei, rojin, dokyo_rojin } 各区分の人数
 * @returns { shotoku, jumin, count, items: [{key,label,n,shotoku,jumin}] }
 */
export function fuyoKojoTotal(counts, D) {
  if (!D?.fuyo?.kubun) throw new Error('参照データ（setsuzei_r08.json の fuyo）が渡されていません');
  let shotoku = 0, jumin = 0, count = 0;
  const items = [];
  for (const k of D.fuyo.kubun) {
    const n = Math.floor(Number(counts?.[k.key]));
    const nn = Number.isFinite(n) && n > 0 ? n : 0;
    if (!nn) continue;
    shotoku += k.shotoku * nn;
    jumin += k.jumin * nn;
    count += nn;
    items.push({ key: k.key, label: k.label, n: nn, shotoku: k.shotoku * nn, jumin: k.jumin * nn });
  }
  return { shotoku, jumin, count, items };
}

/**
 * ひとり親控除・寡婦控除の判定（所得税法2条1項30号・31号、80条・81条）。
 * 条文の判定順そのまま: 婚姻中／事実婚（規則1条の3・1条の4=住民票の「未届の夫・妻」）／
 * 合計所得500万円超は対象外 → 生計を一にする子（総所得金額等62万円以下・他の者の
 * 同一生計配偶者/扶養親族でない=所令11条の2第2項）がいれば**性別・未婚を問わず**ひとり親。
 * ひとり親に該当しない女性だけが寡婦の判定へ進む（30号柱書き「ひとり親に該当しないもの」）:
 * 離婚型（30号イ）は扶養親族が必要、死別・夫生死不明型（30号ロ）は扶養親族不要。
 * 未婚（結婚したことがない）は寡婦のどちらの型にも当たらない。
 * @param input {
 *   sex: 'female'|'male',
 *   marital: 'mikon'|'rikon'|'shibetsu'|'fumei'|'kikon',
 *   jijitsukon: boolean,           // 住民票に「夫(未届)」「妻(未届)」の記載がある
 *   child: 'none'|'qualified'|'not_qualified',
 *     // qualified = 生計を一にする子で所得62万円以下・他の人の扶養にもなっていない
 *     // not_qualified = 子はいるが所得62万円超、または別れた相手など他の人の扶養になっている
 *   otherFuyo: boolean,            // 子以外の扶養親族（合計所得62万円以下）がいる
 *   gokeiShotoku: number,          // 本人の合計所得金額（繰越控除前）
 * }
 * @returns { type: 'hitorioya'|'kafu'|'none', reason, label, shotoku, jumin, gokei, year }
 */
export function hitorioyaKafu(input, D) {
  if (!D?.hitorioya?.kojo) throw new Error('参照データ（setsuzei_r08.json の hitorioya）が渡されていません');
  const H = D.hitorioya;
  const gokei = yen0(input.gokeiShotoku);
  const year = H.year || D._meta?.year || '';
  const none = (reason) => ({ type: 'none', reason, label: '対象外', shotoku: 0, jumin: 0, gokei, year });
  const hit = (key, reason) => ({ type: key, reason, label: H.kojo[key].label,
    shotoku: H.kojo[key].shotoku, jumin: H.kojo[key].jumin, gokei, year });

  if (input.marital === 'kikon') return none('kikon');
  if (input.jijitsukon) return none('jijitsukon');
  if (gokei > H.income_limit) return none('income_over');

  // ひとり親（31号）: 未婚・離婚・死別・生死不明のすべてが「現に婚姻をしていない者」等に当たる
  if (input.child === 'qualified') return hit('hitorioya', 'child_qualified');

  // 寡婦（30号）: 条文が「夫と離婚」「夫と死別」— 女性のみ
  if (input.sex !== 'female') return none('male_no_child');
  if (input.marital === 'rikon') {
    return input.otherFuyo ? hit('kafu', 'rikon_fuyo') : none('rikon_no_fuyo');
  }
  if (input.marital === 'shibetsu' || input.marital === 'fumei') return hit('kafu', 'shibetsu_or_fumei');
  return none('mikon_no_child'); // 未婚（結婚したことがない）は寡婦にならない
}

/**
 * 勤労学生控除の判定（所得税法2条1項32号・82条）。
 * 条文の判定順そのまま: 学校の範囲（イ・ロ・ハ）→ 自己の勤労に基づいて得た
 * 事業所得・給与所得・退職所得・雑所得（給与所得等）を有する → 合計所得金額
 * 89万円以下（令和8年分から。改正前85万円）→ 給与所得等以外の所得10万円以下。
 * ★ロ（専修学校・各種学校）・ハ（認定職業訓練）は政令の課程要件（職業に必要な
 *   技術の教授・修業期間1年以上など＝所令11条の3）を満たす場合だけ対象。
 *   このコアは課程の中身を判定できないので courseNote を立てて返し、
 *   画面が「学校の証明書で確認」を必ず申告する（黙って無条件に該当とは言わない）。
 * @param input {
 *   school: 'ichijo'|'senshu'|'kunren'|'none',
 *   kinroShotoku,   // 勤労による所得の合計（給与所得＋自分の働きによる事業・雑所得。所得ベース）
 *   hikinroShotoku, // 勤労によらない所得（配当・不動産など）
 * }
 * @returns { type:'ok'|'none', reason, courseNote, gokei, shotoku, jumin, year }
 */
export function kinroGakuseiHantei(input, D) {
  if (!D?.kinro_gakusei?.kojo) throw new Error('参照データ（setsuzei_r08.json の kinro_gakusei）が渡されていません');
  const K = D.kinro_gakusei;
  const kinro = yen0(input.kinroShotoku);
  const hikinro = yen0(input.hikinroShotoku);
  const gokei = kinro + hikinro;
  const year = K.year || D._meta?.year || '';
  const courseNote = input.school === 'senshu' || input.school === 'kunren';
  const none = (reason) => ({ type: 'none', reason, courseNote, gokei, shotoku: 0, jumin: 0, year });

  // 32号柱書き「次に掲げる者で」: イ(1条校)・ロ(専修学校・各種学校)・ハ(認定職業訓練)以外は入口で外れる
  if (input.school !== 'ichijo' && input.school !== 'senshu' && input.school !== 'kunren') return none('not_student');
  // 「自己の勤労に基づいて得た…給与所得等を有するもの」: 勤労による所得がゼロなら対象外
  if (kinro <= 0) return none('no_kinro');
  // 「合計所得金額が89万円以下」
  if (gokei > K.income_limit) return none('income_over');
  // 「合計所得金額のうち給与所得等以外の所得に係る部分の金額が10万円以下」
  if (hikinro > K.hikinro_limit) return none('hikinro_over');
  return { type: 'ok', reason: 'ok', courseNote, gokei,
           shotoku: K.kojo.shotoku, jumin: K.kojo.jumin, year };
}

/**
 * 地震保険料控除（所得税法77条1項／地方税法34条1項5号の3・314条の2第1項5号の3）と、
 * 旧長期損害保険料の経過措置（所得税=平18法10 附則10条2項／住民税=平18法7 附則5条5項・11条5項）。
 *
 * ★所得税と住民税で式が3か所違う（住民税を所得税の式で出すと必ず過大になる）:
 *   (1) 地震分  所得税=支払額の全額 ／ 住民税=支払額の2分の1
 *   (2) 上限    所得税=5万円        ／ 住民税=2万5千円
 *   (3) 旧長期の帯の刻み  所得税=1万円・2万円 ／ 住民税=5千円・1万5千円
 * ★合計の上限は「地震分の上限」と同じ（所得税5万円・住民税2万5千円）なので、
 *   地震保険料だけで上限に達している人は、旧長期を足しても控除額は1円も増えない。
 * 帯は生命保険料控除と同じ seihoBand（条文の書き方どおり base+(x−minus)/div、1円未満切り上げ）で評価する。
 *
 * @param input { jishin(地震保険料の年間合計), kyuChoki(旧長期損害保険料の年間合計) }
 * @returns { shotoku:{jishin,kyuChoki,sum,total,capped,totalMax}, jumin:{...}, year }
 */
export function jishinHokenryoKojo(input, D) {
  if (!D?.jishin?.shotoku) throw new Error('参照データ（setsuzei_r08.json の jishin）が渡されていません');
  const J = D.jishin;
  const jishin = yen0(input?.jishin);
  const kyuChoki = yen0(input?.kyuChoki);

  const side = (T) => {
    // 支払いが無い区分は0（帯の先頭が「◯円以下＝全額」なので0を通しても0になるが、意図を明示する）
    const dJishin = jishin > 0 ? seihoBand(jishin, T.jishin) : 0;
    const dKyu = kyuChoki > 0 ? seihoBand(kyuChoki, T.kyu_choki) : 0;
    const sum = dJishin + dKyu;
    return {
      jishin: dJishin, kyuChoki: dKyu, sum,
      total: Math.min(sum, T.total_max),
      capped: sum > T.total_max,
      totalMax: T.total_max,
    };
  };

  return { shotoku: side(J.shotoku), jumin: side(J.jumin), year: J.year || D._meta?.year || '' };
}

/**
 * 一の契約が地震保険料・旧長期損害保険料の**どちらの区分にも該当する**とき、
 * どちらで申告した方が得かを実額で出す（所得税=平18法10 附則10条3項／住民税=平18法7 附則5条6項。
 * 国税庁No.1145は「納税者の選択により」と書くだけで、どちらが有利かは示さない）。
 *
 * 有利・不利は控除額そのものではなく**節税額**で決まる（所得税は超過累進なので、
 * 同じ控除額でも課税所得によって効き方が違う）。よって taxSavingSplit で比較する。
 *
 * @param input {
 *   jishin, kyuChoki,          // どちらの区分か確定している分の年間支払額
 *   bothJishin, bothKyuChoki,  // 両方に該当する一の契約の、証明書に載っている各区分の金額
 *   kazeiShotoku,
 * }
 * @returns { hasChoice, asJishin, asKyuChoki, best, diff }
 */
export function jishinHokenryoBest(input, D) {
  const bothJ = yen0(input?.bothJishin);
  const bothK = yen0(input?.bothKyuChoki);
  const base = { jishin: yen0(input?.jishin), kyuChoki: yen0(input?.kyuChoki) };
  const kazei = yen0(input?.kazeiShotoku);

  const evaluate = (jishin, kyuChoki) => {
    const kojo = jishinHokenryoKojo({ jishin, kyuChoki }, D);
    const saving = taxSavingSplit({
      kazeiShotoku: kazei,
      shotokuKojo: kojo.shotoku.total,
      juminKojo: kojo.jumin.total,
    }, D);
    return { kojo, saving };
  };

  if (bothJ <= 0 && bothK <= 0) {
    const only = evaluate(base.jishin, base.kyuChoki);
    return { hasChoice: false, asJishin: only, asKyuChoki: null, best: only, diff: 0 };
  }

  // その一の契約を「地震保険料の契約」として扱う場合 / 「旧長期の契約」として扱う場合
  const asJishin = evaluate(base.jishin + bothJ, base.kyuChoki);
  const asKyuChoki = evaluate(base.jishin, base.kyuChoki + bothK);
  const a = asJishin.saving.total;
  const b = asKyuChoki.saving.total;
  const best = a >= b ? asJishin : asKyuChoki;
  return {
    hasChoice: true, asJishin, asKyuChoki, best,
    bestKey: a >= b ? 'jishin' : 'kyu_choki',
    diff: Math.abs(a - b),
  };
}
