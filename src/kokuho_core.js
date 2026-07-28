/**
 * 国民健康保険料（税）の賦課額を計算するコア（DOM非依存・テスト対象）。
 *
 * 全国共通なのは「組み立て方」だけで、料率は市町村がそれぞれ条例で定める。
 * したがってこのコアは料率を**必ず引数で受け取る**（推測で埋めない = fail closed）。
 * 全国共通のルールと限度額・軽減の閾値は kokuho_r08.json 側に持たせ、
 * このファイルには数値を書かない（年度改定でコードを触らずに済ませるため）。
 *
 * ★★このツールが黙って誤答しやすい急所（国民健康保険法施行令29条の7）:
 *
 *  1. **令和8年度から賦課区分は4つ。**（1項1号〜4号）医療分・後期高齢者支援金等分・介護分に
 *     **子ども・子育て支援金分（限度額3万円）が加わった**。世に出回っている解説と計算機の
 *     多くが3区分のままなので、3つで組むと新設分をまるごと落とす。
 *
 *  2. **賦課限度額は区分ごとに個別にかかる。**（2項9号・3項・4項・5項）
 *     67万＋26万＋17万＋3万＝113万だが、これは4つの上限の単純合計であって
 *     「合計に113万の上限が1本ある」のではない。合計にだけ上限を当てる実装は、
 *     医療分だけが上限に張り付く高所得世帯で誤る。
 *
 *  3. **軽減されるのは均等割と平等割だけ。所得割は軽減されない。**（6項1号）
 *     所得割まで7割引にすると低所得世帯の保険料を大きく過小に出す。
 *
 *  4. **軽減の判定所得は基礎控除43万円を引く「前」の額。**（6項1号）
 *     所得割の課税標準である「基礎控除後の総所得金額等」（2項4号）とは別物。
 *     同じ43万円という数字が別の役割で2回出てくるので、判定に控除後の額を渡すと
 *     軽減が1段階ずつ甘い方へずれる。
 *
 *  5. **判定所得と人数には「世帯主」と「特定同一世帯所属者」が入る。**（6項1号）
 *     世帯主が国保の被保険者でない場合（擬制世帯主）でも世帯主の所得は判定に入り、
 *     後期高齢者医療へ移った同一世帯の人も人数・所得の両方に算入する。
 *     被保険者だけで判定すると、軽減が本来より甘く出る。
 *
 *  6. **給与所得者等の加算は「2以上」のときだけ。**（6項1号かっこ書）
 *     (給与所得者等の数−1)×10万円 なので、0人でも1人でも加算はゼロ。
 *     人数×10万円にすると単身の給与所得者で判定が甘くなる。
 *
 *  7. **未就学児の5割減額は、7割・5割・2割の軽減を当てた「後」の均等割にかける。**（6項6号）
 *     条文が「その減額後の被保険者均等割額」と明記している。順序を逆にすると
 *     7割軽減世帯の未就学児で減額が過大になる。
 *
 *  8. **子ども・子育て支援金分の均等割は18歳以上だけが負担する。**（5項3号・6項10号11号）
 *     同区分の均等割は「十八歳以上被保険者均等割額」として18歳以上に賦課され、
 *     18歳未満の分は6項11号が全額減額する。全員に掛けると子どものいる世帯で過大になる。
 *
 *  9. **介護分は40歳以上65歳未満だけ。**（1項3号）所得割も均等割も、
 *     介護納付金賦課被保険者でない人の分は積まない。
 *
 * 一次情報: 国民健康保険法施行令29条の7（e-Gov法令API v2 elm=Article_29_7・
 * 法令版 333CO0000000362_20260625_508CO0000000219 で2026-07-28に逐語確認）／
 * 基礎控除43万円は地方税法314条の2第2項1号（同 elm=Article_314_2）。
 */

/** 0以上の数に（未入力・負・NaN は0）。NaN を素通しすると保険料が丸ごと NaN になる。 */
const nz = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 円未満を切り捨てる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * データが揃っていなければ計算せずに投げる（fail closed）。
 * 参照データの読み込みを待たずに計算すると、回線の遅い利用者だけが
 * 「限度額なし・軽減なし」の誤った保険料を見ることになる。
 */
