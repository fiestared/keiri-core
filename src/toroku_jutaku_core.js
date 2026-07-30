/**
 * 不動産の売買・新築に係る登録免許税の計算コア（DOM非依存・テスト対象）。
 *
 * 扱うのは「家を買う／建てるときの登記」＝土地の売買による所有権移転／建物の所有権保存（新築）／
 * 建物の所有権移転（売買・競落）／住宅ローンの抵当権設定。
 * 相続による移転登記は税率も免税措置も別制度なので toroku_menkyo_core.js（/sozoku-toki-menkyozei/）が扱う。
 *
 * ★このツールが黙って誤答しやすい急所（すべて条文で逐語確認済み。出典は RATES/YOKEN の各行）:
 *
 *  1. **抵当権設定の課税標準は「債権金額」であって不動産の評価額ではない**
 *     （登録免許税法 別表第一 第一号（五））。住宅ローンの借入額で計算する。
 *     評価額を入れると額が大きく狂う（頭金の分だけずれる）。
 *
 *  2. **税率が違う登記は、別々に端数処理する**（合算して1回で計算しない）。
 *     土地1.5%・建物0.3%・抵当権0.1% を足してから丸めると、切捨てが1回しか効かず税額がずれる。
 *
 *  3. **住宅用家屋の軽減が使える取得の原因は「売買又は競落」だけ**（措令42条3項）。
 *     贈与・交換・財産分与による移転登記は本則2%のまま。
 *     「マイホームだから軽減」と考えると、贈与で取得した人に誤って0.3%を出す。
 *
 *  4. **長期優良住宅の移転登記だけ「一戸建ては0.2%」**（措法74条2項のかっこ書き）。
 *     マンション等は0.1%。**認定低炭素住宅（74条の2第2項）にはこの区別が無く一戸建てでも0.1%**。
 *     両者を同じ表で説明する解説が多いので、まとめて実装すると必ずどちらかが誤る。
 *
 *  5. **長期優良・低炭素の特例は「新築又は建築後使用されたことのない」ものに限る**
 *     （措法74条1項2項・74条の2第1項2項）。中古の長期優良住宅は0.3%まで。
 *     中古で0.1%になる経路は買取再販（74条の3）だけ。
 *
 *  6. **軽減の期限が2つある**。住宅用家屋の軽減（72条の2・73・74・74条の2・74条の3・75）は
 *     令和9年3月31日まで。**土地の売買の1.5%（72条）は令和11年3月31日まで**で2年長い。
 *     同時に切れると考えると、令和9年4月以降の土地の税率を2%と誤って出す。
 *
 *  7. **中古住宅の築年数要件は廃止済み**。令和4年度改正で「木造20年・耐火25年」は無くなり、
 *     **昭和57年1月1日以後に建築**（又は耐震基準適合）が基準（措令42条1項2号）。
 *     古い解説のまま築年数で切ると、要件を満たす人に「軽減なし」と答える。
 *
 *  8. **最低税額1,000円の判定は、100円未満を切り捨てる「前」の額で行う**
 *     （登録免許税法19条＝定率課税の最低税額）。切り捨ててから判定すると境界で100円ずれる。
 *
 * 端数処理（措置の有無にかかわらず共通）:
 *   ①同じ税率の不動産の価額（持分適用後）を合計 → ②1,000円未満切捨て（通則法118条1項。
 *   ただし全額1,000円未満なら1,000円＝登免税法15条） → ③税率を掛ける →
 *   ④100円未満切捨て（通則法119条1項。ただし税率適用後が1,000円未満なら1,000円＝登免税法19条）。
 *
 * 一次情報: 登録免許税法（342AC0000000035_20260723_508AC0000000064）／
 * 租税特別措置法（332AC0000000026_20260625_508AC0000000012）／
 * 租税特別措置法施行令（332CO0000000043_20260522_508CO0000000098）を e-Gov法令API v2 で逐語取得。
 */

/** 数値化（空文字・null・NaN は0）。 */
const nz = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** unit 未満を切り捨てる。 */
const truncTo = (v, unit) => Math.floor(v / unit) * unit;

/**
 * 課税標準（不動産の価額の合計）から税額を出す共通処理。
 * ★端数処理は「同じ税率が適用される登記」の単位で1回だけ行う。
 *
 * @param {number} kagakuGokei 持分適用後の価額の合計（円）
 * @param {number} ritsu 税率（0.015 など）
 * @param {object} hasu 端数処理の定数（データJSONの hasu）
 */
