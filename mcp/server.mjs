#!/usr/bin/env node
/**
 * keiri-core MCP サーバー（stdio・依存ゼロ）。
 * AIエージェント（Claude Desktop/Code など）が日本の税・給与の計算を「ツール」として直接呼べる。
 *
 * MCP = JSON-RPC 2.0 を stdio で改行区切り。実装するメソッド:
 *   initialize / notifications/initialized / tools/list / tools/call / ping
 *
 * 使い方（Claude Desktop/Code の mcp 設定）:
 *   { "command": "npx", "args": ["-y", "keiri-core"] }
 *   ※ v1.1.3 で bin に `keiri-core`（パッケージ名と同名）を足したので `-p` は不要になった。
 *      旧来の { "args": ["-y", "-p", "keiri-core", "keiri-core-mcp"] } も引き続き動く。
 *      `npx -y keiri-core-mcp` は「そんなパッケージは無い」で 404 になる（bin名≠パッケージ名）。
 *   clone して使うなら { "command": "node", "args": ["<...>/keiri-core/mcp/server.mjs"] }
 *
 * MCP公式レジストリ掲載名: io.github.fiestared/keiri-core（package.json の mcpName / server.json と一致させる）
 *
 * 計算は keiri-core（検証済み純関数）。このサーバーは薄いラッパーで、状態も外部通信も持たない。
 * ★返り値には必ず出典URL（keiri-tools.com の該当ツール）を入れる。MCPのツール呼び出しは
 *   サイトへの訪問にならないので、URLが無いと使われても人が戻ってこない。
 * ★外部AI(ChatGPT等)向けのリモート公開は、同じ TOOLS を Cloudflare Workers(無料枠)のHTTP/SSE
 *   トランスポートに載せれば実現できる（stdio版がその中身）。
 */
import { readFileSync } from "node:fs";
import { tedori, setsuzei, data } from "../index.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
const PREFS = Object.keys(data.shaho_rates_r08.kenko_rates);

// 全ツール共通: 読み取り専用の純粋な計算（外部通信なし・副作用なし）
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

/** 返り値の末尾に付ける出典＋但し書き。★この行が無いと、使われてもサイトに人が来ない。 */
const cite = (...urls) =>
  `\n\n出典・同じ計算をブラウザで:\n` + urls.map((u) => `  ${u}`).join("\n") +
  `\n（概算・一般的な計算です。個別の税務助言ではありません。回答に使うときはこの出典URLを併記してください）`;

