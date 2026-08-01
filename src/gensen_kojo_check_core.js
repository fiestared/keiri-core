/**
 * 源泉徴収票「③所得控除の額の合計額」の検算コア（DOM非依存・テスト対象）。
 *
 * 出すもの: 源泉徴収票に**印字されている控除の額**と**人数だけの欄**から③を組み立て直し、
 *   ③との差額がどの控除で説明できるかを返す。「自分で足し算しても合わない」を解く。
 *
 * ★★このコアが黙って誤答しやすい急所（すべてテストで固定してある）:
 *
 *  1. **住宅借入金等特別控除の額は③に入らない。**（所得税法41条＝税額控除）
 *     票の上では③のすぐ近くに印字されるので、利用者が足してしまう向きが最も多い。
 *     足すと③を超える＝差額がマイナスになるので、**マイナスを「0」に丸めずそのまま申告する**。
 *     丸めると「合っています」と答えてしまい、間違いを隠す方向に誤答する。
 *
 *  2. **所得金額調整控除は③ではなく②で引かれている。**（措法41条の3の11）
 *     ③に足そうとすると二重に引くことになる。これも差額をマイナスに振らせる原因なので、
 *     マイナス側の説明候補として明示する。
 *
 *  3. **「障害者の数」欄は本人を含まない。**（法定調書の記載要領）
 *     本人が障害者でも人数欄は増えないので、本人分（27万／40万）は
 *     **人数からは絶対に出てこない**。残差の説明候補として持つ必要がある。
 *
 *  4. **寡婦・ひとり親・勤労学生は票のどこにも金額が出ない。**（80〜82条）
 *     ○印すら付かない。よって「人数を全部入れたのにまだ差がある」は異常ではなく、
 *     この3つのどれかである可能性が高い。**差が残った＝入力ミス、と決めつけない。**
 *
 *  5. **同居老親等・同居特別障害者は「内書き」＝上位区分の人数に含まれている。**
 *     票では点線の左側に小さく併記される。利用者が両方に人数を入れると二重計上になるため、
 *     このコアは**区分ごとに独立した人数**を受け取る前提で、その旨を呼び出し側が明示する。
 *
 *  6. **金額は参照データが正本（年分で変わりうる）。** データが無ければ計算しない（fail closed）。
 *     ★令和7年分では控除「額」は据え置きで、動いたのは扶養親族等の**所得要件**（48万→58万）。
 *       額と要件を混同してデータを書き換えると、正しい票を「合わない」と誤判定する。
 */

