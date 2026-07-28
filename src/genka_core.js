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
 *  3. **備忘価額1円を残すのは「有形」だけ。資産の種類で償却限度額が変わる。**
 *     所令134条1項2号は、平成19年4月1日以後に取得した資産の償却の限度を3つに分ける:
 *       イ 6条1号〜7号・9号の資産（坑道とハを除く）＝ **取得価額から一円を控除した金額**
 *       ロ **坑道及び6条8号の無形固定資産** ＝ **その取得価額に相当する金額**（＝1円を残さない）
 *       ハ 所有権移転外リース取引のリース賃貸資産（貸主側）＝ 取得価額−残価保証額（当ツール対象外）
 *     一律に1円を残すと、**ソフトウエア等の無形固定資産で永久に1円が残る**（法と違う挙動）。
 *     ★無形固定資産（6条8号）と生物（6条9号）は**定額法のみ**（所令120条の2第1項4号）。
 *     坑道は鉱業用減価償却資産なので定率法も選べる（同項3号ロ）ので、無形と同じ扱いにはしない。
 *
 *  3b. **中古資産は簡便法で耐用年数を見積もれる（耐令3条1項2号）。** 全部経過＝法定耐用年数×20%、
 *     一部経過＝（法定耐用年数−経過年数）＋経過年数×20%。**1年未満の端数は切捨て・2年未満は2年**
 *     （耐令3条5項が「暦に従つて計算し、一年に満たない端数を生じたときは、これを切り捨てる」と
 *     直接定めている＝通達ではなく省令が根拠）。**「暦に従つて計算」なので経過年数は月まで数える**
 *     （中古住宅・中古車は「10年3か月」が普通で、年だけで丸めると耐用年数が1年ずれる）。
 *     ★**ただし書＝資本的支出が取得価額の50%を超えると簡便法は使えない**。落とすと、使えない人に
 *     短い耐用年数を答えて過大償却させる。再取得価額の50%も超えるなら法定耐用年数による（No.5404注）。
 *
 *  4. **初年度は月割。** 年の中途で事業供用した資産は、初年度の償却費＝年額×供用月数÷12。
 *     個人事業主（会計期間＝暦年1〜12月）では供用月から12月までの月数（＝13−供用月）。
 *     月割で初年度が少ない分、償却は耐用年数の後ろへ延びる。
 *
 *  5. **建物・建物附属設備・構築物・無形固定資産（ソフトウェア等）は定率法を選べない（定額法のみ）。**
 *     資産の種類のうち機械的に判定できるのは無形固定資産だけ（＝選択肢にある）なので、そこは
 *     fail closed で止める。建物・構築物か否かは耐用年数からは分からないので画面で注意喚起する。
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
 * 償却の限度額の区分（所令134条1項2号。平成19年4月1日以後に取得した資産）。
 * residual = 償却しきったあとに帳簿に残す金額（円）。
 * ★ハ（所有権移転外リース取引のリース賃貸資産＝貸主側・取得価額−残価保証額）は当ツール対象外。
 *   「無いこと」を黙って落とさないため、ここに理由つきで明示しておく。
 */
export const ASSET_TYPES = {
  yukei: {
    label: '有形固定資産（建物・機械・車両・工具器具備品・生物など）',
    residual: 1,
    kon: '所令134条1項2号イ',
    teiritsuOk: true,
  },
  mukei: {
    label: '無形固定資産（ソフトウエア・特許権など）',
    residual: 0,
    kon: '所令134条1項2号ロ',
    // 所令120条の2第1項4号「第六条第八号に掲げる無形固定資産…及び同条第九号に掲げる生物 定額法」
    teiritsuOk: false,
  },
  kodo: {
    label: '坑道',
    residual: 0,
    kon: '所令134条1項2号ロ',
    // 坑道は鉱業用減価償却資産（所令120条の2第1項3号ロ）＝定率法も選べる
    teiritsuOk: true,
  },
};

