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

// 날짜를 YYYYMMDD 형식으로
function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// YYYYMMDD → YYYY-MM-DD
function dashDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
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

    const disclosures = Array.from(dedup.values())
      .filter((x) => (x.rcept_dt || '') >= bgnDe)
      .map((x) => {
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
          name: x.corp_name,
          stockCode: x.stock_code || null,
          before,
          after,
          change: delta,
          type,
          date: dashDate(x.rcept_dt),
          reportor: x.repror,
          reportResn: x.report_resn || null,
          receiptNo: x.rcept_no,
          dartUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no}`,
        };
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

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
