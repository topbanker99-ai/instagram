// ============================================================
//  Vercel 서버리스 함수: 인스타그램 카드뉴스 캐러셀 자동 발행
//  엔드포인트: POST /api/instagram-publish
//  계정: topbanker99 (Instagram Login API, graph.instagram.com)
//
//  필요한 환경변수 (Vercel > Settings > Environment Variables):
//    IG_USER_ID        인스타 계정 ID (예: 17841405540256066)
//    IG_ACCESS_TOKEN   장기 액세스 토큰 (절대 코드에 직접 쓰지 말 것)
//    PUBLISH_SECRET    아무나 발행 못 하게 막는 비밀 키 (직접 만든 긴 랜덤 문자열)
//
//  호출 방법:
//    POST  /api/instagram-publish?key=<PUBLISH_SECRET값>
//    헤더:  Content-Type: application/json
//    본문:  { "imageUrls": ["url1","url2", ...], "caption": "본문 #해시태그" }
//    (imageUrls는 공개 접근 가능한 JPEG URL 2~10개)
// ============================================================

const API_VERSION = "v23.0"; // 버전 오류가 나면 변경 (예: v22.0, v24.0)
const BASE = `https://graph.instagram.com/${API_VERSION}`;

async function igPost(path, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${BASE}/${path}`, { method: "POST", body });
  const data = await r.json();
  if (data.error) throw new Error(`${path}: ${JSON.stringify(data.error)}`);
  return data;
}

async function igGet(path, params, token) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${BASE}/${path}?${qs}`);
  const data = await r.json();
  if (data.error) throw new Error(`${path}: ${JSON.stringify(data.error)}`);
  return data;
}

async function waitUntilReady(containerId, token) {
  for (let i = 0; i < 30; i++) {
    const { status_code } = await igGet(containerId, { fields: "status_code" }, token);
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`컨테이너 처리 실패 (${status_code})`);
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("컨테이너 준비 시간 초과");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 허용됩니다." });
  }

  // --- 간단한 인증: 아무나 발행하지 못하게 막음 ---
  const secret = req.headers["x-publish-secret"] || (req.query && req.query.key);
  if (!process.env.PUBLISH_SECRET || secret !== process.env.PUBLISH_SECRET) {
    return res.status(401).json({ error: "인증 실패 (PUBLISH_SECRET 불일치)" });
  }

  const IG_USER_ID = process.env.IG_USER_ID;
  const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
  if (!IG_USER_ID || !ACCESS_TOKEN) {
    return res.status(500).json({ error: "환경변수 IG_USER_ID / IG_ACCESS_TOKEN 미설정" });
  }

  const { imageUrls, caption } = req.body || {};
  if (!Array.isArray(imageUrls) || imageUrls.length < 2 || imageUrls.length > 10) {
    return res
      .status(400)
      .json({ error: "imageUrls는 2~10개의 이미지 URL 배열이어야 합니다." });
  }

  try {
    // (1) 이미지마다 자식 컨테이너 생성
    const childIds = [];
    for (const url of imageUrls) {
      const { id } = await igPost(
        `${IG_USER_ID}/media`,
        { image_url: url, is_carousel_item: "true" },
        ACCESS_TOKEN
      );
      childIds.push(id);
    }

    // (2) 부모 캐러셀 컨테이너 생성
    const { id: carouselId } = await igPost(
      `${IG_USER_ID}/media`,
      { media_type: "CAROUSEL", children: childIds.join(","), caption: caption || "" },
      ACCESS_TOKEN
    );

    // (3) 처리 완료까지 대기
    await waitUntilReady(carouselId, ACCESS_TOKEN);

    // (4) 발행
    const { id: mediaId } = await igPost(
      `${IG_USER_ID}/media_publish`,
      { creation_id: carouselId },
      ACCESS_TOKEN
    );

    return res.status(200).json({ success: true, mediaId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