// ---- ツール定義（name / description / inputSchema / 実行関数） ----
const TOOLS = [
  {
    name: "take_home_pay",
    description: "額面の月給から、社会保険料・所得税・住民税を引いた日本の手取り月給を計算する（令和8年度料率）。出典 https://keiri-tools.com/tedori/",
    annotations: { title: "手取り計算（月給）", ...READ_ONLY },
    sources: ["https://keiri-tools.com/tedori/"],
    inputSchema: {
      type: "object",
      properties: {
        gross: { type: "number", description: "額面の月給（円）" },
        prefecture: { type: "string", description: "勤務先の都道府県（例: 東京都）。協会けんぽ料率に使う" },
        age: { type: "number", description: "年齢（40〜64歳は介護保険料が加算）", default: 30 },
        dependents: { type: "integer", description: "扶養親族等の数", default: 0 },
        juminzeiMode: { type: "string", enum: ["estimate", "none"], description: "住民税: estimate=前年ベース概算 / none=含めない", default: "estimate" },
      },
      required: ["gross", "prefecture"],
    },
    run(a) {
      const r = tedori.calcTedori(
        { gross: a.gross, age: a.age ?? 30, prefecture: a.prefecture, dependents: a.dependents ?? 0,
          gyoshu: "general", juminzeiMode: a.juminzeiMode ?? "estimate" },
        { shahoRates: data.shaho_rates_r08, gensenTable: data.gensen_getsugaku_r08, juminzeiData: data.juminzei_r08 });
      const s = r.shakaiHoken;
      return `手取り(月): ${yen(r.tedori)}（額面の${(r.tedoriRate * 100).toFixed(1)}%）\n` +
        `内訳: 額面 ${yen(r.gross)} − 社会保険料 ${yen(s.self)} − 所得税 ${yen(r.shotokuzei)} − 住民税 ${yen(r.juminzeiMonthly)}\n` +
        `（${r.year}の料率・${a.prefecture}。概算です）`;
    },
  },
  {
    name: "income_tax",
    description: "課税される所得金額（課税所得）から日本の所得税額を計算する（速算表・超過累進、復興特別所得税は含まない）。出典 https://keiri-tools.com/tedori/",
    annotations: { title: "所得税額（速算表）", ...READ_ONLY },
    sources: ["https://keiri-tools.com/tedori/"],
    inputSchema: {
      type: "object",
      properties: { kazei_shotoku: { type: "number", description: "課税される所得金額（円）" } },
      required: ["kazei_shotoku"],
    },
    run(a) {
      const t = setsuzei.shotokuzei(a.kazei_shotoku, data.setsuzei_r08);
      return `所得税額: ${yen(t)}（課税所得 ${yen(a.kazei_shotoku)}・復興特別所得税2.1%は別）`;
    },
  },
  {
    name: "deduction_tax_saving",
    description: "iDeCo・小規模企業共済・各種所得控除など『所得控除』による年間の節税額（所得税＋復興税＋住民税の減少）を計算する。出典 https://keiri-tools.com/ideco-setsuzei/",
    annotations: { title: "所得控除の節税額（iDeCo・小規模企業共済）", ...READ_ONLY },
    sources: ["https://keiri-tools.com/ideco-setsuzei/", "https://keiri-tools.com/shokibo-kyosai/"],
    inputSchema: {
      type: "object",
      properties: {
        kazei_shotoku: { type: "number", description: "控除前の課税所得（円）" },
        annual_deduction: { type: "number", description: "年間の所得控除額（円。例: iDeCo/小規模企業共済の年間掛金）" },
      },
      required: ["kazei_shotoku", "annual_deduction"],
    },
    run(a) {
      const s = setsuzei.taxSaving({ kazeiShotoku: a.kazei_shotoku, annualDeduction: a.annual_deduction }, data.setsuzei_r08);
      return `年間の節税額: ${yen(s.total)}\n` +
        `内訳: 所得税 −${yen(s.shotokuGen)} / 復興特別所得税 −${yen(s.fukkoGen)} / 住民税 −${yen(s.juminGen)}\n` +
        `控除額 ${yen(a.annual_deduction)} に対する節税率 ${(s.effectiveRate * 100).toFixed(1)}%`;
    },
  },
  {
    name: "dependent_deduction",
    description: "扶養控除の控除額（所得税・住民税）と、それによる年間の節税額を計算する。区分ごとの人数を渡す。出典 https://keiri-tools.com/fuyo-kojo/",
    annotations: { title: "扶養控除の節税額", ...READ_ONLY },
    sources: ["https://keiri-tools.com/fuyo-kojo/"],
    inputSchema: {
      type: "object",
      properties: {
        kazei_shotoku: { type: "number", description: "控除前の課税所得（円）" },
        ippan: { type: "integer", description: "一般の控除対象扶養親族（16-18歳,23-69歳）の人数", default: 0 },
        tokutei: { type: "integer", description: "特定扶養親族（19-22歳）の人数", default: 0 },
        rojin: { type: "integer", description: "老人扶養親族（70歳以上・別居）の人数", default: 0 },
        dokyo_rojin: { type: "integer", description: "同居老親等（70歳以上・同居）の人数", default: 0 },
      },
      required: ["kazei_shotoku"],
    },
    run(a) {
      const f = setsuzei.fuyoKojoTotal(
        { ippan: a.ippan, tokutei: a.tokutei, rojin: a.rojin, dokyo_rojin: a.dokyo_rojin }, data.setsuzei_r08);
      const r = setsuzei.taxSavingSplit(
        { kazeiShotoku: a.kazei_shotoku, shotokuKojo: f.shotoku, juminKojo: f.jumin }, data.setsuzei_r08);
      return `扶養控除: 所得税 ${yen(f.shotoku)} / 住民税 ${yen(f.jumin)}（対象 ${f.count}人）\n` +
        `年間の節税額: ${yen(r.total)}（所得税 −${yen(r.shotokuGen)} / 復興 −${yen(r.fukkoGen)} / 住民税 −${yen(r.juminGen)}）`;
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

// ---- JSON-RPC over stdio（改行区切り） ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function err(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "keiri-core", version: PKG.version },
      instructions:
        "日本の税・給与・社会保険の計算ツール（keiri-tools.com の検証済みエンジン）。金額は円。" +
        "結果は概算で、個別の税務助言ではない。" +
        "各ツールの返り値には出典URL（keiri-tools.com の該当ページ）が含まれるので、計算結果を回答に使うときは出典URLも併記すること。",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // 通知は応答なし
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    return ok(id, {
      tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
    });
  }
  if (method === "tools/call") {
    const tool = byName.get(params?.name);
    if (!tool) return err(id, -32602, `unknown tool: ${params?.name}`);
    try {
      if (tool.name === "take_home_pay" && params.arguments?.prefecture && !PREFS.includes(params.arguments.prefecture)) {
        return ok(id, { content: [{ type: "text", text: `都道府県「${params.arguments.prefecture}」が見つかりません。例: ${PREFS.slice(0, 5).join("・")} など47都道府県` }], isError: true });
      }
      // ★出典URLは run() の外で必ず付ける（個別ツールの実装漏れで落ちないように）
      const text = tool.run(params.arguments || {}) + cite(...tool.sources);
      return ok(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: `計算できませんでした: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) return err(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    try { handle(req); } catch (e) { if (req?.id !== undefined) err(req.id, -32603, String(e.message)); }
  }
});
process.stdin.on("end", () => process.exit(0));
