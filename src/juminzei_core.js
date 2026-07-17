/**
 * 住民税（所得割）と、ふるさと納税の全額控除される寄附額の上限（限度額）の計算ロジック。
 * DOM非依存・テスト対象。料率・控除額は juminzei_r08.json に持たせる（ページに手書きしない）。
 *
 * 一次ソース（すべて条文の生テキストを読んで実装した）:
 * - 地方税法（e-Gov法令API v2）
 *   314条の2 / 34条  所得控除（住民税の基礎控除43万円・扶養控除33万円 など）
 *   314条の3 / 35条  所得割の税率（市町村6%・道府県4%／指定都市は8%・2%）
 *   314条の6 / 37条  調整控除（市町村3%・道府県2%／指定都市は4%・1%）
 *   314条の7 / 37条の2  寄附金税額控除（基本分・特例分・特例分の20%上限）
 *   附則5条の6       ★特例控除額の割合の読替え（平成26年度〜令和20年度）
 *   20条の4の2       端数計算（課税標準は1,000円未満切捨／確定金額は100円未満切捨）
 * - 所得税法 28条2〜4項・別表第五（給与所得）／86条（基礎控除）
 * - 租税特別措置法 41条の16の2（令和7年分・令和8年分の基礎控除の上乗せ）
 *
 * ★★ この実装でいちばん大事な事実（ここを取り違えると黙って間違える）:
 *
 * 1. **地方税法「本則」の特例控除額の割合は、今日は一つも使われていない。**
 *    37条の2第11項の表は 85 / 80 / 70 / 67 / 57 / 50 / 45% と書いてあるが、
 *    附則5条の6が「平成26年度から令和20年度まで」これを
 *    84.895 / 79.79 / 69.58 / 66.517 / 56.307 / 49.16 / 44.055% に読み替える。
 *    （＝ 90% − 所得税の限界税率 × 1.021。復興特別所得税を織り込んだ値）
 *    本則だけを読んで作ると、限度額を**過大に**出す（割合が大きいほど限度額は小さくなるので、
 *    本則の70%で割ると69.58%で割るより限度額が小さく出る…ではなく、逆。下の注を見よ）。
 *    → 限度額 = 所得割額 × 20% ÷ 割合 + 2,000円 なので、**割合が小さいほど限度額は大きい**。
 *      本則70%で計算すると、実際（69.58%）より限度額を**小さく**見積もる。安全側ではあるが誤り。
 *      逆に「90% − 所得税率」（復興特別所得税を忘れる）で計算すると限度額を**過大**に出し、
 *      利用者は上限を超えて寄附して自腹を切る。
 *
 * 2. **給与所得は速算式では求まらない。**（所法28条4項）
 *    給与収入が660万円未満の人は「別表第五」で求めると法が命じている。
 *    別表第五は収入を**4,000円刻みの区分**に切り、その区分の**下限額**で控除を計算した表。
 *    速算式をそのまま当てると最大1,200円ほど給与所得がずれる。
 *    （この規則が別表第五の1,175行すべてで成り立つことを、条文の表そのもので検証した）
 *
 * 3. **指定都市（政令市）でも限度額は1円も変わらない。**
 *    所得割が 6:4 → 8:2、調整控除が 3%:2% → 4%:1%、特例控除額が 3/5:2/5 → 4/5:1/5 と
 *    市と県の**取り分の比だけ**が入れ替わり、合計は同じ。20%上限も市・県それぞれの所得割の20%なので
 *    合計すれば同じ。→ 限度額の計算では指定都市かどうかを聞く必要がない。
 *
 * 4. **限度額を決めるのは「今年の所得」であって、去年の住民税決定通知書ではない。**
 *    2026年に寄附した分は2027年度（令和9年度）の住民税から引かれ、その所得割は
 *    **2026年（令和8年分）の所得**で決まる。去年の通知書は見積りの材料にすぎない。
 *
 * 5. **金額は整数で計算する。** 84.895% は 84895/100000 と整数比で書く（浮動小数だと1円ずれる）。
 */

import { calcMonthly, calcKoyou } from './shaho_core.js';

