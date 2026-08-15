/**
 * barrel(index.js)のスモークテスト。全コアがexportされ、data経由で実計算が通ることを固定する。
 * 公式値との1銭照合は shaho_oracle / gensen テストが担う。ここは「配布物として壊れていない」の確認。
 */
import { data, tedori, setsuzei } from "../index.js";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// 5) MCPサーバー（mcp/server.mjs）が stdio で応答し、全ツールに出典URLと readOnlyHint が付いているか。
//    ★出典URLが欠けると、AIに使われてもサイトに人が来ない（ツール呼び出しは訪問にならない）。実装漏れをここで止める。
const rpc = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "take_home_pay", arguments: { gross: 300000, prefecture: "東京都" } } },
];
const stdout = execFileSync(process.execPath, [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))],
  { input: rpc.map((r) => JSON.stringify(r)).join("\n") + "\n", encoding: "utf8" });
const res = Object.fromEntries(stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]));
const tools = res[2]?.result?.tools ?? [];
ok(tools.length >= 4, `MCP tools/list = ${tools.length}件`);
const noUrl = tools.filter((t) => !/https:\/\/keiri-tools\.com\//.test(t.description ?? ""));
ok(noUrl.length === 0, `全ツールの説明に出典URL${noUrl.length ? " / 欠落: " + noUrl.map((t) => t.name).join(",") : ""}`);
const noRo = tools.filter((t) => t.annotations?.readOnlyHint !== true);
ok(noRo.length === 0, `全ツールに readOnlyHint${noRo.length ? " / 欠落: " + noRo.map((t) => t.name).join(",") : ""}`);
const callText = res[3]?.result?.content?.[0]?.text ?? "";
ok(callText.includes("https://keiri-tools.com/tedori/"), "tools/call の返り値に出典URLが入る");
ok(res[1]?.result?.serverInfo?.version === JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
   `serverInfo.version が package.json と一致（${res[1]?.result?.serverInfo?.version}）`);

console.log(fails ? `\n❌ ${fails}件 失敗` : "\nall smoke checks passed");
process.exit(fails ? 1 : 0);
