/**
 * 不動産の仲介手数料（宅地建物取引業者が受け取れる報酬の上限）の計算コア（DOM非依存・テスト対象）。
 *
 * 正本は「宅地建物取引業者が宅地又は建物の売買等に関して受けることができる報酬の額」
 * （昭和45年建設省告示第1552号、最終改正 令和6年国土交通省告示第949号）。
 * 宅建業法46条1項が「国土交通大臣の定める額を超えて報酬を受けてはならない」と定めている。
 *
 * ★このツールが黙って誤答しやすい急所（すべて告示の条文で逐語確認済み。出典はデータJSONの各 _source）:
 *
 *  1. **出るのは「上限」であって料金表ではない**。告示は全て「〜以内」「超えてはならない」と書いている。
 *     上限額を「仲介手数料はいくらか」と言い切ると、値引きの余地がないかのような誤解を与える。
 *
 *  2. **代金の額に消費税等相当額を含めない**（第二のかっこ書き）。
 *     売主が課税事業者（新築・不動産会社が売主）の場合、建物価格には消費税が乗っている。
 *     税込の総額のまま計算すると上限を過大に出す。土地は非課税なので土地代はそのまま。
 *
 *  3. **「3％＋6万円」は本体（税抜）の額**。告示の表の割合 5.5％/4.4％/3.3％ は消費税等相当額を
 *     含んだ割合なので、3.3％で計算した額にさらに1.1を掛けると消費税を二重に乗せることになる。
 *
 *  4. **代理は「常に媒介の2倍」ではない**（第三ただし書）。取引の相手方からも媒介の報酬を受ける場合は、
 *     その合計が媒介の2倍を超えてはならない＝相手方から満額もらうなら代理の依頼者からは1倍分まで。
 *
 *  5. **低廉な空家等の特例（第七）は「800万円以下なら33万円」ではない**。
 *     「当該媒介に要する費用を勘案して」第二の額を超えて受け取れるという規定で、33万円はその上限。
 *     しかも代金800万円ちょうどのとき第二の計算額もちょうど33万円になる（＝特例が効くのは800万円未満）。
 *     実際の額は媒介契約の締結前に説明・合意が必要（宅建業法46条・国土交通省「解釈・運用の考え方」）。
 *
 *  6. **貸借の上限は「依頼者の双方から受ける報酬の合計額」にかかる**（第四）。
 *     借主・貸主それぞれが1.1ヶ月分を払うのではない。居住用建物では、媒介の依頼を受けるにあたって
 *     承諾を得ている場合を除き、一方から受け取れるのは0.55ヶ月分まで。
 *     ★この承諾は「契約時にハンコを押したか」ではなく「媒介の依頼を受けるにあたって」得るものなので、
 *     後から1.1ヶ月分を請求する根拠にはならない。
 *
 *  7. **権利金の特例（第六）は居住用の建物を除く**。店舗・事務所・土地で返還されない権利金があるときだけ、
 *     権利金を売買代金とみなして計算でき、借賃基準の額と高い方を選べる。
 *     居住用に適用すると、敷引き等を理由に上限を大幅に過大に出す。
 *
 *  8. **上限額の端数は切り捨てる**。告示は「〜以内」なので、円未満を切り上げると上限を超えてしまう。
 *
 * 収録範囲外（データJSONの out_of_scope に理由つきで列挙。該当する入力には金額を出さない）:
 *   長期の空家等の貸借の特例（第九・第十）／免税事業者の報酬（第十一②）／広告料・出張旅費（第十一①ただし書）。
 *
 * 一次情報: 上記告示の全文PDF（国土交通省 tochi_fudousan_kensetsugyo/const/content/001750143.pdf）を
 * 逐語確認。宅地建物取引業法（327AC1000000176）46条を e-Gov法令API v2 で確認。
 */

/** 数値化（空文字・null・NaN は0）。 */
const nz = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * 上限額なので円未満は切り捨てる（切り上げると告示の上限を超える）。
 * ★2進小数の誤差で 110000 が 109999.99999999999 になると1円下がって出るので、
 * 円未満の丸め誤差（1e-6円＝実務上ありえない桁）だけ吸収してから切り捨てる。
 */
const yen = (v) => Math.floor(v + 1e-6);

/**
 * 税込価格に含まれる消費税等相当額を取り出す。
 * 建物価格が税込1,100万円・税率10%なら 100万円。
 */
export function shohizeiBun(zeikomiGaku, DATA) {
  const r = DATA?.shohizei?.ritsu ?? 0.1;
  const g = Math.max(0, nz(zeikomiGaku));
  return yen((g * r) / (1 + r));
}

