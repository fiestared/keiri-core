/**
 * 減価償却費（定額法・200%定率法）の年次スケジュールを出す計算コア（DOM非依存・テスト対象）。
 *
 * 対象は **平成19年4月1日以後に取得**した減価償却資産（定額法）と
 * **平成24年4月1日以後に取得**した減価償却資産（定率法＝200%定率法）。
 * それ以前の取得は旧定額法・旧定率法（別表第七）で計算が違うので、このコアは扱わない。
 *
 * ★このツールが黙って誤答しやすい急所（すべて一次情報で確認済み。出典は SEIDO の各行）:
 *
 *  1. **定率法は「償却保証額」を下回った年から算式が変わる**（法令48条の2第1項1号ロ・5項）。
 *     未償却残高×償却率 を最後まで続けると、いつまでも償却しきれない（等比数列なので0にならない）。
 *     調整前償却額が償却保証額に満たなくなった年の**期首未償却残高＝改定取得価額**を固定し、
 *     以後は 改定取得価額×改定償却率 の**定額**に切り替える。
 *
 *  2. **改定取得価額は「最初に満たなくなった年」の期首未償却残高で固定**（国税庁 No.2106 注2）。
 *     毎年その年の期首残高で取り直すと、償却費が毎年減り続けて償却しきれない。
 *
 *  3. **残存簿価1円を残すのは有形減価償却資産だけ**（所令134条1項・国税庁 No.2106「限度額」）。
 *     ソフトウエア等の**無形固定資産と坑道は取得価額まで**償却する（1円を残さない）。
 *     一律に1円残すと、無形資産で永久に1円が残る。
 *
 *  4. **年の中途で事業に使い始めた年は月割**（国税庁 No.2106 注1）。
 *     「上記の金額を12で除し業務に使用していた月数を乗じる」＝**償却保証額との比較は
 *     月割前の年額（調整前償却額）で行い、月割は最後に掛ける**。順序を逆にすると、
 *     初年度だけ判定が早まって改定償却率への切替年がずれる。
 *
 *  5. **定率法の耐用年数2年には改定償却率・保証率が存在しない**（別表第十は「―」）。
 *     償却率1.000で初年度に償却しきるため改定の余地がない。ここを0や欠測で埋めず、
 *     「切り替えは起きない」として扱う。
 *
 *  6. **中古資産の簡便法は、資本的支出が取得価額の50%を超えると使えない**（耐令3条1項ただし書）。
 *     さらに再取得価額の50%超なら法定耐用年数による（国税庁 No.5404 注）。
 *     この但し書きを落とすと、使えない人に短い耐用年数を答えて過大償却させる。
 *
 * 端数処理: 償却費に法令上の端数規定は無いため**円未満切捨て**で計算し、画面で申告する。
 * 償却保証額との比較は**切捨て前の値**で行う（国税庁の例が 52,428.8→「52,429」と
 * 丸めて示しているのは説明のためで、比較の実体は算式の値）。
 *
 * 一次情報:
 *  - 減価償却資産の耐用年数等に関する省令（昭和40年大蔵省令15号）別表第八・別表第十・3条
 *    ＝ e-Gov法令API v2（リビジョン 340M50000040015_20260522_508M60000040029）を逐語取得し
 *    `tools/parse_shokyaku_tables.py` で機械抽出 → `assets/shokyaku_rates_r08.json`
 *  - 国税庁 タックスアンサー No.2106（定額法と定率法による減価償却）
 *  - 国税庁 タックスアンサー No.5404（中古資産の耐用年数）
 */

/** 制度の定数。画面はここから描く（ページに数字を手書きしない）。 */
export const SEIDO = {
  /** 有形減価償却資産に残す備忘価額（円）。所令134条1項・国税庁 No.2106「限度額」。 */
  bibouKagaku: 1,
  /** 中古資産の簡便法で経過年数に掛ける割合。耐令3条1項2号。 */
  chukoKeikaRatio: 0.2,
  /** 簡便法の下限年数。耐令3条1項2号「二年に満たないときは、これを二年とする」。 */
  chukoMinYears: 2,
  /** 簡便法が使えなくなる資本的支出の割合（取得価額比）。耐令3条1項ただし書。 */
  chukoShihontekiLimitRatio: 0.5,
  /** 定率法の倍率（平成24年4月1日以後取得）。別表第十＝定額法償却率×2.0。 */
  teiritsuMultiplier: 2.0,
  /** このコアが扱う取得時期の下限（これ以前は旧定額法・旧定率法）。 */
  teigakuFrom: '2007-04-01',
  teiritsuFrom: '2012-04-01',
};

