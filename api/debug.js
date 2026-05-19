/**
 * 디버그용 임시 엔드포인트
 * OpenDART의 실제 응답 구조와 보고자(repror) 필드값을 확인하기 위함
 *
 * 호출 예시:
 *   GET /api/debug                  → 최근 30일 D001 공시 + 샘플 majorstock
 *   GET /api/debug?corp_code=XXXX   → 특정 회사의 majorstock 전체
 *   GET /api/debug?scan=1           → 최근 30일 D001의 모든 보고자(repror) 유니크 목록
 */

export default async function handler(req, res) {
  const API_KEY = process.env.OPENDART_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key missing' });
  }

  const today = new Date();
  const start = new Date(today.getTime() - 30 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

  // 특정 회사 majorstock 조회 모드
  if (req.query.corp_code) {
    const url = `https://opendart.fss.or.kr/api/majorstock.json?crtfc_key=${API_KEY}&corp_code=${req.query.corp_code}`;
    const r = await fetch(url);
    const data = await r.json();
    return res.status(200).json(data);
  }

  // 1. 최근 30일 D001 공시 목록
  const listUrl = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${API_KEY}&pblntf_detail_ty=D001&bgn_de=${fmt(start)}&end_de=${fmt(today)}&page_count=100`;
  const r = await fetch(listUrl);
  const listData = await r.json();

  const list = Array.isArray(listData.list) ? listData.list : [];

  // 스캔 모드: 모든 회사의 majorstock 호출 → 보고자(repror) 유니크 추출
  if (req.query.scan === '1') {
    const uniqueCorps = Array.from(new Set(list.map((x) => x.corp_code))).filter(Boolean);
    const reprorMap = new Map(); // repror → 회사 샘플

    await Promise.all(
      uniqueCorps.slice(0, 50).map(async (cc) => {
        try {
          const url = `https://opendart.fss.or.kr/api/majorstock.json?crtfc_key=${API_KEY}&corp_code=${cc}`;
          const r2 = await fetch(url);
          const d = await r2.json();
          if (d.status === '000' && Array.isArray(d.list)) {
            for (const item of d.list) {
              if (item.repror && !reprorMap.has(item.repror)) {
                reprorMap.set(item.repror, item.corp_name);
              }
            }
          }
        } catch (e) {}
      })
    );

    // 국민연금 관련 키워드 후보 추출
    const allReprors = Array.from(reprorMap.entries()).map(([repror, corp]) => ({ repror, corp }));
    const npsRelated = allReprors.filter((x) =>
      /연금|National Pension|NPS|기금/i.test(x.repror)
    );

    return res.status(200).json({
      listStatus: listData.status,
      listMessage: listData.message,
      totalCompanies: uniqueCorps.length,
      scannedCompanies: Math.min(50, uniqueCorps.length),
      totalUniqueReprors: allReprors.length,
      npsRelated,
      allReprorsSample: allReprors.slice(0, 30),
    });
  }

  // 기본 모드: 첫 회사의 majorstock 샘플
  const sample = list[0];
  let majorstock = null;
  if (sample) {
    const msUrl = `https://opendart.fss.or.kr/api/majorstock.json?crtfc_key=${API_KEY}&corp_code=${sample.corp_code}`;
    const msResp = await fetch(msUrl);
    majorstock = await msResp.json();
  }

  return res.status(200).json({
    listStatus: listData.status,
    listMessage: listData.message,
    listCount: list.length,
    listFirst5: list.slice(0, 5),
    sampleCorp: sample,
    sampleMajorstockStatus: majorstock?.status,
    sampleMajorstockFirst: majorstock?.list?.[0],
    sampleMajorstockKeys: majorstock?.list?.[0] ? Object.keys(majorstock.list[0]) : null,
    sampleMajorstockReprors: (majorstock?.list || []).map((x) => x.repror).slice(0, 10),
  });
}