/**
 * 総額（実際に支払う代金）から、報酬計算に使う「代金の額（税抜）」を出す。
 * @param {number} sogakuZeikomi 売買代金の総額
 * @param {number} tatemonoZeikomi そのうち建物の価格（税込）。土地のみ・個人間売買なら0
 */
export function daikinNuki(sogakuZeikomi, tatemonoZeikomi, DATA) {
  const sogaku = Math.max(0, nz(sogakuZeikomi));
  const tatemono = Math.min(Math.max(0, nz(tatemonoZeikomi)), sogaku);
  const zei = shohizeiBun(tatemono, DATA);
  return { daikin: sogaku - zei, shohizei: zei, sogaku, tatemonoZeikomi: tatemono };
}

/**
 * 告示 第二＝売買・交換の媒介で、依頼者の一方から受け取れる報酬の上限（消費税等相当額を含む）。
 * 代金の額を区分に分け、それぞれに割合を掛けて合計する。
 *
 * @param {number} daikin 代金の額（消費税等相当額を含まない）
 * @returns {{zeikomi:number, hontai:number, uchiwake:Array}}
 */
export function baibaiKijun(daikin, DATA) {
  const gaku = Math.max(0, nz(daikin));
  const bands = DATA.baibai.bands;
  const uchiwake = [];
  let zeikomi = 0;
  let hontai = 0;

  for (const b of bands) {
    const ue = b.ika === null || b.ika === undefined ? Infinity : b.ika;
    const taisho = Math.max(0, Math.min(gaku, ue) - b.koeru); // この区分に入る金額
    if (taisho <= 0) continue;
    zeikomi += taisho * b.ritsu;
    hontai += taisho * b.hontai_ritsu;
    uchiwake.push({
      label: b.label,
      hyoji: b.hyoji,
      hyojiHontai: b.hyoji_hontai,
      taishoGaku: taisho,
      ritsu: b.ritsu,
      gaku: yen(taisho * b.ritsu),
      gakuHontai: yen(taisho * b.hontai_ritsu),
    });
  }
  return { zeikomi: yen(zeikomi), hontai: yen(hontai), uchiwake };
}

/**
 * 速算式（代金の額×3%＋6万円、本体）。400万円を超えるときだけ使える。
 * 区分ごとの合計と一致することを単体テストで固定している。
 */
export function baibaiSokusan(daikin, DATA) {
  const s = DATA.baibai.sokusan;
  const gaku = Math.max(0, nz(daikin));
  if (gaku <= s.shikii) return null;
  const hontai = yen(gaku * s.ritsu_hontai + s.kasan_hontai);
  return { hontai, zeikomi: yen(hontai * DATA.shohizei.kakeru) };
}

/** 取引の日が、このデータが収録している期間に入っているか。 */
function kikanCheck(hidzuke, DATA) {
  const from = DATA._meta.applies_from;
  if (!hidzuke) return { ok: true, unknown: true }; // 日付未入力は今日の制度で計算する（画面が既定値を入れる）
  // 日付どうしは文字列比較（Date にするとUTC解釈でJSTの当日朝がずれる）
  if (String(hidzuke) < from) return { ok: false, from };
  return { ok: true };
}

/**
 * 売買・交換の仲介手数料の上限。
 *
 * @param {object} input
 *   sogakuZeikomi   売買代金の総額（実際に支払う額）
 *   tatemonoZeikomi そのうち建物の価格（税込）。土地のみ・個人間売買は0
 *   tachiba         'baikai'（媒介＝ふつうの仲介）| 'dairi'（代理）
 *   akiyaTekiyo     低廉な空家等の特例について、費用を勘案して合意しているか
 *   aiteHoshu       代理のとき、業者が取引の相手方からも媒介の報酬を受け取るか
 *   hidzuke         媒介契約の日（YYYY-MM-DD）
 */