export function zeigakuFrom(kagakuGokei, ritsu, hasu) {
  const H = hasu || DEFAULT_HASU;
  const raw = Math.max(0, nz(kagakuGokei));

  // ② 課税標準の1,000円未満を切り捨てる。ただし全額が1,000円未満なら1,000円（登免税法15条）。
  let kazeiHyojun = truncTo(raw, H.kazei_hyojun_kirisute);
  if (raw > 0 && kazeiHyojun < H.kazei_hyojun_min) kazeiHyojun = H.kazei_hyojun_min;
  if (raw === 0) kazeiHyojun = 0;

  // ③ 税率を掛ける。
  const zeiritsuGo = kazeiHyojun * ritsu;

  // ④ 100円未満を切り捨てる。
  // ★ただし最低税額1,000円の判定は「税率を適用して計算した金額」＝切り捨てる前の額で見る（19条）。
  let zeigaku = truncTo(zeiritsuGo, H.zeigaku_kirisute);
  if (kazeiHyojun > 0 && zeiritsuGo < H.zeigaku_min) zeigaku = H.zeigaku_min;
  if (kazeiHyojun === 0) zeigaku = 0;

  return { kazeiHyojun, zeigaku: Math.round(zeigaku) };
}

/** データJSONが無いときでも端数処理だけは動くようにする既定値（条文の値そのもの）。 */
const DEFAULT_HASU = {
  kazei_hyojun_kirisute: 1000,
  kazei_hyojun_min: 1000,
  zeigaku_kirisute: 100,
  zeigaku_min: 1000,
};

/**
 * 住宅用家屋の軽減が使えるかを判定する。
 * ★使えない理由は「どれか1つ」ではなく**全部**返す（1つ直しても次で落ちる、を避けるため）。
 *
 * @param {object} j 住宅の条件
 * @param {object} data データJSON
 * @returns {{ok:boolean, riyu:string[]}}
 */
export function jutakuKeigenOk(j, data) {
  const Y = data.yoken;
  const riyu = [];

  if (!j.kojinKyoju) {
    riyu.push("個人が自分の住まいとして使う家屋ではない（措法72条の2・73）。法人が買った場合、別荘・セカンドハウス、投資用の賃貸物件は対象外です。");
  }
  const menseki = nz(j.yukamenseki);
  if (menseki < Y.yukamenseki_min) {
    riyu.push(`床面積が${Y.yukamenseki_min}平方メートル未満（措令41条）。登記簿上の床面積で判定します。マンションは内法面積なので、パンフレットの${Y.yukamenseki_min}平方メートル台の表示でも要件を満たさないことがあります。`);
  }
  if (!Y.gen_in.includes(j.genin)) {
    riyu.push(`取得の原因が${Y.gen_in.join("・")}ではない（措令42条3項）。贈与・交換・財産分与による移転登記に軽減はありません。`);
  }
  if (nz(j.tokiMadeMonths) > Y.toki_kigen_months) {
    riyu.push(`新築・取得から${Y.toki_kigen_months}か月（1年）を過ぎてからの登記（措法72条の2・73）。`);
  }
  // 中古（建築後使用されたことのある）だけに掛かる要件。
  if (j.chuko && !j.taishinTekigo) {
    if (!j.kenchikuBi) {
      riyu.push("中古住宅の建築年月日が未入力のため、新耐震基準（昭和57年1月1日以後の建築）を満たすか判定できません。");
    } else if (j.kenchikuBi < Y.chuko_kenchiku_kijun_bi) {
      riyu.push(`中古住宅で、昭和57年1月1日より前の建築かつ耐震基準適合の証明もない（措令42条1項2号）。★築年数（木造20年・耐火25年）の要件は令和4年度改正で廃止済みです。`);
    }
  }
  return { ok: riyu.length === 0, riyu };
}

/**
 * 建物（家屋）の税率を決める。
 * ★呼ぶ側は必ず jutakuKeigenOk を先に通すこと（軽減が使えないなら本則）。
 *
 * @returns {{ritsu:number, hyoji:string, konkyo:string}}
 */
