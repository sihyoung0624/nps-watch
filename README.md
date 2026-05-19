# NPS Watch — 국민연금 5% 공시 모니터

지인 공유용 국민연금공단 대량보유 공시 알림 웹페이지.

- 데이터: 금융감독원 전자공시시스템(DART) OpenAPI
- 호스팅: Vercel (무료)
- 갱신: 10분 간격 캐싱

---

## 🔧 로컬에서 테스트 (선택사항)

```powershell
# 1. Vercel CLI 설치 (한 번만)
npm i -g vercel

# 2. 로그인
vercel login

# 3. 프로젝트 디렉터리로 이동 후 .env 파일 만들기
# .env.example 파일을 .env로 복사하고 실제 API 키 붙여넣기

# 4. 로컬 실행
vercel dev

# → http://localhost:3000 에서 동작 확인
```

---

## 🚀 배포 (Vercel)

### A. CLI로 한 번에 배포 (권장)

```powershell
# 처음 한 번만: 프로젝트 연결
vercel

# 환경변수 등록
vercel env add OPENDART_API_KEY
# → "Production" 선택 → 키 붙여넣기 → Enter

# 프로덕션 배포
vercel --prod
```

배포 완료 시 `https://nps-watch-xxx.vercel.app` 같은 URL이 출력됩니다.
이 URL을 친구들에게 카톡으로 공유하면 끝.

### B. GitHub + Vercel 대시보드 (GUI)

1. GitHub에 새 저장소 생성 → 이 폴더 파일들 업로드 (`.env` 제외!)
2. https://vercel.com/new → 저장소 import
3. Settings → Environment Variables 에서 `OPENDART_API_KEY` 추가
4. Deploy 클릭

---

## 🔑 환경변수

| 변수 | 설명 | 필수 |
|---|---|---|
| `OPENDART_API_KEY` | OpenDART에서 발급받은 40자리 인증키 | ✅ |

---

## 📁 파일 구조

```
.
├── index.html               # 프론트엔드 (Apple 디자인)
├── api/
│   └── disclosures.js       # OpenDART 호출 서버리스 함수
├── package.json
├── vercel.json              # Vercel 설정 (캐싱·CORS)
├── .gitignore               # .env 보호
├── .env.example             # 로컬 개발용 템플릿
└── README.md
```

---

## ⚠️ 주의사항

- `.env` 파일은 절대 Git/GitHub에 올리지 마세요 (`.gitignore`로 자동 제외됨)
- OpenDART API 일일 한도: 20,000건 (현재 캐싱으로 충분히 여유)
- 본 서비스는 정보 제공 목적이며 투자 권유가 아닙니다
- 데이터 출처: 금융감독원 전자공시시스템(DART)
