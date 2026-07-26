# keiri-core

日本の**給与・税・社会保険の計算ロジック**を、DOM非依存の純関数（ES modules）として切り出したものです。
社会保険料・給与の源泉徴収税額・手取り・住民税・消費税・退職金・営業日計算などを、
**公式の計算例・保険料額表と1銭まで照合したテスト**とともに公開しています。

実際に動いているデモ（無料の計算ツール）: **https://keiri-tools.com/**

> A collection of pure, DOM-independent functions (ES modules) for Japanese payroll, tax and
> social-insurance calculations — social insurance premiums, withholding tax, take-home pay,
> resident tax, consumption tax, and more. Every core module is validated to the sen against
> official government examples and rate tables. Live tools: https://keiri-tools.com/

## なぜ作ったか

この手の計算で一番怖いのは、落ちることではなく**「それらしい数字を、堂々と間違えて返す」**ことです。
そこで、①料率・算式は**一次情報にあたって実装**し、②**公式の計算例・公表値と全数照合するテスト**で固定しています。

- **社会保険料**: 協会けんぽ（全国健康保険協会）の保険料額表・都道府県別料率
- **源泉徴収税額**: 国税庁「給与所得の源泉徴収税額表（月額表）」＋「電算機計算の特例」
- **住民税**: 地方税法（所得割10%・均等割・森林環境税）
- **雇用保険**: 労働保険徴収法（賃金総額課税・二事業ぶんを抜いて折半）

## 使い方

料率テーブルは `data/*.json` に同梱。トップの `keiri-core` から**コアと料率をまとめて**import できます。

```js
import { tedori, setsuzei, data } from "keiri-core";

// 手取り: 額面月給30万・東京都・30歳・扶養0
const t = tedori.calcTedori(
  { gross: 300000, age: 30, prefecture: "東京都", dependents: 0, gyoshu: "general", juminzeiMode: "estimate" },
  { shahoRates: data.shaho_rates_r08, gensenTable: data.gensen_getsugaku_r08, juminzeiData: data.juminzei_r08 }
);
console.log(t.tedori); // => 237060 （額面の79.0%）

// 節税額: 課税所得500万・小規模企業共済/iDeCo等で年84万円を所得控除
const s = setsuzei.taxSaving({ kazeiShotoku: 5_000_000, annualDeduction: 840_000 }, data.setsuzei_r08);
console.log(s.total); // => 255528 （所得税+復興+住民税の減少）
```

コア単体だけ欲しいとき（ブラウザ/バンドラでも動く純関数。料率は自分で渡す）:

```js
import { calcMonthly } from "keiri-core/src/shaho_core.js";
const r = calcMonthly(300000, 9.85, 1.62, 35); // 東京都・35歳の社会保険料
```

> `data` は Node で JSON を読む便利物です。ブラウザ/バンドラでは `keiri-core/data/xxx.json` を直接 import して渡してください。
> コア(`src/*_core.js`)は fs/DOM 非依存なのでどこでも動きます。

## 同期（メンテナ向け）

正本は [keiri-tools](https://keiri-tools.com/) の計算エンジンで、毎日テストで守られています。
本パッケージはその配布物で、`npm run sync`（`sync_from_keiri_tools.mjs`）で `src/`・`data/`・`index.js` を再生成します。

## テスト（1銭まで照合）

```bash
npm test
```

- `test/shaho_oracle.test.mjs` … 協会けんぽ公式額表の**全50等級 × 健保/介護/支援金/厚年**と一致することを全数照合
- `test/gensen.test.mjs` … 国税庁の公式計算例（例: 175,000円・扶養2人 → 210円）と一致

## 収録モジュール（`src/` ・計34コア）

給与・手取り: `tedori` / `bonus_tedori`(賞与) / `shaho`(社会保険料) / `gensen_kyuyo`(源泉・給与) /
`gensen_shoyo`(源泉・賞与) / `juminzei`(住民税) / `zangyodai`(残業代) / `kabe`(年収の壁)
節税・控除: `setsuzei`(iDeCo/小規模企業共済/扶養/配偶者/生命保険/青色申告/地震保険 等をまとめた節税額コア) /
`iryohi`(医療費控除) / `jutaku`(住宅ローン控除) / `hikazei_setai`(住民税非課税世帯)
相続・資産: `sozokuzei`(相続税) / `zoyozei`(贈与税) / `seizen_zoyo`(生前贈与) / `iryubun`(遺留分) /
`jouto`(不動産譲渡所得) / `shokibo_takuchi`(小規模宅地) / `toroku_menkyo`(相続登記の登録免許税)
給付・その他: `kihonteate`(失業給付) / `shobyo`(傷病手当金) / `shussan`(出産手当金) / `ikuji`(育休給付) /
`taishoku`(退職金) / `yukyu`(有給) / `shohizei`(消費税) / `inshi`(印紙税) / `jidoshazei`(自動車税) /
`genka`(減価償却) / `eigyobi`(営業日) / `senpou`(振込手数料) / `zengin`(全銀カナ) ほか。

全一覧と入力の形は各 `src/*_core.js` の JSDoc、実挙動は [keiri-tools.com](https://keiri-tools.com/) で確認できます。

## AIエージェントから使う（MCP サーバー）

AIエージェント（Claude Desktop / Claude Code など）が、日本の税・給与の計算を**ツールとして直接呼べます**。
本パッケージに同梱の `mcp/server.mjs` は依存ゼロ・stdio の MCP サーバーです。設定に追加するだけ:

```json
{
  "mcpServers": {
    "keiri-core": { "command": "npx", "args": ["-y", "-p", "keiri-core", "keiri-core-mcp"] }
  }
}
```

リポジトリを clone して使う場合は `{ "command": "node", "args": ["<path>/keiri-core/mcp/server.mjs"] }`。

提供ツール: `take_home_pay`（手取り）/ `income_tax`（所得税額）/ `deduction_tax_saving`（所得控除の節税額）/
`dependent_deduction`（扶養控除）。「額面30万・東京都の手取りは？」で AI が計算して答えます（＝検証済みエンジンの値）。

> 外部の AI（ChatGPT 等）に公開したい場合は、同じツール定義を **Cloudflare Workers（無料枠）** の HTTP/SSE
> トランスポートに載せます（stdio版がその中身）。計算は純関数なので、状態も外部通信もありません。

## 免責

本ライブラリは**一般的な情報提供**であり、税務・労務の個別助言ではありません。料率・制度は改定されます。
実際の判断は顧問の税理士・社会保険労務士、または所轄の税務署・年金事務所にご確認ください。

MIT License. © 2026 Masahiro Yasu / [経理ミニツールズ](https://keiri-tools.com/)