/** 償却方法の選択肢。画面のセレクトはここから描く。 */
export const METHODS = [
  { key: 'teigaku', label: '定額法', note: '毎年ほぼ同額。個人事業主の原則。' },
  { key: 'teiritsu', label: '定率法（200%定率法）', note: '初めの年ほど多い。法人の機械・器具備品の原則。' },
];

/** 資産の種類。1円を残すかどうかが変わる（急所3）。 */
export const ASSET_KINDS = [
  { key: 'yukei', label: '有形減価償却資産（建物・車両・器具備品など）', leavesMemo: true },
  { key: 'mukei', label: '無形固定資産（ソフトウエア・特許権など）・坑道', leavesMemo: false },
];

function floorYen(x) {
  return Math.floor(x + 1e-9);
}

/**
 * 中古資産の見積耐用年数を簡便法で出す（耐令3条1項2号）。
 *
 * @param {number} houtei 法定耐用年数（年）
 * @param {number} keika  経過年数（年。0以上）
 * @param {{shihontekiShishutsu?: number, shutokuKagaku?: number}} [opts]
 *        資本的支出の額と取得価額。取得価額の50%超なら簡便法は使えない（急所6）。
 * @returns {{years: number|null, unavailable: boolean, reason: string, steps: object}}
 */
export function chukoTaiyoNensu(houtei, keika, opts) {
  const o = opts || {};
  const h = Number(houtei);
  const k = Number(keika);
  if (!(h >= 2) || !isFinite(h)) {
    return { years: null, unavailable: true, reason: '法定耐用年数を2年以上で入力してください。', steps: {} };
  }
  if (!(k >= 0) || !isFinite(k)) {
    return { years: null, unavailable: true, reason: '経過年数を0以上で入力してください。', steps: {} };
  }
  const shishutsu = Number(o.shihontekiShishutsu || 0);
  const shutoku = Number(o.shutokuKagaku || 0);
  if (shutoku > 0 && shishutsu > shutoku * SEIDO.chukoShihontekiLimitRatio) {
    return {
      years: null,
      unavailable: true,
      reason: '資本的支出が取得価額の50%を超えるため、簡便法は使えません（耐令3条1項ただし書）。'
        + '再取得価額の50%も超える場合は法定耐用年数によります。',
      steps: { shishutsu, shutoku },
    };
  }
  // イ 全部経過／ロ 一部経過
  const zenbu = k >= h;
  const raw = zenbu ? h * SEIDO.chukoKeikaRatio : (h - k) + k * SEIDO.chukoKeikaRatio;
  // 1年未満の端数は切捨て → 2年未満は2年（耐通1-5-1・国税庁 No.5404）
  const truncated = Math.floor(raw + 1e-9);
  const years = Math.max(SEIDO.chukoMinYears, truncated);
  return {
    years,
    unavailable: false,
    reason: '',
    steps: { zenbu, raw, truncated, floored: truncated < SEIDO.chukoMinYears },
  };
}

/**
 * 減価償却の年次スケジュールを出す。
 *
 * @param {object} p
 * @param {number} p.shutokuKagaku 取得価額（円）
 * @param {number} p.taiyoNensu    耐用年数（年）
 * @param {'teigaku'|'teiritsu'} p.method 償却方法
 * @param {object} p.rates         `assets/shokyaku_rates_r08.json` の中身（**必ず届いてから渡す**）
 * @param {number} [p.firstYearMonths=12] 初年度に事業の用に供していた月数（1〜12）
 * @param {'yukei'|'mukei'} [p.assetKind='yukei'] 資産の種類（1円を残すか）
 * @param {number} [p.startYear]   1年目の暦年（表示用。省略可）
 * @returns {{ok: boolean, error?: string, beyondData?: boolean, rows: Array, total: number,
 *            shokyakuHoshouGaku: number|null, kaiteiShutokuKagaku: number|null, meta: object}}
 */
