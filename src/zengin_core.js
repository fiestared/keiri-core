/**
 * 振込名義の全銀フォーマット正規化(DOM非依存・テスト対象)。
 *
 * ルールの一次ソース(2026-07-11確認):
 * - 使用可能文字: 全銀協「使用文字一覧」注1 (zenginkyo.or.jp news311202_1.pdf, 2026-07-13 PDF実読)
 *   受取人名・口座名・振込依頼人名は カナ(ヲと小文字を除く)・濁半濁点・英数と、記号は ( ) - . の4種類のみ
 *   ※銀行配布の「データレコード使用可能文字」表(/ ¥ ｢｣ を含む)はレコード全体の文字集合であって
 *     受取人名フィールドの許可集合ではない。混同しないこと(下の ALLOWED のコメント参照)
 * - 変換規則: きらぼし銀行/福井銀行/りそな(小文字→大文字、長音ー→ハイフン、中黒・→ピリオド、最大30文字)
 *   ※長音ｰ とハイフン- は別物。一次ソースが名指しで区別しており、長音は使用不可
 * - 法人・営業所・事業略語: 第四北越銀行 houjinryakugo.pdf
 *   法人略語は位置で形式が変わる: 先頭「カ)」/ 末尾「(カ」/ 中間「(カ)」。事業略語は括弧なし
 */

// ---- 略語テーブル(長い語から先にマッチさせる) ----
export const LEGAL_ABBR = [
  ["特定非営利活動法人", "トクヒ"], ["ＮＰＯ法人", "トクヒ"], ["NPO法人", "トクヒ"],
  ["独立行政法人", "ドク"], ["国立大学法人", "ダイ"],
  ["社会福祉法人", "フク"], ["宗教法人", "シユウ"], ["学校法人", "ガク"],
  ["一般財団法人", "ザイ"], ["公益財団法人", "ザイ"], ["財団法人", "ザイ"],
  ["一般社団法人", "シヤ"], ["公益社団法人", "シヤ"], ["社団法人", "シヤ"],
  ["医療法人社団", "イ"], ["医療法人財団", "イ"], ["医療法人", "イ"],
  ["弁護士法人", "ベン"], ["税理士法人", "ゼイ"],
  ["株式会社", "カ"], ["有限会社", "ユ"], ["合名会社", "メ"],
  ["合資会社", "シ"], ["合同会社", "ド"],
];
export const OFFICE_ABBR = [["営業所", "エイ"], ["出張所", "シユツ"]];
export const BUSINESS_ABBR = [
  ["健康保険組合", "ケンポ"], ["生活協同組合", "セイキヨウ"],
  ["協同組合", "キヨウクミ"], ["連合会", "レン"],
];

