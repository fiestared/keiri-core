/**
 * 遺留分の計算コア（DOM非依存・テスト対象）。民法1042条〜1048条。
 *
 * 出すもの:
 *  ① 遺留分を算定するための財産の価額（1043条1項）＝ 相続開始時の財産 ＋ 算入する贈与 − 債務の全額
 *  ② 総体的遺留分の割合（1042条1項）＝ 直系尊属のみ 1/3 ／ それ以外 1/2
 *  ③ 各相続人の個別的遺留分の割合と金額（1042条2項＝ ② × 900条・901条の法定相続分）
 *  ④ 遺留分侵害額（1046条2項）＝ ③ − 受けた遺贈・特別受益 − 取得する遺産 ＋ 承継する債務
 *
 * ★★このツールが黙って誤答しやすい急所（全て一次情報＝e-Gov法令API v2 で逐語確認済み）:
 *
 *  1. **兄弟姉妹に遺留分はない。**（1042条1項柱書「兄弟姉妹以外の相続人は」）
 *     配偶者＋兄弟姉妹なら配偶者だけが 1/2 × 3/4 ＝ 3/8 を持ち、兄弟姉妹の分は誰にも移らない。
 *     兄弟姉妹だけが相続人なら、遺留分を持つ人は一人もいない（＝遺言で全部持っていかれても取り戻せない）。
 *
 *  2. **「直系尊属のみが相続人である場合」に配偶者がいる場合は含まれない。**（1042条1項1号・2号）
 *     配偶者＋父母は2号の「それ以外」＝ 1/2。1号（1/3）と読むと遺留分を過小に出す。
 *
 *  3. **養子の数を制限してはいけない。**（民法809条・887条1項）
 *     相続税法15条3項の「実子がいれば養子は1人まで」は**相続税だけ**のルール。
 *     民法に人数制限はないので、遺留分では養子を全員数える。
 *     → 相続税コア(sozokuzei_core)の houteiSozokunin は**流用してはいけない**（本ファイルで別に実装する）。
 *     一方、法定相続分そのもの（900条）は共通なので houteiBun は流用する（二重実装しない）。
 *
 *  4. **放棄は反映する。**（939条「初めから相続人とならなかったものとみなす」）
 *     相続税法15条2項の「放棄がなかったものとした数」とは**向きが逆**。
 *     子が全員放棄すれば次順位（直系尊属→兄弟姉妹）へ繰り上がり、遺留分の枠組みごと変わる。
 *
 *  5. **贈与を足す期間は、相続人か第三者かで違う。**（1044条1項・3項）
 *     第三者への贈与＝相続開始前の1年間。相続人への贈与＝10年間、かつ**特別受益に限る**。
 *     ★相続税の生前贈与加算（相続税法19条・最長7年）とは別制度・別年数。混ぜると大きく狂う。
 *
 *  6. **1046条2項3号（承継する債務）だけが「加算」。**
 *     借金を承継する分だけ、取り戻すべき額は**増える**。符号を間違えると二重に外す。
 *
 *  7. **2019年7月1日より前に開始した相続には、この計算を当てはめない。**
 *     平成30年法律第72号 附則2条「施行日前に開始した相続については…なお従前の例による」。
 *     旧法では遺留分の割合は**1028条**にあり（現行1042条に相当）、旧1042条は「減殺請求権の期間の制限」
 *     というまったく別の条文だった。旧法に1044条3項の「10年」の枠はなく、相続人への特別受益は
 *     期間の制限なく算入されると解されていたので、新法の枠で計算すると**遺留分を過少に出す**。
 *     → 施行日前の相続は計算せず、その旨を返す（fail closed）。
 *
 * 一次情報: 民法809・887・889・890・900・901・903・939・1042〜1048条／
 *           平成30年法律第72号 附則1条・2条（e-Gov法令API v2・2026-07-25 逐語確認）。
 */

import { houteiBun } from './sozokuzei_core.js';

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると金額が丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
/** 0以上の整数に（人数用）。負や NaN は0。 */
const cnt = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
/** 日付は YYYY-MM-DD の文字列比較で行う（new Date("YYYY-MM-DD") はUTC解釈でJSTだと1日ずれる）。 */
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * 民法上の相続人を決める（★相続税法上の「法定相続人の数」とは別物。急所3・4）。
 * - 放棄した人は初めから相続人でない（939条）＝ 人数から引く
 * - 養子は制限しない（809条・887条1項）＝ 実子と同じく全員数える
 * - 順位: 子（実子＋養子・代襲相続人を含む）→ 直系尊属 → 兄弟姉妹（887条1項・889条1項）
 * - 配偶者は常に相続人（890条）。ただし放棄すれば相続人でない
 *
 * @returns { count, blood:{kind:'child'|'parent'|'sibling'|'none', n}, spouse }
 */
