/**
 * 収入印紙・印紙税額の判定コア（DOM非依存・テスト対象）。
 *
 * 出すもの: 文書の種類＋記載金額から、その文書1通（1冊）に必要な収入印紙の額を
 *   印紙税額の一覧表（国税庁 No.7140/No.7141）と軽減措置（No.7108）で判定する。
 *
 * ★★このツールが黙って誤答しやすい急所:
 *
 *  1. **5万円境界と消費税（No.6925）。** 消費税額等が区分記載されている（または税込・税抜の
 *     併記で消費税額等が明らかな）場合、第1号・第2号・第17号文書に限り、記載金額に
 *     消費税額等を含めない＝**税抜金額で判定**する。税込54,800円の領収書も「うち消費税等
 *     4,981円」と書いてあれば記載金額49,819円で**非課税**。逆に、**免税事業者**は区分記載
 *     しても含める（税込で判定）。この取扱いが無い号（15号・16号など）では引かない。
 *
 *  2. **軽減措置は「不動産の譲渡」と「建設工事の請負」だけ（No.7108・措法91条）。**
 *     同じ1号でも消費貸借・運送は本則。同じ2号でも建設工事以外の請負（修理・広告・
 *     システム開発）は本則。適用期間（平成26-04-01〜令和9-03-31）と適用下限
 *     （不動産＞10万円・建設＞100万円。以下は本則200円）をデータに持つ。
 *
 *  3. **売上代金かそれ以外かで17号の税額が違う。** 売上代金（何らかの給付の反対給付）は
 *     金額階級ごと、売上代金以外（借入金・保険金・損害賠償金など）は5万円以上一律200円。
 *
 *  4. **営業に関しない受取書は非課税（17号のみ）。** 公益法人や商人以外の個人の行為は
 *     営業に当たらない（No.7105）。ここを聞かずに個人のマイホーム売却の領収書に
 *     200円と答えるのは誤答。
 *
 *  5. **金額の記載のない文書は0円ではない。** 1号・2号・15号・16号・17号は200円。
 *     3号（手形）だけは非課税（ただし金額を補充した人が納税義務者になる）。
 *
 *  6. **電磁的記録（電子契約・電子領収書）は「作成」に当たらず印紙不要**（画面で常時明示。
 *     コアは紙の文書についてのみ答える）。
 *
 * 一次情報: 国税庁 No.7140/No.7141（印紙税額の一覧表）・No.7108（軽減措置）・
 *   No.7105（受取書・営業に関しない）・No.6925（消費税等と印紙税）。
 */

/** 円に整える（負・NaNは0）。NaNを素通しすると判定金額が丸ごとNaNになる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 金額階級表から該当する行を返す（upto: null は上限なし）。 */
function pickBracket(amount, brackets) {
  for (const b of brackets) {
    if (b.upto === null || b.upto === undefined || amount <= b.upto) return b;
  }
  return brackets[brackets.length - 1];
}

/**
 * 入口。
 * input = {
 *   doc,          // 文書キー（inshi_r07.json の docs のキー。例 'k17_uriage'）
 *   amount,       // 記載金額（円）。noamount:true のときは無視
 *   noamount,     // true = 金額の記載がない文書
 *   taxPart,      // うち消費税額等（円）。区分記載されている場合のみ入力（1号/2号/17号だけ有効）
 *   menzei,       // true = 作成者が免税事業者（消費税額等を引かない＝税込で判定。No.6925）
 *   hieigyo,      // true = 営業に関しない受取書（17号のみ・非課税）
 *   ichiranbarai, // true = 一覧払・金融機関相互間・外貨表示など（3号のみ・特例税率）
 * }
 * D = inshi_r07.json
 *
 * 返り値 = {
 *   tax,             // 印紙税額（円）。非課税は 0
 *   taxable,         // false = 非課税（印紙は不要）
 *   perYear,         // true = 「1年ごとに」の額（18号〜20号）
 *   judgeAmount,     // 判定に使った金額（消費税控除後）。金額を使わない文書は null
 *   usedTaxExclusion,// true = 消費税額等を差し引いて判定した（No.6925）
 *   keigenApplied,   // true = 軽減税率を適用した（No.7108）
 *   bracketLabel,    // 当たった金額階級のラベル（例 '5,000万円を超え1億円以下'）
 *   go, docName,     // 号数・文書名
 *   notes: [],       // 画面に出すべき注意（非課税の理由・軽減の適用期間など）
 * }
 */
