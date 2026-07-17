/**
 * 出産手当金の計算ロジック。DOM非依存・テスト対象。
 *
 * ★ 額の算式は傷病手当金と「同じ」なので、日額・二号頭打ち・報酬調整・継続給付は
 *   shobyo_core.js から **import して使い回す**（正本を2箇所に置かない）。
 *   ここに新しく書くのは **支給期間（産前・産後の数え方）だけ**。
 *
 * 一次ソース（e-Gov 法令API v2 の生条文を読んで実装。要約サイトは見ていない）:
 * - 健康保険法 102条1項（産前42日〈多胎98日〉〜産後56日・予定日後出産の読替え）
 * - 健康保険法 102条2項（**99条2項・3項を準用**＝日額の算式は傷病手当金と同じ）
 * - 健康保険法 108条2項（報酬との調整＝差額支給）
 * - 健康保険法 104条（資格喪失後の継続給付。傷病手当金「又は出産手当金」を明記）
 * - 健康保険法 99条1項かっこ書き（任意継続被保険者を除く。「第百二条第一項において同じ」）
 *
 * ★ ここを取り違えると黙って間違える、という事実:
 *
 * 1. **待期3日は無い**。102条2項が準用するのは99条の **2項・3項だけ**（待期を定めた1項は準用外）。
 *    → **産前休業の初日から支給対象**（傷病手当金は4日目から）。−3日すると3日ぶん安く出る。
 *
 * 2. **支給期間の上限（通算1年6月）は無い**。それは99条4項＝傷病手当金の話で、102条2項は準用しない。
 *    出産手当金の期間は102条1項が **産前42日（多胎98日）＋産後56日** と直接定める。
 *
 * 3. **予定日より遅れた日数は、そのまま給付が増える**（102条1項かっこ書き）。
 *    産前の起点は「出産日以前42日」だが、**出産日が予定日より後のときは起点を『予定日以前42日』に固定**する。
 *    終点は常に「出産日後56日」。→ 10日遅れ＝**+10日ぶん**（標準報酬30万で +66,670円）。
 *    逆に早く産まれると起点が実際の出産日に戻るので **産前が短くなる**（10日早い＝−66,670円）。
 *    ★「産前は必ず42日」と焼き込むと、遅れた人に足りず・早い人に払いすぎる。
 *
 * 4. **多胎（双子以上）は産前98日**（産後は56日のまま）＝合計154日。
 *
 * 5. **上限額の規定は無い**（傷病手当金と同じく、最高等級139万円まで2/3が出る＝1日30,887円）。
 *    「上限日額◯◯円」という解説は12月未満の二号頭打ち（現在32万円）の話。混同しない。
 *
 * 6. **給与が出ていても、もらえないとは限らない**（108条2項ただし書）。
 *    報酬の日額が出産手当金の日額より **少なければ、その差額が出る**。「給料が出ているから対象外」は誤り。
 *    ★ただし出産手当金の108条は **報酬との調整だけ**。障害厚生年金・老齢退職年金との調整（108条3項・5項）は
 *    **傷病手当金にしか無い**。だから chosei は hoshu だけを渡す（年金を渡すと出産手当金に無い調整を効かせてしまう）。
 *
 * 7. **任意継続被保険者には出産手当金は出ない**（99条1項かっこ書きを102条1項が「同じ」で引く）。
 *    ただし退職前から受けていた人は104条の継続給付で受け続けられる（傷病手当金と同じ罠）。
 *    ★退職日に出勤すると「労務に服した」ことになり②の要件が崩れて全部消える（協会けんぽが明示）。
 */

import { nichigaku, chosei, keizokuKyufu } from './shobyo_core.js';
import { kenkoGrade } from './shaho_core.js';

