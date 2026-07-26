/**
 * keiri-tools（本サイト）の検証済みコアと料率データを keiri-core（OSS npm）へ同期する。
 *
 * なぜ: コアの正本は keiri-tools/docs/assets/*_core.js（毎日テストで守られている）。OSS はその
 * 配布物。手でコピーすると必ず腐る（実際 2026-07 に8コア分同期漏れした）。**worker が新ツールを
 * 作ったらこれを走らせる**（prompt.md の規律）。src/ と data/ を丸ごとミラーし、index.js を再生成する。
 *
 *   node sync_from_keiri_tools.mjs           同期＋index.js再生成
 *   node sync_from_keiri_tools.mjs --check    差分があれば失敗（CI用）
 *
 * コアは料率データを「引数で受ける純関数」なので、data/*.json も同梱し、index で data を読み込んで渡せる形にする。
 */
import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "..", "keiri-tools", "docs", "assets");
const CHECK = process.argv.includes("--check");
if (!existsSync(SRC)) { console.error(`✗ 正本が見つからない: ${SRC}`); process.exit(1); }

mkdirSync(join(ROOT, "src"), { recursive: true });
mkdirSync(join(ROOT, "data"), { recursive: true });

// サイト専用JS/巨大な検索indexは配布しない（純ロジックと料率だけ）
const SKIP_JSON = new Set(["qa_index.json"]);
const isCore = (f) => /_core\.js$/.test(f);
const isData = (f) => /\.json$/.test(f) && !SKIP_JSON.has(f);

let changed = 0;
const copied = { core: [], data: [] };
function sync(f, destDir, bucket) {
  const s = join(SRC, f), d = join(destDir, f);
  const next = readFileSync(s);
  const cur = existsSync(d) ? readFileSync(d) : null;
  if (!cur || !cur.equals(next)) {
    if (CHECK) { console.error(`✗ 未同期: ${f}`); process.exit(1); }
    copyFileSync(s, d); changed++;
  }
  copied[bucket].push(f);
}

for (const f of readdirSync(SRC)) {
  if (isCore(f)) sync(f, join(ROOT, "src"), "core");
  else if (isData(f)) sync(f, join(ROOT, "data"), "data");
}
copied.core.sort(); copied.data.sort();

// ---- index.js（barrel）を生成: 各コアを名前空間で再export＋data を全部読み込んで公開 ----
const nsOf = (f) => f.replace(/_core\.js$/, "").replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase());
const importLines = copied.core.map((f) => `export * as ${nsOf(f)} from "./src/${f}";`).join("\n");
// data は readFileSync 方式（Node 18+で動く。import attributes は新しいNode専用なので避ける）。
const dataMap = copied.data.map((f) => `  ${JSON.stringify(f.replace(/\.json$/, ""))}: load(${JSON.stringify(f)}),`).join("\n");
const index = `// このファイルは sync_from_keiri_tools.mjs が生成する。手で編集しない。
// 各計算コアを名前空間で提供（例: import { tedori, data } from "keiri-core";
//   tedori.calcTedori(input, { shahoRates: data.shaho_rates_r08, ... })）。
// コア自体は純関数(DOM/fs非依存)なのでブラウザ/バンドラでも動く。data は Node で JSON を読む便利物。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
const load = (n) => JSON.parse(readFileSync(join(__dir, "data", n), "utf8"));
${importLines}

/** 料率・税額表データ（コアに引数で渡す）。キーはファイル名から .json を除いたもの。 */
export const data = {
${dataMap}
};
`;
const idxPath = join(ROOT, "index.js");
const idxCur = existsSync(idxPath) ? readFileSync(idxPath, "utf8") : "";
if (idxCur !== index) {
  if (CHECK) { console.error("✗ index.js が未再生成"); process.exit(1); }
  writeFileSync(idxPath, index); changed++;
}

if (CHECK) { console.log("✓ keiri-core は最新（keiri-toolsと同期済み）"); process.exit(0); }
console.log(`✓ 同期: コア${copied.core.length}本 / データ${copied.data.length}件 / index.js 再生成 (変更 ${changed}件)`);