export function calcShokyaku(p) {
  const out = {
    ok: false, rows: [], total: 0,
    shokyakuHoshouGaku: null, kaiteiShutokuKagaku: null, meta: {},
  };
  const price = Number(p && p.shutokuKagaku);
  const n = Number(p && p.taiyoNensu);
  const method = (p && p.method) || 'teigaku';
  const months = p && p.firstYearMonths != null ? Number(p.firstYearMonths) : 12;
  const kind = (p && p.assetKind) || 'yukei';
  const rates = p && p.rates;

  if (!rates || !rates.teigaku || !rates.teiritsu_200) {
    // 参照データが届いていない。**推測で答えない**（fail closed）。
    return Object.assign(out, { error: '償却率データが読み込めていません。' });
  }
  if (!isFinite(price) || price <= 0) {
    return Object.assign(out, { error: '取得価額を1円以上で入力してください。' });
  }
  if (!isFinite(n) || n < 2 || n !== Math.floor(n)) {
    return Object.assign(out, { error: '耐用年数は2年以上の整数で入力してください。' });
  }
  if (!isFinite(months) || months < 1 || months > 12 || months !== Math.floor(months)) {
    return Object.assign(out, { error: '初年度の月数は1〜12の整数で入力してください。' });
  }

  const key = String(n);
  const table = method === 'teiritsu' ? rates.teiritsu_200 : rates.teigaku;
  if (!(key in table)) {
    // 収録範囲（耐用年数2〜100年）の外。黙って答えない。
    return Object.assign(out, {
      beyondData: true,
      error: '耐用年数' + n + '年は償却率表（2〜100年）の収録範囲外です。',
    });
  }

  const memo = kind === 'mukei' ? 0 : SEIDO.bibouKagaku;
  const limit = price - memo;              // 償却できる上限の累計額
  const rows = [];
  let boka = price;                        // 期首未償却残高
  let cum = 0;
  let kaiteiShutoku = null;                // 改定取得価額（固定される）
  let hoshou = null;

  if (method === 'teigaku') {
    const rate = table[key];
    out.meta = { rate: rate, method: 'teigaku' };
    // 定額法: 毎年 取得価額×償却率。初年度だけ月割。
    for (let i = 1; i <= 200; i++) {
      const annual = price * rate;
      const raw = i === 1 ? annual * months / 12 : annual;
      let amount = floorYen(raw);
      const remain = limit - cum;
      let last = false;
      if (amount >= remain) { amount = remain; last = true; }
      rows.push({
        n: i,
        year: p.startYear ? Number(p.startYear) + i - 1 : null,
        kishuBoka: boka,
        chouseimae: null,
        shokyaku: amount,
        kimatsuBoka: boka - amount,
        kaitei: false,
        months: i === 1 ? months : 12,
        last: last,
      });
      cum += amount;
      boka -= amount;
      if (last || remain <= 0) break;
    }
  } else {
    const row = table[key];
    const rate = row.rate;
    // 急所5: 2年は改定償却率・保証率が存在しない＝切替は起きない。
    const revised = row.revised;
    const guaranteeRate = row.guarantee;
    hoshou = guaranteeRate == null ? null : price * guaranteeRate;
    out.meta = { rate: rate, revised: revised, guaranteeRate: guaranteeRate, method: 'teiritsu' };

    for (let i = 1; i <= 200; i++) {
      let raw;
      let isKaitei = false;
      if (kaiteiShutoku != null) {
        // 切替後は「改定取得価額×改定償却率」の定額（急所2: 改定取得価額は固定）
        raw = kaiteiShutoku * revised;
        isKaitei = true;
      } else {
        const chouseimae = boka * rate;      // 調整前償却額（月割**前**の年額。急所4）
        if (hoshou != null && chouseimae < hoshou) {
          kaiteiShutoku = boka;              // その年の期首未償却残高で固定
          raw = kaiteiShutoku * revised;
          isKaitei = true;
        } else {
          raw = chouseimae;
        }
      }
      const monthly = i === 1 ? raw * months / 12 : raw;
      let amount = floorYen(monthly);
      const remain = limit - cum;
      let last = false;
      if (amount >= remain) { amount = remain; last = true; }
      rows.push({
        n: i,
        year: p.startYear ? Number(p.startYear) + i - 1 : null,
        kishuBoka: boka,
        chouseimae: isKaitei ? null : floorYen(boka * rate),
        shokyaku: amount,
        kimatsuBoka: boka - amount,
        kaitei: isKaitei,
        months: i === 1 ? months : 12,
        last: last,
      });
      cum += amount;
      boka -= amount;
      if (last || remain <= 0) break;
    }
  }

  out.ok = true;
  out.rows = rows;
  out.total = cum;
  out.shokyakuHoshouGaku = hoshou == null ? null : floorYen(hoshou);
  out.kaiteiShutokuKagaku = kaiteiShutoku;
  out.meta.memo = memo;
  out.meta.limit = limit;
  return out;
}