/** null を「上限なし」として扱う区分表の検索 */
function pickBracket(list, value) {
  for (const b of list) {
    if (b.upto === null || b.upto === undefined || value <= b.upto) return b;
  }
  return list[list.length - 1];
}

/** 納税者本人の合計所得金額で段階的に減る控除（配偶者控除など）の検索 */
function pickByNozeisha(list, goukeiShotoku) {
  for (const b of list) {
    if (b.nozeisha_goukei_upto === null || b.nozeisha_goukei_upto === undefined) return b;
    if (goukeiShotoku <= b.nozeisha_goukei_upto) return b;
  }
  return list[list.length - 1];
}

/**
 * 円に丸める（0未満・未入力・数値でないものは0）。
 * ★ Math.max(0, Math.floor(undefined)) は 0 ではなく NaN を返す。
 *   省略可能な入力（社会保険料・その他の控除）を素通しすると、結果が丸ごと NaN になって画面が全損する。
 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 給与所得控除額（所法28条3項）。区分の「下限額」を渡して使う。
 * ※ 収入660万円未満では、別表第五の刻み（4,000円）に丸めた額を渡すこと。
 */
export function kyuyoKojo(shunyu, D) {
  const K = D.kyuyo_shotoku;
  const b = pickBracket(K.kojo_brackets, shunyu);
  if (b.rate_pct === 0) return b.base;
  return b.base + Math.floor((shunyu - b.over) * b.rate_pct / 100);
}

/**
 * 給与所得（所法28条2項〜4項・別表第五）。
 *
 * ★ 収入660万円未満は「別表第五」による（速算式ではない）:
 *    - 651,000円未満 … 0円
 *    - 651,000円以上 190万円未満 … 収入 − 650,000円（刻みなし）
 *    - 190万円以上 660万円未満 … 収入を4,000円刻みに切り捨てた額 A について A − 給与所得控除(A)
 *   660万円以上は速算式で求め、1円未満を切り捨てる（別表第五の備考）。
 */
export function kyuyoShotoku(shunyu, D) {
  const K = D.kyuyo_shotoku;
  const s = yen(shunyu);
  if (s < K.hyo5_zero_under) return 0;
  if (s < K.hyo5_flat_upper) return s - K.hyo5_flat_kojo;
  if (s < K.hyo5_upper) {
    const a = Math.floor(s / K.hyo5_step) * K.hyo5_step; // 別表第五の区分の下限額
    return a - kyuyoKojo(a, D);
  }
  return yen(s - kyuyoKojo(s, D));
}

/** 住民税の基礎控除（地税314条の2第2項）。合計所得2,400万円以下なら43万円 */
export function juminzeiKisoKojo(goukeiShotoku, D) {
  return pickBracket(D.juminzei_kiso_kojo.brackets, goukeiShotoku).amount;
}

/**
 * 所得税の基礎控除（所法86条1項＋措置法41条の16の2）。
 * ★ 住民税そのものには使わない。「人的控除差調整額」（ふるさと納税の割合の判定）にだけ要る。
 */
export function shotokuzeiKisoKojo(goukeiShotoku, D) {
  return pickBracket(D.shotokuzei_kiso_kojo.brackets, goukeiShotoku).amount;
}

/**
 * 家族構成（人的控除）の入力。すべて省略可。
 * { haigusha: 'none'|'ippan'|'rojin',
 *   fuyoIppan, fuyoTokutei, fuyoRojin, fuyoDokyoRooya,   … 人数
 *   shogaiIppan, shogaiTokubetsu, shogaiDokyoTokubetsu,  … 人数（本人・同一生計配偶者・扶養親族の合計）
 *   kafu, hitorioyaHaha, hitorioyaChichi, kinroGakusei } … 真偽
 */