/** 産前の日数（単胎）。102条1項。 */
export const SANZEN_TANTAI = 42;
/** 産前の日数（多胎妊娠）。102条1項かっこ書き。 */
export const SANZEN_TATAI = 98;
/** 産後の日数（多胎でも同じ）。102条1項。 */
export const SANGO_DAYS = 56;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD を UTC のエポック日数へ（TZ非依存で日数を数えるため）。 */
function toEpochDay(s) {
  if (!DATE_RE.test(String(s || ''))) throw new Error(`日付は YYYY-MM-DD で指定してください: ${s}`);
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** エポック日数を YYYY-MM-DD へ。 */
function fromEpochDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/** a から b までの日数（b − a、符号つき）。 */
export function daysBetween(a, b) {
  return toEpochDay(b) - toEpochDay(a);
}

/** dateStr の n 日後（符号可）。 */
export function addDays(dateStr, n) {
  return fromEpochDay(toEpochDay(dateStr) + Math.trunc(n));
}

/**
 * 出産手当金の支給期間を求める（102条1項）。
 *
 * 前提モデル: **予定日の42日（多胎98日）前から産前休業に入り、産後56日まで休む**（満額のケース）。
 * 実際に働いた日は「労務に服した」ので支給対象外だが、その分は報酬調整（108条2項）で扱う。
 *
 * @param yoteibi   出産予定日（YYYY-MM-DD・必須）
 * @param shussanbi 実際の出産日（YYYY-MM-DD）。未確定なら予定日と同じにする（＝オンタイム見込み）
 * @param tatai     多胎妊娠か（産前98日）
 */
export function shussanKikan(yoteibi, shussanbi, tatai) {
  if (!DATE_RE.test(String(yoteibi || ''))) throw new Error('出産予定日（YYYY-MM-DD）が必要です');
  const birth = DATE_RE.test(String(shussanbi || '')) ? shussanbi : yoteibi;
  const sanzenBase = tatai ? SANZEN_TATAI : SANZEN_TANTAI;

  // 遅れ＝+／早い＝−（102条1項かっこ書き：出産日が予定日後なら起点は予定日に固定＝遅れた分だけ産前が延びる）
  const delay = daysBetween(yoteibi, birth);
  const sanzen = Math.max(0, sanzenBase + delay);
  const sango = SANGO_DAYS;
  const days = sanzen + sango;

  // 支給を始める日＝産前休業開始日（予定日の (産前基準−1) 日前）。二号頭打ちの額を「支給開始日」で引くのに使う
  const startDate = addDays(yoteibi, -(sanzenBase - 1));
  // 支給の最終日＝出産日後56日
  const endDate = addDays(birth, SANGO_DAYS);

  return {
    yoteibi,
    shussanbi: birth,
    shussanbiEstimated: !DATE_RE.test(String(shussanbi || '')), // 出産日未入力＝予定日で見込み計算
    tatai: !!tatai,
    sanzenBase,
    delay, // +遅れ / −早い（0=予定日どおり）
    sanzen,
    sango,
    days,
    startDate,
    endDate,
  };
}

/**
 * 出産手当金をまとめて計算する。
 *
 * @param input.yoteibi        出産予定日（必須）
 * @param input.shussanbi      実際の出産日（未確定なら省略＝予定日で見込み）
 * @param input.tatai          多胎妊娠か
 * @param input.standards      各月の標準報酬月額（古い→新しい順）。monthly と排他
 * @param input.monthly        月給（報酬月額）。standards が無いとき等級表から概算
 * @param input.months         被保険者期間（月数）。12月未満の二号頭打ち・104条の判定に使う
 * @param input.hoshuNichigaku 産休中に受けられる報酬の日額（108条2項の差額支給）
 * @param input.heikinOverride 保険者独自の平均標準報酬月額（健保組合の人が上書き）
 * @param input.ninnikeizoku   任意継続被保険者か（99条1項かっこ書き＝「新たに」は不支給）
 * @param input.taishokugo     退職後の継続給付か（104条）。任意継続でもこれが立てば支給される
 * @param D 参照データ（shobyo_r08.json を共用。fail closed）
 */
export function calcShussan(input, D) {
  if (!D) throw new Error('参照データ（shobyo_r08.json）が渡されていません');
  const i = input || {};

  // 被保険者期間（月数）。standards が来たらその長さ、monthly なら months
  const months = Math.max(
    0,
    Math.floor(Number(i.months) || 0) ||
      (Array.isArray(i.standards) ? i.standards.length : 0),
  );

  // ── 任意継続被保険者（99条1項かっこ書き・102条1項で同じ） ───────────────────
  // 傷病手当金と同じ扱い: 任意継続になってから「新たに」出産…は無いが、退職前から受給していた人は
  // 104条の継続給付で受け続けられる。ここを「任意継続なら¥0」で終わらせない。
  if (i.ninnikeizoku) {
    const k = keizokuKyufu({ hihokenshaMonths: months, receivingAtLoss: !!i.taishokugo });
    if (!k.ok) {
      return {
        eligible: false,
        reason: k.receiving ? 'keizoku_under1y' : 'ninnikeizoku',
        keizoku: k,
        message: k.receiving
          ? '退職日までの被保険者期間が1年に満たないため、資格喪失後の継続給付は受けられません'
            + '（健康保険法104条。任意継続の期間はこの1年に算入されません）。'
          : '任意継続被保険者になってからの出産については、出産手当金は支給されません'
            + '（健康保険法99条1項かっこ書き・102条1項）。'
            + '★ただし、退職する前から出産手当金を受けていた（産前休業に入っていた）方は、'
            + '任意継続でも「資格喪失後の継続給付」として受け続けられます（104条）。'
            + 'その場合は「退職後の継続給付を受けている」にチェックしてください。'
            + '★退職日に出勤すると受けられなくなります（労務に服した扱いになるため）。',
        total: 0,
      };
    }
    // k.ok → 104条の継続給付。以下、通常どおり計算する
  }

  // ── 支給期間（産前・産後） ─────────────────────────────────────────────
  const kikan = shussanKikan(i.yoteibi, i.shussanbi, i.tatai);

  // ── 標準報酬月額の列（実額 or 月給からの概算） ──────────────────────────
  let standards;
  let estimated = false;
  if (Array.isArray(i.standards) && i.standards.length > 0) {
    standards = i.standards; // 各月の標準報酬月額の実額（古い→新しい順）
  } else {
    const monthly = Math.max(0, Math.floor(Number(i.monthly) || 0));
    if (monthly <= 0) throw new Error('月給または標準報酬月額を入力してください');
    // 月給を等級表で標準報酬月額に直し、被保険者月数ぶん（最大12）並べた概算列。
    // 「毎月同じ標準報酬月額だったと仮定した概算」であることを画面に出す（estimated）。
    const std = kenkoGrade(monthly).standard;
    standards = new Array(Math.max(1, Math.min(months || 12, 12))).fill(std);
    estimated = true;
  }

  const n = nichigaku(standards, D, { startDate: kikan.startDate, heikinOverride: i.heikinOverride });

  // ── 報酬との調整（108条2項）。★出産手当金は報酬だけ。年金の調整は渡さない ──────────
  const adj = chosei(n.amount, { hoshuNichigaku: i.hoshuNichigaku });

  const days = kikan.days;
  const total = adj.paid * days;

  return {
    eligible: true,
    via104: !!i.ninnikeizoku, // 104条の継続給付として計算したか（任意継続なのに支給される）
    estimated,
    months: n.months,
    rule: n.rule, // 'full'（12月以上）/ 'short'（12月未満＝二号頭打ちがありうる）
    base: n.base,
    own: n.own,
    cap: n.cap,
    capped: n.capped,
    heikin: n.heikin ?? null,
    heikinLabel: n.heikinLabel ?? null,
    nichigaku: n.amount, // 調整前の日額
    chosei: adj,
    paidNichigaku: adj.paid, // 調整後の日額
    kikan, // 産前・産後・遅れ/早い・支給開始/終了日
    days,
    total,
  };
}
