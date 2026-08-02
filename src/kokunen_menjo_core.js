/**
 * 国民年金保険料の免除・納付猶予・学生納付特例の判定コア（DOM非依存・テスト対象）。
 *
 * 出すもの:
 *  ① 6区分（全額免除／4分の3免除／半額免除／4分の1免除／納付猶予／学生納付特例）それぞれについて、
 *     本人・世帯主・配偶者の**誰が基準を満たし、誰が落としたか**
 *  ② 承認されたときに毎月納める保険料
 *  ③ その区分で1年間過ごした場合、将来の老齢基礎年金が満額納付と比べていくら下がるか
 *
 * ★★このツールが黙って誤答しやすい急所（すべて e-Gov 法令API v2 の生条文で逐語確認済み・2026-08-02）:
 *
 *  1. **全額免除には社会保険料控除等を引かない。一部免除には引く。**
 *     施行令6条の11（法90条1項1号=全額免除・3号=障害者等135万）は総所得金額等をそのまま所得とし、
 *     控除の減算規定を**持たない**。施行令6条の12（法90条の2=一部免除、法90条の3=学生納付特例）だけが
 *     第2項で 雑損／医療費／社会保険料／小規模企業共済等掛金／配偶者特別／特定親族特別 の控除額と、
 *     障害者27万（特別障害者40万）・寡婦27万・ひとり親35万・勤労学生27万 を控除する。
 *     日本年金機構のページが全額免除だけ「+社会保険料控除額等」を書いていないのは**省略ではなく条文**。
 *     6区分に一律で控除を引くと、**全額免除の判定だけが甘くなって「免除されます」と誤って答える**。
 *
 *  2. **扶養親族等の使い方も区分で違う。**全額免除・納付猶予は「(数+1)×35万+32万」＝**頭数だけ**
 *     （施行令6条の7）。一部免除・学生納付特例は**区分ごとの控除額**（一般38万・同一生計配偶者/
 *     老人扶養48万・特定扶養63万）を基準額に加算する。揃えると、特定扶養（大学生の子）が居る世帯で
 *     一部免除の基準額を1人あたり25万円 過小に出す。
 *
 *  3. **誰の所得を見るかが区分で違う。**免除（全額・一部）は本人・世帯主・配偶者の**全員**
 *     （法90条1項ただし書・90条の2各項ただし書）。納付猶予は**本人と配偶者だけ**＝世帯主を見ない。
 *     学生納付特例は**本人だけ**。ここを揃えると、実務でいちばん多い「親と同居する20代」を取り違える
 *     （親の所得で全額免除に落ちる人が、納付猶予なら通る。これが納付猶予の存在理由そのもの）。
 *
 *  4. **納付猶予と学生納付特例は年金額に1円も反映されない。**全額免除の「2分の1もらえる」と混同しない。
 *     受給資格期間（10年）には入るので「未納よりまし」だが、**額の話では未納と同じ**。
 *
 *  5. **年齢が分からないときに納付猶予を与えない。**50歳未満が要件なので、不明なら fail closed。
 *
 * 一次情報: 国民年金法 90条・90条の2・90条の3／国民年金法施行令 6条の7・6条の8・6条の8の2・
 *           6条の9・6条の9の2・6条の11・6条の12（e-Gov法令API v2・2026-08-02 逐語確認）。
 *           保険料額と年金額への反映は日本年金機構の免除ページ（更新日2026年4月1日）で照合。
 */

import { calcKiso, pickMangaku } from './nenkin_core.js';

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると合計が丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 人数（0以上の整数）。 */
const cnt = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 年齢。未入力は null（＝年齢が要る判定はしない＝納付猶予を与えない）。 */
const ageOf = (n) => {
  if (n === '' || n == null) return null;
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 0 ? v : null;
};

/** データから区分定義を引く。無ければ null（黙って別の区分を選ばない）。 */
export function kubunDef(key, data) {
  return (data?.kubun || []).find((k) => k.key === key) || null;
}

/** 扶養親族等の頭数（施行令6条の7の「扶養親族等の数」）。区分を問わず合計する。 */
export function fuyoNinzu(fuyo) {
  return cnt(fuyo?.ippan) + cnt(fuyo?.rojin) + cnt(fuyo?.tokutei);
}

