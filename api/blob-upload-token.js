// api/blob-upload-token.js
// 브라우저가 Blob에 직접(대용량) 업로드할 수 있도록 클라이언트 토큰을 발급합니다.
// @vercel/blob/client 의 handleUpload 사용. (같은 폴더의 blob-client-node.js 번들)
//
// 필요한 환경변수: PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
//   ※ BLOB_READ_WRITE_TOKEN 은 Blob 저장소의 ".env.local" 탭에 있는 값을 등록해야 합니다.

const { handleUpload } = require('./blob-client-node.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST 요청만 허용됩니다.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  try {
    const jsonResponse = await handleUpload({
      body: body,
      request: req,
      onBeforeGenerateToken: async function (pathname, clientPayload) {
        let payload = {};
        try { payload = JSON.parse(clientPayload || '{}'); } catch (e) {}
        if (!process.env.PUBLISH_SECRET || payload.secret !== process.env.PUBLISH_SECRET) {
          throw new Error('인증 실패: 올바른 비밀키가 필요합니다.');
        }
        return {
          allowedContentTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
          maximumSizeInBytes: 300 * 1024 * 1024,
          addRandomSuffix: true
        };
      }
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: (err && err.message) ? err.message : String(err) });
  }
};
