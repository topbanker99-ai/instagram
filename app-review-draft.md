# 탑뱅커 인스타그램 앱 검수(App Review) 신청서 초안

앱: topbanker-publisher (App ID 3940999346205894 / Instagram 앱 1024266756749932)
운영 주체: 탑뱅커평생교육시설
용도: 취업 준비생 대상 교육 콘텐츠 인스타그램 자동 발행 및 댓글 자동응답

신청 권한 3종:
- instagram_business_basic
- instagram_business_manage_comments
- instagram_business_manage_messages

---

## 0. 앱 전체 소개 (App Review 첫 화면 "앱이 하는 일" 설명용 — 영문/국문)

**국문**
탑뱅커평생교육시설이 운영하는 인스타그램 비즈니스 계정(@topbanker99)에서, 은행·금융권 취업 준비생을 위한 교육 콘텐츠(면접 자료, 자기소개서 가이드 등)를 자동으로 발행하고, 게시물에 특정 키워드(예: "금공채") 댓글을 남긴 이용자에게 요청한 학습 자료 링크를 자동 답장(다이렉트 메시지)으로 제공합니다. 모든 데이터는 자사 계정 운영 목적으로만 사용하며 제3자에게 판매하지 않습니다.

**영문 (검수관용)**
This app is operated by TOP BANKER (탑뱅커평생교육시설), a registered education service business. It publishes career-prep educational content on our own Instagram Business account (@topbanker99) and, when a user comments a specific keyword (e.g. "금공채") on our post, automatically sends that user the requested study material link via a private reply (DM). Data is used solely to operate our own account and is never sold to third parties.

---

## 1. instagram_business_basic

**사용 이유 (국문)**
앱이 운영 계정(@topbanker99)의 프로필·미디어 기본 정보를 읽어 콘텐츠 발행과 댓글/메시지 처리의 대상 계정을 식별하기 위해 필요합니다.

**Why we need it (영문)**
Required to read basic profile and media information of our own Instagram Business account so the app can identify the target account for publishing and for comment/message handling.

---

## 2. instagram_business_manage_comments

**사용 이유 (국문)**
게시물에 달린 댓글을 웹훅으로 수신하여, 특정 키워드가 포함된 댓글을 감지하고 공개 답글을 남기기 위해 필요합니다. 이는 이용자가 자료를 요청하는 방식(댓글에 키워드 입력)의 핵심 트리거입니다.

**Why we need it (영문)**
Required to receive comment webhooks on our media, detect comments containing a specific keyword, and post a public reply. This is the core trigger by which a user requests our study material (by commenting the keyword).

---

## 3. instagram_business_manage_messages

**사용 이유 (국문)**
키워드 댓글을 남긴 이용자에게 요청한 자료 링크를 비공개 답장(Private Reply, DM)으로 자동 발송하기 위해 필요합니다. 이용자가 먼저 명시적으로 자료를 요청(키워드 댓글)한 경우에 한해 1회 발송합니다.

**Why we need it (영문)**
Required to send the requested material link to the user via a private reply (DM) after they explicitly request it by commenting the keyword. A single reply is sent only in response to the user's own request.

---

## 4. 검수관 시연 단계 (Step-by-step instructions for reviewer, 영문 권장)

1. Go to our Instagram Business account @topbanker99 and open the pinned/most recent Reel about the "금공채" (finance job fair) study material.
2. On that Reel, post a comment containing the keyword: **금공채**
3. Within about a minute, the app posts a public reply under your comment (e.g. "DM 확인해주세요! 📩").
4. The app then sends you a private reply (DM). Open the account's Direct Messages to see it.
5. The DM contains the requested study material link:
   `https://instagram-three-wheat.vercel.app/gonggongchae-2026.pdf`
6. Open the link to confirm the study material (PDF) loads.

Notes for reviewer:
- The DM is sent only because the commenter explicitly requested the material by commenting the keyword.
- No unsolicited messages are sent; one reply per requesting comment.

---

## 5. 녹화(스크린캐스트) 스크립트 — 시연 영상 촬영용

화면 녹화로 아래 흐름을 1~2분 안에 보여주세요 (검수 필수 제출물):

1. @topbanker99 프로필 → 금공채 홍보 릴스 진입 (앱이 발행한 게시물임을 보여줌)
2. 검수용/테스트 계정으로 그 릴스에 **"금공채"** 댓글 입력하는 장면
3. 잠시 후 댓글 아래 **공개 답글**이 자동으로 달리는 장면
4. 그 계정의 **DM 메시지함**을 열어 자동 도착한 자료 링크 메시지 보여주기
5. 링크를 눌러 **PDF 자료가 열리는** 장면
6. (권장) 화면에 개인정보처리방침 페이지(`/privacy.html`)를 잠깐 보여주며 데이터 사용·삭제 안내가 있음을 확인

팁: 실제 키워드 댓글 → 공개답글 → DM → 링크 열림, 이 4개가 한 영상에 끊김 없이 담기면 통과율이 높습니다.

---

## 6. 진행 순서 요약

1. (완료) 개인정보처리방침 URL·데이터 삭제 URL·카테고리 등록
2. 비즈니스 인증(Business Verification) — 사업자등록증 업로드, 심사 며칠
3. 앱 검수 제출 — 위 1~5 내용 입력 + 시연 영상 업로드
4. 검수 통과 후 앱 "라이브" 전환 → 실제 이용자에게 댓글→DM 작동

주의: 검수 시연을 하려면 앱이 실제로 그 기능을 수행할 수 있어야 하므로, 자체 웹훅(/api/ig-webhook)을 다시 켜고 테스트 계정을 앱 테스터로 등록한 상태에서 영상을 촬영하는 것이 좋습니다.
