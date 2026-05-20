/**
 * 국민연금공단 5% 대량보유 공시 조회 API
 *
 * 출처: 금융감독원 전자공시시스템 OpenDART (opendart.fss.or.kr)
 * 절차:
 *   1. 최근 N일간 D001(대량보유보고서) 공시 목록 가져오기
 *   2. 각 회사(corp_code)별로 majorstock.json 호출 → 보고자=국민연금공단 필터
 *   3. 변동률·날짜 기준 정렬 후 반환
 *
 * 캐싱: Vercel Edge가 10분간 결과를 캐싱 (OpenDART 쿼터 보호)
 * 호출 예시: GET /api/disclosures?days=90
 */

const OPENDART_BASE = 'https://opendart.fss.or.kr/api';
const NPS_KEYWORDS = ['국민연금공단', '국민연금기금']; // 보고자 매칭 키워드

// 함수 인스턴스 내 in-memory 캐시 (동일 인스턴스 재사용 시 야후 호출 절감)
const priceCache = new Map();

/**
 * 야후 파이낸스 chart API로 보고일 부근 종가 조회
 * @param {string} stockCode 6자리 단축코드 (예: '005930')
 * @param {string} corpCls 'Y'=KOSPI, 'K'=KOSDAQ
 * @param {string} dateYYYYMMDD 보고일 YYYYMMDD
 * @returns {Promise<number|null>} 종가 (원) 또는 null
 */
