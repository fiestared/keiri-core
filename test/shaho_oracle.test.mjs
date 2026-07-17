/**
 * 社会保険料の計算を「協会けんぽの公式 保険料額表」と全数照合する。
 *
 * なぜこのテストが要るか:
 *   test_shaho.mjs は自作の期待値を自分で再計算して比べているだけで、
 *   料率や等級表そのものが間違っていても気づけない（実際、料率の検査は
 *   「8〜12%の範囲か」しか見ていなかった）。
 *   ここでは公式PDF(東京支部)から機械抽出した全50等級の全額/折半額を
 *   オラクルとして、こちらの実装が公式と1銭まで一致するかを見る。
 *
 * オラクル: tests/fixtures/kyoukaikenpo_tokyo_r08.json
 *   ← https://www.kyoukaikenpo.or.jp/assets/R8_13tokyo.pdf から抽出
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { calcMonthly, koseiStandard } from "../src/shaho_core.js";

const O = JSON.parse(readFileSync(new URL("../data/fixtures/kyoukaikenpo_tokyo_r08.json", import.meta.url)));
const { kenko, kaigo, kosodate, kosei } = O._meta.rates;
const RATES = JSON.parse(readFileSync(new URL("../data/shaho_rates_r08.json", import.meta.url)));

// 銭(小数1位)まで一致していること
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: 実装=${a} / 公式額表=${b}`);

// --- 0. 前提: ツールが持つ料率が、額表の前提料率と同じであること -----------------
assert.equal(RATES.kenko_rates["東京都"], kenko, "東京都の健保料率が額表と違う");
assert.equal(RATES.kaigo_rate, kaigo, "介護保険料率が額表と違う");
assert.equal(RATES.kosodate_rate, kosodate, "子ども・子育て支援金率が額表と違う");
assert.equal(RATES.kosei_nenkin_rate, kosei, "厚生年金保険料率が額表と違う");

// --- 1. 等級表の構造 ---------------------------------------------------------
assert.equal(O.grades.length, 50, "健康保険は第1〜50級");
const koseiRows = O.grades.filter((g) => g.kosei_grade);
assert.equal(koseiRows.length, 32, "厚生年金は第1〜32級");
assert.equal(koseiRows[0].standard, 88000);
assert.equal(koseiRows[koseiRows.length - 1].standard, 650000);

// --- 2. 全50等級 × 4項目を公式額表と照合 --------------------------------------
let checked = 0;
for (const g of O.grades) {
  const monthly = g.standard; // 標準報酬月額は必ず自分の報酬月額レンジ内にある

  // (a) 介護保険第2号に該当しない場合（39歳）: 健康保険料のみ
  const young = calcMonthly(monthly, kenko, kaigo, 39, kosei, kosodate);
  assert.equal(young.standard, g.standard, `等級${g.grade}: 標準報酬月額`);
  assert.equal(young.grade, g.grade, `等級${g.grade}: 等級の判定`);
  near(young.kenkoKaigo.total, g.kenko_total, `等級${g.grade} 健保 全額`);
  near(young.kenkoKaigo.half, g.kenko_half, `等級${g.grade} 健保 折半額`);

  // (b) 介護保険第2号に該当する場合（45歳）: 健保+介護の合算列
  const mid = calcMonthly(monthly, kenko, kaigo, 45, kosei, kosodate);
  near(mid.kenkoKaigo.total, g.kenko_kaigo_total, `等級${g.grade} 健保+介護 全額`);
  near(mid.kenkoKaigo.half, g.kenko_kaigo_half, `等級${g.grade} 健保+介護 折半額`);

  // (c) 子ども・子育て支援金（年齢に関係なく全員）
  near(young.kosodate.total, g.kosodate_total, `等級${g.grade} 支援金 全額`);
  near(young.kosodate.half, g.kosodate_half, `等級${g.grade} 支援金 折半額`);
  near(mid.kosodate.total, g.kosodate_total, `等級${g.grade} 支援金は年齢で変わらない`);

  // (d) 厚生年金（額表に列があるのは第1〜32級の行だけ）
  if (g.kosei_grade) {
    near(young.kosei.total, g.kosei_total, `等級${g.grade} 厚年 全額`);
    near(young.kosei.half, g.kosei_half, `等級${g.grade} 厚年 折半額`);
    assert.equal(young.koseiStandard, g.standard, `等級${g.grade} 厚年の標準報酬月額`);
  } else {
    // 額表に厚年の列が無い等級 = 上限(650,000)か下限(88,000)で頭打ちになる
    const capped = g.standard > 650000 ? 650000 : 88000;
    assert.equal(young.koseiStandard, capped, `等級${g.grade} 厚年は${capped}で頭打ち`);
  }
  checked++;
}
assert.equal(checked, 50);

// --- 3. 頭打ちの境界（額表の最終行の値と一致するか） ---------------------------
const top = koseiRows[koseiRows.length - 1]; // 650,000 = 厚年32級
near(calcMonthly(2000000, kenko, kaigo, 45, kosei, kosodate).kosei.total, top.kosei_total,
  "報酬200万でも厚年は650,000で頭打ち");
assert.equal(koseiStandard(50000), 88000, "下限は88,000");

// --- 4. 支援金を落としていないか（回帰防止） ----------------------------------
// 令和8年4月分から全員にかかる。0.23%を忘れると全ユーザーの答えが過少になる
const r = calcMonthly(300000, kenko, kaigo, 30, kosei, kosodate);
assert.ok(r.kosodate.self > 0, "子ども・子育て支援金が計算されていない");
assert.equal(r.kosodate.self, 345, "標準報酬30万の支援金 本人負担 = 300,000×0.23%÷2 = 345円");
assert.equal(r.selfTotal, r.kenkoKaigo.self + r.kosodate.self + r.kosei.self);

console.log(`all shaho oracle tests passed (公式額表 全${checked}等級 × 健保/介護/支援金/厚年 と一致)`);