// ---- カナ変換テーブル ----
const KATA_HALF = {
  ア: "ｱ", イ: "ｲ", ウ: "ｳ", エ: "ｴ", オ: "ｵ",
  カ: "ｶ", キ: "ｷ", ク: "ｸ", ケ: "ｹ", コ: "ｺ",
  サ: "ｻ", シ: "ｼ", ス: "ｽ", セ: "ｾ", ソ: "ｿ",
  タ: "ﾀ", チ: "ﾁ", ツ: "ﾂ", テ: "ﾃ", ト: "ﾄ",
  ナ: "ﾅ", ニ: "ﾆ", ヌ: "ﾇ", ネ: "ﾈ", ノ: "ﾉ",
  ハ: "ﾊ", ヒ: "ﾋ", フ: "ﾌ", ヘ: "ﾍ", ホ: "ﾎ",
  マ: "ﾏ", ミ: "ﾐ", ム: "ﾑ", メ: "ﾒ", モ: "ﾓ",
  ヤ: "ﾔ", ユ: "ﾕ", ヨ: "ﾖ",
  ラ: "ﾗ", リ: "ﾘ", ル: "ﾙ", レ: "ﾚ", ロ: "ﾛ",
  ワ: "ﾜ", ン: "ﾝ",
  ガ: "ｶﾞ", ギ: "ｷﾞ", グ: "ｸﾞ", ゲ: "ｹﾞ", ゴ: "ｺﾞ",
  ザ: "ｻﾞ", ジ: "ｼﾞ", ズ: "ｽﾞ", ゼ: "ｾﾞ", ゾ: "ｿﾞ",
  ダ: "ﾀﾞ", ヂ: "ﾁﾞ", ヅ: "ﾂﾞ", デ: "ﾃﾞ", ド: "ﾄﾞ",
  バ: "ﾊﾞ", ビ: "ﾋﾞ", ブ: "ﾌﾞ", ベ: "ﾍﾞ", ボ: "ﾎﾞ",
  パ: "ﾊﾟ", ピ: "ﾋﾟ", プ: "ﾌﾟ", ペ: "ﾍﾟ", ポ: "ﾎﾟ",
  ヴ: "ｳﾞ",
  // 小文字は大文字へ(全銀規則)。ヵ/ヶ も小書きなので カ/ケ へ
  ッ: "ﾂ", ャ: "ﾔ", ュ: "ﾕ", ョ: "ﾖ",
  ァ: "ｱ", ィ: "ｲ", ゥ: "ｳ", ェ: "ｴ", ォ: "ｵ", ヮ: "ﾜ", ヵ: "ｶ", ヶ: "ｹ",
  // 旧かな: 半角カナに存在せず全銀の文字表にも無い → イ/エ へ(ヲ→オ と同じ扱い。警告を出す)
  ヰ: "ｲ", ヱ: "ｴ",
  // 記号
  ー: "-", "・": ".", "　": " ",
  "（": "(", "）": ")", "．": ".", "－": "-", "‐": "-", "―": "-",
  "／": "/", "￥": "¥", "「": "｢", "」": "｣", "，": ",",
};
// 半角小文字カナ・ヲの補正
const HALF_FIX = {
  ｧ: "ｱ", ｨ: "ｲ", ｩ: "ｳ", ｪ: "ｴ", ｫ: "ｵ", ｬ: "ﾔ", ｭ: "ﾕ", ｮ: "ﾖ", ｯ: "ﾂ",
  "･": ".", ｰ: "-",
};

// 【重要】「使用可能文字」には2階層あり、混同すると使えない文字を通してしまう(2026-07-13に踏みかけた)。
//  (a) レコード全体の文字集合(JIS X 0201系): ( ) ｢ ｣ / - . ¥ まで含む。銀行が配る
//      「全銀仕様データレコード使用可能文字」(但馬信金・きらぼし等)はこの階層を載せている
//  (b) フィールド別の制限 ← 受取人名・口座名・振込依頼人名はこちら。**記号は ( ) - . の4種類のみ**
//      一次ソース: 全銀協「使用文字一覧」注1 (zenginkyo.or.jp news311202_1.pdf, 2026-07-13 PDF実読)
//      「口座名等で使用できる文字は、カナ(ヲと小文字を除く)、濁点、(中略)、
//       記号4種類(( ) -〔ハイフン〕 .〔ピリオド〕)のみである」
//  このツールが扱うのは受取人名なので (b) に従う。/ ¥ ｢ ｣ , は不可。長音ｰもハイフン-とは別物で不可。
const ALLOWED = /^[ｱ-ﾝﾞﾟA-Z0-9()\-. ]*$/;
const KANJI = /[々㐀-鿿豈-﫿]/;

