/**
 * 適格請求書発行事業者の登録番号 / 法人番号の検証（DOM非依存・テスト対象）。
 *
 * 一次情報（2026-07-26 に curl で生読みして確認）:
 *  - 登録番号の構成 https://www.invoice-kohyo.nta.go.jp/about-toroku/index.html
 *      法人番号を有する課税事業者: 「T」＋ 法人番号（数字13桁）
 *      上記以外（個人事業者、人格のない社団等）: 「T」＋ 数字13桁
 *      （注）13桁の数字にはマイナンバーは用いず、法人番号とも重複しない事業者ごとの番号
 *  - チェックデジットの算式 https://www.houjin-bangou.nta.go.jp/documents/checkdigit.pdf
 *      検査用数字 = 9 −（(最下位から偶数桁の和)×2 ＋(最下位から奇数桁の和)）÷9 の余り
 *      ※ 桁は「12桁の基礎番号」を最下位から数える
 *
 * ★ここが誤りやすい: チェックデジットで妥当性を判定できるのは**法人番号ベースの番号だけ**。
 *   個人事業者・人格のない社団等の13桁について、国税庁は検査用数字の規則を公表していない。
 *   したがって検査に外れた番号を「誤り」と断定してはいけない（正しい番号を誤判定する）。
 *   → 本モジュールは NOT_HOUJIN を「法人番号ではない。個人事業者等の可能性があり、
 *      この検査では妥当性を判定できない」という意味で返す。UI もそう表示すること。
 */

/** 判定結果の種類 */
export const STATUS = {
  EMPTY: "empty",              // 入力なし
  FORMAT: "format",            // 13桁の数字にならない（桁数・文字種）
  HOUJIN: "houjin",            // 法人番号として検査用数字が整合＝法人の登録番号として妥当
  NOT_HOUJIN: "not_houjin",    // 13桁だが法人番号ではない（個人事業者等かもしれない＝判定不能）
};

const DASHES = /[-‐‑‒–—―−－ー─]/g;
const SPACES = /[\s　]/g;

/**
 * 入力を13桁の数字に寄せる。全角・T・ハイフン・空白の混在を吸収する。
 * @returns {{digits:string, hadT:boolean, stripped:string}}
 */
export function normalize(raw) {
  let s = String(raw ?? "");
  // 全角英数 → 半角
  s = s.replace(/[０-９Ｔｔ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(DASHES, "").replace(SPACES, "");
  const hadT = /^[Tt]/.test(s);
  const stripped = hadT ? s.slice(1) : s;
  return { digits: stripped, hadT, stripped };
}

/**
 * 12桁の基礎番号から検査用数字を求める。
 * ★戻り値は 1〜9（余り0〜8に対し 9−余り）。**0にはならない**ので、
 *   先頭が0の13桁は法人番号ではありえない。
 * @param {string} base12 数字12桁
 * @returns {number} 検査用数字
 */
export function checkDigit(base12) {
  const s = String(base12);
  if (!/^\d{12}$/.test(s)) throw new Error("基礎番号は数字12桁でなければならない: " + s);
  let evenSum = 0; // 最下位から偶数桁
  let oddSum = 0;  // 最下位から奇数桁
  for (let i = 0; i < 12; i++) {
    const n = Number(s[11 - i]); // i=0 が最下位
    if ((i + 1) % 2 === 0) evenSum += n;
    else oddSum += n;
  }
  return 9 - ((evenSum * 2 + oddSum) % 9);
}

/**
 * 13桁が法人番号として整合するか。
 * @returns {{ok:boolean, expected:number, actual:number, base:string}}
 */
export function verifyHoujinBangou(n13) {
  const s = String(n13);
  if (!/^\d{13}$/.test(s)) throw new Error("法人番号は数字13桁でなければならない: " + s);
  const actual = Number(s[0]);
  const base = s.slice(1);
  const expected = checkDigit(base);
  return { ok: actual === expected, expected, actual, base };
}

/**
 * 1件を判定する。UI と一括処理の両方がこれを使う。
 * @returns {{status:string, digits:string, hadT:boolean, formatted:string,
 *            expected?:number, actual?:number, reason?:string}}
 */
export function classify(raw) {
  const { digits, hadT } = normalize(raw);
  if (!digits) return { status: STATUS.EMPTY, digits: "", hadT, formatted: "" };

  if (!/^\d+$/.test(digits)) {
    return {
      status: STATUS.FORMAT, digits, hadT, formatted: digits,
      reason: "数字以外の文字が含まれている",
    };
  }
  if (digits.length !== 13) {
    return {
      status: STATUS.FORMAT, digits, hadT, formatted: digits,
      reason: `13桁でなければならない（入力は${digits.length}桁）`,
    };
  }

  const v = verifyHoujinBangou(digits);
  const formatted = "T" + digits;
  if (v.ok) {
    return { status: STATUS.HOUJIN, digits, hadT, formatted,
             expected: v.expected, actual: v.actual };
  }
  return {
    status: STATUS.NOT_HOUJIN, digits, hadT, formatted,
    expected: v.expected, actual: v.actual,
    // ★「誤り」と断定しない。個人事業者等の番号は検査規則が公表されていない
    reason: "法人番号の検査用数字と一致しない（法人番号ではない）。"
          + "個人事業者・人格のない社団等の登録番号は、この検査では妥当性を判定できない",
  };
}

/**
 * 貼り付けた複数行をまとめて判定する（公式サイトは1件ずつしか引けないので、ここが本命）。
 * 行に社名などが混ざっていても、その行から番号らしい部分を取り出す。
 * @returns {Array<{line:number, input:string} & ReturnType<typeof classify>>}
 */
export function parseMany(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    // 行の中から「T付き13桁」または「13桁」を探す。無ければ行全体を渡して理由を出させる
    const half = line
      .replace(/[０-９Ｔｔ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(DASHES, "");
    const m = half.match(/[Tt]?\s*\d(?:[\s　]*\d){12}/);
    const picked = m ? m[0] : line;
    out.push({ line: i + 1, input: line.trim(), ...classify(picked) });
  });
  return out;
}

/** 集計（画面のサマリ用） */
export function summarize(results) {
  const s = { total: 0, houjin: 0, notHoujin: 0, format: 0 };
  for (const r of results) {
    if (r.status === STATUS.EMPTY) continue;
    s.total++;
    if (r.status === STATUS.HOUJIN) s.houjin++;
    else if (r.status === STATUS.NOT_HOUJIN) s.notHoujin++;
    else s.format++;
  }
  return s;
}