async function fetchClosePrice(stockCode, corpCls, dateYYYYMMDD) {
  if (!stockCode || stockCode.length !== 6 || !/^\d+$/.test(stockCode)) return null;

  const cacheKey = `${stockCode}_${dateYYYYMMDD}`;
  if (priceCache.has(cacheKey)) return priceCache.get(cacheKey);

  // 코넥스(N), 기타(E)는 야후에 없을 가능성 높음 → KOSPI로 기본 시도
  const suffix = corpCls === 'K' ? '.KQ' : '.KS';
  const symbol = stockCode + suffix;

  const y = parseInt(dateYYYYMMDD.slice(0, 4), 10);
  const m = parseInt(dateYYYYMMDD.slice(4, 6), 10);
  const d = parseInt(dateYYYYMMDD.slice(6, 8), 10);
  const target = new Date(Date.UTC(y, m - 1, d, 6)); // KST 자정 ≈ UTC 15시 전일, 안전하게 06시 UTC
  const targetTs = Math.floor(target.getTime() / 1000);

  // 보고일 ±7일 (휴장일 보정)
  const start = targetTs - 7 * 86400;
  const end = targetTs + 7 * 86400;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${start}&period2=${end}&interval=1d`;

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; nps-watch/1.0)' },
    });
    if (!r.ok) {
      priceCache.set(cacheKey, null);
      return null;
    }
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) {
      priceCache.set(cacheKey, null);
      return null;
    }
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    // 보고일에 가장 가까운 거래일 종가
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < ts.length; i += 1) {
      if (closes[i] == null) continue;
      const diff = Math.abs(ts[i] - targetTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    const price = best >= 0 ? closes[best] : null;
    priceCache.set(cacheKey, price);
    return price;
  } catch (e) {
    priceCache.set(cacheKey, null);
    return null;
  }
}

// 날짜를 YYYYMMDD 형식으로
function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// YYYYMMDD 또는 YYYY-MM-DD → YYYY-MM-DD (정규화)
function dashDate(s) {
  if (!s) return s;
  const clean = String(s).replace(/-/g, '');
  if (clean.length < 8) return s;
  return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
}

// 어떤 형식이든 YYYYMMDD로 (날짜 비교용)
function compactDate(s) {
  return (s || '').toString().replace(/-/g, '');
}

// 안전한 숫자 파싱
function num(v) {
  if (v == null) return null;
  const cleaned = String(v).replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

export default async function handler(req, res) {
  const API_KEY = process.env.OPENDART_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      error: 'OPENDART_API_KEY 환경변수가 설정되지 않았습니다.',
      hint: 'Vercel 대시보드 → Settings → Environment Variables 에서 등록하세요.',
    });
  }

  // OpenDART 정책: corp_code 없이는 최대 3개월(~89일)까지만 검색 가능
  const days = Math.min(parseInt(req.query.days || '60', 10), 89);

  const today = new Date();
  const startDate = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  const bgnDe = fmtDate(startDate);
  const endDe = fmtDate(today);

  try {
    // -----------------------------
    // STEP 1: D001 공시 목록
    // -----------------------------
    const allList = [];
    let page = 1;
    const PAGE_COUNT = 100;
    const MAX_PAGES = 5; // 최근 500건 정도까지

    while (page <= MAX_PAGES) {
      const listUrl = new URL(`${OPENDART_BASE}/list.json`);
      listUrl.searchParams.set('crtfc_key', API_KEY);
      listUrl.searchParams.set('pblntf_detail_ty', 'D001');
      listUrl.searchParams.set('bgn_de', bgnDe);
      listUrl.searchParams.set('end_de', endDe);
      listUrl.searchParams.set('page_count', String(PAGE_COUNT));
      listUrl.searchParams.set('page_no', String(page));

      const r = await fetch(listUrl.toString());
      const j = await r.json();

      if (j.status === '013') {
        // "조회된 데이터가 없습니다"
        break;
      }
      if (j.status !== '000') {
        return res.status(500).json({
          error: 'OpenDART list API 오류',
          status: j.status,
          message: j.message,
        });
      }

      const list = Array.isArray(j.list) ? j.list : [];
      allList.push(...list);

      if (list.length < PAGE_COUNT) break;
      page += 1;
    }

    // -----------------------------
    // STEP 1.5: corp_code 부가정보 매핑 (list.json 결과에서 추출)
    //   - corp_cls: 'Y'=KOSPI, 'K'=KOSDAQ, 'N'=KONEX
    //   - stock_code: 6자리 단축코드 (majorstock 응답에는 없으므로 별도 매핑 필요)
    // -----------------------------
    const corpClsMap = new Map();
    const stockCodeMap = new Map();
    for (const item of allList) {
      if (!item.corp_code) continue;
      if (item.corp_cls)   corpClsMap.set(item.corp_code, item.corp_cls);
      if (item.stock_code) stockCodeMap.set(item.corp_code, item.stock_code);
    }

    // -----------------------------
    // STEP 2: 회사별 majorstock 병렬 조회
    // -----------------------------
    const uniqueCorps = Array.from(new Set(allList.map((x) => x.corp_code))).filter(Boolean);

    const promises = uniqueCorps.map(async (corp_code) => {
      const url = new URL(`${OPENDART_BASE}/majorstock.json`);
      url.searchParams.set('crtfc_key', API_KEY);
      url.searchParams.set('corp_code', corp_code);

      try {
        const r = await fetch(url.toString());
        const j = await r.json();
        if (j.status === '000' && Array.isArray(j.list)) {
          // 국민연금 관련 보고자만 필터
          return j.list.filter(
            (x) => x.repror && NPS_KEYWORDS.some((kw) => x.repror.includes(kw))
          );
        }
      } catch (e) {
        // 개별 회사 조회 실패는 무시 (전체 결과에 영향 X)
      }
      return [];
    });

    const settled = await Promise.all(promises);
    const allNps = settled.flat();

    // -----------------------------
    // STEP 3: 가공·정렬·중복 제거
    // -----------------------------
    const dedup = new Map();
    for (const x of allNps) {
      const key = `${x.rcept_no}`;
      if (!dedup.has(key)) dedup.set(key, x);
    }

    // 1차 가공 (지분율·주식수)
    const filtered = Array.from(dedup.values()).filter(
      (x) => compactDate(x.rcept_dt) >= bgnDe
    );

    const baseList = filtered.map((x) => {
      const after = num(x.stkrt);
      const delta = num(x.stkrt_irds);
      const before = after != null && delta != null ? +(after - delta).toFixed(2) : null;

      const type =
        delta == null
          ? '변동'
          : delta > 0
          ? '증가'
          : delta < 0
          ? '감소'
          : '변동없음';

      return {
        _corp_code: x.corp_code,
        name: x.corp_name,
        stockCode: x.stock_code || stockCodeMap.get(x.corp_code) || null,
        corpCls: corpClsMap.get(x.corp_code) || null, // 'Y' or 'K'
        before,
        after,
        change: delta,
        type,
        date: dashDate(x.rcept_dt),
        reportor: x.repror,
        reportResn: x.report_resn || null,
        receiptNo: x.rcept_no,
        dartUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no}`,
        stockQty: num(x.stkqy),
        stockQtyChange: num(x.stkqy_irds),
        rcept_dt_compact: compactDate(x.rcept_dt),
      };
    });

    // 2차 가공: 종가 조회 + 평가액 계산 (Phase 2, 야후 파이낸스)
    const enriched = await Promise.all(
      baseList.map(async (d) => {
        const close = await fetchClosePrice(d.stockCode, d.corpCls, d.rcept_dt_compact);
        const valueHold =
          close != null && d.stockQty != null ? Math.round(close * d.stockQty) : null;
        const valueChange =
          close != null && d.stockQtyChange != null
            ? Math.round(close * d.stockQtyChange)
            : null;
        // 내부용 필드 제거 후 반환
        const { _corp_code, rcept_dt_compact, ...rest } = d;
        return {
          ...rest,
          closePrice: close,
          valueHold,
          valueChange,
          priceSource: close != null ? 'yahoo' : null,
        };
      })
    );

    const disclosures = enriched.sort((a, b) =>
      (b.date || '').localeCompare(a.date || '')
    );

    // Vercel CDN 캐시 (10분) + stale-while-revalidate (30분)
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      range: { from: dashDate(bgnDe), to: dashDate(endDe), days },
      count: disclosures.length,
      disclosures,
    });
  } catch (err) {
    return res.status(500).json({
      error: '서버 내부 오류',
      message: err && err.message ? err.message : String(err),
    });
  }
}