/**
 * 扶養親族等控除額の合計（施行令6条の8の2／6条の9／6条の9の2）。
 * 一般38万・同一生計配偶者/老人扶養48万・特定扶養63万。**一部免除と学生納付特例だけが使う。**
 */
export function fuyoKojoGaku(fuyo, data) {
  const tbl = data?.fuyo_kojo || [];
  let sum = 0;
  for (const def of tbl) sum += cnt(fuyo?.[def.key]) * yen(def.yen);
  return sum;
}

/**
 * 所得から引く定額の控除（施行令6条の12第2項2号）。障害者27万（特別障害者40万）・
 * 寡婦27万・ひとり親35万・勤労学生27万。**一部免除と学生納付特例だけが使う。**
 * 障害者は「一般」と「特別」を重ねない（特別を選んだら40万円ひとつ）。
 */
export function teigakuKojoGaku(person, data) {
  const tbl = data?.kojo_teigaku || [];
  const find = (k) => yen((tbl.find((x) => x.key === k) || {}).yen);
  let sum = 0;
  if (person?.tokuBetsuShogaisha) sum += find('toku_shogaisha');
  else if (person?.shogaisha) sum += find('shogaisha');
  if (person?.kafu) sum += find('kafu');
  if (person?.hitorioya) sum += find('hitorioya');
  if (person?.kinroGakusei) sum += find('kinro_gakusei');
  return sum;
}

/**
 * その区分の判定に使う「所得の額」。
 * deduct が false（全額免除・納付猶予）なら**引かない**＝施行令6条の11。
 * deduct が true（一部免除・学生納付特例）なら控除を引く＝施行令6条の12第2項。
 */
export function shotokuFor(person, def, data) {
  const base = yen(person?.shotoku);
  if (!def?.deduct) return base;
  const hikari = yen(person?.kojo) + teigakuKojoGaku(person, data);
  return Math.max(0, base - hikari);
}

/**
 * その区分でその人に当てはまる基準額。
 * count_plus_one … (扶養親族等の数+1)×35万円+32万円（施行令6条の7）
 * base_plus_kojo … 88万/128万/168万 + 扶養親族等控除額（施行令6条の8の2/6条の9/6条の9の2）
 *
 * ★全額免除に限り、障害者・寡婦・ひとり親は135万円の別ルート（法90条1項3号・施行令6条の8）があり、
 *   扶養加算を持たない定額なので、**通常式と比べて有利なほう**を採る。
 */
export function kijunGaku(person, def, data) {
  if (!def) return null;
  let base;
  if (def.formula === 'count_plus_one') {
    base = (fuyoNinzu(person?.fuyo) + 1) * yen(def.per_person_yen) + yen(def.base_yen);
  } else if (def.formula === 'base_plus_kojo') {
    base = yen(def.base_yen) + fuyoKojoGaku(person?.fuyo, data);
  } else {
    return null; // 未知の式は黙って計算しない
  }
  // 135万円の特例は全額免除だけ（納付猶予は法90条1項3号を持たないので効かない）
  if (def.key === 'zengaku' && isTokureiTaisho(person)) {
    const t = yen(data?.tokurei_135?.yen);
    if (t > base) base = t;
  }
  return base;
}

/** 135万円の特例（法90条1項3号）の対象か＝地方税法上の障害者・寡婦・ひとり親。 */
export function isTokureiTaisho(person) {
  return !!(person?.shogaisha || person?.tokuBetsuShogaisha || person?.kafu || person?.hitorioya);
}

/** その人がその区分の所得基準を満たすか。境界は「以下」（条文が「政令で定める額以下であるとき」）。 */
export function judgePerson(person, def, data) {
  const kijun = kijunGaku(person, def, data);
  const shotoku = shotokuFor(person, def, data);
  if (kijun == null) return { pass: false, kijun: null, shotoku, undecidable: true };
  return { pass: shotoku <= kijun, kijun, shotoku, undecidable: false };
}

/** 入力から「その区分で見るべき人」を並べる。居ない人（配偶者なし等）は見ない。 */
function membersFor(input, def) {
  const out = [];
  for (const who of def.who || []) {
    const p = input?.[who];
    if (who === 'honnin') out.push({ who, label: '本人', person: p || {} });
    else if (p) out.push({ who, label: who === 'setainushi' ? '世帯主' : '配偶者', person: p });
  }
  return out;
}