export function tatemonoRitsu(j, data) {
  const K = data.keigen;
  const H = data.honsoku;
  const hozon = j.tokiShurui === "hozon";

  const keigenOk = jutakuKeigenOk(j, data).ok;
  if (!keigenOk) {
    return hozon
      ? { ritsu: H.hozon.ritsu, hyoji: H.hozon.hyoji, konkyo: "登録免許税法 別表第一 第一号（一）（本則）" }
      : { ritsu: H.iten_sonota.ritsu, hyoji: H.iten_sonota.hyoji, konkyo: "登録免許税法 別表第一 第一号（二）ハ（本則）" };
  }

  // 認定住宅の特例は「新築又は建築後使用されたことのない」ものに限る（措法74条1項2項・74条の2）。
  const shinchikuKei = !j.chuko;

  if (j.nintei === "chouki" && shinchikuKei) {
    const C = K.chouki_yuryo;
    if (hozon) {
      return { ritsu: C.hozon_ritsu, hyoji: C.hozon_hyoji, konkyo: "租税特別措置法74条1項（特定認定長期優良住宅・保存）" };
    }
    // ★移転登記だけ一戸建ては0.2%（74条2項かっこ書き）。
    return j.kodate
      ? { ritsu: C.iten_kodate_ritsu, hyoji: C.iten_kodate_hyoji, konkyo: "租税特別措置法74条2項かっこ書き（一戸建ての特定認定長期優良住宅・移転）" }
      : { ritsu: C.iten_ritsu, hyoji: C.iten_hyoji, konkyo: "租税特別措置法74条2項（特定認定長期優良住宅・移転）" };
  }

  if (j.nintei === "teitanso" && shinchikuKei) {
    const T = K.tei_tanso;
    // ★低炭素には一戸建ての区別が無い（74条の2第2項にかっこ書きが無い）。
    return hozon
      ? { ritsu: T.hozon_ritsu, hyoji: T.hozon_hyoji, konkyo: "租税特別措置法74条の2第1項（認定低炭素住宅・保存）" }
      : { ritsu: T.iten_ritsu, hyoji: T.iten_hyoji, konkyo: "租税特別措置法74条の2第2項（認定低炭素住宅・移転）" };
  }

  // 買取再販は中古の移転登記のみ（措法74条の3第1項）。
  if (j.kaitoriHanbai && j.chuko && !hozon) {
    const B = K.kaitori_hanbai;
    return { ritsu: B.iten_ritsu, hyoji: B.iten_hyoji, konkyo: "租税特別措置法74条の3第1項（買取再販住宅・移転）" };
  }

  return hozon
    ? { ritsu: K.jutaku_hozon.ritsu, hyoji: K.jutaku_hozon.hyoji, konkyo: "租税特別措置法72条の2（住宅用家屋・保存）" }
    : { ritsu: K.jutaku_iten.ritsu, hyoji: K.jutaku_iten.hyoji, konkyo: "租税特別措置法73条（住宅用家屋・移転）" };
}

/**
 * 登記を受ける日から、その日に使える軽減を判定する。
 *
 * ★日付の比較は `YYYY-MM-DD` の文字列比較で行う（`new Date("YYYY-MM-DD")` はUTC解釈なので
 *   JSTでは当日の00:00〜09:00が「まだ来ていない」と判定される。CLAUDE.md の実害例そのもの）。
 *
 * ★この判定が要る理由: 軽減の期限は**2つ別々にある**（急所⑥）。
 *   住宅用家屋の軽減は令和9年3月31日・土地の売買の1.5%は令和11年3月31日。
 *   期限を過ぎた日の登記に今日の税率をそのまま当てると、**軽減を受けられない人に
 *   「軽減されます」と答える**（データの next_review_reason が最も危険な向きと書いている方向）。
 *   延長されるか失効するかは令和9年度税制改正で決まるので、**分からないと申告する**（fail closed）。
 *
 * @returns {{ok:boolean, riyu?:string, jutakuKeigen?:boolean}}
 *   jutakuKeigen=false は「住宅用家屋の軽減が使えるかまだ分からない」の意味（使えない、ではない）。
 */