function normalizeFamily(f) {
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  return {
    haigusha: f?.haigusha === 'ippan' || f?.haigusha === 'rojin' ? f.haigusha : 'none',
    fuyoIppan: n(f?.fuyoIppan),
    fuyoTokutei: n(f?.fuyoTokutei),
    fuyoRojin: n(f?.fuyoRojin),
    fuyoDokyoRooya: n(f?.fuyoDokyoRooya),
    shogaiIppan: n(f?.shogaiIppan),
    shogaiTokubetsu: n(f?.shogaiTokubetsu),
    shogaiDokyoTokubetsu: n(f?.shogaiDokyoTokubetsu),
    kafu: !!f?.kafu,
    hitorioyaHaha: !!f?.hitorioyaHaha,
    hitorioyaChichi: !!f?.hitorioyaChichi,
    kinroGakusei: !!f?.kinroGakusei,
    // ★16歳未満の扶養親族。所得控除には1円も効かない（平成24年に年少扶養控除が廃止された）が、
    //   均等割・所得割の非課税限度額の「扶養親族の数」には入る（施行令47条の3第1号・附則3条の3）。
    fuyoNensho: n(f?.fuyoNensho),
    // 地税295条1項2号の判定に使う（本人が障害者／未成年者か）。扶養親族の障害者控除とは別物。
    honninShogai: !!f?.honninShogai,
    honninMiseinen: !!f?.honninMiseinen,
  };
}

/** 住民税の人的控除の合計額（地税314条の2第1項） */
export function jintekiKojo(family, goukeiShotoku, D) {
  const f = normalizeFamily(family);
  const S = D.shotoku_kojo;
  let sum = 0;
  if (f.haigusha !== 'none') {
    sum += pickByNozeisha(S.haigusha[f.haigusha], goukeiShotoku).amount;
  }
  sum += f.fuyoIppan * S.fuyo_ippan;
  sum += f.fuyoTokutei * S.fuyo_tokutei;
  sum += f.fuyoRojin * S.fuyo_rojin;
  sum += f.fuyoDokyoRooya * S.fuyo_dokyo_rooya;
  sum += f.shogaiIppan * S.shogai_ippan;
  sum += f.shogaiTokubetsu * S.shogai_tokubetsu;
  sum += f.shogaiDokyoTokubetsu * S.shogai_dokyo_tokubetsu;
  if (f.kafu) sum += S.kafu;
  if (f.hitorioyaHaha || f.hitorioyaChichi) sum += S.hitorioya;
  if (f.kinroGakusei) sum += S.kinro_gakusei;
  return sum;
}

/**
 * 調整控除の計算に使う「人的控除の差」の合計（地税314条の6第1号イ / 37条1号イ）。
 * ★ 実際の控除額の差ではなく、法が表で定めた額。基礎控除分の5万円は必ず入る。
 */
export function jintekiSaGokei(family, goukeiShotoku, D) {
  const f = normalizeFamily(family);
  const J = D.jinteki_kojo_sa;
  let sum = J.kiso; // 5万円（基礎控除の差として法が定めた額）
  if (f.haigusha !== 'none') {
    sum += pickByNozeisha(J.haigusha[f.haigusha], goukeiShotoku).amount;
  }
  sum += f.fuyoIppan * J.fuyo_ippan;
  sum += f.fuyoTokutei * J.fuyo_tokutei;
  sum += f.fuyoRojin * J.fuyo_rojin;
  sum += f.fuyoDokyoRooya * J.fuyo_dokyo_rooya;
  sum += f.shogaiIppan * J.shogai_ippan;
  sum += f.shogaiTokubetsu * J.shogai_tokubetsu;
  sum += f.shogaiDokyoTokubetsu * J.shogai_dokyo_tokubetsu;
  if (f.kafu) sum += J.kafu;
  if (f.hitorioyaHaha) sum += J.hitorioya_haha;
  else if (f.hitorioyaChichi) sum += J.hitorioya_chichi;
  if (f.kinroGakusei) sum += J.kinro_gakusei;
  return sum;
}

/** 課税総所得金額（1,000円未満切捨・地税20条の4の2第1項） */
export function kazeiSoShotoku(goukeiShotoku, shotokuKojoGokei) {
  return Math.max(0, Math.floor((goukeiShotoku - shotokuKojoGokei) / 1000) * 1000);
}

/**
 * 調整控除（地税314条の6・37条）。市町村分・道府県分を別々に返す。
 * 前年の合計所得金額が2,500万円を超える人には無い。
 */
