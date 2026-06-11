# 쿠핫 중앙 서버

이 서버는 일반 사용자 앱이 접속하는 공개 API입니다.
PC 수집기/업로더가 `/ingest/snaps`로 상품 가격을 올리고, 앱은 `/deals`에서 딜 목록을 읽습니다.

## 환경변수

- `KUHOT_INGEST_KEY`: PC 업로더 전용 업로드 키. 반드시 긴 랜덤 문자열로 변경.
- `DATABASE_URL`: PostgreSQL 연결 문자열.
- `PORT`: 기본 3000.
- `KUHOT_READ_KEY`: 선택. 비워두면 앱 피드는 공개.

## 로컬 테스트

```bash
npm install
set KUHOT_INGEST_KEY=dev-key
npm start
```

로컬에서 `DATABASE_URL`이 없으면 메모리 DB로만 동작합니다. 운영은 PostgreSQL을 쓰세요.