/**
 * 中古資産の見積耐用年数を簡便法で出す（耐令3条1項2号・5項／国税庁 No.5404）。
 *
 * ★経過年数は「暦に従つて計算」する（耐令3条5項）ので**月まで数える**。全部を月に直して
 *   整数のまま計算し（×20% は ÷5）、最後に年へ落として1年未満を切り捨て、2年未満は2年にする。
 *   浮動小数で 0.2 を掛けると 13.799999… のような値が出て切捨てが1年ずれうるため、
 *   分母を払った整数演算のみで行う。
 *
 * input = {
 *   houteiLife,           // 法定耐用年数（年・2以上）
 *   keikaYears,           // 経過年数（年・0以上）
 *   keikaMonths,          // 経過月数（0〜11。省略可）
 *   shihontekiShishutsu,  // 事業供用のために支出した資本的支出の額（円・省略可）
 *   cost,                 // 中古資産の取得価額（円・省略可。ただし書の50%判定に使う）
 * }
 * 返り値 = { years, unavailable, reason, zenbu, houteiMonths, keikaTotalMonths, rawMonths, floored, notes }
 * fail closed: 入力が不正／ただし書に当たる場合は years=null・unavailable=true で理由を返す（黙って答えない）。
 */
export function chukoTaiyoNensu(input) {
  const i = input || {};
  const notes = [];

  const houtei = Math.floor(Number(i.houteiLife));
  if (!Number.isFinite(houtei) || houtei < 2) {
    return { years: null, unavailable: true, reason: '法定耐用年数を2年以上で入力してください。', notes };
  }
  const ky = i.keikaYears == null || i.keikaYears === '' ? 0 : Math.floor(Number(i.keikaYears));
  const km = i.keikaMonths == null || i.keikaMonths === '' ? 0 : Math.floor(Number(i.keikaMonths));
  if (!Number.isFinite(ky) || ky < 0 || !Number.isFinite(km) || km < 0 || km > 11) {
    return { years: null, unavailable: true, reason: '経過年数は0年以上、経過月数は0〜11で入力してください。', notes };
  }

  // ── 耐令3条1項ただし書: 資本的支出 > 取得価額×50% なら簡便法（2号）は使えない ──────────
  const cost = Number(i.cost) > 0 ? Math.floor(Number(i.cost)) : 0;
  const shishutsu = Number(i.shihontekiShishutsu) > 0 ? Math.floor(Number(i.shihontekiShishutsu)) : 0;
  if (cost > 0 && shishutsu * 2 > cost) {
    return {
      years: null,
      unavailable: true,
      reason: `資本的支出（${shishutsu.toLocaleString()}円）が取得価額（${cost.toLocaleString()}円）の50％を超えるため、簡便法は使えません（耐令3条1項ただし書）。`
        + '使用可能期間を見積もる方法（同項1号）によるか、資本的支出が再取得価額（同じ新品を買う場合の価額）の50％も超えるときは法定耐用年数によります。',
      cost, shishutsu, notes,
    };
  }

  const houteiMonths = houtei * 12;
  const keikaTotalMonths = ky * 12 + km;
  const zenbu = keikaTotalMonths >= houteiMonths; // イ 全部経過 ／ ロ 一部経過

  // ×20% は ÷5。分母5を払った「月×5」で持ち、最後に 60（＝12か月×5）で割って年にする。
  const rawMonths5 = zenbu
    ? houteiMonths                                        // イ: 法定 × 20%
    : (houteiMonths - keikaTotalMonths) * 5 + keikaTotalMonths; // ロ: (法定−経過) + 経過 × 20%
  const truncated = Math.floor(rawMonths5 / 60);          // 1年未満の端数は切捨て（耐令3条5項）
  const years = Math.max(2, truncated);                   // 2年に満たないときは2年（同項2号かっこ書き）

  notes.push(zenbu
    ? `法定耐用年数の全部を経過しているので、法定耐用年数${houtei}年×20％で計算しました（耐令3条1項2号イ）。`
    : `法定耐用年数の一部を経過しているので、（${houtei}年−経過${formatYm(keikaTotalMonths)}）＋経過${formatYm(keikaTotalMonths)}×20％で計算しました（耐令3条1項2号ロ）。`);
  if (truncated < 2) {
    notes.push(`計算した年数が2年に満たないので、2年としました（耐令3条1項2号かっこ書き）。`);
  } else if (rawMonths5 % 60 !== 0) {
    notes.push(`計算した年数の1年未満の端数（${formatYm(rawMonths5 / 5 - truncated * 12)}）は切り捨てました（耐令3条5項）。`);
  }
  notes.push('簡便法が使えるのは、使用可能期間の年数を見積もることが困難な場合に限られます（耐令3条1項2号）。中古資産の耐用年数の見積りは、事業に使い始めた年にしかできません。');

  return {
    years, unavailable: false, reason: '',
    zenbu, houteiMonths, keikaTotalMonths,
    rawMonths: rawMonths5 / 5, floored: truncated < 2,
    cost, shishutsu, notes,
  };
}

