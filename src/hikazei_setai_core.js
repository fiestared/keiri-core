/**
 * 住民税非課税世帯の判定コア（DOM非依存・テスト対象）。
 *
 * 「住民税非課税世帯」＝ **世帯全員が住民税の均等割非課税**である世帯。
 * 給付金・高額療養費の区分・保育料の減免などが使う定義はこれで、所得割だけが非課税でも該当しない。
 *
 * 出すもの:
 *  ① 世帯の各人の合計所得金額（給与所得＋公的年金等雑所得＋その他所得 − 所得金額調整控除）
 *  ② 各人の均等割非課税限度額と、非課税かどうか
 *  ③ 世帯として非課税かどうか（＝全員が①≦②）
 *  ④ 課税になっている人が、あといくら所得が下がれば非課税になるか
 *
 * ★★このツールが黙って誤答しやすい急所（すべて e-Gov 法令API v2 で逐語確認済み・2026-07-26）:
 *
 *  1. **非課税限度額は juminzei_r08.json から引く。ここに書き写さない。**
 *     同じ数字を2箇所に持つと必ず片方が腐る。級地倍率（1.0/0.9/0.8）も加算額（21万円）も
 *     あちらが正本で、hikazeiHantei() をそのまま呼ぶ。
 *
 *  2. **65歳以上かどうかは「その年12月31日」の年齢**（措法41条の15の3第4項）。
 *     公的年金等控除の最低保障額が 60万円 → **110万円** に読み替わるのはこの判定に懸かっており、
 *     1歳ずれると年金収入155万円の人の答えが「非課税」と「課税」で反転する。
 *
 *  3. **住民税にも措置法の特例が及ぶ。**（地税313条2項「所得税法**その他の所得税に関する法令**の
 *     規定による…計算の例により算定する」）。所得税法35条だけを見て65歳以上の110万円を落とすと、
 *     年金暮らしの世帯をまとめて「課税」と誤判定する。
 *
 *  4. **扶養に入れる所得の上限は58万円**（地税292条1項7号・9号）。令和7年度までは48万円だった。
 *     48万円のまま計算すると合計所得48万〜58万円の家族を人数に数えられず、限度額を過小に出す。
 *
 *  5. **扶養親族の数には16歳未満も入る**（施行令47条の3第1号）。所得控除には1円も効かないのに、
 *     非課税限度額には効く。子どもを数え落とすと限度額を35万円（1級地）過小に出す。
 *
 *  6. **誰を誰の扶養に付けるかで、世帯の判定が変わることがある。**
 *     例: 夫の合計所得100万円・妻60万円・子2人（1級地）。子2人を夫にまとめて付けると
 *     妻（限度額45万円）が課税で世帯は課税。子を1人ずつ分けると夫も妻も限度額101万円で
 *     **世帯非課税になる**。だから「所得が多い人にまとめる」固定の割り当てでは答えを外す。
 *     → 付け方を全通り試し、**非課税になる付け方が1つでもあるか**で判定する。
 *
 *  7. **子のアルバイト代が世帯の非課税を壊す。**
 *     合計所得58万円以下なら扶養には入れるが、その子自身も均等割の判定を受ける。
 *     1級地なら本人の限度額は45万円なので、合計所得50万円（給与収入115万円）の子は
 *     **自分が課税**になり、世帯は非課税世帯でなくなる。ただし**未成年（18歳未満）なら
 *     合計所得135万円以下で非課税**（地税295条1項2号）なので、同じ収入でも年齢で反転する。
 *
 * 一次情報: 所得税法35条2項1号・4項／租税特別措置法41条の15の3第1項・4項、41条の3の11第2項／
 *           地方税法292条1項7号・9号、295条1項2号・3項、313条2項／同法施行令47条の3
 *           （e-Gov 法令API v2・2026-07-26 逐語確認）。
 */

import { kyuyoShotoku, kyuyoShotokuR8, hikazeiHantei } from './juminzei_core.js';

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると合計が丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
/** 年齢（0以上の整数）。未入力は null（＝年齢が要る判定はしない） */
const ageOf = (n) => {
  if (n === '' || n == null) return null;
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 0 ? v : null;
};

/** upto が null（上限なし）まで含めて区分を引く。境界は「その額まで」＝以下。 */
function pickBracket(brackets, x) {
  for (const b of brackets) {
    if (b.upto == null || x <= b.upto) return b;
  }
  return brackets[brackets.length - 1];
}

