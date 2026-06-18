// api/instagram-reel.js
// 업로드된 영상(공개 URL)을 인스타그램 릴스로 발행합니다.
//
// 호출 (POST, JSON): 헤더 x-publish-secret, 본문 { videoUrl, caption }
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, PUBLISH_SECRET

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
function sendJson(res, status, payload) { res.status(status).json(payload); }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-publish-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST 요청만 허용됩니다.' }); return; }

  const provided = req.headers['x-publish-secret'] || (req.query && req.query.key);
  if (!process.env.PUBLISH_SECRET || provided !== process.env.PUBLISH_SECRET) {
    sendJson(res, 401, { ok: false, error: '인증 실패: 올바른 비밀키가 필요합니다.' }); return;
  }
  const IG_USER_ID = process.env.IG_USER_ID;
  const TOKEN = process.env.IG_ACCESS_TOKEN;
  if (!IG_USER_ID || !TOKEN) { sendJson(res, 500, { ok: false, error: '서버 설정 오류: IG_USER_ID 또는 IG_ACCESS_TOKEN 환경변수가 없습니다.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const caption = (body.caption == null ? '' : String(body.caption));
  const videoUrl = body.videoUrl;
  if (!videoUrl) { sendJson(res, 400, { ok: false, error: '영상 주소(videoUrl)가 없습니다.' }); return; }

  try {
    // 1) 릴스 컨테이너 생성
    const rC = await fetch(`${GRAPH}/${IG_USER_ID}/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption: caption, access_token: TOKEN })
    });
    const jC = await rC.json();
    if (!rC.ok || !jC.id) { sendJson(res, 502, { ok: false, step: '릴스 컨테이너 생성', error: (jC && jC.error) ? jC.error : jC }); return; }
    const creationId = jC.id;

    // 2) 처리 상태 폴링 (릴스는 처리에 시간이 걸림)
    let statusCode = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(function (r) { setTimeout(r, 2500); });
      const rs = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`);
      const js = await rs.json();
      statusCode = js.status_code || '';
      if (statusCode === 'FINISHED') break;
      if (statusCode === 'ERROR') { sendJson(res, 502, { ok: false, step: '영상 처리', error: '인스타그램이 영상 처리에 실패했습니다(ERROR). 영상 형식·길이를 확인하세요.' }); return; }
    }
    if (statusCode !== 'FINISHED') { sendJson(res, 504, { ok: false, step: '영상 처리', error: '처리 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.' }); return; }

    // 3) 발행
    const rP = await fetch(`${GRAPH}/${IG_USER_ID}/media_publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: creationId, access_token: TOKEN })
    });
    const jP = await rP.json();
    if (!rP.ok || !jP.id) { sendJson(res, 502, { ok: false, step: '발행', error: (jP && jP.error) ? jP.error : jP }); return; }

    sendJson(res, 200, { ok: true, mediaId: jP.id });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