export function calcInshi(input, D) {
  if (!D || !D.docs) throw new Error('参照データ（inshi_r07.json）が渡されていません');
  const i = input || {};
  const doc = D.docs[i.doc];
  if (!doc) throw new Error('文書の種類を選んでください');

  const notes = [];
  const base = {
    go: doc.go, docName: doc.name, perYear: false, judgeAmount: null,
    usedTaxExclusion: false, keigenApplied: false, bracketLabel: '', notes,
  };

  // 定額の号（5号〜14号）・通帳（18号〜20号）は金額を使わない
  if (doc.type === 'fixed') {
    if (doc._note) notes.push(doc._note);
    return { ...base, tax: doc.tax, taxable: true };
  }
  if (doc.type === 'per_year') {
    if (doc._note) notes.push(doc._note);
    return { ...base, tax: doc.tax, taxable: true, perYear: true };
  }

  // ── 以下、金額階級のある号（1号〜4号・15号〜17号）──────────────────────────

  // 急所4: 営業に関しない受取書は非課税（17号のみ。他の号にこの非課税は無い）
  if (i.hieigyo) {
    if (doc.go !== '17号') throw new Error('「営業に関しない」の非課税は受取書（17号）だけです');
    notes.push('営業に関しない受取書（公益法人や、商人以外の個人が事業と関係なく作成するもの）は金額によらず非課税です（No.7105）。');
    return { ...base, tax: 0, taxable: false };
  }

  // 急所5: 金額の記載のない文書は号ごとに扱いが違う（0円と決めつけない）
  if (i.noamount) {
    if (doc.noamount === null || doc.noamount === undefined) {
      throw new Error(doc.noamount_note || 'この文書は金額（' + doc.unit + '）の入力が必要です');
    }
    if (doc.noamount_note) notes.push(doc.noamount_note);
    if (doc.noamount === 0) return { ...base, tax: 0, taxable: false };
    return { ...base, tax: doc.noamount, taxable: true, bracketLabel: doc.unit + 'の記載のないもの' };
  }

  const amount = yen(i.amount);
  if (amount <= 0) throw new Error('記載金額（' + doc.unit + '・円）を入力してください');

  // 急所1: 消費税額等の区分記載（No.6925）。対象は1号・2号・17号だけ。免税事業者は引かない
  let judgeAmount = amount;
  let usedTaxExclusion = false;
  const taxPart = yen(i.taxPart);
  if (taxPart > 0) {
    const eligible = (D.kubun_shohizei?.applies_to || []).includes(i.doc);
    if (!eligible) {
      notes.push('消費税額等を記載金額から除ける取扱い（No.6925）は第1号・第2号・第17号文書だけです。この文書では税込金額で判定します。');
    } else if (i.menzei) {
      notes.push('免税事業者は、その取引に課されるべき消費税等が無いため、区分記載しても記載金額に含めます（税込で判定・No.6925）。');
    } else {
      if (taxPart >= amount) throw new Error('消費税額等が記載金額以上になっています。入力を確認してください');
      judgeAmount = amount - taxPart;
      usedTaxExclusion = true;
      notes.push('消費税額等が区分記載されているため、記載金額に含めず税抜 ' + judgeAmount.toLocaleString('ja-JP') + '円で判定しました（No.6925）。');
    }
  }

  // 非課税の下限（1号/2号=1万円未満・3号=10万円未満・17号=5万円未満・15号=1万円未満・16号=3千円未満）
  if (doc.hikazei_under !== null && doc.hikazei_under !== undefined && judgeAmount < doc.hikazei_under) {
    return { ...base, tax: 0, taxable: false, judgeAmount, usedTaxExclusion,
      bracketLabel: doc.unit + 'が' + doc.hikazei_under.toLocaleString('ja-JP') + '円未満のもの' };
  }

  // 3号の特例（一覧払・金融機関相互間・外貨表示・非居住者円表示・円建銀行引受手形）: 10万円以上は一律200円
  if (i.ichiranbarai) {
    if (!doc.ichiranbarai) throw new Error('一覧払等の特例は約束手形・為替手形（3号）だけです');
    return { ...base, tax: doc.ichiranbarai.tax, taxable: true, judgeAmount, usedTaxExclusion,
      bracketLabel: '一覧払のもの等（' + doc.ichiranbarai.hikazei_under.toLocaleString('ja-JP') + '円以上・一律）' };
  }

  // 急所2: 軽減措置（不動産譲渡＞10万円・建設工事請負＞100万円だけ。以下は本則）
  if (doc.keigen && judgeAmount > doc.keigen.over) {
    const b = pickBracket(judgeAmount, doc.keigen.brackets);
    notes.push('軽減措置（措法91条・' + (D._meta?.keigen_from_label || '') + '〜' + (D._meta?.keigen_until_label || '') + 'に作成される契約書）を適用しました（No.7108）。');
    return { ...base, tax: b.tax, taxable: true, judgeAmount, usedTaxExclusion,
      keigenApplied: true, bracketLabel: b.label };
  }

  const b = pickBracket(judgeAmount, doc.brackets);
  if (doc._note) notes.push(doc._note);
  return { ...base, tax: b.tax, taxable: true, judgeAmount, usedTaxExclusion, bracketLabel: b.label };
}