/** 月数を「N年Mか月」の形にする（表示用）。小数月は小数のまま出す。 */
export function formatYm(months) {
  const m = Number(months);
  if (!Number.isFinite(m) || m <= 0) return '0か月';
  const y = Math.floor(m / 12);
  const rest = Math.round((m - y * 12) * 10) / 10;
  if (y === 0) return `${rest}か月`;
  if (rest === 0) return `${y}年`;
  return `${y}年${rest}か月`;
}

/**
 * 入口。
 * input = {
 *   method,     // 'teigaku'（定額法）| 'teiritsu'（定率法）
 *   cost,       // 取得価額（円・1以上の整数）
 *   life,       // 耐用年数（年・2〜50）
 *   acqYm,      // 'YYYY-MM' 取得（＝事業供用）年月。定率法の適用表と初年度月割の起点に使う
 *   bizRatio,   // 事業専用割合（0超100以下・％）。省略＝100。必要経費算入額＝償却費×割合
 *   assetType,  // 'yukei'（既定）| 'mukei' | 'kodo'。償却の限度額（備忘1円の有無）を決める
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

  // ── 急所3: 資産の種類で償却の限度額が変わる（1円を残すのは有形だけ）───────────────────
  const assetType = i.assetType == null || i.assetType === '' ? 'yukei' : String(i.assetType);
  const AT = ASSET_TYPES[assetType];
  if (!AT) throw new Error('資産の種類を選んでください');
  const residual = AT.residual; // 償却しきった後に残す金額（有形=1円 / 無形・坑道=0円）
  if (i.method === 'teiritsu' && !AT.teiritsuOk) {
    throw new Error(`${AT.label}は定率法を選べません（定額法のみ・所令120条の2第1項4号）。償却方法を定額法に変えてください。`);
  }

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
  while (book > residual && year < 200) {
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
    // 急所3: 償却の限度額（有形は備忘価額1円を残す／無形固定資産・坑道は取得価額まで償却する）
    if (dep > book - residual) dep = book - residual;
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
  notes.push(residual > 0
    ? `${AT.label}は最終年に備忘価額1円を残します（帳簿価額は0でなく1円で止まります・${AT.kon}）。`
    : `${AT.label}は取得価額まで償却します（備忘価額1円を残しません＝帳簿価額は0円になります・${AT.kon}）。1円を残すのは有形固定資産・生物です。`);
  if (ratio < 100) {
    notes.push(`必要経費に算入できるのは償却費×事業専用割合（${ratio}％）です。帳簿価額（未償却残高）は家事用部分も含めた償却費の全額で減っていきます。`);
  }
  if (i.method === 'teiritsu') {
    notes.push('建物は定率法を選べません（定額法のみ）。建物附属設備・構築物も平成28年4月1日以後に取得したものは定額法のみです（所令120条の2第1項1号）。定率法で計算する場合は対象資産かご確認ください。');
  }
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
    assetType, assetLabel: AT.label, residual,
    rate, kaiteiRate, hoshoRate, hoshoGaku, usedMonths,
    schedule, firstYearDep: schedule[0] ? schedule[0].dep : 0,
    firstYearExpense: schedule[0] ? schedule[0].expense : 0,
    totalYears: schedule.length, totalDep, notes,
  };
}
