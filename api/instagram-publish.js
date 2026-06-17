// api/instagram-publish.js
// 탑뱅커 인스타그램 카드뉴스 자동 발행 엔드포인트
//
// 동작:
//   1) base64 이미지를 받아 Vercel Blob(public)에 업로드 → 공개 URL 생성
//   2) 그 URL들로 인스타그램 캐러셀(여러 장) 발행
//
// 필요한 환경변수 (Vercel 프로젝트에 이미 등록됨):
//   IG_USER_ID        : 인스타그램 사용자 ID
//   IG_ACCESS_TOKEN   : 장기 액세스 토큰
//   PUBLISH_SECRET    : 이 엔드포인트 호출용 비밀키
//   BLOB_STORE_ID     : Blob 저장소 ID (OIDC 인증, VERCEL_OIDC_TOKEN과 함께 자동 사용)
//   (OIDC가 동작하지 않는 경우에만 BLOB_READ_WRITE_TOKEN을 추가하면 됨)
//
// 호출 방법 (POST, JSON):
//   헤더 : x-publish-secret: <PUBLISH_SECRET>
//   본문 : {
//            "caption": "본문 내용",
//            "images":  [ { "filename": "01.jpg", "data": "data:image/jpeg;base64,..." }, ... ]   // 2~10장
//          }
//   (이미 공개 URL이 있다면 images 대신 "imageUrls": ["https://...", ...] 도 가능)

const { put } = require('@vercel/blob');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

module.exports = async (req, res) => {
  // --- CORS (발행 페이지에서 호출 허용) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-publish-secret');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST 요청만 허용됩니다.' });
    return;
  }

  // --- 인증 ---
  const provided = req.headers['x-publish-secret'] || (req.query && req.query.key);
  if (!process.env.PUBLISH_SECRET || provided !== process.env.PUBLISH_SECRET) {
    sendJson(res, 401, { ok: false, error: '인증 실패: 올바른 비밀키가 필요합니다.' });
    return;
  }

  const IG_USER_ID = process.env.IG_USER_ID;
  const TOKEN = process.env.IG_ACCESS_TOKEN;
  if (!IG_USER_ID || !TOKEN) {
    sendJson(res, 500, { ok: false, error: '서버 설정 오류: IG_USER_ID 또는 IG_ACCESS_TOKEN 환경변수가 없습니다.' });
    return;
  }

  // --- 본문 파싱 ---
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const caption = (body.caption == null ? '' : String(body.caption));
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.slice() : [];
  const images = Array.isArray(body.images) ? body.images : [];

  try {
    // --- 1) base64 이미지 → Blob 업로드 ---
    if (images.length > 0) {
      const folder = `carousel/${Date.now()}`;
      for (let i = 0; i < images.length; i++) {
        const img = images[i] || {};
        const raw = String(img.data || '');
        const base64 = raw.includes(',') ? raw.split(',')[1] : raw;
        if (!base64) {
          sendJson(res, 400, { ok: false, error: `${i + 1}번째 이미지 데이터가 비어 있습니다.` });
          return;
        }
        const buffer = Buffer.from(base64, 'base64');

        const nameExt = (img.filename && String(img.filename).includes('.'))
          ? String(img.filename).split('.').pop().toLowerCase()
          : 'jpg';
        const ext = ['jpg', 'jpeg', 'png'].includes(nameExt) ? nameExt : 'jpg';
        const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
        const pathname = `${folder}/${String(i + 1).padStart(2, '0')}.${ext}`;

        const blob = await put(pathname, buffer, {
          access: 'public',
          contentType: contentType,
          addRandomSuffix: true,
        });
        imageUrls.push(blob.url);
      }
    }

    // --- 검증: 캐러셀은 2~10장 ---
    if (imageUrls.length < 2 || imageUrls.length > 10) {
      sendJson(res, 400, {
        ok: false,
        error: `인스타그램 캐러셀은 이미지 2~10장이 필요합니다. (현재 ${imageUrls.length}장)`,
      });
      return;
    }

    // --- 2) 자식 컨테이너 생성 (각 이미지) ---
    const childIds = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const r = await fetch(`${GRAPH}/${IG_USER_ID}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: url,
          is_carousel_item: true,
          access_token: TOKEN,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.id) {
        sendJson(res, 502, {
          ok: false,
          step: `자식 컨테이너 생성(${i + 1}번째)`,
          error: (j && j.error) ? j.error : j,
          imageUrl: url,
        });
        return;
      }
      childIds.push(j.id);
    }

    // --- 3) 부모(캐러셀) 컨테이너 생성 ---
    const rParent = await fetch(`${GRAPH}/${IG_USER_ID}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption: caption,
        access_token: TOKEN,
      }),
    });
    const jParent = await rParent.json();
    if (!rParent.ok || !jParent.id) {
      sendJson(res, 502, {
        ok: false,
        step: '캐러셀 컨테이너 생성',
        error: (jParent && jParent.error) ? jParent.error : jParent,
      });
      return;
    }
    const creationId = jParent.id;

    // --- 4) 컨테이너 처리 상태 폴링 (최대 약 60초) ---
    let statusCode = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const rs = await fetch(
        `${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`
      );
      const js = await rs.json();
      statusCode = js.status_code || '';
      if (statusCode === 'FINISHED') break;
      if (statusCode === 'ERROR') {
        sendJson(res, 502, { ok: false, step: '미디어 처리', error: '인스타그램이 미디어 처리에 실패했습니다(ERROR).' });
        return;
      }
    }
    if (statusCode !== 'FINISHED') {
      sendJson(res, 504, { ok: false, step: '미디어 처리', error: '처리 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }

    // --- 5) 발행 ---
    const rPub = await fetch(`${GRAPH}/${IG_USER_ID}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: creationId,
        access_token: TOKEN,
      }),
    });
    const jPub = await rPub.json();
    if (!rPub.ok || !jPub.id) {
      sendJson(res, 502, {
        ok: false,
        step: '발행',
        error: (jPub && jPub.error) ? jPub.error : jPub,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      mediaId: jPub.id,
      count: imageUrls.length,
      imageUrls: imageUrls,
    });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