function hiraganaToKatakana(s) {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

function fullToHalfAlnum(s) {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 略語変換: 位置に応じて括弧形式を変える。1回だけ適用 */
function applyAbbr(name, table, style, warnings) {
  for (const [pat, abbr] of table) {
    const idx = name.indexOf(pat);
    if (idx === -1) continue;
    let rep;
    if (style === "plain") {
      rep = abbr;
    } else if (idx === 0) {
      rep = abbr + ")";
    } else if (idx + pat.length === name.length) {
      rep = "(" + abbr;
    } else {
      rep = "(" + abbr + ")";
    }
    return name.slice(0, idx) + rep + name.slice(idx + pat.length);
  }
  return name;
}

export const MAX_LEN_DEFAULT = 30; // 総合振込の受取人名の一般的な上限

/**
 * 1名義を正規化する。
 * @returns {{ output: string, warnings: string[], length: number, ok: boolean }}
 */
export function normalize(input, maxLen = MAX_LEN_DEFAULT) {
  const warnings = [];
  let s = input.trim();
  if (!s) return { output: "", warnings: ["空行"], length: 0, ok: false };

  // 1) 法人・営業所・事業略語(漢字のまま先に置換)
  s = applyAbbr(s, LEGAL_ABBR, "paren", warnings);
  s = applyAbbr(s, OFFICE_ABBR, "paren", warnings);
  s = applyAbbr(s, BUSINESS_ABBR, "plain", warnings);

  // 2) ひらがな→カタカナ、英数字全角→半角
  s = hiraganaToKatakana(s);
  s = fullToHalfAlnum(s);

  // 3) 全銀の文字表に無いカナの読み替え(ヲ→オ / ヰ→イ・ヱ→エ)。
  //    黙って置き換えると銀行の登録名義とズレても気付けないので、必ず申告する。
  if (/[ヲｦ]/.test(s)) {
    s = s.replace(/[ヲｦ]/g, "オ");
    warnings.push("「ヲ」は口座名義に使えないため「オ」に変換しました");
  }
  if (/[ヰヱ]/.test(s)) {
    warnings.push("「ヰ」「ヱ」は全銀の文字表に無いため「イ」「エ」に変換しました(例: ヱビス→ｴﾋﾞｽ)");
  }

  // 4) カナ・記号→半角
  let out = "";
  for (const ch of s) {
    if (KATA_HALF[ch] !== undefined) out += KATA_HALF[ch];
    else if (HALF_FIX[ch] !== undefined) out += HALF_FIX[ch];
    else out += ch;
  }

  // 5) 英小文字→大文字
  out = out.replace(/[a-z]/g, (c) => c.toUpperCase());

  // 6) 連続スペースの圧縮
  out = out.replace(/ {2,}/g, " ").trim();

  // 7) 使用不可文字の検出
  // 残った文字の種類で助言を変える。以前は一律「漢字名義は読みをカナで」と言っていたため、
  // 記号や旧かなが残ったときに「カナで入力しろ」と的外れな指示になり、直しようが無かった。
  const bad = [...new Set([...out].filter((c) => !ALLOWED.test(c)))];
  if (bad.length) {
    const kanji = bad.filter((c) => KANJI.test(c));
    // ★ワ行の濁音(ヷヸヹヺ)は「記号」ではなくカナ。半角カナ表に無く機械的には変換できないが、
    //   「使える記号は ( ) - . だけ」という記号向けの説明を出すのは誤り(2026-07-19レビュー)。
    //   名義の実際の登録表記(ﾜ・ﾊﾞ等)は口座側で決まっているので、確認を促す文言にする。
    const wagyo = bad.filter((c) => /[ヷヸヹヺ]/.test(c));
    const other = bad.filter((c) => !KANJI.test(c) && !/[ヷヸヹヺ]/.test(c));
    const parts = [];
    if (kanji.length) parts.push(`${kanji.join(" ")} (漢字は読みをカナで入力してください)`);
    if (wagyo.length) {
      parts.push(
        `${wagyo.join(" ")} (ワ行の濁音は全銀の半角カナに無い文字です。口座名義がどの表記(ﾜ・ﾊﾞ 等)で登録されているかを通帳・銀行に確認し、その表記で入力してください)`
      );
    }
    if (other.length) {
      parts.push(
        `${other.join(" ")} (受取人名で使える記号は ( ) - . と半角スペースだけです)`
      );
    }
    warnings.push(`使用できない文字が残っています: ${parts.join(" / ")}`);
  }

  // 8) 文字数チェック(半角で数える)
  if (out.length > maxLen) {
    warnings.push(`${out.length}文字 — 上限${maxLen}文字を超えています(超過分は銀行側で切られる可能性)`);
  }

  return { output: out, warnings, length: out.length, ok: bad.length === 0 && out.length <= maxLen };
}

/** 複数行の一括正規化 */
export function normalizeBatch(text, maxLen = MAX_LEN_DEFAULT) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => ({ input: line.trim(), ...normalize(line, maxLen) }));
}