export function kigenHantei(tokiBi, data) {
  const M = data._meta;
  const K = data.keigen;
  if (!tokiBi) {
    return { ok: false, riyu: "登記を受ける日を入れてください。適用できる軽減はその日に施行されている法律で決まります。" };
  }
  if (tokiBi < M.applies_from) {
    return {
      ok: false,
      riyu: `本ツールが答えられるのは${M.applies_from_hyoji}以後に受ける登記です。それ以前の税率は同じですが、当時の適用期限の条文まで版を遡って確認していないため、税額を出しません。`,
    };
  }
  if (tokiBi > K.tochi_baibai.kigen) {
    return {
      ok: false,
      riyu: `${K.tochi_baibai.kigen_hyoji}より後に受ける登記は税額を出せません。土地の売買の軽減（1000分の15）の適用期限がその日までで、延長されるか本則（1000分の20）に戻るかが決まっていないためです。`,
    };
  }
  return { ok: true, jutakuKeigen: tokiBi <= K.jutaku_kigen };
}

/**
 * 不動産の売買・新築に係る登録免許税を計算する。
 *
 * @param {object} inp
 *   @param {number} inp.tochiKagaku   土地の固定資産税評価額（円）。0なら土地の登記なし
 *   @param {number} inp.tochiMochibun 土地の持分（1 = 全部）
 *   @param {number} inp.tatemonoKagaku   建物の評価額（新築は法務局の認定価格）
 *   @param {number} inp.tatemonoMochibun 建物の持分
 *   @param {string} inp.tokiShurui   "hozon"（新築の保存）| "iten"（売買等の移転）
 *   @param {number} inp.saikenGaku   住宅ローンの借入額（＝抵当権設定の課税標準）。0なら抵当権なし
 *   @param {boolean} inp.chuko       建築後使用されたことのある住宅か
 *   @param {string} inp.tokiBi       登記を受ける日（YYYY-MM-DD）。渡すと期限を判定する。
 *                                    ★省略時は期限を見ない（データの checked 時点の税率で計算する）
 *   ほか jutakuKeigenOk / tatemonoRitsu が見る条件
 * @param {object} data toroku_jutaku_r08.json
 */