export function calcBaibai(input, DATA) {
  const kikan = kikanCheck(input.hidzuke, DATA);
  if (!kikan.ok) {
    return {
      ok: false,
      code: "kikan_gai",
      riyu:
        `このツールは${DATA._meta.applies_from_hyoji}以後の告示（令和6年改正後）で計算します。` +
        `それより前に締結した媒介契約の報酬は改正前の告示によるため、金額を出しません。`,
    };
  }

  const d = daikinNuki(input.sogakuZeikomi, input.tatemonoZeikomi, DATA);
  if (d.sogaku <= 0) {
    return { ok: false, code: "mi_nyuryoku", riyu: "売買代金を入力してください。" };
  }

  const kijun = baibaiKijun(d.daikin, DATA);
  const chuui = [];
  const dairi = input.tachiba === "dairi";

  // 第七・第八＝低廉な空家等の特例
  const A = DATA.akiya;
  const akiyaTaisho = d.daikin <= A.jogen_kagaku;
  const akiyaTekiyo = !!input.akiyaTekiyo && akiyaTaisho && A.status === "active";
  let jogen = dairi ? kijun.zeikomi * DATA.dairi.bai : kijun.zeikomi;
  let konkyo = dairi ? "告示 第三（売買・交換の代理＝媒介の2倍以内）" : "告示 第二（売買・交換の媒介）";

  if (akiyaTekiyo) {
    const akiyaJogen = dairi ? A.jogen_hoshu * A.dairi_bai : A.jogen_hoshu;
    if (akiyaJogen > jogen) {
      jogen = akiyaJogen;
      konkyo = dairi
        ? "告示 第八（低廉な空家等の売買・交換の代理＝第七の2倍以内）"
        : "告示 第七（低廉な空家等の売買・交換の媒介）";
      chuui.push(
        `低廉な空家等の特例により、原則の上限（${kijun.zeikomi.toLocaleString()}円）を超えて` +
          `${jogen.toLocaleString()}円まで受け取れます。ただし自動的にこの額になるのではなく、` +
          `「媒介に要する費用を勘案して」の額であり、媒介契約の締結前に説明と合意が必要です。`
      );
    } else if (akiyaTaisho) {
      chuui.push(
        `代金の額が800万円に近いため、低廉な空家等の特例（上限${A.jogen_hoshu.toLocaleString()}円）を` +
          `使っても原則の計算額のほうが高く、上限は変わりません。`
      );
    }
  } else if (akiyaTaisho && A.status === "active") {
    chuui.push(
      `代金の額が${A.jogen_kagaku.toLocaleString()}円以下なので、低廉な空家等の特例（告示 第七）の対象です。` +
        `媒介に要する費用を勘案して合意した場合は、上限が${A.jogen_hoshu.toLocaleString()}円まで上がります。`
    );
  }

  jogen = yen(jogen);

  if (dairi) {
    if (input.aiteHoshu) {
      chuui.push(
        `取引の相手方からも媒介の報酬を受け取る場合、その合計が媒介の2倍（${yen(
          kijun.zeikomi * DATA.dairi.bai
        ).toLocaleString()}円）を超えてはなりません（告示 第三ただし書）。` +
          `相手方から満額（${kijun.zeikomi.toLocaleString()}円）を受け取るなら、代理の依頼者から受け取れるのは` +
          `${yen(jogen - kijun.zeikomi).toLocaleString()}円までです。`
      );
    }
  }

  if (d.shohizei > 0) {
    chuui.push(
      `建物価格に含まれる消費税${d.shohizei.toLocaleString()}円を除いた` +
        `${d.daikin.toLocaleString()}円で計算しています（告示 第二は「代金の額（消費税等相当額を含まない）」と定めています）。`
    );
  }

  return {
    ok: true,
    shurui: "baibai",
    tachiba: dairi ? "dairi" : "baikai",
    daikin: d.daikin,
    sogaku: d.sogaku,
    shohizeiBun: d.shohizei,
    kijunGaku: kijun.zeikomi,
    uchiwake: kijun.uchiwake,
    jogen,
    jogenHontai: yen(jogen / DATA.shohizei.kakeru),
    akiyaTaisho,
    akiyaTekiyo,
    sokusan: baibaiSokusan(d.daikin, DATA),
    konkyo,
    chuui,
  };
}

/**
 * 貸借の仲介手数料の上限。
 *
 * @param {object} input
 *   yachinZeikomi 借賃の1月分（実際に払う額）
 *   isKyojuyo     居住用の建物か（居住用の家賃は非課税・0.55倍ルールの対象）
 *   shodaku       居住用で、媒介の依頼を受けるにあたって承諾を得ているか
 *   tachiba       'baikai' | 'dairi'
 *   kenrikin      返還されない権利金の額（税抜。居住用以外のみ）
 *   hidzuke       媒介契約の日
 */
