/**
 * 相続税の計算コア（DOM非依存・テスト対象）。
 *
 * 出すもの:
 *  ① 相続税の総額 …… 課税価格の合計額と法定相続人の構成だけから一意に決まる額（配偶者の税額軽減・
 *     2割加算より前）。国税庁 No.4152 の3段階計算そのもの。
 *  ② 実際に納める相続税の合計 …… 各人が「法定相続分どおりに取得した」典型的な分け方をした場合の、
 *     2割加算・配偶者の税額軽減を反映した納税額。標準的な相続税の早見表が載せているのはこの②。
 *
 * ★★このツールが黙って誤答しやすい急所（国税庁 No.4152 注・No.4155・No.4157・No.4158）:
 *
 *  1. **基礎控除の「法定相続人の数」は、相続放棄を無視して数える。**（相法15条2項）
 *     放棄した人がいても「放棄がなかったものとした数」で数える。放棄で基礎控除は減らない。
 *     → 本ツールは相続人の“構成”を受け取り、放棄は数に反映しない（＝放棄がなかったものとした数）。
 *
 *  2. **養子は算入制限がある。**（相法15条3項）実子がいれば養子は1人まで、実子がいなければ2人まで。
 *     無制限に数えると基礎控除が過大になり、税額を過少に見せる。
 *
 *  3. **速算表は「法定相続分に応ずる取得金額」に当てる。**（相法16条）
 *     実際に取得した金額に速算表を当てるのは典型的な誤り。課税遺産総額を法定相続分で割ってから当てる。
 *
 *  4. **配偶者の税額軽減。**（相法19条の2）配偶者が法定相続分（または1.6億円）まで取得した分は非課税。
 *     本ツールは「配偶者が法定相続分を取得」する前提なので、配偶者の税額はつねに0になる。
 *
 *  5. **2割加算。**（相法18条）配偶者・親・子・代襲相続人である孫 以外（＝兄弟姉妹など）は税額に＋20%。
 *
 *  6. **課税価格の合計が基礎控除以下なら相続税0。**（相法15条）ただし特例で0にする場合は申告が要る。
 *
 * 一次情報: 相続税法15・16・18・19条の2／民法900条／国税庁 No.4152・4155・4157・4158。
 */

/** 円に丸める（0未満・未入力・数値でないものは0）。NaN を素通しすると税額が丸ごと NaN になる。 */
const yen = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
/** 1以上の整数に（人数用）。負や NaN は0。 */
const cnt = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * 相続税法上の「法定相続人の数」と、その内訳（血族側の順位・人数）を決める。
 * ★放棄は数に反映しない（急所1）。★養子は制限して数える（急所2）。
 * @returns { count, blood, spouse } blood = { kind:'child'|'parent'|'sibling'|'none', n }
 */
export function houteiSozokunin(family, D) {
  if (!D) throw new Error('参照データ（sozokuzei_r08.json）が渡されていません');
  const H = D.houtei_sozokunin;
  const f = family || {};
  const spouse = !!f.hasSpouse;

  const jisshi = cnt(f.numChildrenReal);
  const youshiRaw = cnt(f.numChildrenAdopted);
  // 養子の算入制限（実子がいれば1人・いなければ2人）
  const youshiCap = jisshi > 0 ? H.youshi_limit_with_jisshi : H.youshi_limit_without_jisshi;
  const youshi = Math.min(youshiRaw, youshiCap);
  const effChildren = jisshi + youshi;

  let blood;
  if (effChildren > 0) {
    blood = { kind: 'child', n: effChildren, jisshi, youshi, youshiCapped: youshiRaw > youshi };
  } else if (cnt(f.numParents) > 0) {
    blood = { kind: 'parent', n: cnt(f.numParents) };
  } else if (cnt(f.numSiblings) > 0) {
    blood = { kind: 'sibling', n: cnt(f.numSiblings) };
  } else {
    blood = { kind: 'none', n: 0 };
  }

  const count = blood.n + (spouse ? 1 : 0);
  return { count, blood, spouse };
}

