/**
 * 不動産取得税（土地・家屋）の税額を出す計算コア（DOM非依存・テスト対象）。
 *
 * ★このツールが黙って誤答しやすい急所（すべて条文で確認済み。出典は下の SEIDO の各行）:
 *
 *  1. **令和8年度改正で免税点が上がった**（法73条の15の2）。土地10万円→**16万円**、
 *     建築に係る家屋23万円→**66万円**、その他の家屋12万円→**34万円**。施行は2026年4月1日
 *     （令和8年法律第2号）。改正前の額のまま判定すると、非課税の取得に税額を出す。
 *     e-Gov法令APIで 2025-10-01施行版（十万円・二十三万円・十二万円）と
 *     2026-04-01施行版（十六万円・六十六万円・三十四万円）を逐語比較して確認した。
 *
 *  2. **同じ改正で新築・中古住宅の床面積要件の下限が50㎡→40㎡になった**
 *     （令37条の16第1号・37条の18第1項）。改正前は「五十平方メートル（貸家の用に供する
 *     共同住宅等にあつては四十平方メートル）以上」で、**貸家だけが40㎡**だった。
 *     改正後はかっこ書きが消えて**自己居住用でも40㎡**から控除を受けられる。
 *     50㎡で切ると、40〜50㎡の住宅に1,200万円の控除を落とす（税額が数十万円ずれる）。
 *
 *  3. **住宅用土地の減額は「45,000円」ではなく「150万円 × 税率」**（法73条の24）。
 *     条文は税額から「150万円（…を超えるときは当該乗じて得た金額）に**税率を乗じて得た額**を
 *     減額する」と書いている。税率3%のときに45,000円になるだけで、税率が変われば変わる。
 *
 *  4. **住宅用土地の減額に使う1㎡単価は、宅地なら「価格の2分の1」**（附則11条の5第2項が
 *     73条の24の「価格」を「価格の二分の一に相当する額」と読み替える）。
 *     読み替えを忘れると減額が2倍になり、税額を過小に答える。
 *
 *  5. **税率3%は住宅と土地だけ**（附則11条の2）。店舗・事務所・倉庫などの住宅以外の家屋は
 *     本則の4%（法73条の15）。3%を一律に当てると住宅以外で25%過小になる。
 *
 *  6. **中古住宅の控除額は「その住宅が新築された時に施行されていた額」**（法73条の14第3項）。
 *     つまり新築年月日ごとに違う。e-Gov法令APIが遡れるのは2017年4月1日施行版までなので、
 *     **それより前に新築された住宅の控除額は本コアの収録範囲外**として `uncomputable` を立て、
 *     家屋の税額を出さない（推測した額で答えない）。
 *
 * 端数処理は法20条の4の2（課税標準額は1,000円未満切捨て・確定税額は100円未満切捨て）。
 *
 * 一次情報: 地方税法（昭和25年法律226号・2026-06-05施行版）／同施行令（同245号・2026-06-25施行版）を
 * e-Gov法令API v2 で逐語取得。改正の有無は 2025-10-01施行版・2026-01-01施行版との条文比較で確認。
 */

/** 制度の定数。画面はここから描く（ページに数字を手書きしない）。 */
export const SEIDO = {
  /** 標準税率(%)。法73条の15「百分の四」。 */
  honsokuRate: 4,
  /** 住宅・土地の税率の特例(%)。附則11条の2「百分の三」。 */
  tokureiRate: 3,
  /** 税率の特例の期限。附則11条の2「令和九年三月三十一日まで」。 */
  tokureiUntil: "2027-03-31",
  /** 宅地評価土地の課税標準の割合。附則11条の5「価格の二分の一」。 */
  takuchiRatio: 0.5,
  /** 宅地1/2の期限。附則11条の5「令和九年三月三十一日まで」。 */
  takuchiUntil: "2027-03-31",
  /** 新築住宅の控除額。法73条の14第1項「千二百万円」。 */
  shinchikuKojo: 12000000,
  /** 住宅用土地の減額の基準額。法73条の24「百五十万円」。これに税率を乗じた額を税額から引く。 */
  tochiGenkakuBase: 1500000,
  /** 住宅用土地の減額で使う床面積の倍率と上限㎡。法73条の24「床面積の二倍」「二百を超える場合には二百」。 */
  tochiGenkakuMultiplier: 2,
  tochiGenkakuMaxM2: 200,
  /** 耐震基準適合とみなされる新築日。令37条の18第3項1号「昭和五十七年一月一日以後」。 */
  taishinFrom: "1982-01-01",
  /** 中古住宅の控除額を条文で確認できる下限（e-Gov法令APIの最古版が2017-04-01施行）。 */
  chukoKojoVerifiedFrom: "2017-04-01",
};

/**
 * 免税点（法73条の15の2）。取得日で版が変わる。
 * ★令和8年法律第2号（2026-04-01施行）で引き上げられた。両方とも条文で確認済み。
 */