export function choseiKojo(kazei, saGokei, goukeiShotoku, shiteiToshi, D) {
  const C = D.chosei_kojo;
  if (goukeiShotoku > C.goukei_shotoku_limit) return { shichoson: 0, dofuken: 0, total: 0, base: 0 };
  let base;
  if (kazei <= C.threshold) {
    base = Math.min(saGokei, kazei); // 少ない方
  } else {
    base = Math.max(saGokei - (kazei - C.threshold), C.floor_amount); // 5万円を下回らない
  }
  if (base <= 0) return { shichoson: 0, dofuken: 0, total: 0, base: 0 };
  const sPct = shiteiToshi ? C.shitei_shichoson_pct : C.shichoson_pct;
  const dPct = shiteiToshi ? C.shitei_dofuken_pct : C.dofuken_pct;
  const shichoson = Math.floor(base * sPct / 100);
  const dofuken = Math.floor(base * dPct / 100);
  return { shichoson, dofuken, total: shichoson + dofuken, base };
}

/**
 * 人的控除差調整額（地税37条の2第11項1号）。
 * ＝ 調整控除の「人的控除の差の合計」＋（所得税の基礎控除 − 48万円。0未満なら0）
 * ★ 令和7年分・令和8年分は所得税の基礎控除が上乗せされている（58〜95万円）ので、
 *   この第2項が10〜47万円と大きい。ここを落とすと、特例控除額の割合の区分を1段階誤ることがある。
 */
export function jintekiChoseiGaku(family, goukeiShotoku, D) {
  const sa = jintekiSaGokei(family, goukeiShotoku, D);
  const kiso = shotokuzeiKisoKojo(goukeiShotoku, D);
  return sa + Math.max(0, kiso - 480000);
}

/**
 * 特例控除額の割合（地税37条の2第11項＋附則5条の6）。
 * pct_x1000（百分率×1000）で返す。84.895% → 84895。
 *
 * 判定に使うのは「住民税の課税総所得金額 − 人的控除差調整額」。
 * これが0未満で山林所得・退職所得がないときは 90%（第11項2号）。
 */
export function tokureiRitsu(kazei, choseiGaku, D) {
  const T = D.furusato.tokurei_ritsu;
  const diff = kazei - choseiGaku;
  if (diff < 0) return { pct_x1000: T.minus_pct_x1000, diff, honsoku_pct: 90, shotokuzei_pct: 0 };
  const b = pickBracket(T.brackets, diff);
  return { pct_x1000: b.pct_x1000, diff, honsoku_pct: b.honsoku_pct, shotokuzei_pct: b.shotokuzei_pct };
}

/**
 * ふるさと納税の限度額（全額控除される寄附額の上限）。
 *
 *   特例控除額 = (寄附金 − 2,000円) × 割合  … ただし 住民税所得割額(調整控除後) の20%が上限
 *   その上限にちょうど張り付く寄附額が「限度額」なので、
 *   限度額 = 所得割額 × 20% ÷ 割合 + 2,000円
 *
 * ★「割合」は附則5条の6の読替え後（84.895% など）。90% − 所得税率（×1.021を忘れる）で計算すると
 *   限度額を過大に出し、利用者は上限を超えて寄附して自腹を切る。
 */
export function furusatoGendo(shotokuwariAfterChosei, pct_x1000, D) {
  const F = D.furusato;
  const cap = Math.floor(shotokuwariAfterChosei * F.tokurei_cap_pct / 100); // 所得割額の20%
  if (cap <= 0) return { gendo: 0, cap: 0 };
  // (X − 2,000) × pct/100000 ≤ cap を満たす最大の X
  const gendo = Math.floor(cap * 100000 / pct_x1000) + F.jiko_futan;
  return { gendo, cap };
}

/**
 * 寄附額を入れたときの実際の控除額（基本分・特例分・所得税分）。
 *
 * ★ 寄附金税額控除は市町村分・道府県分を**別々に**計算する。1円未満は**切り上げ**る
 *   （大阪市の公表計算例：13,000円 × 84.895% × 4/5 = 8,829.08 → 8,830円、
 *     × 1/5 = 2,207.27 → 2,208円。合計してから丸めると1〜2円合わない）。
 * ★ 基本分の比は所得割の税率と同じ（市6%:県4%／指定都市 8%:2%）。
 *   特例分の比は 3/5:2/5（指定都市 4/5:1/5）。どちらも合計すれば10%・割合そのもので、
 *   **指定都市かどうかで合計額は変わらない**（1円未満の丸めを除く）。
 */