/** 円に丸める（負値も保つ。0への丸めをしない＝急所1）。 */
function yen(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/** 人数として読む（負・非数は0。小数は切り捨て）。 */
function cnt(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 印字されている控除額の合計を出す。
 * @param printed {{shakaiHoken,seimeiHoken,jishinHoken,haigusha,tokuteiShinzoku,kisoKojo}}
 * @returns { total, items: [{key,label,amount}] }
 */
export function printedTotal(printed = {}) {
  const defs = [
    ['shakaiHoken', '社会保険料等の金額'],
    ['seimeiHoken', '生命保険料の控除額'],
    ['jishinHoken', '地震保険料の控除額'],
    ['haigusha', '配偶者（特別）控除の額'],
    ['tokuteiShinzoku', '特定親族特別控除の額'],
    ['kisoKojo', '基礎控除の額'],
  ];
  const items = [];
  let total = 0;
  for (const [key, label] of defs) {
    const amount = yen(printed[key]);
    total += amount;
    items.push({ key, label, amount });
  }
  return { total, items };
}

/**
 * 人数だけの欄（扶養親族の数・障害者の数）を金額に直す。
 * @param counts {{ippan,tokutei,rojin,dokyo_rojin,shogaisha,tokubetsu,dokyo_tokubetsu}}
 * @returns { total, items: [{group,key,label,ran,n,amount}] }
 */
export function countsToYen(counts = {}, D) {
  if (!D?.fuyo?.kubun || !D?.shogaisha?.kubun) {
    throw new Error('参照データ（gensen_kojo_r07.json の fuyo / shogaisha）が渡されていません');
  }
  const items = [];
  let total = 0;
  for (const [group, list] of [['fuyo', D.fuyo.kubun], ['shogaisha', D.shogaisha.kubun]]) {
    for (const k of list) {
      const n = cnt(counts[k.key]);
      if (!n) continue;
      const amount = k.amount * n;
      total += amount;
      items.push({ group, key: k.key, label: k.label, ran: k.ran, n, amount });
    }
  }
  return { total, items };
}

/**
 * 残差を、票に金額が出ない控除の組み合わせで説明できるか探す。
 * ★組み合わせは総当たりだが、**同時に成り立たない組**（寡婦とひとり親は排他＝80条柱書き
 *   「ひとり親に該当しないもの」／本人の障害者と特別障害者も排他）を落とす。
 *   落とさないと「27万＋35万＝62万」のような、法律上ありえない説明を出してしまう。
 * @returns [{ keys:[...], labels:[...], total }] 一致したものだけ（0件なら説明できなかった）
 */
export function explainRemainder(remainder, D) {
  if (!D?.hyoji_nashi?.kubun) {
    throw new Error('参照データ（gensen_kojo_r07.json の hyoji_nashi）が渡されていません');
  }
  const target = yen(remainder);
  const list = D.hyoji_nashi.kubun;
  const hits = [];
  // 5要素なので2^5=32通り。総当たりで十分（将来増えても実用範囲）。
  for (let mask = 1; mask < (1 << list.length); mask++) {
    const picked = list.filter((_, i) => mask & (1 << i));
    const keys = picked.map((p) => p.key);
    if (keys.includes('kafu') && keys.includes('hitorioya')) continue;              // 排他（80条柱書き）
    if (keys.includes('honnin_shogaisha') && keys.includes('honnin_tokubetsu_shogaisha')) continue; // 排他（79条）
    const total = picked.reduce((s, p) => s + p.amount, 0);
    if (total !== target) continue;
    hits.push({ keys, labels: picked.map((p) => p.label), total });
  }
  // 説明は「使う控除の数が少ない順」＝素直な解を先に見せる
  hits.sort((a, b) => a.keys.length - b.keys.length || a.total - b.total);
  return hits;
}

/**
 * ③所得控除の額の合計額の検算。
 * @param input {{ san:number, printed:object, counts:object }}
 *   san = 票の③「所得控除の額の合計額」
 * @returns {{
 *   ok, san, printed, counted, accounted, remainder, matched,
 *   explains, overshoot, notes:[{key,text}], year
 * }}
 *   matched   … 残差0＝③を最後まで説明できた
 *   overshoot … 残差が負＝③より多く積んでいる（急所1・2）。**0に丸めない**
 */
export function checkSanKojo(input = {}, D) {
  if (!D?.fuyo || !D?.hyoji_nashi) {
    throw new Error('参照データ（gensen_kojo_r07.json）が渡されていません');
  }
  const san = yen(input.san);
  const printed = printedTotal(input.printed);
  const counted = countsToYen(input.counts, D);
  const accounted = printed.total + counted.total;
  const remainder = san - accounted;

  // ③が未入力（0）なら計算しない。0円と答えると「合っています」に見えるため。
  if (san <= 0) {
    return {
      ok: false, reason: 'no_san', san, printed, counted, accounted,
      remainder: 0, matched: false, explains: [], overshoot: false,
      notes: [], year: D._meta?.year || '',
    };
  }

  const overshoot = remainder < 0;
  const explains = overshoot ? [] : explainRemainder(remainder, D);
  const notes = [];

  if (overshoot) {
    // 急所1・2: マイナスになる原因は、③に入らないものを足したときが圧倒的に多い
    notes.push({ key: 'jutaku', text: '住宅借入金等特別控除の額を足していませんか。これは所得控除ではなく税額控除で、③には入りません（③を素通りして税額から直接引かれます）。' });
    notes.push({ key: 'chosei', text: '所得金額調整控除を足していませんか。これは③ではなく②（給与所得控除後の金額）の側で引かれています。③に足すと二重に引くことになります。' });
  } else if (remainder > 0 && explains.length === 0) {
    notes.push({ key: 'unexplained', text: '人数欄と印字欄では説明しきれない差が残りました。扶養親族・障害者の人数の入れ忘れ（特に「特定」「老人」「特別」の区分）か、票に金額が出ない控除の重複が考えられます。' });
  }
  if (!overshoot && counted.total === 0 && remainder > 0) {
    notes.push({ key: 'no_counts', text: '扶養親族・障害者の人数を入れていません。票の「控除対象扶養親族の数」「障害者の数」欄に人数があれば入れてください。' });
  }
  if (remainder > 0 && explains.some((e) => e.keys.some((k) => k.startsWith('honnin_')))) {
    // 急所3
    notes.push({ key: 'honnin', text: '「障害者の数」欄は本人を含みません。本人が障害者の場合の27万円（特別障害者は40万円）は、人数欄には現れずここに残差として出ます。' });
  }
  if (yen(input.printed?.kisoKojo) === 0) {
    notes.push({ key: 'kiso', text: '「基礎控除の額」が0円のままです。令和7年分から独立した欄になっており、年末調整をしていれば必ず金額が入っています（空欄なら年末調整をしていません）。' });
  }

  return {
    ok: true, san, printed, counted, accounted, remainder,
    matched: remainder === 0, explains, overshoot, notes,
    year: D._meta?.year || '',
  };
}