export const MENZEITEN = [
  { from: "2026-04-01", tochi: 160000, kenchiku: 660000, sonota: 340000, note: "令和8年度改正後" },
  { from: "0000-01-01", tochi: 100000, kenchiku: 230000, sonota: 120000, note: "令和8年度改正前" },
];

/**
 * 住宅の控除を受けるための床面積要件（令37条の16第1号・37条の18第1項）。
 * ★同じ令和8年度改正で下限が50㎡→40㎡になり、「貸家共同住宅だけ40㎡」の区別が消えた。
 */
export const FLOOR_YOKEN = [
  { from: "2026-04-01", min: 40, max: 240, kashiyaMin: 40, note: "令和8年度改正後（自己居住用も40㎡）" },
  { from: "0000-01-01", min: 50, max: 240, kashiyaMin: 40, note: "令和8年度改正前（貸家共同住宅等のみ40㎡）" },
];

/** 家屋の種類。画面の選択肢はここから描く（「など」で丸めない）。 */
export const KAOKU_KUBUN = [
  { key: "none", label: "家屋は取得していない（土地だけ）", jutaku: false },
  { key: "shinchiku", label: "新築住宅（建築・新築未使用の購入）", jutaku: true },
  { key: "chuko", label: "中古住宅（人が住んだことのある住宅の購入）", jutaku: true },
  { key: "hijutaku", label: "住宅以外の家屋（店舗・事務所・倉庫など）", jutaku: false },
];

/** 日付は文字列比較で行う（new Date("YYYY-MM-DD") はUTC解釈でJSTの当日朝がずれる）。 */
function pickByDate(table, date) {
  const d = date || "9999-12-31";
  for (const row of table) if (d >= row.from) return row;
  return table[table.length - 1];
}

/** 免税点の版を取得日から選ぶ。 */
export function menzeitenFor(acquireDate) {
  return pickByDate(MENZEITEN, acquireDate);
}

/** 床面積要件の版を取得日から選ぶ。 */
export function floorYokenFor(acquireDate) {
  return pickByDate(FLOOR_YOKEN, acquireDate);
}

/**
 * 税率(%)を返す。住宅と土地は特例3%、住宅以外の家屋は本則4%。
 * 特例の期限を過ぎた取得は本則に戻る（附則11条の2）。
 */
export function rateFor(kind, acquireDate) {
  const isTokureiTarget = kind === "tochi" || kind === "shinchiku" || kind === "chuko";
  if (!isTokureiTarget) return SEIDO.honsokuRate;
  const d = acquireDate || "9999-12-31";
  return d <= SEIDO.tokureiUntil ? SEIDO.tokureiRate : SEIDO.honsokuRate;
}

const floor1000 = (n) => Math.floor(n / 1000) * 1000;
const floor100 = (n) => Math.floor(n / 100) * 100;

/**
 * 不動産取得税を計算する。
 *
 * @param {object} input
 *   acquireDate  取得日 "YYYY-MM-DD"
 *   houseKind    KAOKU_KUBUN の key
 *   houseValue   家屋の固定資産税評価額（円）
 *   houseFloor   家屋の床面積（㎡）
 *   builtDate    中古住宅の新築年月日 "YYYY-MM-DD"
 *   selfUse      個人が自己の居住の用に供するか（中古住宅の控除の要件・法73条の14第3項）
 *   landValue    土地の固定資産税評価額（円）
 *   landArea     土地の面積（㎡）
 *   isTakuchi    宅地評価土地か（附則11条の5の1/2特例）
 *   landForHouse 上の住宅の敷地か（法73条の24の減額）
 */