export function calcTorokuJutaku(inp, data) {
  if (!data || !data.honsoku || !data.keigen || !data.yoken || !data.hasu) {
    // fail closed: 参照データが無いのに推測で計算しない。
    return { ok: false, riyu: "税率データを読み込めませんでした。" };
  }
  const H = data.hasu;
  const meisai = [];

  // ★相続・遺贈による移転は税率そのものが別（別表第一 第一号（二）イ＝1000分の4）。
  //   本ツールの表は売買・新築用なので、そのまま当てると「その他の移転」の1000分の20＝**5倍**を出す。
  //   軽減が使えないだけの贈与・交換（本則2%が正しい）と違い、**本則の税率から違う**ので断る。
  if (inp.genin === "相続" || inp.tochiGenin === "相続") {
    return {
      ok: false,
      hanigai: true,
      betsuTool: "/sozoku-toki-menkyozei/",
      riyu: "相続・遺贈による移転の登記は、このツールでは計算できません。税率が別表第一 第一号（二）イの1000分の4で、"
        + "本ツールが使う「その他の原因による移転」1000分の20とは別です（そのまま当てると5倍の額になります）。"
        + "相続登記の登録免許税は専用の計算機をお使いください。",
    };
  }

  // ── 登記を受ける日 → その日に使える軽減 ────────────────────────
  // tokiBi を渡さない呼び出し（単体テスト・埋め込み用途）は従来どおり期限を見ない。
  const kigen = inp.tokiBi === undefined ? null : kigenHantei(inp.tokiBi, data);
  if (kigen && !kigen.ok) return { ok: false, riyu: kigen.riyu, hanigai: true };
  const jutakuKeigenKa = kigen ? kigen.jutakuKeigen : true;
  // ★期限を過ぎた日に「出せない」のは、軽減が**使えたはずの人**だけ。
  //   要件を満たしていない人は本則（期限のない税率）なので、その日でも答えは決まっている。
  const kigenGai = [];

  // ── 土地（売買による所有権移転） ──────────────────────────
  const tochiKagaku = nz(inp.tochiKagaku) * (inp.tochiMochibun == null ? 1 : nz(inp.tochiMochibun));
  if (tochiKagaku > 0) {
    const T = data.keigen.tochi_baibai;
    // ★土地の1.5%は個人・法人を問わず、居住用でなくても使える（措法72条）。
    const useKeigen = T.status === "active" && inp.tochiGenin === "売買";
    const ritsu = useKeigen ? T.ritsu : data.honsoku.iten_sonota.ritsu;
    const r = zeigakuFrom(tochiKagaku, ritsu, H);
    meisai.push({
      key: "tochi",
      name: "土地の所有権移転（売買）",
      kazeiHyojun: r.kazeiHyojun,
      ritsu,
      ritsuHyoji: useKeigen ? T.hyoji : data.honsoku.iten_sonota.hyoji,
      konkyo: useKeigen ? "租税特別措置法72条1項1号" : "登録免許税法 別表第一 第一号（二）ハ（本則）",
      zeigaku: r.zeigaku,
    });
  }

  // ── 建物（保存 or 移転） ────────────────────────────────
  const tateKagaku = nz(inp.tatemonoKagaku) * (inp.tatemonoMochibun == null ? 1 : nz(inp.tatemonoMochibun));
  let keigenHantei = null;
  if (tateKagaku > 0) {
    keigenHantei = jutakuKeigenOk(inp, data);
    const rt = tatemonoRitsu(inp, data);
    const r = zeigakuFrom(tateKagaku, rt.ritsu, H);
    if (keigenHantei.ok && !jutakuKeigenKa) {
      // 軽減が使えたはずの人だけ、期限後は税率が確定しない。
      kigenGai.push(inp.tokiShurui === "hozon" ? "建物の所有権保存（新築）" : "建物の所有権移転（取得）");
    } else meisai.push({
      key: "tatemono",
      name: inp.tokiShurui === "hozon" ? "建物の所有権保存（新築）" : "建物の所有権移転（取得）",
      kazeiHyojun: r.kazeiHyojun,
      ritsu: rt.ritsu,
      ritsuHyoji: rt.hyoji,
      konkyo: rt.konkyo,
      zeigaku: r.zeigaku,
      keigenNashi: !keigenHantei.ok,
    });
  }

  // ── 抵当権設定 ────────────────────────────────────────
  // ★課税標準は債権金額（借入額）。不動産の評価額ではない（別表第一 第一号（五））。
  const saiken = nz(inp.saikenGaku);
  if (saiken > 0) {
    const K = data.keigen.jutaku_teitoken;
    // 抵当権の軽減も住宅用家屋の要件を満たすことが前提（措法75条）。
    const ok = keigenHantei ? keigenHantei.ok : jutakuKeigenOk(inp, data).ok;
    const useKeigen = ok && K.status === "active";
    const ritsu = useKeigen ? K.ritsu : data.honsoku.teitoken.ritsu;
    const r = zeigakuFrom(saiken, ritsu, H);
    if (useKeigen && !jutakuKeigenKa) {
      kigenGai.push("抵当権の設定（住宅ローン）");
    } else meisai.push({
      key: "teitoken",
      name: "抵当権の設定（住宅ローン）",
      kazeiHyojun: r.kazeiHyojun,
      ritsu,
      ritsuHyoji: useKeigen ? K.hyoji : data.honsoku.teitoken.hyoji,
      konkyo: useKeigen ? "租税特別措置法75条" : "登録免許税法 別表第一 第一号（五）（本則）",
      zeigaku: r.zeigaku,
      saikenBase: true,
      keigenNashi: !useKeigen,
    });
  }

  // 期限後で税率が決まらない項目の断り書き（1つでもあれば合計は「一部だけ」になる）。
  const kigenGaiRiyu = kigenGai.length === 0 ? null
    : `${data.keigen.jutaku_kigen_hyoji}より後に受ける登記なので、${kigenGai.join("と")}の税額は出せません。`
      + `住宅用家屋の軽減（措法72条の2・73・74・74条の2・75）の適用期限がその日までで、`
      + `延長されるか本則に戻るかは令和9年度税制改正で決まります。`
      + `★土地の売買の軽減は${data.keigen.tochi_baibai.kigen_hyoji}までなので、そちらは出せます（期限が別の制度です）。`;

  if (meisai.length === 0) {
    return kigenGaiRiyu
      ? { ok: false, riyu: kigenGaiRiyu, hanigai: true }
      : { ok: false, riyu: "評価額または借入額を入力してください。" };
  }

  const gokei = meisai.reduce((a, m) => a + m.zeigaku, 0);
  return {
    ok: true,
    meisai,
    gokei,
    // ★一部しか出せていないことを申告する（合計を「全部の税額」として読ませない）。
    bubun: kigenGai.length > 0,
    kigenGai,
    kigenGaiRiyu,
    keigenRiyu: keigenHantei && !keigenHantei.ok ? keigenHantei.riyu : [],
  };
}