/**
 * 公的年金等控除額（所法35条4項＋措法41条の15の3第1項）。
 *
 * @param shunyu    公的年金等の収入金額
 * @param age       その年12月31日の年齢（null なら65歳未満として扱う＝安全側。
 *                  65歳以上の110万円は「有利な」読替えなので、年齢不明で勝手に与えない）
 * @param igaiShotoku 公的年金等に係る雑所得**以外**の合計所得金額
 */
export function kokyoNenkinKojo(shunyu, age, igaiShotoku, D) {
  const N = D.kokyo_nenkin_kojo;
  const s = yen(shunyu);
  if (s <= 0) return 0;

  const b = pickBracket(N.igai_brackets, yen(igaiShotoku));
  const is65 = age != null && age >= N.age_65;
  const min = is65 ? b.min_65over : b.min_under65;

  // ロ: 収入から50万円を引いた残額を、残額の区分で按分する
  const zangaku = Math.max(0, s - N.ro_sashihiki);
  const rb = pickBracket(N.ro_brackets, zangaku);
  const ro = rb.base + Math.floor((zangaku - rb.over) * rb.rate_pct / 100);

  return Math.max(b.i + ro, min);
}

/** 公的年金等に係る雑所得（所法35条2項1号）。控除しきれない分はマイナスにしない。 */
export function nenkinZatsuShotoku(shunyu, age, igaiShotoku, D) {
  const s = yen(shunyu);
  if (s <= 0) return 0;
  return Math.max(0, s - kokyoNenkinKojo(s, age, igaiShotoku, D));
}

/**
 * 所得金額調整控除（措法41条の3の11第2項・給与と年金の両方がある人）。
 * min(給与所得,10万) ＋ min(年金雑所得,10万) − 10万。両方あって合計が10万円を超えるときだけ。
 */
export function choseiKojoNenkinKyuyo(kyuyoSho, nenkinSho, D) {
  const C = D.chosei_kojo_nenkin_kyuyo;
  const k = yen(kyuyoSho);
  const n = yen(nenkinSho);
  if (k <= 0 || n <= 0) return 0;
  if (k + n <= C.shikii) return 0;
  return Math.min(k, C.cap_each) + Math.min(n, C.cap_each) - C.shikii;
}

/**
 * 世帯の1人分の合計所得金額を出す。
 *
 * ★計算の順序: 給与所得 → 公的年金等控除（「以外の合計所得金額」は所得金額調整控除**前**の額で判定）
 *   → 年金雑所得 → 所得金額調整控除 → 合計所得金額。
 *   調整控除は最大10万円なので、この順序が答えを変えるのは「以外の合計所得」が
 *   1,000万円・2,000万円の境界から10万円以内にいる人だけで、非課税の判定には届かない。
 *
 * @param m  { kyuyoShunyu, nenkinShunyu, sonotaShotoku, age }
 * @param zeisei 'r8' なら令和8年分・令和9年分の給与所得（措法29条の4）で計算する
 */
export function memberShotoku(m, D, J, zeisei) {
  const kyuyoSho = zeisei === 'r8'
    ? kyuyoShotokuR8(yen(m.kyuyoShunyu), J)
    : kyuyoShotoku(yen(m.kyuyoShunyu), J);
  const sonota = yen(m.sonotaShotoku);
  const age = ageOf(m.age);

  const igai = kyuyoSho + sonota; // 公的年金等に係る雑所得以外の合計所得金額
  const nenkinSho = nenkinZatsuShotoku(m.nenkinShunyu, age, igai, D);
  const chosei = choseiKojoNenkinKyuyo(kyuyoSho, nenkinSho, D);

  return {
    kyuyoShotoku: kyuyoSho,
    nenkinShotoku: nenkinSho,
    nenkinKojo: yen(m.nenkinShunyu) > 0
      ? kokyoNenkinKojo(m.nenkinShunyu, age, igai, D) : 0,
    sonotaShotoku: sonota,
    choseiKojo: chosei,
    goukeiShotoku: Math.max(0, kyuyoSho + nenkinSho + sonota - chosei),
    age,
    is65: age != null && age >= D.kokyo_nenkin_kojo.age_65,
  };
}

/**
 * 1人分の均等割非課税の判定。扶養している人数（配偶者＋扶養親族）を渡す。
 * 判定そのものは juminzei_core の hikazeiHantei（＝非課税限度額の正本）に委ねる。
 */