function assertData(data) {
  if (!data || !Array.isArray(data.kubun) || data.kubun.length === 0) {
    throw new Error('kokuho_r08.json が読み込まれていません（賦課区分が空）');
  }
  if (!data.keigen || !Array.isArray(data.keigen.dankai)) {
    throw new Error('kokuho_r08.json が読み込まれていません（軽減の段階が空）');
  }
  if (!(nz(data.kiso_kojo_yen) > 0)) {
    throw new Error('kokuho_r08.json が読み込まれていません（基礎控除額が空）');
  }
}

/**
 * 年齢から被保険者の区分フラグを作る補助。
 * ★法令はいずれも「◯歳に達する日以後の最初の3月31日」で区切るため、
 *   厳密には年度末時点の年齢で判定する。ここでは年度末年齢を受け取る前提とし、
 *   呼び出し側（画面）がその旨を利用者に示す。
 * @param {number} nendomatsuAge 年度末（3月31日）時点の年齢
 */
export function classifyByAge(nendomatsuAge) {
  const age = nz(nendomatsuAge);
  return {
    // 介護納付金賦課被保険者＝介護保険法9条2号（40歳以上65歳未満）
    kaigo2: age >= 40 && age < 65,
    // 未就学児＝6歳に達する日以後の最初の3月31日以前
    mishugakuji: age <= 6,
    // 18歳に達する日以後の最初の3月31日以前
    under18: age <= 18,
  };
}

/**
 * 軽減の判定。
 * @returns {{key:string|null, name:string, rate_pct:number, hanteiShotoku:number,
 *            base:number, kyuyoCount:number, headcount:number, thresholds:Array}}
 */
export function judgeKeigen(input, data) {
  assertData(data);
  const members = Array.isArray(input.members) ? input.members : [];
  const tokutei = Array.isArray(input.tokuteiDouitsu) ? input.tokuteiDouitsu : [];
  const k = data.keigen;

  // ★判定所得は基礎控除を引く「前」の総所得金額等の合算（急所4）。
  // ★世帯主が被保険者でない場合（擬制世帯主）もその所得を加える（急所5）。
  let hanteiShotoku = 0;
  for (const m of members) hanteiShotoku += nz(m.shotoku);
  for (const t of tokutei) hanteiShotoku += nz(t.shotoku);
  if (input.setainushiIsHihokensha === false) {
    hanteiShotoku += nz(input.setainushiShotoku);
  }

  // 給与所得者等の数（世帯主・被保険者・特定同一世帯所属者を通じて数える）
  let kyuyoCount = 0;
  for (const m of members) if (m.kyuyoShotokusha) kyuyoCount += 1;
  for (const t of tokutei) if (t.kyuyoShotokusha) kyuyoCount += 1;
  if (input.setainushiIsHihokensha === false && input.setainushiKyuyoShotokusha) {
    kyuyoCount += 1;
  }

  // ★加算は「2以上」のときだけ（急所6）。
  const base = nz(k.base_yen)
    + Math.max(0, kyuyoCount - 1) * nz(k.kyuyo_shotokusha_add_yen);

  // ★人数には特定同一世帯所属者を含む（急所5）。
  const headcount = members.length + tokutei.length;

  const thresholds = k.dankai.map((d) => ({
    key: d.key,
    name: d.name,
    rate_pct: nz(d.rate_pct),
    threshold: base + headcount * nz(d.per_head_add_yen),
  }));

  // 条文の順（7割→5割→2割）に、判定所得が閾値以下になる最初の段階を採る。
  for (const t of thresholds) {
    if (hanteiShotoku <= t.threshold) {
      return { key: t.key, name: t.name, rate_pct: t.rate_pct, hanteiShotoku, base, kyuyoCount, headcount, thresholds };
    }
  }
  return { key: null, name: '軽減なし', rate_pct: 0, hanteiShotoku, base, kyuyoCount, headcount, thresholds };
}

/** その区分の均等割を負担する被保険者かどうか。 */
function isKintouwariTaisho(member, kubun) {
  if (kubun.kintouwari_taisho === 'kaigo2') return !!member.kaigo2;
  // ★子ども・子育て支援金分の均等割は18歳以上だけ（急所8）。
  if (kubun.kintouwari_taisho === 'over18') return !member.under18;
  return true;
}

/** その区分の所得割を負担する被保険者かどうか。 */
function isShotokuwariTaisho(member, kubun) {
  // ★介護分は40歳以上65歳未満だけ（急所9）。
  if (kubun.taisho === 'kaigo2') return !!member.kaigo2;
  return true;
}