/** 基礎控除額 ＝ 3,000万円 ＋ 600万円 × 法定相続人の数（相法15条）。 */
export function kisoKojo(houteiCount, D) {
  if (!D) throw new Error('参照データ（sozokuzei_r08.json）が渡されていません');
  const K = D.kiso_kojo;
  return K.teigaku + K.per_houtei_sozokunin * cnt(houteiCount);
}

/** 速算表から、金額に対応する税額 ＝ 金額×税率 − 控除額（相法16条・No.4155）。 */
export function sokusanZei(kingaku, D) {
  if (!D) throw new Error('参照データ（sozokuzei_r08.json）が渡されていません');
  const B = D.sokusanhyo.brackets;
  const v = yen(kingaku);
  for (const b of B) {
    if (b.upto === null || b.upto === undefined || v <= b.upto) {
      return { zei: Math.max(0, Math.round(v * b.rate_pct / 100) - b.deduction), rate_pct: b.rate_pct, deduction: b.deduction, label: b.label };
    }
  }
  const last = B[B.length - 1];
  return { zei: Math.max(0, Math.round(v * last.rate_pct / 100) - last.deduction), rate_pct: last.rate_pct, deduction: last.deduction, label: last.label };
}

/**
 * 各順位の「1人あたりの法定相続分」を [分子, 分母] で返す（民法900条）。
 * 配偶者がいるかどうかと血族の順位で決まる。
 * @returns { spouse:[num,den]|null, blood:[num,den]|null } blood は血族1人あたり
 */
export function houteiBun(sozokunin) {
  const { spouse, blood } = sozokunin;
  const n = blood.n;
  if (spouse && blood.kind === 'child')   return { spouse: [1, 2], blood: n ? [1, 2 * n] : null };
  if (spouse && blood.kind === 'parent')  return { spouse: [2, 3], blood: n ? [1, 3 * n] : null };
  if (spouse && blood.kind === 'sibling') return { spouse: [3, 4], blood: n ? [1, 4 * n] : null };
  if (spouse && blood.kind === 'none')    return { spouse: [1, 1], blood: null };
  // 配偶者がいない → 最先順位の血族が全部を等分
  if (!spouse && n > 0)                    return { spouse: null, blood: [1, n] };
  return { spouse: null, blood: null };
}

/** 課税遺産総額を [分子,分母] の法定相続分で按分（1,000円未満切り捨て・相法16条）。 */
function bunToShare(kazeiIsan, frac) {
  const [num, den] = frac;
  return Math.floor(kazeiIsan * num / den / 1000) * 1000;
}

/** 兄弟姉妹（＝配偶者・親・子・代襲孫でない者）は2割加算の対象か（相法18条・急所5）。 */
function isNiwariKasan(bloodKind) {
  return bloodKind === 'sibling';
}

/**
 * 入口。
 * input = {
 *   isanTotal,            // 課税価格の合計額（円）。基礎控除の前の、遺産の評価額の合計
 *   hasSpouse,            // 配偶者の有無
 *   numChildrenReal,      // 実子の数
 *   numChildrenAdopted,   // 養子の数
 *   numParents,           // 直系尊属（親）の数 …… 子がいないときだけ相続人になる
 *   numSiblings,          // 兄弟姉妹の数 …… 子も親もいないときだけ相続人になる
 * }
 * D = sozokuzei_r08.json
 */