function hantei1(sho, fuyoCount, hasSpouseDep, m, kyuchi, J) {
  const family = {
    haigusha: hasSpouseDep ? 'ippan' : 'none',
    // 配偶者以外の扶養親族。16歳未満も含めて数える（施行令47条の3第1号）
    fuyoIppan: fuyoCount,
    honninShogai: !!m.shogaisha,
    // 未成年（18歳未満）は年齢から自動で立てる。入力で明示されていればそちらを優先する。
    // ★295条1項2号の判定時期は賦課期日（1月1日）だが、年齢は誕生日の前日に加算されるため
    //   （年齢計算ニ関スル法律）、12月31日時点の年齢と1月1日時点の年齢が食い違うのは
    //   1月2日生まれの人だけ。画面でその旨を注記する。
    honninMiseinen: m.miseinen != null ? !!m.miseinen : (sho.age != null && sho.age < 18),
    kafu: !!m.kafu,
    hitorioyaHaha: !!m.hitorioya,
  };
  const h = hikazeiHantei(sho.goukeiShotoku, sho.goukeiShotoku, family, kyuchi, J);
  return {
    kintouLimit: h.kintouLimit,
    hikazei: h.kintouwariHikazei,
    jonrei295: h.jonrei295,
    ninzu: h.ninzu,
    kyuchiLabel: h.kyuchiLabel,
    // 課税の人が、あといくら合計所得を下げれば非課税になるか
    chokaGaku: h.kintouwariHikazei ? 0 : sho.goukeiShotoku - h.kintouLimit,
  };
}

/**
 * 扶養の付け方を全通り試して、世帯が非課税になる付け方があるかを探す。
 *
 * ★固定の割り当て（例: 所得が最も多い人にまとめる）では答えを外す。
 *   夫100万・妻60万・子2人（1級地）は、子を1人ずつ分けたときだけ世帯非課税になる。
 *
 * assign[i] = その人を扶養している人の index（-1 = 誰の扶養にも入らない）。
 * 扶養に入れるのは合計所得が58万円以下の人だけで、扶養に入っている人は他人を扶養できない
 * （重ねて数えると同じ人を二重に数えることになる）。
 */
function searchAssignments(members, shotokus, kyuchi, J, D) {
  const n = members.length;
  const limit = D.fuyo_yoken.goukei_shotoku_ika;
  const eligible = shotokus.map((s) => s.goukeiShotoku <= limit);

  let best = null;

  const evaluate = (assign) => {
    // 扶養に入っている人は扶養者になれない
    for (let i = 0; i < n; i++) {
      if (assign[i] >= 0 && assign.some((a, k) => k !== i && a === i)) return null;
    }
    const rows = [];
    for (let i = 0; i < n; i++) {
      let fuyoCount = 0;
      let hasSpouseDep = false;
      for (let k = 0; k < n; k++) {
        if (assign[k] !== i) continue;
        if (members[k].zokugara === 'spouse' && !hasSpouseDep) hasSpouseDep = true;
        else fuyoCount++;
      }
      const h = hantei1(shotokus[i], fuyoCount, hasSpouseDep, members[i], kyuchi, J);
      rows.push({ ...h, fuyoCount, hasSpouseDep, fuyoSaki: assign[i] });
    }
    const setaiHikazei = rows.every((r) => r.hikazei);
    // 課税の人数が少ないものを良しとし、同数なら超過額の合計が小さいものを良しとする
    const kazeiNin = rows.filter((r) => !r.hikazei).length;
    const chokaSum = rows.reduce((a, r) => a + r.chokaGaku, 0);
    return { rows, setaiHikazei, kazeiNin, chokaSum, assign: assign.slice() };
  };

  const assign = new Array(n).fill(-1);
  const rec = (i) => {
    if (best && best.setaiHikazei) return; // 非課税になる付け方が見つかればそこで止めてよい
    if (i === n) {
      const r = evaluate(assign);
      if (!r) return;
      if (!best
        || (r.setaiHikazei && !best.setaiHikazei)
        || (r.setaiHikazei === best.setaiHikazei
            && (r.kazeiNin < best.kazeiNin
                || (r.kazeiNin === best.kazeiNin && r.chokaSum < best.chokaSum)))) {
        best = r;
      }
      return;
    }
    // その人を誰の扶養にも入れない
    assign[i] = -1;
    rec(i + 1);
    if (!eligible[i]) return;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      assign[i] = k;
      rec(i + 1);
    }
    assign[i] = -1;
  };
  rec(0);
  return best;
}

