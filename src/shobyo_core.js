/**
 * 傷病手当金の計算ロジック。DOM非依存・テスト対象。
 *
 * 一次ソース（e-Gov 法令API v2 の生条文を読んで実装した。要約サイトは一切見ていない）:
 * - 健康保険法 99条1項（待期3日・任意継続被保険者を除く）
 * - 健康保険法 99条2項（日額の算定式と2段階の端数処理）／同項ただし書・各号（12月未満の場合）
 * - 健康保険法 99条4項（支給期間＝通算して1年6月）
 * - 健康保険法 104条（資格喪失後の継続給付）
 * - 健康保険法 108条1項（報酬との調整＝差額支給）・3項（障害厚生年金）・5項（老齢退職年金）
 *
 * ★ ここを取り違えると黙って間違える、という事実:
 *
 * 1. **「日額」は2段階で丸める。しかも両方とも“切り上げ側”に寄っている**（99条2項）:
 *      ① 平均標準報酬月額 ÷ 30 … 5円未満は切捨て、**5円以上10円未満は10円に切上げ**
 *      ② ①× 2/3        … 50銭未満は切捨て、**50銭以上1円未満は1円に切上げ**
 *    どちらも「四捨五入（境界は上げる）」。単純な切捨てで実装すると1円ずつ安く出る。
 *
 * 2. **被保険者期間が12月に満たない人は式が別**（99条2項ただし書）。
 *    次の2つの「÷30した額」を比べて **少ないほう** を採り、そのあとに 2/3 を掛ける:
 *      一号 … 自分の（12月に満たない）各月の標準報酬月額の平均 ÷ 30
 *      二号 … 全被保険者の平均標準報酬月額を報酬月額とみなしたときの標準報酬月額 ÷ 30
 *    → 入社1年未満で給料が高い人は **二号で頭打ち**になる。
 *    **2/3 を掛けるのは「少ないほうを選んだ後」**（各号の額は 2/3 前の額）。
 *
 *    ★★ここが今いちばん間違えられている: **二号の額は毎年度改定されうる**。
 *      協会けんぽの公表値は **支給開始日が令和7年3月31日以前 → 30万円 /
 *      令和7年4月1日以降 → 32万円**。
 *      → **上限日額は 6,667円 ではなく 7,113円**（32万 → 標準報酬32万 → ÷30 = 10,670 → ×2/3）。
 *      世に出回っている「上限は日額6,667円」という解説は **令和7年3月31日以前の話で、今は誤り**。
 *      だから額は **支給開始日で引く**（データに日付表として持たせ、コードに焼き込まない）。
 *
 * 3. **待期3日は「支給されない3日」**（99条1項）。「起算して三日を経過した日から」＝ **4日目から**。
 *    支給日数 ＝ 労務不能の日数 − 3日。全期間に日額を掛けると3日分多く出る。
 *
 * 4. **給与が出ていても、もらえないとは限らない**（108条1項ただし書）。
 *    報酬の日額が傷病手当金の日額より **少なければ、その差額が出る**。
 *    「給料が出ているから対象外」は誤り。
 *
 * 5. **老齢年金との調整は「退職後の継続給付の人」だけ**（108条5項が対象を
 *    「第104条の規定により受けるべき者」に限定している）。在職中の人には効かない。
 *    一方 **障害厚生年金との調整（108条3項）は在職中の人にも効く**。調整対象が違う。
 *
 * 6. **任意継続被保険者には傷病手当金が出ない**（99条1項のかっこ書きが明文で除いている）。
 *    ただし退職前から受けていた人は104条の継続給付で受け続けられる（別の話）。
 *
 * 7. **支給期間は「通算して」1年6月**（99条4項・令和4年1月1日施行）。
 *    途中で復職して働いた期間はカウントされない。
 *    「支給を始めた日から1年6か月で終わり」と書いてある解説は、今は誤り。
 *
 *    ★★**「1年6月＝546日」と焼き込んではいけない**。厚労省の事務連絡（令和3年11月10日・
 *    保険局保険課）が「**暦に従って1年6月間の計算を行い、支給期間を確定する**」と明記していて、
 *    **総日数は支給開始日によって変わる**（同事務連絡の例は 令和4年3月4日開始 →
 *    令和5年9月3日まで＝**549日**。一方 令和8年2月15日開始なら**546日**）。
 *    → 暦で「開始日 + 18か月 − 1日」を出してから日数を数える。
 *
 * 8. **「支給を始める日」（99条2項・日額の基準日）と「支給を始めた日」（99条4項・
 *    1年6月の起算日）は別の概念**。前者は日額を固定し、後者は期間を起算する。
 *
 * ★★保険者による違い（定数にできない）:
 *    上の 2. の「全被保険者の平均標準報酬月額」は **保険者ごとに違う**。
 *    協会けんぽは32万円だが、**健保組合は組合自身の平均**を使う（例: 関東ITソフトウェア健保は
 *    平成28年度 38万円）。だからこの額は **データで持ち、利用者が上書きできる** ようにする。
 */