/**
 * 世帯の年間保険料を計算する。
 *
 * @param {object} input
 *   - members: [{shotoku, kaigo2, mishugakuji, under18, kyuyoShotokusha}] 国保の被保険者
 *   - tokuteiDouitsu: [{shotoku, kyuyoShotokusha}] 特定同一世帯所属者（保険料は賦課されない）
 *   - setainushiIsHihokensha: 世帯主が被保険者か（false＝擬制世帯主）
 *   - setainushiShotoku / setainushiKyuyoShotokusha: 擬制世帯主のときだけ使う
 *   - rates: {iryo:{shotokuwari,kintouwari,heitouwari}, shien:{...}, kaigo:{...}, kosodate:{...}}
 *     shotokuwari は百分率（7.5 なら 7.5%）、kintouwari は1人あたり円、heitouwari は1世帯あたり円
 * @param {object} data kokuho_r08.json
 */
export function calcKokuho(input, data) {
  assertData(data);
  const members = Array.isArray(input.members) ? input.members : [];
  const rates = input.rates || {};
  const kisoKojo = nz(data.kiso_kojo_yen);

  const keigen = judgeKeigen(input, data);
  const keigenRate = keigen.rate_pct / 100;

  const mishugakujiRate = nz(data.mishugakuji && data.mishugakuji.genzoku_rate_pct) / 100;

  const kubunResults = [];
  let total = 0;

  for (const kubun of data.kubun) {
    const r = rates[kubun.key] || {};
    const shotokuwariRate = nz(r.shotokuwari) / 100;
    const kintouwariUnit = nz(r.kintouwari);
    const heitouwariUnit = nz(r.heitouwari);

    // ① 所得割 ― 各被保険者の「基礎控除後の総所得金額等」の合計に率を掛ける。
    // ★基礎控除は人ごとに引く（世帯合計から1回だけ引くと多人数世帯で過大になる）。
    let kazeiHyojun = 0;
    for (const m of members) {
      if (!isShotokuwariTaisho(m, kubun)) continue;
      kazeiHyojun += Math.max(0, nz(m.shotoku) - kisoKojo);
    }
    const shotokuwari = kazeiHyojun * shotokuwariRate;

    // ② 均等割 ― 対象者1人ずつ。軽減 →（未就学児なら）5割減 の順に当てる（急所7）。
    let kintouwari = 0;
    let mishugakujiGenzoku = 0;
    let kintouwariCount = 0;
    for (const m of members) {
      if (!isKintouwariTaisho(m, kubun)) continue;
      kintouwariCount += 1;
      const afterKeigen = kintouwaraiAfterKeigen(kintouwariUnit, keigenRate);
      if (m.mishugakuji) {
        const genzoku = afterKeigen * mishugakujiRate;
        mishugakujiGenzoku += genzoku;
        kintouwari += afterKeigen - genzoku;
      } else {
        kintouwari += afterKeigen;
      }
    }

    // ③ 平等割 ― 1世帯あたり。軽減の対象。その区分に均等割の対象者がいない場合はかからない。
    const heitouwari = kintouwariCount > 0
      ? kintouwaraiAfterKeigen(heitouwariUnit, keigenRate)
      : 0;

    const beforeCap = shotokuwari + kintouwari + heitouwari;
    // ★限度額は区分ごとに個別に当てる（急所2）。
    const cap = nz(kubun.genkoku_yen);
    const capped = beforeCap > cap;
    const amount = yen(capped ? cap : beforeCap);

    kubunResults.push({
      key: kubun.key,
      name: kubun.name,
      law_name: kubun.law_name,
      shotokuwari: yen(shotokuwari),
      kintouwari: yen(kintouwari),
      heitouwari: yen(heitouwari),
      mishugakujiGenzoku: yen(mishugakujiGenzoku),
      kintouwariCount,
      kazeiHyojun,
      beforeCap: yen(beforeCap),
      cap,
      capped,
      amount,
    });
    total += amount;
  }

  return { total, kubun: kubunResults, keigen, kisoKojo };
}

/** 軽減後の額（均等割・平等割に共通）。軽減は割合の減額なので (1 − 軽減率) を掛ける。 */
function kintouwaraiAfterKeigen(unit, keigenRate) {
  return nz(unit) * (1 - keigenRate);
}