/**
 * 世帯の判定本体。
 *
 * @param input {
 *   kyuchi,     // 1|2|3（生活保護法の級地区分）
 *   zeisei,     // 'r8' なら令和9年度住民税（令和8年分の所得）で計算する
 *   members: [{ label, zokugara, age, kyuyoShunyu, nenkinShunyu, sonotaShotoku,
 *               shogaisha, miseinen, kafu, hitorioya }]
 * }
 * @param D 参照データ（hikazei_setai_r08.json）
 * @param J 参照データ（juminzei_r08.json）… 給与所得と非課税限度額の正本
 */
export function calcHikazeiSetai(input, D, J) {
  if (!D || !J) throw new Error('参照データが渡されていません');
  const members = Array.isArray(input?.members) ? input.members : [];
  if (members.length === 0) throw new Error('世帯に人が1人もいません');
  if (members.length > D.hantei.max_members) {
    throw new Error(`このツールで判定できるのは${D.hantei.max_members}人までです`);
  }

  const kyuchi = [1, 2, 3].includes(Number(input?.kyuchi)) ? Number(input.kyuchi) : 1;
  const zeisei = input?.zeisei === 'r8' ? 'r8' : undefined;

  const shotokus = members.map((m) => memberShotoku(m, D, J, zeisei));
  const best = searchAssignments(members, shotokus, kyuchi, J, D);

  // 「所得が最も多い人にまとめる」付け方でも非課税になるか（＝付け替えの提案が要るか）を見る
  const naive = naiveAssignment(members, shotokus, kyuchi, J, D);

  const rows = members.map((m, i) => ({
    label: m.label || `${i + 1}人目`,
    ...shotokus[i],
    ...best.rows[i],
    fuyoSakiLabel: best.rows[i].fuyoSaki >= 0
      ? (members[best.rows[i].fuyoSaki].label || `${best.rows[i].fuyoSaki + 1}人目`)
      : null,
  }));

  return {
    rows,
    setaiHikazei: best.setaiHikazei,
    kazeiNin: best.kazeiNin,
    // ★付け方を変えれば非課税になる（＝扶養の付け替えで結果が変わる）ケース
    fuyoTsukekaeDeKawaru: best.setaiHikazei && !naive.setaiHikazei,
    kyuchi: String(kyuchi),
    kyuchiLabel: best.rows[0].kyuchiLabel,
    ninzu: members.length,
    year: D._meta?.year || '',
    zeiseiLabel: zeisei === 'r8' ? '令和9年度（令和8年分の所得）' : '令和8年度（令和7年分の所得）',
    fuyoLimit: D.fuyo_yoken.goukei_shotoku_ika,
  };
}

/** 素朴な付け方（扶養に入れる人を、合計所得が最も多い人にまとめる）。比較用。 */
function naiveAssignment(members, shotokus, kyuchi, J, D) {
  const n = members.length;
  const limit = D.fuyo_yoken.goukei_shotoku_ika;
  let top = 0;
  for (let i = 1; i < n; i++) {
    if (shotokus[i].goukeiShotoku > shotokus[top].goukeiShotoku) top = i;
  }
  let fuyoCount = 0;
  let hasSpouseDep = false;
  for (let k = 0; k < n; k++) {
    if (k === top || shotokus[k].goukeiShotoku > limit) continue;
    if (members[k].zokugara === 'spouse' && !hasSpouseDep) hasSpouseDep = true;
    else fuyoCount++;
  }
  const rows = members.map((m, i) => (i === top
    ? hantei1(shotokus[i], fuyoCount, hasSpouseDep, m, kyuchi, J)
    : hantei1(shotokus[i], 0, false, m, kyuchi, J)));
  return { rows, setaiHikazei: rows.every((r) => r.hikazei) };
}

/**
 * 「年金収入だけならいくらまで非課税か」を逆算する（画面の目安表示用）。
 * 二分探索ではなく、限度額から素直に逆算した候補を判定で検算する（式を二重に持たない）。
 */
export function nenkinBorder(age, kyuchi, fuyoCount, hasSpouseDep, D, J) {
  const family = {
    haigusha: hasSpouseDep ? 'ippan' : 'none',
    fuyoIppan: fuyoCount,
  };
  const h = hikazeiHantei(0, 0, family, kyuchi, J);
  const limit = h.kintouLimit;
  let lo = 0;
  let hi = 20000000;
  // 単調増加なので二分探索でよい（判定は必ず本物の計算を通す＝式の二重管理をしない）
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const sho = nenkinZatsuShotoku(mid, age, 0, D);
    if (sho <= limit) lo = mid; else hi = mid - 1;
  }
  return { limit, shunyuMax: lo };
}