import { kenkoGrade } from './shaho_core.js';

/** 待期期間（法99条1項「三日を経過した日から」）。 */
export const TAIKI_DAYS = 3;

/** 年金額を日額に割るときの除数（年金額 ÷ 360）。 */
export const NENKIN_DIVISOR = 360;

/**
 * 5円未満切捨て・5円以上10円未満切上げ（法99条2項の「÷30」の端数処理）。
 * 有理数 num/den をそのまま渡す（浮動小数点の誤差を持ち込まないため）。
 * 10 × floor((v + 5) / 10) と同値。
 */
export function round10(num, den) {
  return 10 * Math.floor((num + 5 * den) / (10 * den));
}

/**
 * 50銭未満切捨て・50銭以上1円未満切上げ（法99条2項の「×2/3」の端数処理）。
 * 有理数 num/den を1円単位へ。floor(v + 1/2) = floor((2num + den) / (2den))。
 */
export function round1(num, den) {
  return Math.floor((2 * num + den) / (2 * den));
}

/**
 * 99条2項2号の「全被保険者の平均標準報酬月額」を **支給開始日で引く**（毎年度改定されうる）。
 * 協会けんぽの公表値: 令和7年3月31日以前 30万円 / 令和7年4月1日以降 32万円。
 *
 * @param startDate 支給を始める日（'YYYY-MM-DD'）
 * @param D 参照データ
 */
export function zenpiHeikin(startDate, D) {
  if (!D || !Array.isArray(D.zenpi_heikin_hyojun_hoshu)) {
    throw new Error('参照データ（shobyo_r08.json）が渡されていません');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
    // 支給開始日が無ければ額を選べない。今日で代用すると黙って古い/新しい額を使う
    throw new Error('支給を始める日（YYYY-MM-DD）が必要です');
  }
  const rows = [...D.zenpi_heikin_hyojun_hoshu].sort((a, b) => (a.from < b.from ? 1 : -1));
  const hit = rows.find((r) => startDate >= r.from);
  if (!hit) throw new Error('支給開始日に対応する平均標準報酬月額がありません');
  return { amount: Math.floor(Number(hit.amount) || 0), label: hit.label, from: hit.from };
}

/**
 * 標準報酬月額の配列から傷病手当金の日額を求める（法99条2項）。
 *
 * @param standards 各月の標準報酬月額。**古い→新しい順**。12月を超える場合は直近12月を使う
 * @param D 参照データ（shobyo_r08.json）。渡されなければ計算しない（fail closed）
 * @param opt.startDate 支給を始める日。**12月未満のときだけ**必要（二号の額を引くため）
 * @param opt.heikinOverride 保険者独自の平均標準報酬月額（健保組合の人が上書きする）
 */