export function furusatoKojo(kifu, shotokuwariShichoson, shotokuwariDofuken, pct_x1000, shotokuzeiPct, sotShotokuTou, shiteiToshi, D) {
  const F = D.furusato;
  const Z = D.zeiritsu;
  const k = yen(kifu);
  const empty = { kihon: 0, tokurei: 0, tokureiCapped: false, shotokuzei: 0, total: 0, jikoFutan: k, kihonCapped: false };
  if (k <= F.jiko_futan) return empty;

  // 基本分は「総所得金額等の30%」が寄附額の上限（37条の2第1項）
  const kihonCap = Math.floor(sotShotokuTou * F.kihon_shotoku_cap_pct / 100);
  const kihonBase = Math.min(k, kihonCap);
  const kihonTaisho = Math.max(0, kihonBase - F.jiko_futan);

  const sPct = shiteiToshi ? Z.shitei_shichoson_pct : Z.shichoson_pct;
  const dPct = shiteiToshi ? Z.shitei_dofuken_pct : Z.dofuken_pct;
  const kihonS = Math.ceil(kihonTaisho * sPct / 100);
  const kihonD = Math.ceil(kihonTaisho * dPct / 100);

  // 特例分（20%上限つき）。★特例分には30%の上限は掛からない（11項に規定がない）
  const taisho = k - F.jiko_futan;
  // 指定都市は 4/5 : 1/5、それ以外は 3/5 : 2/5（附則5条の6が読み替える前の本則どおりの比）
  const [sNum, dNum] = shiteiToshi ? [4, 1] : [3, 2];
  const capS = Math.floor(shotokuwariShichoson * F.tokurei_cap_pct / 100);
  const capD = Math.floor(shotokuwariDofuken * F.tokurei_cap_pct / 100);
  const rawS = Math.ceil(taisho * pct_x1000 * sNum / (100000 * 5));
  const rawD = Math.ceil(taisho * pct_x1000 * dNum / (100000 * 5));
  const tokureiS = Math.min(rawS, capS);
  const tokureiD = Math.min(rawD, capD);

  // 所得税からの控除（寄附金控除・所得控除方式）: (寄附金 − 2,000) × 所得税の限界税率 × 1.021
  // ※所得税は総所得金額等の40%が寄附額の上限（所法78条2項）
  const shotokuzeiCap = Math.floor(sotShotokuTou * 40 / 100);
  const shotokuzeiTaisho = Math.max(0, Math.min(k, shotokuzeiCap) - F.jiko_futan);
  const shotokuzei = Math.floor(shotokuzeiTaisho * shotokuzeiPct * 1021 / (100 * 1000));

  const kihon = kihonS + kihonD;
  const tokurei = tokureiS + tokureiD;
  const total = kihon + tokurei + shotokuzei;
  return {
    kihon, kihonS, kihonD,
    tokurei, tokureiS, tokureiD,
    tokureiCapped: rawS > capS || rawD > capD,
    kihonCapped: k > kihonCap,
    shotokuzei,
    total,
    // 実質の自己負担額（2,000円で収まっていれば上限内）
    jikoFutan: Math.max(0, k - total),
  };
}

