// api/instagram-publish.js
// 탑뱅커 인스타그램 카드뉴스 자동 발행 엔드포인트
//
// 이미지 업로드는 같은 폴더의 blob-bundle.js(=@vercel/blob 번들)를 사용합니다.
// 따라서 Vercel에서 npm install이 되지 않아도 정상 작동합니다.
//
// 동작:
//   1) base64 이미지를 Vercel Blob(public)에 업로드 → 공개 URL 생성
//   2) 그 URL들로 인스타그램 캐러셀 발행
//
// 환경변수:
//   IG_USER_ID, IG_ACCESS_TOKEN, PUBLISH_SECRET (필수)
//   BLOB_STORE_ID (자동, OIDC 인증) — 또는 BLOB_READ_WRITE_TOKEN (있으면 우선 사용)

const { put } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-publish-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST 요청만 허용됩니다.' });
    return;
  }

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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const caption = (body.caption == null ? '' : String(body.caption));
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.slice() : [];
  const images = Array.isArray(body.images) ? body.images : [];

  try {
    // 1) base64 이미지 → Blob 업로드
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
          token: process.env.BLOB_READ_WRITE_TOKEN, // 없으면 자동(OIDC) 인증
        });
        imageUrls.push(blob.url);
      }
    }

    if (imageUrls.length < 2 || imageUrls.length > 10) {
      sendJson(res, 400, { ok: false, error: `인스타그램 캐러셀은 이미지 2~10장이 필요합니다. (현재 ${imageUrls.length}장)` });
      return;
    }

    // 2) 자식 컨테이너
    const childIds = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const r = await fetch(`${GRAPH}/${IG_USER_ID}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: url, is_carousel_item: true, access_token: TOKEN }),
      });
      const j = await r.json();
      if (!r.ok || !j.id) {
        sendJson(res, 502, { ok: false, step: `자식 컨테이너 생성(${i + 1}번째)`, error: (j && j.error) ? j.error : j, imageUrl: url });
        return;
      }
      childIds.push(j.id);
    }

    // 3) 부모(캐러셀) 컨테이너
    const rParent = await fetch(`${GRAPH}/${IG_USER_ID}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_type: 'CAROUSEL', children: childIds.join(','), caption: caption, access_token: TOKEN }),
    });
    const jParent = await rParent.json();
    if (!rParent.ok || !jParent.id) {
      sendJson(res, 502, { ok: false, step: '캐러셀 컨테이너 생성', error: (jParent && jParent.error) ? jParent.error : jParent });
      return;
    }
    const creationId = jParent.id;

    // 4) 처리 상태 폴링
    let statusCode = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const rs = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`);
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

    // 5) 발행
    const rPub = await fetch(`${GRAPH}/${IG_USER_ID}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: creationId, access_token: TOKEN }),
    });
    const jPub = await rPub.json();
    if (!rPub.ok || !jPub.id) {
      sendJson(res, 502, { ok: false, step: '발행', error: (jPub && jPub.error) ? jPub.error : jPub });
      return;
    }

    sendJson(res, 200, { ok: true, mediaId: jPub.id, count: imageUrls.length, imageUrls: imageUrls });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
