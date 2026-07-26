// 不動産（土地・建物）を売ったときの譲渡所得・税額の計算（分離課税）
//
// 正本データは docs/assets/jouto_r08.json（税率・償却率・控除額・期限は全てそちら）。
// このファイルには数値を直書きしない ── 制度が動いたときに画面だけ古い数字を名乗るのを防ぐため。
//
// ★このツールの急所は「所有期間は譲渡した年の1月1日で数える」こと（措法31条1項）。
//   譲渡日で数えると短期(39.63%)と長期(20.315%)を取り違え、税額がおよそ2倍ずれる。
//
// 日付は YYYY-MM-DD の文字列比較で扱う（new Date("YYYY-MM-DD") は UTC 解釈になり、
// JST では当日の 00:00〜09:00 が「まだ来ていない」と判定される ── keiri-tools/CLAUDE.md）。

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" を {y,m,d} に分解する。壊れた日付は例外にする（黙って0年にしない）。 */
export function parseDate(s, label) {
  const m = DATE_RE.exec(String(s || "").trim());
  if (!m) throw new Error(`${label || "日付"}は YYYY-MM-DD の形で入力してください`);
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new Error(`${label || "日付"}に存在しない日付が入力されています`);
  }
  return { y, m: mo, d };
}

/** a から b までの経過を「年＋端数月」で返す（a < b を前提。月末の繰り越しを起こさない）。 */
function spanYM(a, b) {
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;              // 日で足りない分は1か月未満として落とす
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12, totalMonths: months };
}

/**
 * 所有期間（譲渡した年の1月1日時点）。措法31条1項・2項。
 * 「取得をした日の翌日から引き続き所有していた期間」を、譲渡した年の1月1日で数える。
 */
