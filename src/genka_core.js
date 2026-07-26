/**
 * 減価償却費（定額法・定率法）計算コア（DOM非依存・テスト対象）。
 *
 * 出すもの: 取得価額・耐用年数・償却方法・取得年月から、平成19年4月1日以後に取得した
 *   減価償却資産の毎年の償却費と期末未償却残高（＝償却スケジュール）を、国税庁の
 *   償却率・改定償却率・保証率の表（genka_rates.json）で計算する。個人事業主（暦年）を
 *   前提に、初年度は事業供用月からの月割で計算する。事業専用割合を入れると必要経費算入額も出す。
 *
 * ★★このツールが黙って誤答しやすい急所:
 *
 *  1. **取得年月で適用する償却率表が変わる（最大の急所）。** 定率法は
 *     平成19年4月1日〜平成24年3月31日取得＝250%定率法（別表第九）、
 *     平成24年4月1日以後取得＝200%定率法（別表第十）で率が違う。同じ耐用年数でも
 *     取得時期で償却費が変わる。平成19年3月31日以前取得（旧定額法・旧定率法＝残存価額・
 *     5%均等償却）は制度が別物なので当ツールの対象外（fail closed）。
 *
 *  2. **定率法の「償却保証額」切替（定率法の核心）。** 定率法は「期首帳簿価額×償却率」で
 *     減っていくが、その額（調整前償却額）が償却保証額（取得価額×保証率）を初めて下回った年から、
 *     「改定取得価額（その年の期首帳簿価額）×改定償却率」で毎年同額に切り替わる。ここを実装し
 *     忘れると、いつまでも帳簿価額×償却率で計算して償却が終わらない（＝毎年少なく誤答）。
 *
 *  3. **備忘価額1円を残す。** 有形減価償却資産は取得価額から1円を控除した額まで償却する。
 *     最終年は「期首帳簿価額−1円」でクランプし、帳簿価額を0でなく1円で止める。
 *
 *  4. **初年度は月割。** 年の中途で事業供用した資産は、初年度の償却費＝年額×供用月数÷12。
 *     個人事業主（会計期間＝暦年1〜12月）では供用月から12月までの月数（＝13−供用月）。
 *     月割で初年度が少ない分、償却は耐用年数の後ろへ延びる。
 *
 *  5. **建物・建物附属設備・構築物・無形固定資産（ソフトウェア等）は定率法を選べない（定額法のみ）。**
 *     このツールは資産の種類を持たず耐用年数だけで計算するので、定率法を選べない資産に定率法を
 *     当てないよう画面で注意喚起する（計算自体は止めない＝利用者の申告に委ねる）。
 *
 *  6. **1円未満の端数は切り捨てで計算（切り上げも認められる）。** 調整前償却額・年額の端数は
 *     切り捨て。国税庁の計算例（262,144×0.200＝52,428）も切り捨て。
 *
 * 一次情報: 国税庁 タックスアンサー No.2106『定額法と定率法による減価償却』／同添付
 *   『減価償却資産の償却率等表』（別表第八＝定額法・別表第九＝250%定率法）／『法人の
 *   減価償却制度の改正に関するQ&A（平成24年2月・別表第十＝200%定率法）』。数値は
 *   genka_rates.json（PDFから機械転記・償却率列は式で照合・公表計算例で照合済み）。
 */

