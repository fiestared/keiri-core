/**
 * 給与の源泉徴収税額（月額表・令和8年分）のテスト。
 *
 * 検算の要は「2つの独立した国税庁PDFを突き合わせる」こと:
 *   ①月額表(01-07.pdf) を機械抽出した JSON
 *   ②甲欄の電算機計算の特例(denshi_01.pdf) の算式を実装した denshiKouTax()
 * 特例PDFは「税額表は階級の中間値を基として計算してある
 * （175,000円以上177,000円未満 → 176,000円として計算）」と明記しているので、
 * **表の全行 × 扶養0〜7人** について 表の値 == 特例(中間値) が成り立たなければならない。
 * 片方の転記ミスも、片方の算式の読み違いも、これで落ちる。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  kouTax, otsuTax, denshiKouTax, findRow, extraDependentCount,
  kyuyoShotokuKojo, kisoKojo, taxFromB,
} from "../src/gensen_kyuyo_core.js";

const table = JSON.parse(
  readFileSync(new URL("../data/gensen_getsugaku_r08.json", import.meta.url)),
);

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// ── 1. 国税庁PDF(denshi_01.pdf 3ページ目)の計算例をそのままオラクルにする ──
// 「源泉控除対象配偶者と源泉控除対象親族1人」= 扶養親族等の数 2人
t("計算例1: 175,000円・2人 → 月額表250円 / 特例210円", () => {
  assert.equal(kouTax(table, 175_000, 2), 250);
  assert.equal(denshiKouTax(175_000, 2), 210);
});

// 「配偶者と親族7人」= 8人。表では7人の税額(2,620円)から1,610円を控除して1,010円
t("計算例2: 446,000円・8人 → 月額表1,010円 / 特例940円", () => {
  assert.equal(kouTax(table, 446_000, 7), 2_620);
  assert.equal(kouTax(table, 446_000, 8), 1_010);
  assert.equal(denshiKouTax(446_000, 8), 940);
});

// 「配偶者と親族2人」= 3人。740,000円超なので算式区分
t("計算例3: 775,200円・3人 → 月額表59,477円 / 特例59,470円", () => {
  assert.equal(kouTax(table, 775_200, 3), 59_477);
  assert.equal(denshiKouTax(775_200, 3), 59_470);
});

// ── 2. 表の全行 × 0〜7人 を、特例(中間値)と突合する ──
//
// ⚠️ ここは最初「表の値 == 特例(中間値)」で書いたが、**その等式は成り立たない**。
// 特例PDFの「税額表は階級の中間値を基として計算してある」は、両者が食い違う *理由の説明* であって、
// 「中間値を入れれば表と同じ値になる」という保証ではなかった（1,848セル中375件が不一致）。
// PDF自身が「特例により求めた税額は税額表による税額とは必ずしも一致しません」と明記している。
//
// 実測した食い違いの姿（令和8年分）:
//   - 375/1,848件が不一致。うち368件は**ちょうど±10円**（丸めの境界）
//   - 残り7件は「表は0円だが特例は少額を出す」ケース（課税給与所得金額がほぼ0の境目）
//   - **最大の差は100円**
// したがって等式ではなく「100円以内に収まること」を不変条件にする。
// 列がずれる・桁を読み違えるといった抽出事故は数百〜数千円の差になるので、この幅で確実に落ちる。
const MAX_DIVERGENCE = 100;

t(`月額表と電算機特例(中間値)の差が${MAX_DIVERGENCE}円以内 [231行 × 8人数]`, () => {
  let checked = 0;
  const bad = [];
  for (const r of table.rows) {
    const mid = (r.min + r.max) / 2;
    assert.ok(Number.isInteger(mid), `中間値が整数でない: ${r.min}-${r.max}`);
    for (let n = 0; n <= 7; n++) {
      const d = Math.abs(denshiKouTax(mid, n) - r.kou[n]);
      if (d > MAX_DIVERGENCE) {
        bad.push(`${r.min.toLocaleString()}〜${r.max.toLocaleString()}円/${n}人: `
          + `表${r.kou[n]} vs 特例(${mid.toLocaleString()})${denshiKouTax(mid, n)} 差${d}`);
      }
      checked++;
    }
  }
  assert.equal(bad.length, 0,
    `${bad.length}件が${MAX_DIVERGENCE}円を超えて乖離:\n  ` + bad.slice(0, 10).join("\n  "));
  assert.equal(checked, table.rows.length * 8);
});

// 「一致しない」こと自体も固定する。ここが0件になったら、
// 表か特例のどちらかを取り違えている（同じものを2回計算している）疑いがある。
t("表と特例は実際に食い違う（同じ計算を2回していないことの確認）", () => {
  let diff = 0;
  for (const r of table.rows) {
    const mid = (r.min + r.max) / 2;
    for (let n = 0; n <= 7; n++) {
      if (denshiKouTax(mid, n) !== r.kou[n]) diff++;
    }
  }
  assert.ok(diff > 0, "表と特例が完全一致した — 別々の計算になっていない可能性");
  // 国税庁PDFの計算例1がまさにこの食い違い（表250円 / 特例210円）
  assert.notEqual(kouTax(table, 175_000, 2), denshiKouTax(175_000, 2));
});

// ── 3. 表の構造 ──
t("105,000円未満は甲欄0円・乙欄は3.063%", () => {
  assert.equal(kouTax(table, 104_999, 0), 0);
  assert.equal(kouTax(table, 88_000, 0), 0);
  assert.equal(otsuTax(table, 100_000), Math.floor(100_000 * 0.03063)); // 3,063円
});

t("乙欄は表から引く（105,000円の行 = 3,800円）", () => {
  assert.equal(otsuTax(table, 105_000), 3_800);
  assert.equal(otsuTax(table, 106_999), 3_800);
  assert.equal(otsuTax(table, 107_000), 3_800);
});

t("乙欄740,000円以上は 259,200円 + 超過×40.84%", () => {
  assert.equal(otsuTax(table, 740_000), 259_200);
  assert.equal(otsuTax(table, 800_000), Math.floor(259_200 + 60_000 * 0.4084));
});

t("乙欄: 従たる給与の申告書があるときだけ1人1,610円を控除", () => {
  assert.equal(otsuTax(table, 300_000, 0), otsuTax(table, 300_000));
  assert.equal(otsuTax(table, 300_000, 2), otsuTax(table, 300_000) - 3_220);
});

t("扶養親族等の数が7人を超えても税額は負にならない", () => {
  assert.equal(kouTax(table, 105_000, 20), 0);
  assert.ok(kouTax(table, 300_000, 30) >= 0);
});

t("扶養親族等の数の加算（障害者・ひとり親・勤労学生など）", () => {
  assert.equal(extraDependentCount({}), 0);
  assert.equal(extraDependentCount({ shogaisha: true }), 1);
  assert.equal(extraDependentCount({ hitorioya: true, kinroGakusei: true }), 2);
  assert.equal(extraDependentCount({ shogaishaFuyoCount: 2 }), 2);
  assert.equal(extraDependentCount({ kafu: true, shogaishaFuyoCount: 1 }), 2);
});

// ── 4. 表は人数について単調非増加・金額について単調非減少（抽出が壊れたら落ちる） ──
t("甲欄は扶養が増えるほど安く、給与が増えるほど高い", () => {
  for (const r of table.rows) {
    for (let n = 0; n < 7; n++) {
      assert.ok(r.kou[n] >= r.kou[n + 1],
        `${r.min}円: ${n}人(${r.kou[n]}) < ${n + 1}人(${r.kou[n + 1]})`);
    }
  }
  for (let i = 0; i + 1 < table.rows.length; i++) {
    for (let n = 0; n <= 7; n++) {
      assert.ok(table.rows[i].kou[n] <= table.rows[i + 1].kou[n]);
    }
  }
});

t("算式区分の境界が連続している（表の上端 → 740,000円の算式）", () => {
  // 737,000〜740,000の行(3人=51,980) の次が 740,000ちょうど(3人=52,290)
  assert.equal(kouTax(table, 739_999, 3), 51_980);
  assert.equal(kouTax(table, 740_000, 3), 52_290);
  // 算式区分の基点では「基点の税額そのもの」になる
  for (const seg of table.kouSegments) {
    assert.equal(kouTax(table, seg.from, 0), seg.baseTax[0],
      `${seg.from}円の基点`);
  }
});

t("第1表・第3表・第4表の端数処理", () => {
  assert.equal(kyuyoShotokuKojo(176_000), 59_467);   // 176,000*30%+6,667 = 59,467
  assert.equal(kyuyoShotokuKojo(100_000), 54_167);   // 下限は定額
  assert.equal(kyuyoShotokuKojo(1_000_000), 162_500); // 上限は定額
  assert.equal(kisoKojo(300_000), 48_334);
  assert.equal(kisoKojo(2_300_000), 0);
  assert.equal(taxFromB(4_865), 250);                // 248.36 → 10円未満四捨五入
  assert.equal(taxFromB(4_165), 210);                // 212.6  → 210
  assert.equal(taxFromB(0), 0);
  assert.equal(taxFromB(-1000), 0);
});

console.log(`✓ test_gensen_kyuyo: ${pass} 件 pass`);