/**
 * 社会保険料（本人負担・年額）の**概算**。
 *
 * ★ なぜ概算をわざわざ作るのか（そして、なぜ「概算」と名乗り続けるのか）:
 *   限度額は社会保険料の実額で動く（社会保険料は全額が所得控除なので、課税所得＝所得割額＝限度額に
 *   そのまま効く）。ところが利用者は自分の社会保険料の年額を覚えていない。
 *   → **年収から概算し、画面に金額を出したうえで、源泉徴収票の実額で上書きできるようにする**。
 *
 * ★★ 総務省の「目安」一覧表を再現しようとしてはいけない（第20便の教訓）。
 *   あの表は**社会保険料の前提を公表していない**ので、合わせに行くと
 *   「自分の入力を相手の出力にフィッティングする」だけになり、検証にならない。
 *   ここでは前提（下の3つ）を**すべて画面に出して**、利用者が実額で上書きできる形にする。
 *
 * 前提（＝概算である理由。ここが実態と違う人は源泉徴収票の額を入れてもらう）:
 *   1. **賞与がない**ものとして年収を12等分する。賞与がある人は標準賞与額の上限
 *      （健保は年度累計573万円・厚年は1回150万円）が効くので、保険料は概算より少なくなりうる。
 *   2. 健康保険は**協会けんぽ**の都道府県料率（組合健保・共済は料率が違う）。
 *   3. 雇用保険は**一般の事業**の料率。
 *
 * 料率は shaho_rates_r08.json をそのまま使う（このツールのために数字を書き写さない ＝ 正本を1つにする）。
 *
 * @param {number} kyuyoShunyu 給与収入（年額・額面）
 * @param {number} age 年齢（40〜64歳は介護保険料がかかる）
 * @param {string} kenName 都道府県名（協会けんぽの料率表のキー）
 * @param {object} S shaho_rates_r08.json
 */
export function shakaiHokenGaisan(kyuyoShunyu, age, kenName, S) {
  if (!S) throw new Error('参照データ（shaho_rates_r08.json）が渡されていません');
  const shunyu = yen(kyuyoShunyu);
  if (shunyu <= 0) return { total: 0, kenkoKaigoKosodate: 0, kosei: 0, koyou: 0, monthly: 0, kenkoRate: 0, unknownKen: false };

  const kenkoRate = S.kenko_rates[kenName];
  const unknownKen = !(kenkoRate > 0);
  // 収録外の都道府県名を渡されたら黙って0%で計算しない（保険料が消えて限度額が過大になる）。
  const rate = unknownKen ? S.kenko_rates['東京都'] : kenkoRate;

  const monthly = Math.floor(shunyu / 12); // ★賞与なしの前提
  const m = calcMonthly(monthly, rate, S.kaigo_rate, Number(age) || 0, S.kosei_nenkin_rate, S.kosodate_rate);
  const kenkoKaigoKosodate = (m.kenkoKaigo.self + m.kosodate.self) * 12;
  const kosei = m.kosei.self * 12;

  // 雇用保険は標準報酬月額ではなく**賃金総額**にかかる（徴収法11条1項）。年収にそのまま当てる。
  const g = S.koyou.types.general;
  const koyou = calcKoyou(shunyu, g.total_permille, g.jigyo2_permille).self;

  return {
    total: kenkoKaigoKosodate + kosei + koyou,
    kenkoKaigoKosodate, kosei, koyou,
    monthly, kenkoRate: rate, kaigoApplies: m.kaigoApplies, unknownKen,
  };
}

/**
 * 入口。給与収入と家族構成から、住民税の所得割額とふるさと納税の限度額を出す。
 *
 * input = {
 *   kyuyoShunyu,        // 給与収入（年収・額面）
 *   shakaiHoken,        // 社会保険料の年額（実額）
 *   sonotaKojo,         // その他の所得控除（生命保険料控除・地震保険料控除・小規模企業共済等掛金 など）
 *   sonotaShotoku,      // 給与以外の所得（合計所得金額に足す）
 *   family,             // 上の normalizeFamily 参照
 *   shiteiToshi,        // 指定都市（政令市）に住んでいるか。★限度額には影響しない
 *   kifu                // （任意）実際に寄附する額。入れると控除の内訳を返す
 * }
 */
/** 自治体プリセットを引く。未知のキーは標準税率（先頭）に倒す。 */
export function pickJichitai(key, D) {
  const list = D.kintouwari.jichitai;
  return list.find((j) => j.key === key) || list[0];
}

/**
 * 非課税限度額の判定（地税295条1項・3項、附則3条の3）。
 *
 * ★★均等割と所得割は根拠も金額も別物:
 *   - 均等割: 基本額(級地で1.0/0.9/0.8倍) × 人数 + 10万 +（扶養等がいれば）加算額(級地倍率あり)
 *   - 所得割: 35万 × 人数 + 10万 +（扶養等がいれば）32万  ← 法律で全国一律。級地は効かない
 * 加算額が21万 vs 32万と違うので、「所得割は非課税だが均等割は課税される」帯ができる。
 */