export function nichigaku(standards, D, opt) {
  if (!D) throw new Error('参照データ（shobyo_r08.json）が渡されていません');
  if (!Array.isArray(standards) || standards.length === 0) {
    throw new Error('標準報酬月額が1月分もありません');
  }
  const o = opt || {};
  const recent = standards.slice(-12).map((v) => Math.floor(Number(v) || 0));
  if (recent.some((v) => v <= 0)) throw new Error('標準報酬月額に0以下の月があります');

  const n = recent.length;
  const sum = recent.reduce((a, b) => a + b, 0);

  // 一号相当: 自分の平均 ÷ 30（10円単位・5円以上は切上げ）
  const own = round10(sum, 30 * n);

  if (n >= 12) {
    return {
      months: n,
      rule: 'full', // 12月以上 → 自分の平均だけで決まる。二号の額は一切使わない
      base: own,
      own,
      cap: null,
      capped: false,
      amount: round1(own * 2, 3),
    };
  }

  // 二号: 全被保険者の平均標準報酬月額を「報酬月額」とみなしたときの標準報酬月額 ÷ 30
  // ★健保組合は組合自身の平均額を使う（協会けんぽの32万円ではない）ので上書きできる
  const override = Math.floor(Number(o.heikinOverride) || 0);
  const src = override > 0 ? { amount: override, label: '保険者（健保組合）の平均標準報酬月額' }
                           : zenpiHeikin(o.startDate, D);
  if (src.amount <= 0) throw new Error('全被保険者の平均標準報酬月額がありません');

  const capStandard = kenkoGrade(src.amount).standard;
  const cap = round10(capStandard, 30);

  const base = Math.min(own, cap);
  return {
    months: n,
    rule: 'short', // 12月未満 → 一号と二号の少ないほう
    base,
    own,
    cap,
    capped: cap < own, // 二号で頭打ちになった（給料が高いのに上限に抑えられた）
    heikin: src.amount, // 二号の元になった額（画面に出して前提を開示する）
    heikinLabel: src.label,
    amount: round1(base * 2, 3),
  };
}

/**
 * 支給期間（法99条4項「通算して一年六月間」）を **暦で** 求める。
 *
 * ★★546日と焼き込んではいけない。厚労省事務連絡（令和3年11月10日・保険局保険課）が
 *   「暦に従って1年6月間の計算を行い、傷病手当金の支給期間を確定する」と明記しており、
 *   **総日数は支給開始日によって変わる**（549日にも546日にもなる）。
 *
 * @param startDate 支給を **始めた** 日（待期3日の翌日＝4日目）
 * @returns { start, end, totalDays } end は最終日（開始日 + 18か月 − 1日）
 */
export function shikyuKikan(startDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) {
    throw new Error('支給を始めた日（YYYY-MM-DD）が必要です');
  }
  const [y, m, d] = startDate.split('-').map(Number);
  // 開始日の18か月後の前日が最終日（例: 2022-03-04 → 2023-09-03）
  const end = new Date(Date.UTC(y, m - 1 + 18, d));
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(Date.UTC(y, m - 1, d));
  const totalDays = Math.round((end - start) / 86400000) + 1; // 両端を含む
  return { start: startDate, end: end.toISOString().slice(0, 10), totalDays };
}

/**
 * 支給日数（法99条1項）。待期3日を差し引く。
 * @param restDays 労務不能で仕事を休んだ日数
 * @param taikiDone すでに待期3日が完成している場合 true（受給中の人が続きを計算するとき）
 */
export function shikyuNissu(restDays, taikiDone) {
  const days = Math.max(0, Math.floor(Number(restDays) || 0));
  if (taikiDone) return days;
  return Math.max(0, days - TAIKI_DAYS);
}

/**
 * 報酬・年金との調整（法108条）。**日額どうし**を比べ、少ない側との差額だけが出る。
 *
 * @param amount 調整前の傷病手当金の日額（99条2項の額）
 * @param opt.hoshuNichigaku  受けられる報酬の日額（108条1項）
 * @param opt.shogaiNenkin    障害厚生年金＋障害基礎年金の**年額**（108条3項）
 * @param opt.roureiNenkin    老齢退職年金給付の**年額**（108条5項）
 * @param opt.taishokugo      退職後の継続給付か（老齢年金の調整はこの人だけ）
 */