export function calcTaishaku(input, DATA) {
  const kikan = kikanCheck(input.hidzuke, DATA);
  if (!kikan.ok) {
    return {
      ok: false,
      code: "kikan_gai",
      riyu:
        `このツールは${DATA._meta.applies_from_hyoji}以後の告示（令和6年改正後）で計算します。` +
        `それより前に締結した媒介契約の報酬は改正前の告示によるため、金額を出しません。`,
    };
  }

  const T = DATA.taishaku;
  const isKyojuyo = !!input.isKyojuyo;
  const zeikomiYachin = Math.max(0, nz(input.yachinZeikomi));
  if (zeikomiYachin <= 0) {
    return { ok: false, code: "mi_nyuryoku", riyu: "借賃（1か月分）を入力してください。" };
  }

  // 居住用の家賃は消費税が非課税。店舗・事務所等は税込で払っているので税抜に直す（第四のかっこ書き）。
  const shohizei = isKyojuyo ? 0 : shohizeiBun(zeikomiYachin, DATA);
  const yachin = zeikomiYachin - shohizei;

  const dairi = input.tachiba === "dairi";
  const gokei = yen(yachin * T.gokei_bairitsu);
  const chuui = [];

  // 一方から受け取れる上限（第四後段）。
  let ippo = gokei;
  let ippoRiyu = "居住用以外なので、合計が上限内であれば貸主・借主の配分は自由です。";
  if (isKyojuyo && !input.shodaku) {
    ippo = yen(yachin * T.kyojuyo_ippo_bairitsu);
    ippoRiyu =
      "居住用の建物で、媒介の依頼を受けるにあたっての承諾がないため、一方から受け取れるのは借賃の0.55か月分までです。";
  } else if (isKyojuyo && input.shodaku) {
    ippoRiyu =
      "居住用の建物ですが、媒介の依頼を受けるにあたって承諾を得ている場合なので、一方から1.1か月分まで受け取れます（双方の合計も1.1か月分が上限です）。";
    chuui.push(
      "★この承諾は「媒介の依頼を受けるにあたって」得るものです（告示 第四）。" +
        "物件を紹介された後や契約時に同意を求められても、依頼の時点で承諾していなければ上限は0.55か月分のままです。"
    );
  }

  // 第六＝権利金の授受がある場合の特例（居住用の建物は除く）
  let kenrikinKekka = null;
  const kenrikin = Math.max(0, nz(input.kenrikin));
  if (kenrikin > 0) {
    if (isKyojuyo && DATA.kenrikin.kyojuyo_jogai) {
      chuui.push(
        "権利金の特例（告示 第六）は居住用の建物には使えません。居住用では敷金・礼金があっても借賃基準で計算します。"
      );
    } else {
      const k = baibaiKijun(kenrikin, DATA);
      const kJogen = dairi ? yen(k.zeikomi * DATA.dairi.bai) : k.zeikomi;
      kenrikinKekka = { kijun: k.zeikomi, jogen: kJogen, uchiwake: k.uchiwake };
      if (kJogen > ippo) {
        chuui.push(
          `権利金${kenrikin.toLocaleString()}円を売買代金とみなして計算すると` +
            `${kJogen.toLocaleString()}円となり、借賃基準（${ippo.toLocaleString()}円）より高いため、` +
            `業者はこちらを選べます（告示 第六）。`
        );
      } else {
        chuui.push(
          `権利金を売買代金とみなして計算すると${kJogen.toLocaleString()}円で、借賃基準の額を超えないため、` +
            `上限は借賃基準のままです（告示 第六は「よることができる」＝高い方を選べる規定です）。`
        );
      }
    }
  }

  const ippoSaishu = kenrikinKekka ? Math.max(ippo, kenrikinKekka.jogen) : ippo;
  const gokeiSaishu = kenrikinKekka ? Math.max(gokei, kenrikinKekka.jogen) : gokei;

  if (shohizei > 0) {
    chuui.push(
      `賃料に含まれる消費税${shohizei.toLocaleString()}円を除いた${yachin.toLocaleString()}円で計算しています` +
        `（告示 第四は「借賃（消費税等相当額を含まない）」と定めています）。`
    );
  }
  if (dairi) {
    chuui.push(
      "貸借の代理の上限も借賃の1.1か月分です（告示 第五）。取引の相手方からも媒介の報酬を受け取る場合は、その合計が1.1か月分を超えてはなりません。"
    );
  }

  return {
    ok: true,
    shurui: "taishaku",
    tachiba: dairi ? "dairi" : "baikai",
    yachin,
    yachinZeikomi: zeikomiYachin,
    shohizeiBun: shohizei,
    gokeiJogen: gokeiSaishu,
    ippoJogen: ippoSaishu,
    ippoJogenHontai: yen(ippoSaishu / DATA.shohizei.kakeru),
    ippoRiyu,
    kenrikin: kenrikinKekka,
    konkyo: dairi ? "告示 第五（貸借の代理）" : "告示 第四（貸借の媒介）",
    chuui,
  };
}

/** 入口。torihiki で振り分ける。 */
export function calc(input, DATA) {
  if (!DATA || !DATA._meta || !DATA.baibai) {
    return { ok: false, code: "data_nashi", riyu: "料率データを読み込めませんでした。通信環境を確認して再読み込みしてください。" };
  }
  return input.torihiki === "taishaku" ? calcTaishaku(input, DATA) : calcBaibai(input, DATA);
}