export function minpoSozokunin(family) {
  const f = family || {};
  const spouse = !!f.hasSpouse && !f.spouseRenounced;

  // 放棄した人数を引く。引ききってマイナスにはしない。
  const children = Math.max(0, cnt(f.numChildrenReal) + cnt(f.numChildrenAdopted) - cnt(f.numChildrenRenounced));
  const parents = Math.max(0, cnt(f.numParents) - cnt(f.numParentsRenounced));
  const siblings = Math.max(0, cnt(f.numSiblings) - cnt(f.numSiblingsRenounced));

  let blood;
  if (children > 0) blood = { kind: 'child', n: children };
  else if (parents > 0) blood = { kind: 'parent', n: parents };
  else if (siblings > 0) blood = { kind: 'sibling', n: siblings };
  else blood = { kind: 'none', n: 0 };

  return { count: blood.n + (spouse ? 1 : 0), blood, spouse };
}

/**
 * 総体的遺留分の割合を [分子, 分母] で返す（1042条1項）。
 * ★1号「直系尊属のみが相続人である場合」＝ 配偶者がいない かつ 血族が直系尊属（急所2）。
 * ★兄弟姉妹だけが相続人なら遺留分を持つ人がいないので [0,1]（急所1）。
 */
export function sotaiIryubun(sozokunin, D) {
  if (!D) throw new Error('参照データ（iryubun_r08.json）が渡されていません');
  const { spouse, blood } = sozokunin;
  if (sozokunin.count === 0) return null;                       // 相続人がいない
  if (!spouse && blood.kind === 'sibling') return [0, 1];        // 兄弟姉妹のみ＝遺留分ゼロ
  if (!spouse && blood.kind === 'parent') return D.sotai_warigo.chokkei_sonzoku_nomi; // 1号 1/3
  return D.sotai_warigo.sonota;                                  // 2号 1/2
}

/** 分数の掛け算（約分はしない。表示側で既約にする必要があれば gcd を使う）。 */
const mul = (a, b) => [a[0] * b[0], a[1] * b[1]];
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
/** 既約分数に直す（0/n は [0,1]）。 */
export function reduce(frac) {
  const [n, d] = frac;
  if (n === 0) return [0, 1];
  const g = gcd(Math.abs(n), Math.abs(d));
  return [n / g, d / g];
}

/**
 * 各相続人の「個別的遺留分の割合」（1042条2項＝総体的遺留分 × 900条・901条の法定相続分）。
 * ★兄弟姉妹は1042条1項柱書で除かれるので、法定相続分は持つが遺留分は0（急所1）。
 * @returns [{ who, label, count, frac:[n,d], each:[n,d] }] frac=そのグループ合計 / each=1人あたり
 */
export function kobetsuIryubun(sozokunin, D) {
  const sotai = sotaiIryubun(sozokunin, D);
  if (!sotai) return [];
  const bun = houteiBun(sozokunin); // 民法900条の法定相続分（相続税コアと共通・二重実装しない）
  const out = [];

  if (bun.spouse) {
    const each = reduce(mul(sotai, bun.spouse));
    out.push({ who: 'spouse', label: '配偶者', count: 1, each, frac: each, houtei: reduce(bun.spouse), hasIryubun: each[0] > 0 });
  }
  if (bun.blood && sozokunin.blood.n > 0) {
    const kind = sozokunin.blood.kind;
    // ★兄弟姉妹には遺留分がない（1042条1項柱書）。法定相続分があっても0にする。
    const each = kind === 'sibling' ? [0, 1] : reduce(mul(sotai, bun.blood));
    const n = sozokunin.blood.n;
    out.push({
      who: kind,
      label: kind === 'child' ? '子' : kind === 'parent' ? '父母（直系尊属）' : '兄弟姉妹',
      count: n,
      each,
      frac: reduce([each[0] * n, each[1]]),
      houtei: reduce(bun.blood), // ★法定相続分（900条）。兄弟姉妹は相続分はあるが遺留分は0
      hasIryubun: each[0] > 0,
    });
  }
  return out;
}

/**
 * 遺留分を算定するための財産の価額（1043条1項）。
 *   ＝ 相続開始の時において有した財産 ＋ 算入する贈与 − 債務の全額
 * 贈与は用途別に分けて受け取る（1044条1項・3項。急所5）。
 */
export function santeiZaisan(input) {
  const i = input || {};
  const isan = yen(i.isanTotal);
  const zoyoSozokunin = yen(i.zoyoSozokunin);   // 相続人への特別受益（10年内）
  const zoyoDaisansha = yen(i.zoyoDaisansha);   // 第三者への贈与（1年内）
  const zoyoGaiZoyo = yen(i.zoyoSongaiShiri);   // 期間外だが当事者双方が損害を知ってした贈与
  const saimu = yen(i.saimuTotal);
  const zoyoTotal = zoyoSozokunin + zoyoDaisansha + zoyoGaiZoyo;
  return {
    isan,
    zoyoSozokunin,
    zoyoDaisansha,
    zoyoSongaiShiri: zoyoGaiZoyo,
    zoyoTotal,
    saimu,
    // 債務が財産を上回れば0（マイナスの遺留分は観念しない）
    kingaku: Math.max(0, isan + zoyoTotal - saimu),
    saimuChoka: isan + zoyoTotal - saimu < 0,
  };
}