export function chosei(amount, opt) {
  const o = opt || {};
  const hoshu = Math.max(0, Math.floor(Number(o.hoshuNichigaku) || 0));

  // 年金は「年額 ÷ 360」で日額にする
  const shogaiY = Math.max(0, Math.floor(Number(o.shogaiNenkin) || 0));
  const roureiY = Math.max(0, Math.floor(Number(o.roureiNenkin) || 0));
  const shogai = shogaiY > 0 ? Math.floor(shogaiY / NENKIN_DIVISOR) : 0;
  // 老齢年金の調整は退職後の継続給付の人だけ（108条5項）
  const rourei = o.taishokugo && roureiY > 0 ? Math.floor(roureiY / NENKIN_DIVISOR) : 0;

  // 差し引く相手は「いちばん多いもの」。報酬・障害年金・老齢年金が同時に効くとき、
  // 条文は合算でなく「いずれか多い額」との差額を出す構成になっている（108条3項各号）。
  const deduct = Math.max(hoshu, shogai, rourei);
  const paid = Math.max(0, amount - deduct);

  return {
    amount, // 調整前の日額
    hoshu,
    shogai,
    rourei,
    deduct,
    paid, // 実際に受け取れる日額
    zero: paid === 0 && deduct > 0, // 全額不支給
    reason:
      deduct === 0 ? null : deduct === hoshu ? 'hoshu' : deduct === shogai ? 'shogai' : 'rourei',
  };
}

/**
 * 資格喪失後の継続給付を受けられるか（法104条）。
 * 退職しても受け続けられるのは、次の2つを **両方** 満たす人だけ。
 */
export function keizokuKyufu(input) {
  const i = input || {};
  const months = Math.max(0, Math.floor(Number(i.hihokenshaMonths) || 0));
  const oneYear = months >= 12; // 資格喪失日の前日まで引き続き1年以上被保険者
  const receiving = !!i.receivingAtLoss; // 資格喪失の際に傷病手当金を受けている（受けられる状態）
  return {
    ok: oneYear && receiving,
    oneYear,
    receiving,
    // 任意継続の期間は「1年以上」に算入されない（104条かっこ書き）
    note: !oneYear
      ? '退職日までの被保険者期間が1年に満たないため、退職後は受けられません'
      : !receiving
        ? '退職日に傷病手当金を受けている（受けられる状態にある）ことが必要です'
        : null,
  };
}

/**
 * 入力から被保険者期間（月数）を読む。104条の「引き続き1年以上」の判定に使う。
 * standards（月ごとの標準報酬月額）だけが渡されたときは、その列の長さを月数とみなす。
 */
function hihokenshaMonths(i) {
  const m = Math.floor(Number(i.months) || 0);
  if (m > 0) return m;
  return Array.isArray(i.standards) ? i.standards.length : 0;
}

/**
 * 傷病手当金をまとめて計算する。
 *
 * @param input.standards       各月の標準報酬月額（古い→新しい順）。monthly と排他
 * @param input.monthly         月給（報酬月額）。standards が無いときに等級表から概算する
 * @param input.months          monthly を使うときの被保険者期間（月数）
 * @param input.restDays        仕事を休んだ日数
 * @param input.taikiDone       待期3日が完成済みか
 * @param input.ninnikeizoku    任意継続被保険者か（99条1項：**新たに** 病気になった人には支給されない）
 * @param input.taishokugo      退職後の継続給付か（104条）。★任意継続でもこれが立てば支給される
 * @param D 参照データ（fail closed）
 */