export function hikazeiHantei(goukeiShotoku, sotShotokuTou, family, kyuchi, D) {
  const H = D.hikazei;
  const f = normalizeFamily(family);

  const fuyoCount =
    f.fuyoIppan + f.fuyoTokutei + f.fuyoRojin + f.fuyoDokyoRooya + f.fuyoNensho;
  const haigushaCount = f.haigusha !== 'none' ? 1 : 0;
  const ninzu = 1 + haigushaCount + fuyoCount; // 本人＋同一生計配偶者＋扶養親族
  const hasFuyo = haigushaCount + fuyoCount > 0; // 加算額が発動するか

  // 295条1項2号：本人が障害者・未成年者・寡婦・ひとり親で、合計所得135万円以下 → 均等割も所得割も非課税
  const honninTokurei =
    f.honninShogai || f.honninMiseinen || f.kafu || f.hitorioyaHaha || f.hitorioyaChichi;
  const jonrei295 = honninTokurei && goukeiShotoku <= H.shogaisha_goukei_limit;

  const K = H.kintouwari.kyuchi[String(kyuchi)] || H.kintouwari.kyuchi['1'];
  const kintouLimit = K.kihon * ninzu + H.kintouwari.plus + (hasFuyo ? K.kasan : 0);

  const S = H.shotokuwari;
  const shotokuLimit = S.kihon * ninzu + S.plus + (hasFuyo ? S.kasan : 0);

  // 均等割は「合計所得金額」、所得割は「総所得金額等」で判定する（条文が別の語を使っている）
  const kintouwariHikazei = jonrei295 || goukeiShotoku <= kintouLimit;
  const shotokuwariHikazei = jonrei295 || sotShotokuTou <= shotokuLimit;

  return {
    kintouwariHikazei,
    shotokuwariHikazei,
    kintouLimit,
    shotokuLimit,
    ninzu,
    hasFuyo,
    jonrei295,
    kyuchi: String(kyuchi),
    kyuchiLabel: K.label,
    // 所得割だけ非課税＝均等割（＋森林環境税）だけを払う帯
    kintouwariOnly: !kintouwariHikazei && shotokuwariHikazei,
  };
}

/** 均等割＋森林環境税。均等割が非課税なら森林環境税もかからない（森林環境税法4条）。 */
export function kintouwariGaku(jichitai, kintouwariHikazei, D) {
  if (kintouwariHikazei) {
    return { shichoson: 0, dofuken: 0, shinrin: 0, total: 0 };
  }
  const shinrin = D.kintouwari.shinrin_kankyozei;
  return {
    shichoson: jichitai.shichoson_kintou,
    dofuken: jichitai.dofuken_kintou,
    shinrin,
    total: jichitai.shichoson_kintou + jichitai.dofuken_kintou + shinrin,
  };
}

