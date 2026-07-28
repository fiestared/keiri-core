// このファイルは sync_from_keiri_tools.mjs が生成する。手で編集しない。
// 各計算コアを名前空間で提供（例: import { tedori, data } from "keiri-core";
//   tedori.calcTedori(input, { shahoRates: data.shaho_rates_r08, ... })）。
// コア自体は純関数(DOM/fs非依存)なのでブラウザ/バンドラでも動く。data は Node で JSON を読む便利物。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
const load = (n) => JSON.parse(readFileSync(join(__dir, "data", n), "utf8"));
export * as bonusTedori from "./src/bonus_tedori_core.js";
export * as eigyobi from "./src/eigyobi_core.js";
export * as fudosanShutoku from "./src/fudosan_shutoku_core.js";
export * as genka from "./src/genka_core.js";
export * as gensen from "./src/gensen_core.js";
export * as gensenKyuyo from "./src/gensen_kyuyo_core.js";
export * as gensenShoyo from "./src/gensen_shoyo_core.js";
export * as hikazeiSetai from "./src/hikazei_setai_core.js";
export * as ikuji from "./src/ikuji_core.js";
export * as inshi from "./src/inshi_core.js";
export * as invoiceBangou from "./src/invoice_bangou_core.js";
export * as iryohi from "./src/iryohi_core.js";
export * as iryubun from "./src/iryubun_core.js";
export * as jidoshazei from "./src/jidoshazei_core.js";
export * as jouto from "./src/jouto_core.js";
export * as juminzei from "./src/juminzei_core.js";
export * as jutaku from "./src/jutaku_core.js";
export * as kabe from "./src/kabe_core.js";
export * as kihonteate from "./src/kihonteate_core.js";
export * as kokuho from "./src/kokuho_core.js";
export * as koteiShisanzei from "./src/kotei_shisanzei_core.js";
export * as payday from "./src/payday_core.js";
export * as seizenZoyo from "./src/seizen_zoyo_core.js";
export * as senpou from "./src/senpou_core.js";
export * as setsuzei from "./src/setsuzei_core.js";
export * as shaho from "./src/shaho_core.js";
export * as shobyo from "./src/shobyo_core.js";
export * as shohizei from "./src/shohizei_core.js";
export * as shokiboTakuchi from "./src/shokibo_takuchi_core.js";
export * as shussan from "./src/shussan_core.js";
export * as sozokuzei from "./src/sozokuzei_core.js";
export * as taishoku from "./src/taishoku_core.js";
export * as tedori from "./src/tedori_core.js";
export * as torokuMenkyo from "./src/toroku_menkyo_core.js";
export * as yukyu from "./src/yukyu_core.js";
export * as zangyodai from "./src/zangyodai_core.js";
export * as zengin from "./src/zengin_core.js";
export * as zoyozei from "./src/zoyozei_core.js";

/** 料率・税額表データ（コアに引数で渡す）。キーはファイル名から .json を除いたもの。 */
export const data = {
  "fee_table": load("fee_table.json"),
  "genka_rates": load("genka_rates.json"),
  "gensen_getsugaku_r08": load("gensen_getsugaku_r08.json"),
  "gensen_shoyo_r08": load("gensen_shoyo_r08.json"),
  "hikazei_setai_r08": load("hikazei_setai_r08.json"),
  "holidays_jp": load("holidays_jp.json"),
  "inshi_r07": load("inshi_r07.json"),
  "iryohi_r08": load("iryohi_r08.json"),
  "iryubun_r08": load("iryubun_r08.json"),
  "jidoshazei_r08": load("jidoshazei_r08.json"),
  "jouto_r08": load("jouto_r08.json"),
  "juminzei_r08": load("juminzei_r08.json"),
  "jutaku_r07": load("jutaku_r07.json"),
  "kabe_thresholds_r08": load("kabe_thresholds_r08.json"),
  "kihonteate_r07": load("kihonteate_r07.json"),
  "kokuho_r08": load("kokuho_r08.json"),
  "seizen_zoyo_r08": load("seizen_zoyo_r08.json"),
  "setsuzei_r08": load("setsuzei_r08.json"),
  "shaho_rates_r08": load("shaho_rates_r08.json"),
  "shobyo_r08": load("shobyo_r08.json"),
  "shokibo_takuchi_r08": load("shokibo_takuchi_r08.json"),
  "sozokuzei_r08": load("sozokuzei_r08.json"),
  "taishoku_rates_r08": load("taishoku_rates_r08.json"),
  "toroku_menkyo_r08": load("toroku_menkyo_r08.json"),
  "zangyodai_rates": load("zangyodai_rates.json"),
  "zoyozei_r08": load("zoyozei_r08.json"),
};