/**
 * 遺留分侵害額の請求権の期限の目安（1048条）。
 * 知った日から1年（時効）／相続開始から10年（除斥）。日付は文字列比較で扱う（TZ非依存）。
 */
export function jikoKigen(kaishiDate, shittaDate, D) {
  if (!D) throw new Error('参照データ（iryubun_r08.json）が渡されていません');
  const J = D.jiko;
  const addYears = (ymd, y) => {
    const [Y, M, Dd] = ymd.split('-').map(Number);
    return `${Y + y}-${String(M).padStart(2, '0')}-${String(Dd).padStart(2, '0')}`;
  };
  const out = { kaishiKara: null, shittaKara: null, years1: J.shitta_toki_kara_years, years10: J.kaishi_kara_years };
  if (isDate(kaishiDate)) out.kaishiKara = addYears(kaishiDate, J.kaishi_kara_years);
  if (isDate(shittaDate)) out.shittaKara = addYears(shittaDate, J.shitta_toki_kara_years);
  return out;
}

/**
 * 入口。
 * input = {
 *   kaishiDate,           // 相続開始日 YYYY-MM-DD（★2019-07-01より前なら計算しない）
 *   isanTotal,            // 相続開始の時において有した財産の価額
 *   zoyoSozokunin,        // 相続人への特別受益の贈与（相続開始前10年内）
 *   zoyoDaisansha,        // 第三者への贈与（相続開始前1年内）
 *   zoyoSongaiShiri,      // 期間外だが当事者双方が損害を加えることを知ってした贈与
 *   saimuTotal,           // 債務の全額
 *   hasSpouse, spouseRenounced,
 *   numChildrenReal, numChildrenAdopted, numChildrenRenounced,
 *   numParents, numParentsRenounced,
 *   numSiblings, numSiblingsRenounced,
 *   me,                   // 'spouse' | 'child' | 'parent' | 'sibling'（あなたの立場）
 *   meJuizo,              // あなたが受けた遺贈・特別受益の価額（1046条2項1号）
 *   meShutoku,            // あなたが取得する（した）遺産の価額（同2号）
 *   meSaimu,              // あなたが承継する債務の額（同3号・★加算）
 *   shittaDate,           // 侵害を知った日（時効の目安表示用・任意）
 * }
 */
export function calcIryubun(input, D) {
  if (!D) throw new Error('参照データ（iryubun_r08.json）が渡されていません');
  const i = input || {};

  // ── 急所7: 施行日前の相続は計算しない（fail closed）──────────────────────
  const shikoubi = D.shinpo.shikoubi;
  if (isDate(i.kaishiDate) && i.kaishiDate < shikoubi) {
    return {
      kyuho: true,
      shikoubi,
      shikoubiHyoji: D.shinpo.shikoubi_hyoji,
      kyujoBangou: D.shinpo.kyujo_bangou,
      message: `相続開始日が${D.shinpo.shikoubi_hyoji}より前のため、このツールでは計算できません。`,
    };
  }

  const zaisan = santeiZaisan(i);
  const sozokunin = minpoSozokunin(i);
  if (sozokunin.count === 0) {
    throw new Error('相続人がいません。配偶者・子・父母・兄弟姉妹のいずれかを入力してください');
  }

  const sotai = sotaiIryubun(sozokunin, D);
  const kobetsu = kobetsuIryubun(sozokunin, D);
  // 誰にも遺留分がない（兄弟姉妹のみが相続人）
  const daremoNashi = sotai[0] === 0;

  // 各グループの金額（1円未満は切り捨て）
  const rows = kobetsu.map((k) => ({
    ...k,
    eachYen: Math.floor(zaisan.kingaku * k.each[0] / k.each[1]),
    groupYen: Math.floor(zaisan.kingaku * k.each[0] / k.each[1]) * k.count,
  }));

  // ── あなたの遺留分侵害額（1046条2項）────────────────────────────────
  const me = i.me || null;
  const myRow = me ? rows.find((r) => r.who === me) || null : null;
  let shingai = null;
  if (myRow) {
    const iryubunGaku = myRow.eachYen;
    const juizo = yen(i.meJuizo);     // 1号（控除）
    const shutoku = yen(i.meShutoku); // 2号（控除）
    const saimu = yen(i.meSaimu);     // 3号（★加算）
    const raw = iryubunGaku - juizo - shutoku + saimu;
    shingai = {
      iryubunGaku,
      juizo,
      shutoku,
      saimu,
      gaku: Math.max(0, raw),
      shingaiAri: raw > 0,
      hasIryubun: myRow.hasIryubun,
    };
  }

  return {
    kyuho: false,
    zaisan,
    sozokunin,
    sotai,
    sotaiHyoji: sotai[0] === 0 ? 'なし' : `${sotai[1]}分の${sotai[0]}`,
    daremoNashi,
    rows,
    me,
    myRow,
    shingai,
    kigen: jikoKigen(i.kaishiDate, i.shittaDate, D),
    year: D._meta?.year || '',
  };
}