export function calcShobyo(input, D) {
  if (!D) throw new Error('参照データ（shobyo_r08.json）が渡されていません');
  const i = input || {};

  // ── 任意継続被保険者（99条1項のかっこ書き） ─────────────────────────────
  // ★★ここは「任意継続なら¥0」で終わらせてはいけない。**104条の継続給付は別の権利**で、
  //   退職前から受けていた人は、任意継続被保険者になっても受け続けられる。
  //   104条1項が「被保険者の資格を喪失した日（**任意継続被保険者の資格を喪失した者にあっては、
  //   その資格を取得した日**）の前日まで引き続き一年以上被保険者…であった者」と書いているとおり、
  //   条文自身が「任意継続になる人」を想定して起算日を用意している。
  //   （108条5項も「傷病手当金の支給を受けるべき者（**第百四条の規定により受けるべき者**…）」と言う）
  //
  //   99条1項が排除しているのは **任意継続の期間中に新たに労務不能になった人** だけ。
  //   病気で辞めた人はほぼ全員が任意継続を選ぶ（病気なのだから保険が要る）ので、
  //   ここを取り違えると **いちばん重い病気の人に「¥0」と答える**（月給30万で 3,640,182円）。
  if (i.ninnikeizoku) {
    const k = keizokuKyufu({
      hihokenshaMonths: hihokenshaMonths(i),
      receivingAtLoss: !!i.taishokugo,
    });
    if (!k.ok) {
      return {
        eligible: false,
        reason: k.receiving ? 'keizoku_under1y' : 'ninnikeizoku',
        keizoku: k,
        message: k.receiving
          // 継続給付だと言っているが、1年要件を満たしていない
          ? '退職日までの被保険者期間が1年に満たないため、資格喪失後の継続給付は受けられません'
            + '（健康保険法104条。任意継続の期間はこの1年に算入されません）。'
          // 任意継続の期間中に新たに労務不能になった人（99条1項の本来の対象外）
          : '任意継続被保険者が、任意継続になってから新たに病気やケガで働けなくなった場合、'
            + '傷病手当金は支給されません（健康保険法99条1項）。'
            + '★ただし、退職する前から傷病手当金を受けていた（受けられる状態だった）方は、'
            + '任意継続でも「資格喪失後の継続給付」として受け続けられます（104条）。'
            + 'その場合は「退職後の継続給付を受けている」にチェックしてください。',
        total: 0,
      };
    }
    // k.ok → 104条の継続給付。以下、通常どおり計算する
  }

  // 標準報酬月額の列を用意する
  let standards;
  let estimated = false;
  if (Array.isArray(i.standards) && i.standards.length > 0) {
    standards = i.standards;
  } else {
    const monthly = Math.max(0, Math.floor(Number(i.monthly) || 0));
    if (monthly <= 0) throw new Error('月給または標準報酬月額を入力してください');
    const months = Math.max(1, Math.floor(Number(i.months) || 12));
    const std = kenkoGrade(monthly).standard;
    standards = new Array(Math.min(months, 12)).fill(std);
    estimated = true; // 「毎月同じ標準報酬月額だったと仮定した概算」であることを画面に出す
  }

  const n = nichigaku(standards, D, {
    startDate: i.startDate,
    heikinOverride: i.heikinOverride,
  });
  const adj = chosei(n.amount, {
    hoshuNichigaku: i.hoshuNichigaku,
    shogaiNenkin: i.shogaiNenkin,
    roureiNenkin: i.roureiNenkin,
    taishokugo: i.taishokugo,
  });

  const days = shikyuNissu(i.restDays, i.taikiDone);
  const total = adj.paid * days;

  return {
    eligible: true,
    // ★104条の継続給付として計算したか（任意継続なのに支給される＝画面で必ず名乗る）
    via104: !!i.ninnikeizoku,
    estimated,
    months: n.months,
    rule: n.rule,
    base: n.base, // ÷30した額（10円単位）
    own: n.own,
    cap: n.cap,
    capped: n.capped,
    heikin: n.heikin ?? null, // 二号の額（前提として画面に出す）
    heikinLabel: n.heikinLabel ?? null,
    nichigaku: n.amount, // 調整前の日額
    chosei: adj,
    paidNichigaku: adj.paid, // 調整後の日額
    days,
    taikiDays: i.taikiDone ? 0 : Math.min(TAIKI_DAYS, Math.max(0, Math.floor(Number(i.restDays) || 0))),
    total,
    // 支給期間（暦で1年6月）。支給を始めた日がわかるときだけ
    kikan: /^\d{4}-\d{2}-\d{2}$/.test(String(i.startDate || '')) ? shikyuKikan(i.startDate) : null,
  };
}