/**
 * 6区分すべてを判定する。
 *
 * @param input {
 *   honnin:{shotoku,fuyo:{ippan,rojin,tokutei},kojo,shogaisha,tokuBetsuShogaisha,kafu,hitorioya,kinroGakusei},
 *   setainushi: 同上 | null（本人が世帯主なら null）,
 *   haigusha:   同上 | null（配偶者なし・別世帯なら null）,
 *   age: number|null,   // 納付猶予の50歳未満判定に使う。不明なら猶予を与えない
 *   isStudent: boolean  // 学生は免除・納付猶予の対象外（学生納付特例へ）
 * }
 * @returns {{results:Array, available:Array, best:Object|null, isStudent:boolean}}
 */
export function hantei(input, data) {
  const age = ageOf(input?.age);
  const isStudent = !!input?.isStudent;
  const results = [];

  for (const def of data?.kubun || []) {
    const r = { key: def.key, label: def.label, law: def.law, payRatio: def.pay_ratio, def };

    // 学生かどうかで、そもそも申請できる制度が入れ替わる（重ねて使えるものではない）。
    if (def.students_only && !isStudent) {
      results.push({ ...r, pass: false, blocked: 'not_student', reason: '学生の方だけが申請できます' });
      continue;
    }
    if (!def.students_only && isStudent) {
      results.push({ ...r, pass: false, blocked: 'student', reason: '学生の方は対象外です（学生納付特例へ）' });
      continue;
    }
    // 納付猶予は50歳未満。年齢不明なら fail closed（有利な扱いを勝手に与えない）。
    if (def.max_age_exclusive != null) {
      if (age == null) {
        results.push({ ...r, pass: false, blocked: 'age_unknown', reason: '年齢が未入力のため判定していません' });
        continue;
      }
      if (age >= def.max_age_exclusive) {
        results.push({ ...r, pass: false, blocked: 'age', reason: `${def.max_age_exclusive}歳以上の方は対象外です` });
        continue;
      }
    }

    const people = membersFor(input, def).map((m) => ({ ...m, ...judgePerson(m.person, def, data) }));
    const failed = people.filter((p) => !p.pass);
    results.push({ ...r, pass: failed.length === 0, people, failed });
  }

  // 有利な順（データの並び順＝全額→4分の3→半額→4分の1→納付猶予→学生納付特例）
  const available = results.filter((x) => x.pass);
  return { results, available, best: available[0] || null, isStudent };
}

/** 承認された区分で毎月納める保険料（法90条の2第6項の端数処理つき）。 */
export function getsugakuHokenryo(def, data) {
  const full = yen(data?.hokenryo?.monthly_yen);
  if (!def || !full) return null;
  const raw = full * Number(def.pay_ratio || 0);
  if (raw <= 0) return 0;
  // 5円未満は切捨て、5円以上10円未満は10円に切上げ＝10円単位への四捨五入
  return Math.round(raw / 10) * 10;
}

/**
 * その区分で12か月過ごした場合の、老齢基礎年金への影響。
 * ★満額も反映率も nenkin_r08.json を正本にして nenkin_core.calcKiso() をそのまま使う
 *   （同じ数字を2箇所に持つと必ず片方が腐る）。
 *
 * @returns {{paidYen:number, menjoYen:number, diffYen:number, reflects:boolean}|null}
 */
export function nenkinEizoku(def, months, nenkinData, birthDate) {
  if (!def || !nenkinData) return null;
  const m = cnt(months) || 12;
  const mangaku = pickMangaku(birthDate, nenkinData);
  const mangakuYen = yen(mangaku?.yen);
  if (!mangakuYen) return null;

  const paid = calcKiso({ mangakuYen, paid: m }, nenkinData);
  if (!def.nenkin_key) {
    // 納付猶予・学生納付特例は額に1円も反映されない（未納と同額）
    return { paidYen: paid.yen, menjoYen: 0, diffYen: paid.yen, reflects: false };
  }
  const menjo = calcKiso({ mangakuYen, [def.nenkin_key]: m }, nenkinData);
  return { paidYen: paid.yen, menjoYen: menjo.yen, diffYen: paid.yen - menjo.yen, reflects: true };
}