/** 円未満切り捨て（負・NaNは0）。 */
export function floorYen(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 3桁小数の償却率（例 0.200）を整数化して掛け、円未満切り捨て。
 * 0.200 等は2進小数で誤差が出る（1,000,000×0.06552 が 65,519.99…になる類）ので、
 * 率を1000倍（保証率は100000倍）した整数で計算して誤差を避ける。
 */
export function applyRate(base, rate, scale = 1000) {
  const num = Math.round(Number(rate) * scale);
  const v = Math.floor((Number(base) * num) / scale);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 個人事業主（暦年）の初年度に事業で使った月数。供用月（1〜12）から12月まで＝13−供用月。
 *  1月供用→12 / 4月→9 / 12月→1
 */
export function usedMonthsFromStart(startMonth) {
  const m = Math.floor(Number(startMonth));
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  return 13 - m;
}

/**
 * 入口。
 * input = {
 *   method,     // 'teigaku'（定額法）| 'teiritsu'（定率法）
 *   cost,       // 取得価額（円・1以上の整数）
 *   life,       // 耐用年数（年・2〜50）
 *   acqYm,      // 'YYYY-MM' 取得（＝事業供用）年月。定率法の適用表と初年度月割の起点に使う
 *   bizRatio,   // 事業専用割合（0超100以下・％）。省略＝100。必要経費算入額＝償却費×割合
 * }
 * D = genka_rates.json
 *
 * 返り値 = {
 *   method, methodLabel, eraLabel, life, cost, bizRatio,
 *   rate, kaiteiRate, hoshoRate, hoshoGaku,   // 適用した率と償却保証額（定額法は kaitei/hosho=null）
 *   usedMonths,                                // 初年度の事業供用月数（1〜12）
 *   schedule: [{ year, openBook, dep, closeBook, expense }],  // dep=償却費 / expense=必要経費算入額
 *   firstYearDep, firstYearExpense, totalYears, totalDep,
 *   notes: [],
 * }
 * fail closed: データ無し・不正入力・平成19年3月31日以前取得・耐用年数範囲外は throw（黙って答えない）。
 */
export function calcGenka(input, D) {
  if (!D || !D.teigaku_rate || !D.teiritsu_200 || !D.teiritsu_250 || !D.boundaries) {
    throw new Error('参照データ（genka_rates.json）が渡されていません');
  }
  const i = input || {};
  const notes = [];

  if (i.method !== 'teigaku' && i.method !== 'teiritsu') {
    throw new Error('償却方法（定額法／定率法）を選んでください');
  }

  const cost = Math.floor(Number(i.cost));
  if (!Number.isFinite(cost) || cost < 1) throw new Error('取得価額（円）を正しく入力してください');

  const life = Math.floor(Number(i.life));
  if (!Number.isFinite(life) || life < D.min_life || life > D.max_life) {
    throw new Error(`耐用年数は${D.min_life}〜${D.max_life}年で入力してください（${D.max_life}年超は当ツール未対応）`);
  }

  const acqYm = typeof i.acqYm === 'string' ? i.acqYm.slice(0, 7) : '';
  if (!/^\d{4}-\d{2}$/.test(acqYm)) throw new Error('取得（事業供用）年月を入力してください');

  // ── 急所1: 取得年月で適用表を決める。平成19年3月31日以前は旧法＝対象外（fail closed）──────
  const B = D.boundaries;
  if (acqYm < B.shin_start) {
    throw new Error(`${B.shin_start_label}より前に取得した資産（旧定額法・旧定率法）は当ツールの対象外です。旧法は残存価額・5%均等償却があり計算が異なります。`);
  }

  const startMonth = Number(acqYm.slice(5, 7));
  const usedMonths = usedMonthsFromStart(startMonth); // 初年度の事業供用月数（13−取得月）

  const ratio = i.bizRatio == null || i.bizRatio === '' ? 100 : Number(i.bizRatio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100) throw new Error('事業専用割合は0〜100％で入力してください');

  // ── 率の選択 ────────────────────────────────────────────────────────────────
  let methodLabel, eraLabel, rate, kaiteiRate = null, hoshoRate = null;
  if (i.method === 'teigaku') {
    methodLabel = '定額法';
    eraLabel = `定額法（${B.shin_start_label}以後に取得・別表第八）`;
    rate = D.teigaku_rate[String(life)];
    if (rate == null) throw new Error('この耐用年数の定額法償却率が収録範囲にありません');
  } else {
    methodLabel = '定率法';
    const is200 = acqYm >= B.teiritsu200_start;
    const tbl = is200 ? D.teiritsu_200 : D.teiritsu_250;
    eraLabel = is200
      ? `200%定率法（${B.teiritsu200_start_label}以後に取得・別表第十）`
      : `250%定率法（${B.shin_start_label}〜平成24年3月31日に取得・別表第九）`;
    const row = tbl[String(life)];
    if (!row) throw new Error('この耐用年数の定率法償却率が収録範囲にありません');
    rate = row.rate;
    kaiteiRate = row.kaitei;   // null なら改定なし（n=2 等）
    hoshoRate = row.hosho;
  }

  // 償却保証額（定率法のみ・保証率が無い区分は切替なし）。保証率は5桁小数なので100000倍で整数化。
  const hoshoGaku = i.method === 'teiritsu' && hoshoRate != null ? applyRate(cost, hoshoRate, 100000) : null;
  const canSwitch = i.method === 'teiritsu' && kaiteiRate != null && hoshoRate != null;

  // ── 償却スケジュールを1年ずつ積む ─────────────────────────────────────────────
  const annualTeigaku = i.method === 'teigaku' ? applyRate(cost, rate) : null;
  const schedule = [];
  let book = cost;
  let kaiteiToku = null; // 改定取得価額（切替年の期首帳簿価額）
  let totalDep = 0;
  let year = 0;
  while (book > 1 && year < 200) {
    year++;
    let dep;
    if (i.method === 'teigaku') {
      dep = annualTeigaku;
    } else if (kaiteiToku != null) {
      dep = applyRate(kaiteiToku, kaiteiRate); // 切替後は毎年同額
    } else {
      const chosei = applyRate(book, rate); // 調整前償却額
      if (canSwitch && chosei < hoshoGaku) {
        kaiteiToku = book; // 改定取得価額＝この年の期首帳簿価額
        dep = applyRate(kaiteiToku, kaiteiRate);
      } else {
        dep = chosei;
      }
    }
    // 急所4: 初年度は月割
    if (year === 1 && usedMonths < 12) dep = floorYen(dep * usedMonths / 12);
    // 急所3: 備忘価額1円を残す
    if (dep > book - 1) dep = book - 1;
    if (dep < 0) dep = 0;
    const expense = ratio >= 100 ? dep : floorYen(dep * ratio / 100);
    schedule.push({ year, openBook: book, dep, closeBook: book - dep, expense });
    totalDep += dep;
    book -= dep;
    // 定額法・改定後で dep が 0 に張り付いたら（1円まで来た）終了
    if (dep === 0) break;
  }

  // ── 画面に出す注記 ───────────────────────────────────────────────────────────
  notes.push(`${eraLabel}で計算しました。`);
  if (i.method === 'teiritsu' && !(acqYm >= B.teiritsu200_start)) {
    notes.push('平成24年3月31日以前に取得した定率法は250%定率法です（平成24年4月1日以後の取得なら200%定率法で率が下がります）。');
  }
  if (usedMonths < 12) {
    notes.push(`初年度は事業供用月（${startMonth}月）から12月までの${usedMonths}か月で月割りしました（個人事業主・暦年を前提。法人は事業年度の月数で計算します）。`);
  }
  if (i.method === 'teiritsu' && canSwitch) {
    notes.push(`定率法は調整前償却額が償却保証額（${hoshoGaku.toLocaleString()}円＝取得価額×保証率${hoshoRate}）を下回った年から、改定取得価額×改定償却率（${kaiteiRate}）で毎年同額になります。`);
  }
  notes.push('有形減価償却資産は最終年に備忘価額1円を残します（帳簿価額は0でなく1円で止まります）。');
  if (ratio < 100) {
    notes.push(`必要経費に算入できるのは償却費×事業専用割合（${ratio}％）です。帳簿価額（未償却残高）は家事用部分も含めた償却費の全額で減っていきます。`);
  }
  notes.push('建物・建物附属設備・構築物・ソフトウェア等の無形固定資産は定率法を選べません（定額法のみ）。定率法で計算する場合は対象資産かご確認ください。');
  notes.push('1円未満の端数は切り捨てで計算しています（切り上げも認められます）。');
  // 少額な資産は減価償却せず別の取扱いができる。金額基準・適用期限は参照データが正本
  // （中小企業者等の少額特例は令和8年度改正で30万円未満→40万円未満。境界は「取得日」なので acqYm で分ける）
  const S = D.shogaku_tokurei;
  if (S) {
    if (cost < S.ikkatsu_mangan) {
      notes.push(`取得価額が${S.shogaku_mangan_label}なら消耗品費などで買った年に全額、${S.ikkatsu_mangan_label}なら一括償却資産として${S.ikkatsu_years}年で均等に経費にできます（この計算とは別の取扱いです）。`);
    }
    const kakuju = acqYm >= S.chusho_kakuju_start;
    const chushoMangan = kakuju ? S.chusho_mangan : S.chusho_mangan_kyu;
    const chushoLabel = kakuju ? S.chusho_mangan_label : S.chusho_mangan_kyu_label;
    if (cost < chushoMangan) {
      if (acqYm <= S.chusho_kigen.slice(0, 7)) {
        notes.push(`青色申告の中小企業者等（常時使用する従業員${S.chusho_jugyoin}人以下）は、この資産を少額減価償却資産の特例（取得価額${chushoLabel}・${S.chusho_nengaku_gendo_label}まで）で買った年に全額経費にできる場合があります（${S.chusho_kigen_label}までに取得したものが対象）。`);
      } else {
        notes.push(`少額減価償却資産の特例（中小企業者等・取得価額${chushoLabel}）は${S.chusho_kigen_label}までに取得したものが対象です。それ以後に取得した資産に使えるかは、延長されたかどうかをご確認ください。`);
      }
    }
  }

  return {
    method: i.method, methodLabel, eraLabel, life, cost, bizRatio: ratio,
    rate, kaiteiRate, hoshoRate, hoshoGaku, usedMonths,
    schedule, firstYearDep: schedule[0] ? schedule[0].dep : 0,
    firstYearExpense: schedule[0] ? schedule[0].expense : 0,
    totalYears: schedule.length, totalDep, notes,
  };
}