export function shoyuKikanAt1Jan(shutokuBi, joutoBi) {
  const a = parseDate(shutokuBi, "取得日");
  const b = parseDate(joutoBi, "譲渡日");
  const joutoYmd = `${b.y}-${String(b.m).padStart(2, "0")}-${String(b.d).padStart(2, "0")}`;
  const shutokuYmd = `${a.y}-${String(a.m).padStart(2, "0")}-${String(a.d).padStart(2, "0")}`;
  if (joutoYmd <= shutokuYmd) {
    throw new Error("譲渡日は取得日より後の日付を入力してください");
  }
  // 取得の日の「翌日」から数える（31条2項）。日付は文字列で持ち回るので +1日は Date で行い、
  // その場で YYYY-MM-DD に戻す（UTC解釈でも +1日 の結果は同じ暦日になる）。
  const next = new Date(Date.UTC(a.y, a.m - 1, a.d + 1));
  const start = { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
  const kijun = { y: b.y, m: 1, d: 1 };    // ★譲渡日ではなく、譲渡した年の1月1日
  const startYmd = ymd(start);
  const kijunYmd = `${b.y}-01-01`;
  const at1Jan = kijunYmd < startYmd ? { years: 0, months: 0, totalMonths: 0 } : spanYM(start, kijun);
  const atJouto = spanYM(start, b);
  return {
    kijunbi: kijunYmd,
    startYmd,                 // 所有期間の起算日（取得日の翌日）
    kijunYmd,                 // 判定基準日（譲渡した年の1月1日）
    years: at1Jan.years,
    months: at1Jan.months,
    totalMonths: at1Jan.totalMonths,
    joutoJitenYears: atJouto.years,
    joutoJitenMonths: atJouto.months,
  };
}

/** {y,m,d} を "YYYY-MM-DD" に戻す。 */
function ymd(o) {
  return `${o.y}-${String(o.m).padStart(2, "0")}-${String(o.d).padStart(2, "0")}`;
}

/**
 * 「その年1月1日において所有期間が n年を超える」か。
 * ★年月の切り捨て（years/months）で判定してはいけない。起算日に n年 を足した日と基準日を
 *   日付そのもので比べる。例: 2020-12-30取得（起算日 12-31）を2026年に譲渡すると
 *   所有期間は5年と2日で「5年を超える」＝長期だが、月単位に丸めると5年0か月に見えて
 *   短期(39.63%)と誤判定し、税額がおよそ2倍ずれる。
 */
export function koeruKikan(kikan, n) {
  const s = parseDate(kikan.startYmd);
  const plusN = ymd({ y: s.y + n, m: s.m, d: s.d });
  return kikan.kijunYmd > plusN;
}

/** 経過年数（所令85条2項2号: 6月以上の端数は1年、6月未満は切捨て）。減価償却に使う。 */
export function keikaNensu(shutokuBi, joutoBi) {
  const a = parseDate(shutokuBi, "取得日");
  const b = parseDate(joutoBi, "譲渡日");
  const s = spanYM(a, b);
  return s.months >= 6 ? s.years + 1 : s.years;
}

/**
 * 建物の減価償却費相当額（非業務用）。所令85条・国税庁 No.3261。
 *   建物の取得価額 × 0.9 × 償却率 × 経過年数（取得価額の95%が限度）
 */
export function genkaShokyaku({ tatemonoShutokuKagaku, kozoKey, shutokuBi, joutoBi }, D) {
  requireData(D);
  const kozo = D.shokyaku.kozo.find((k) => k.key === kozoKey);
  if (!kozo) throw new Error("建物の構造を選んでください");
  const nensu = keikaNensu(shutokuBi, joutoBi);
  const raw = tatemonoShutokuKagaku * D.shokyaku.shikiso * kozo.ritsu * nensu;
  const gendo = tatemonoShutokuKagaku * (D.shokyaku.gendo_pct / 100);
  const capped = raw > gendo;
  return {
    gaku: Math.floor(capped ? gendo : raw),
    keikaNensu: nensu,
    kozo,
    gendoTekiyo: capped,
    gendoGaku: Math.floor(gendo),
    shikiso: D.shokyaku.shikiso,
  };
}

function requireData(D) {
  if (!D || !D.zeiritsu || !D.shokyaku || !D.tokubetsu_kojo || !D.fukko) {
    throw new Error("参照データ（税率・償却率・控除額）を読み込めていません");
  }
}

const yen = (n) => Math.floor(n);

/**
 * 譲渡所得と税額の計算。
 *
 * input:
 *   joutoKagaku        譲渡価額（売却代金）
 *   joutoHiyo          譲渡費用（仲介手数料など）
 *   tochiShutokuhi     土地の取得費（実額）
 *   tatemonoShutokuKagaku 建物の取得価額（実額・減価償却前）
 *   kozoKey            建物の構造キー
 *   shutokuBi/joutoBi  取得日・譲渡日（YYYY-MM-DD）
 *   gaisanOnly         true なら概算取得費（5%）だけで計算する（実額が分からない）
 *   tokureiKey         "none" | "kyojuyo" | "akiya"
 *   sozokuninSu        空き家特例のときの相続人の数
 *   keigenZeiritsu     10年超軽減税率を使うか（居住用で10年超のとき）
 *   jigyoYo            賃貸など事業に使っていた期間があるか（あるならこの償却計算は使えない）
 */
export function calcJouto(input, D) {
  requireData(D);
  const {
    joutoKagaku = 0, joutoHiyo = 0,
    tochiShutokuhi = 0, tatemonoShutokuKagaku = 0,
    kozoKey = "mokuzo", shutokuBi, joutoBi,
    gaisanOnly = false, tokureiKey = "none",
    sozokuninSu = 1, keigenZeiritsu = false, jigyoYo = false,
  } = input;

  if (!(joutoKagaku > 0)) throw new Error("譲渡価額（売却代金）を入力してください");

  const kikan = shoyuKikanAt1Jan(shutokuBi, joutoBi);
  const joutoY = parseDate(joutoBi, "譲渡日").y;
  const notes = [];

  // ── 取得費 ───────────────────────────────────────────────
  // 実額（建物は減価償却後）と概算取得費5%を両方出し、大きい方を採る。
  // ★5%は「取得費が分からないとき」だけの逃げ道ではない。実額が5%を下回るときも使える
  //   （国税庁 No.3258 / No.3208・措法31条の4はただし書で実額がそれを上回る場合に実額とする構造）。
  const gaisan = yen(joutoKagaku * D.shutokuhi.gaisan_rate);
  let shokyaku = null, jitsugaku = null;
  if (!gaisanOnly) {
    shokyaku = tatemonoShutokuKagaku > 0
      ? genkaShokyaku({ tatemonoShutokuKagaku, kozoKey, shutokuBi, joutoBi }, D)
      : null;
    const tatemonoAfter = tatemonoShutokuKagaku - (shokyaku ? shokyaku.gaku : 0);
    jitsugaku = yen(tochiShutokuhi + tatemonoAfter);
  }
  const useGaisan = gaisanOnly || jitsugaku === null || jitsugaku < gaisan;
  const shutokuhi = useGaisan ? gaisan : jitsugaku;
  if (!gaisanOnly && jitsugaku !== null && jitsugaku < gaisan) {
    notes.push("実額の取得費が譲渡価額の5%を下回るため、概算取得費（5%）を使いました（国税庁 No.3258）。");
  }
  if (jigyoYo) {
    notes.push("★賃貸などで事業に使っていた期間がある建物は、その期間について毎年の減価償却費を合計する必要があります。このツールの減価償却費相当額（非業務用の算式）は使えません。");
  }

  // ── 譲渡所得 ─────────────────────────────────────────────
  const joutoShotoku = joutoKagaku - shutokuhi - joutoHiyo;

  // ── 特別控除 ─────────────────────────────────────────────
  const tokurei = tokureiKey === "none" ? null : D.tokubetsu_kojo[tokureiKey];
  let kojoGaku = 0, kojoName = "なし", kojoRieki = 0, akiyaBlocked = null;
  if (tokurei) {
    let limit = tokurei.gaku_en;
    if (tokureiKey === "akiya") {
      // 相続人が3人以上なら控除額が2,000万円に下がる（措法35条4項）
      if (sozokuninSu >= tokurei.sozokunin_shikii) {
        limit = tokurei.gaku_en_3nin_ijo;
        notes.push(`相続人が${sozokuninSu}人（${tokurei.sozokunin_shikii}人以上）なので、控除額は3,000万円ではなく2,000万円です（措法35条4項）。`);
      }
      // 1億円超は特例そのものが使えない
      if (joutoKagaku > tokurei.taika_jogen_en) {
        akiyaBlocked = "taika";
        limit = 0;
      }
      // 適用期限（令和9年12月31日）を過ぎたら fail closed
      const joutoYmd = `${joutoY}-${String(parseDate(joutoBi).m).padStart(2, "0")}-${String(parseDate(joutoBi).d).padStart(2, "0")}`;
      if (joutoYmd > tokurei.kigen) {
        akiyaBlocked = akiyaBlocked || "kigen";
        limit = 0;
      }
    }
    kojoGaku = Math.max(0, Math.min(limit, Math.max(0, joutoShotoku)));
    kojoName = tokurei.name;
    kojoRieki = kojoGaku;
  }

  // 課税譲渡所得金額（1,000円未満切捨て・国税通則法118条1項）。損失は0扱い。
  const kazeiRaw = Math.max(0, joutoShotoku - kojoGaku);
  const unit = D.hasu.kazei_jouto_kirisute_en;
  const kazei = Math.floor(kazeiRaw / unit) * unit;

  // ── 税率 ─────────────────────────────────────────────────
  const isChoki = koeruKikan(kikan, D.shoyu_kikan.choki_koeru_years);
  const is10Choki = koeruKikan(kikan, D.shoyu_kikan.keigen_koeru_years);
  const keigenOK = keigenZeiritsu && is10Choki && tokureiKey === "kyojuyo";

  // 復興特別所得税は令和19年分まで。過ぎた年分には掛けない（黙って古い税率を当てない）。
  const fukkoOn = joutoY <= D.fukko.until_year;
  const fukkoMul = fukkoOn ? 1 + D.fukko.rate : 1;
  if (!fukkoOn) {
    notes.push(`${joutoY}年分の譲渡なので、復興特別所得税（令和19年＝${D.fukko.until_year}年分まで）は掛かりません。`);
  }

  let shotokuZei = 0, juminZei = 0, kubun, zeiritsuLabel, uchiwake = [];
  if (keigenOK) {
    const k = D.zeiritsu.keigen;
    const ika = Math.min(kazei, k.kijun_en);
    const koe = Math.max(0, kazei - k.kijun_en);
    shotokuZei = ika * (k.ika.shotoku_pct / 100) + koe * (k.koe.shotoku_pct / 100);
    juminZei = ika * (k.ika.jumin_pct / 100) + koe * (k.koe.jumin_pct / 100);
    kubun = k.name;
    zeiritsuLabel = `6,000万円以下の部分 ${k.ika.goukei_pct_with_fukko}%／超える部分 ${k.koe.goukei_pct_with_fukko}%`;
    uchiwake = [
      { label: `6,000万円以下の部分`, gaku: ika, shotokuPct: k.ika.shotoku_pct, juminPct: k.ika.jumin_pct },
      { label: `6,000万円を超える部分`, gaku: koe, shotokuPct: k.koe.shotoku_pct, juminPct: k.koe.jumin_pct },
    ];
  } else {
    const z = isChoki ? D.zeiritsu.choki : D.zeiritsu.tanki;
    shotokuZei = kazei * (z.shotoku_pct / 100);
    juminZei = kazei * (z.jumin_pct / 100);
    kubun = z.name;
    zeiritsuLabel = `合計 ${z.goukei_pct_with_fukko}%（所得税${z.shotoku_pct}%＋復興特別所得税＋住民税${z.jumin_pct}%）`;
    uchiwake = [{ label: "課税譲渡所得金額", gaku: kazei, shotokuPct: z.shotoku_pct, juminPct: z.jumin_pct }];
  }
  const shotokuZeiY = yen(shotokuZei);
  const fukkoZeiY = yen(shotokuZei * (fukkoOn ? D.fukko.rate : 0));
  const juminZeiY = yen(juminZei);
  const goukei = shotokuZeiY + fukkoZeiY + juminZeiY;

  // ── 短期だったとき「年を越したら長期になるか」を出す（行動に移せる答えにする） ──
  let kurikoshi = null;
  if (!isChoki) {
    // 翌年1月2日を仮の譲渡日として、その年の1月1日で数え直す
    const next = shoyuKikanAt1Jan(shutokuBi, `${joutoY + 1}-01-02`);
    if (koeruKikan(next, D.shoyu_kikan.choki_koeru_years)) {
      const c = D.zeiritsu.choki;
      const sz = yen(kazei * (c.shotoku_pct / 100));
      const fz = yen(kazei * (c.shotoku_pct / 100) * (fukkoOn ? D.fukko.rate : 0));
      const jz = yen(kazei * (c.jumin_pct / 100));
      kurikoshi = { year: joutoY + 1, goukei: sz + fz + jz, sagaku: goukei - (sz + fz + jz) };
    }
  }

  return {
    kikan, isChoki, is10Choki, keigenTekiyo: keigenOK,
    kubun, zeiritsuLabel, uchiwake,
    gaisan, jitsugaku, useGaisan, shutokuhi, shokyaku,
    joutoShotoku, kojoGaku, kojoName, kojoRieki, akiyaBlocked,
    kazeiRaw, kazei,
    shotokuZei: shotokuZeiY, fukkoZei: fukkoZeiY, juminZei: juminZeiY, goukei,
    tedori: joutoKagaku - joutoHiyo - goukei,
    fukkoOn, joutoYear: joutoY, kurikoshi, notes,
    dataYear: D._meta && D._meta.year,
  };
}