export function calcFudosanShutoku(input) {
  const acquireDate = input.acquireDate || "";
  const menzeiten = menzeitenFor(acquireDate);
  const yoken = floorYokenFor(acquireDate);
  const kubun = KAOKU_KUBUN.find((k) => k.key === input.houseKind) || KAOKU_KUBUN[0];

  // ───────── 家屋 ─────────
  const houseValue = Math.max(0, Number(input.houseValue) || 0);
  const houseFloor = Math.max(0, Number(input.houseFloor) || 0);
  const houseRate = rateFor(kubun.key, acquireDate);
  const house = {
    kind: kubun.key,
    label: kubun.label,
    value: houseValue,
    rate: houseRate,
    kojo: 0,
    kojoReason: "",
    base: 0,
    tax: 0,
    taxable: false,
    uncomputable: false,
    uncomputableReason: "",
    menzeitenLine: 0,
    floorOk: false,
  };

  // ★床面積の判定は評価額と切り離す。土地の減額（法73条の24）は「その土地の上に特例適用住宅が
  //   新築されたこと」で決まり、家屋の評価額は要らない。新築の評価額は後から決まるので、
  //   評価額が未入力（0）でも土地の減額は成立する。ここを評価額で門にすると、
  //   「土地を買って家を建てる人」の減額を丸ごと落とす。
  house.floorOk = kubun.jutaku && houseFloor >= yoken.min && houseFloor <= yoken.max;

  if (kubun.key !== "none" && houseValue > 0) {
    // 免税点の判定は「建築に係るもの」＝新築かどうかで線が違う（法73条の15の2）。
    // 判定は控除前の価格で行う。控除で課税標準が0になる場合は税額も0なので、
    // どちらで判定しても最終税額は変わらない（安全側で一致する）。
    house.menzeitenLine = kubun.key === "shinchiku" ? menzeiten.kenchiku : menzeiten.sonota;
    house.taxable = houseValue >= house.menzeitenLine;

    if (kubun.key === "shinchiku") {
      if (house.floorOk) {
        house.kojo = SEIDO.shinchikuKojo;
      } else {
        house.kojoReason = `床面積が${yoken.min}㎡以上${yoken.max}㎡以下でないため、新築住宅の控除は適用されません（地方税法施行令37条の16第1号）。`;
      }
    } else if (kubun.key === "chuko") {
      const built = input.builtDate || "";
      if (!built) {
        house.uncomputable = true;
        house.uncomputableReason = "中古住宅の控除額は「その住宅が新築された時に施行されていた額」で決まるため（地方税法73条の14第3項）、新築年月日の入力が必要です。";
      } else if (built < SEIDO.chukoKojoVerifiedFrom) {
        house.uncomputable = true;
        house.uncomputableReason = `新築年月日が${SEIDO.chukoKojoVerifiedFrom}より前の住宅は、当時の控除額を条文で確認できる範囲の外です。推測した額では計算しません。取得した都道府県の「中古住宅の控除額表」でご確認ください。`;
      } else if (!input.selfUse) {
        house.kojoReason = "中古住宅の控除は「個人が自己の居住の用に供する」場合の控除です（地方税法73条の14第3項）。賃貸用・法人の取得には適用されません。";
      } else if (!house.floorOk) {
        house.kojoReason = `床面積が${yoken.min}㎡以上${yoken.max}㎡以下でないため、中古住宅の控除は適用されません（地方税法施行令37条の18第1項）。`;
      } else {
        house.kojo = SEIDO.shinchikuKojo;
      }
    }

    if (!house.uncomputable) {
      house.base = house.taxable ? floor1000(Math.max(0, houseValue - house.kojo)) : 0;
      house.tax = floor100((house.base * house.rate) / 100);
    }
  }

  // ───────── 土地 ─────────
  const landValue = Math.max(0, Number(input.landValue) || 0);
  const landArea = Math.max(0, Number(input.landArea) || 0);
  // 空文字は文字列比較で「どの日付よりも小さい」ので、そのまま比べると期限切れの取得に
  // 特例を当ててしまう。日付が無いときは期限外として扱う（rateFor と同じ向き＝安全側）。
  const isTakuchi = !!input.isTakuchi && (acquireDate || "9999-12-31") <= SEIDO.takuchiUntil;
  const land = {
    value: landValue,
    area: landArea,
    isTakuchi,
    rate: rateFor("tochi", acquireDate),
    kazeiHyojunPrice: 0,
    base: 0,
    taxBefore: 0,
    genkaku: 0,
    genkakuBasis: "",
    tax: 0,
    taxable: false,
    menzeitenLine: menzeiten.tochi,
    unitPrice: 0,
  };

  if (landValue > 0) {
    // 宅地評価土地は課税標準が価格の1/2（附則11条の5第1項）。免税点もこの額で判定する。
    land.kazeiHyojunPrice = isTakuchi ? landValue * SEIDO.takuchiRatio : landValue;
    land.taxable = land.kazeiHyojunPrice >= menzeiten.tochi;
    land.base = land.taxable ? floor1000(land.kazeiHyojunPrice) : 0;
    land.taxBefore = (land.base * land.rate) / 100;

    // 住宅用土地の減額（法73条の24）。1㎡単価は宅地なら1/2後の額で出す（附則11条の5第2項の読替え）。
    const houseEligible = kubun.jutaku && house.floorOk && !house.uncomputable;
    if (input.landForHouse && houseEligible && landArea > 0) {
      land.unitPrice = land.kazeiHyojunPrice / landArea;
      const m2 = Math.min(houseFloor * SEIDO.tochiGenkakuMultiplier, SEIDO.tochiGenkakuMaxM2);
      const byArea = land.unitPrice * m2;
      const basis = Math.max(SEIDO.tochiGenkakuBase, byArea);
      land.genkakuBasis = byArea > SEIDO.tochiGenkakuBase ? "menseki" : "teigaku";
      land.genkaku = (basis * land.rate) / 100;
    }
    land.tax = floor100(Math.max(0, land.taxBefore - land.genkaku));
  }

  const uncomputable = house.uncomputable;
  return {
    acquireDate,
    menzeiten,
    yoken,
    house,
    land,
    uncomputable,
    total: uncomputable ? null : house.tax + land.tax,
  };
}
