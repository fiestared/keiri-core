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

```js
import { calcMonthly } from "keiri-core/src/shaho_core.js";

// 標準報酬月額300,000円・東京都(健保9.85%)・35歳(介護なし)の社会保険料
const r = calcMonthly(300000, 9.85, 1.62, 35);
console.log(r.self); // 本人負担額
```

料率テーブルは `data/*.json`、協会けんぽ公式額表のオラクルは `data/fixtures/` にあります。

## テスト（1銭まで照合）

```bash
npm test
```

- `test/shaho_oracle.test.mjs` … 協会けんぽ公式額表の**全50等級 × 健保/介護/支援金/厚年**と一致することを全数照合
- `test/gensen.test.mjs` … 国税庁の公式計算例（例: 175,000円・扶養2人 → 210円）と一致

## 収録モジュール（`src/`）

`shaho`(社会保険料) / `gensen_kyuyo`(源泉・給与) / `gensen_shoyo`(源泉・賞与) / `tedori`(手取り) /
`juminzei`(住民税) / `shohizei`(消費税) / `taishoku`(退職金) / `zangyodai`(残業代) / `yukyu`(有給) /
`iryohi`(医療費控除) / `sozokuzei`(相続税) / `zoyozei`(贈与税) / `jutaku`(住宅ローン控除) / ほか計26。

## 免責

本ライブラリは**一般的な情報提供**であり、税務・労務の個別助言ではありません。料率・制度は改定されます。
実際の判断は顧問の税理士・社会保険労務士、または所轄の税務署・年金事務所にご確認ください。

MIT License. © 2026 Masahiro Yasu / [経理ミニツールズ](https://keiri-tools.com/)