export function calc(input, D) {
  if (!D) throw new Error('参照データ（juminzei_r08.json）が渡されていません');

  const shunyu = yen(input.kyuyoShunyu);
  const kyuyo = kyuyoShotoku(shunyu, D);
  const sonotaShotoku = yen(input.sonotaShotoku);
  const goukei = kyuyo + sonotaShotoku; // 合計所得金額（＝総所得金額等。損失の繰越は扱わない）

  const kisoKojo = juminzeiKisoKojo(goukei, D);
  const shakai = yen(input.shakaiHoken);
  const sonotaKojo = yen(input.sonotaKojo);
  const jinteki = jintekiKojo(input.family, goukei, D);
  const kojoGokei = kisoKojo + shakai + sonotaKojo + jinteki;

  const kazei = kazeiSoShotoku(goukei, kojoGokei);

  // 自治体プリセット。未指定なら標準税率（＝従来の呼び出し側の挙動を変えない）。
  const hasJichitai = input.jichitai != null && input.jichitai !== '';
  const J = pickJichitai(input.jichitai, D);
  const shitei = hasJichitai ? !!J.shitei : !!input.shiteiToshi;

  const Z = D.zeiritsu;
  const sPct = shitei ? Z.shitei_shichoson_pct : Z.shichoson_pct;
  const dPct = shitei ? Z.shitei_dofuken_pct : Z.dofuken_pct;

  const saGokei = jintekiSaGokei(input.family, goukei, D);
  const chosei = choseiKojo(kazei, saGokei, goukei, shitei, D);

  // ★非課税の判定（均等割と所得割で別々に効く）。
  //   このコアは繰越損失を扱わないので「合計所得金額」＝「総所得金額等」として扱う。
  const hikazei = hikazeiHantei(goukei, goukei, input.family, input.kyuchi || 1, D);

  // ── ① 標準税率で計算した所得割額 ──────────────────────────────
  // ★★ふるさと納税の限度額は、必ずこちらで決まる。
  //   地税37条の2第11項の20%上限は「第三十五条及び前条の規定を適用した場合の所得割の額」＝
  //   標準税率で計算した額を明文で指すので、自治体の超過課税・減税は限度額を1円も動かさない。
  const shichosonRaw = Math.floor(kazei * sPct / 100);
  const dofukenRaw = Math.floor(kazei * dPct / 100);
  const shichoson = Math.max(0, shichosonRaw - chosei.shichoson);
  const dofuken = Math.max(0, dofukenRaw - chosei.dofuken);
  // 所得割が非課税なら、控除される所得割そのものが無い（限度額も自己負担2,000円だけになる）
  const shotokuwari = hikazei.shotokuwariHikazei ? 0 : shichoson + dofuken;

  // ── ② その自治体で実際に課される所得割額 ──────────────────────
  // 超過課税（神奈川県 +0.025%）・減税（名古屋市 7.7%）はこちらにだけ効く。
  const aSPct1000 = hasJichitai ? J.shichoson_pct_x1000 : sPct * 1000;
  const aDPct1000 = hasJichitai ? J.dofuken_pct_x1000 : dPct * 1000;
  const jissaiShichoson = hikazei.shotokuwariHikazei
    ? 0 : Math.max(0, Math.floor(kazei * aSPct1000 / 100000) - chosei.shichoson);
  const jissaiDofuken = hikazei.shotokuwariHikazei
    ? 0 : Math.max(0, Math.floor(kazei * aDPct1000 / 100000) - chosei.dofuken);
  const shotokuwariJissai = jissaiShichoson + jissaiDofuken;

  // ── ③ 均等割＋森林環境税 ────────────────────────────────────
  const kintou = kintouwariGaku(J, hikazei.kintouwariHikazei, D);

  const choseiGaku = jintekiChoseiGaku(input.family, goukei, D);
  const R = tokureiRitsu(kazei, choseiGaku, D);
  const { gendo, cap } = furusatoGendo(shotokuwari, R.pct_x1000, D);

  const out = {
    kyuyoShotoku: kyuyo,
    goukeiShotoku: goukei,
    kisoKojo,
    jintekiKojo: jinteki,
    shotokuKojoGokei: kojoGokei,
    kazeiSoShotoku: kazei,
    choseiKojo: chosei,
    shotokuwariShichoson: shichoson,
    shotokuwariDofuken: dofuken,
    shotokuwari,
    jintekiSaGokei: saGokei,
    jintekiChoseiGaku: choseiGaku,
    tokureiRitsu: R,
    furusatoGendo: gendo,
    tokureiCap: cap,
    year: D._meta?.year || '',

    // 住民税そのもの（/juminzei/ が使う）
    jichitai: J,
    hikazei,
    shotokuwariJissaiShichoson: jissaiShichoson,
    shotokuwariJissaiDofuken: jissaiDofuken,
    shotokuwariJissai,
    kintouwari: kintou,
    juminzeiTotal: shotokuwariJissai + kintou.total,
  };

  if (input.kifu != null && input.kifu !== '') {
    out.kifu = furusatoKojo(
      input.kifu, shichoson, dofuken, R.pct_x1000, R.shotokuzei_pct, goukei, shitei, D
    );
  }
  return out;
}
