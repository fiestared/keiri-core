/**
 * barrel(index.js)のスモークテスト。全コアがexportされ、data経由で実計算が通ることを固定する。
 * 公式値との1銭照合は shaho_oracle / gensen テストが担う。ここは「配布物として壊れていない」の確認。
 */
import { data, tedori, setsuzei } from "../index.js";
import { readdirSync } from "node:fs";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) fails++; };

// 1) src の全コアが barrel から名前空間で引けるか（同期漏れ検知）
const coreFiles = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith("_core.js"));
const mod = await import("../index.js");
const nsOf = (f) => f.replace(/_core\.js$/, "").replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase());
const missing = coreFiles.map(nsOf).filter((ns) => !mod[ns]);
ok(missing.length === 0, `全${coreFiles.length}コアが barrel から引ける${missing.length ? " / 欠落: " + missing.join(",") : ""}`);

// 2) data が全料率を読めているか
ok(Object.keys(data).length >= 20 && data.shaho_rates_r08 && data.setsuzei_r08,
   `data 読込 ${Object.keys(data).length}件`);

// 3) 手取り: 額面30万・東京・30歳・扶養0 → サイトと同じ 237,060
const r = tedori.calcTedori(
  { gross: 300000, age: 30, prefecture: "東京都", dependents: 0, gyoshu: "general", juminzeiMode: "estimate" },
  { shahoRates: data.shaho_rates_r08, gensenTable: data.gensen_getsugaku_r08, juminzeiData: data.juminzei_r08 });
ok(r.tedori === 237060, `手取り計算 = ${r.tedori}（期待 237060）`);

// 4) 節税: 課税所得500万・小規模企業共済 年84万控除 → 節税額 255,528
const s = setsuzei.taxSaving({ kazeiShotoku: 5_000_000, annualDeduction: 840_000 }, data.setsuzei_r08);
ok(s.total === 255528, `節税額 = ${s.total}（期待 255528）`);

console.log(fails ? `\n❌ ${fails}件 失敗` : "\nall smoke checks passed");
process.exit(fails ? 1 : 0);