export function calcSozokuzei(input, D) {
  if (!D) throw new Error('参照データ（sozokuzei_r08.json）が渡されていません');
  const i = input || {};
  const isanTotal = yen(i.isanTotal);
  if (isanTotal <= 0) throw new Error('遺産総額（課税価格の合計額）を入力してください');

  const sozokunin = houteiSozokunin(i, D);
  if (sozokunin.count === 0) {
    throw new Error('法定相続人がいません。配偶者・子・親・兄弟姉妹のいずれかを入力してください');
  }

  const houteiCount = sozokunin.count;
  const kiso = kisoKojo(houteiCount, D);
  const kazeiIsan = Math.max(0, isanTotal - kiso); // 課税遺産総額（相法16条）
  const belowKiso = isanTotal <= kiso;

  const frac = houteiBun(sozokunin);

  // ── ① 相続税の総額（No.4152 の第2段階：課税遺産総額を法定相続分で按分→速算表→合計） ──
  const bunList = []; // 表示用（法定相続分に応ずる取得金額と税額）
  let sumZei = 0;
  if (frac.spouse) {
    const share = bunToShare(kazeiIsan, frac.spouse);
    const s = sokusanZei(share, D);
    bunList.push({ who: 'spouse', label: '配偶者', frac: frac.spouse, share, zei: s.zei, rate_pct: s.rate_pct });
    sumZei += s.zei;
  }
  if (frac.blood) {
    const share = bunToShare(kazeiIsan, frac.blood);
    const s = sokusanZei(share, D);
    for (let k = 0; k < sozokunin.blood.n; k++) {
      bunList.push({ who: sozokunin.blood.kind, label: bloodLabel(sozokunin.blood.kind), frac: frac.blood, share, zei: s.zei, rate_pct: s.rate_pct });
      sumZei += s.zei;
    }
  }
  // 相続税の総額は100円未満切り捨て
  const sogaku = belowKiso ? 0 : Math.floor(sumZei / 100) * 100;

  // ── ② 実際に納める相続税（各人が法定相続分どおり取得した前提）──────────────────
  //   各人の算出税額 ＝ 相続税の総額 × その人の法定相続分。2割加算・配偶者軽減を反映し100円未満切り捨て。
  const kasan = isNiwariKasan(sozokunin.blood.kind);
  const kasanRate = D.niwari_kasan.rate_pct;

  const perHeir = []; // { who, label, count, eachTax, groupTax, kasan }
  let jishitsu = 0;

  if (frac.spouse) {
    // 配偶者は法定相続分を取得 → 税額軽減で0（急所4）
    perHeir.push({ who: 'spouse', label: '配偶者', count: 1, eachTax: 0, groupTax: 0, kasan: false, keigen: true });
  }
  if (frac.blood) {
    const [num, den] = frac.blood;
    let each = Math.round(sogaku * num / den); // 算出税額（各人）
    if (kasan) each = each + Math.round(each * kasanRate / 100); // 2割加算（急所5）
    each = Math.floor(each / 100) * 100; // 各人の納付税額は100円未満切り捨て
    const n = sozokunin.blood.n;
    perHeir.push({ who: sozokunin.blood.kind, label: bloodLabel(sozokunin.blood.kind), count: n, eachTax: each, groupTax: each * n, kasan });
    jishitsu += each * n;
  }
  const jishitsuFutan = belowKiso ? 0 : jishitsu;

  return {
    isanTotal,
    houteiCount,
    kiso,
    kazeiIsan,
    belowKiso,
    sogaku,          // ① 相続税の総額（軽減・加算の前）
    jishitsuFutan,   // ② 実際の納税額（配偶者が法定相続分を取得した前提）
    bunList,         // ① の内訳（法定相続分に応ずる取得金額と各人の税額）
    perHeir,         // ② の内訳（各人・グループの納付税額）
    sozokunin,       // 法定相続人の内訳（放棄無視・養子制限後）
    niwariKasan: kasan,
    hasSpouse: sozokunin.spouse,
    year: D._meta?.year || '',
  };
}

function bloodLabel(kind) {
  return kind === 'child' ? '子' : kind === 'parent' ? '父母（直系尊属）' : kind === 'sibling' ? '兄弟姉妹' : '';
}
