// api/ig-webhook.js — 인스타 댓글 → 자동 DM(비공개 답장) 웹훅 (계정1 topbanker99)
//   · GET  : Meta 웹훅 검증 (hub.verify_token 확인 → hub.challenge 반환)
//   · POST : 댓글 이벤트 수신 → 댓글에 키워드(기본 '금공채') 포함 시,
//            그 댓글 작성자에게 비공개 답장(DM)으로 자료 링크 자동 발송
//
// Instagram 비공개 답장(Private Reply) 요건(Meta 문서):
//   - 인스타 프로페셔널 계정
//   - 권한: instagram_business_manage_comments (Advanced Access → App Review 필요)
//   - 웹훅: comments 필드 구독
//   - 댓글 후 7일 이내, 댓글당 1회만 발송 가능
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN(계정1, comments 관리 스코프 포함),
//           IG_WEBHOOK_VERIFY_TOKEN(웹훅 검증 문자열, 임의 지정),
//           DM_KEYWORD(기본 '금공채'), DM_REPLY_TEXT(보낼 메시지), DM_PDF_URL(자료 링크)
//   · (선택) 중복 방지용 Blob 로그 — BLOB_READ_WRITE_TOKEN 있으면 사용

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) { resolve(typeof req.body === 'string' ? safeParse(req.body) : req.body); return; }
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(safeParse(d)));
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

async function sendPrivateReply(IG, TOKEN, commentId, text) {
  const r = await fetch(`${GRAPH}/${IG}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text }, access_token: TOKEN }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!(r.ok && (j.message_id || j.recipient_id || j.id)), detail: j };
}

module.exports = async (req, res) => {
  // ── 웹훅 검증 (GET) ──
  if (req.method === 'GET') {
    const q = req.query || {};
    const mode = q['hub.mode'], token = q['hub.verify_token'], challenge = q['hub.challenge'];
    if (mode === 'subscribe' && token && token === process.env.IG_WEBHOOK_VERIFY_TOKEN) {
      res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end(String(challenge || ''));
    }
    res.statusCode = 403; return res.end('forbidden');
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end('method not allowed'); }

  // Meta는 200을 빠르게 받아야 재시도를 멈춤 → 먼저 응답하고 처리
  const body = await readBody(req);
  res.statusCode = 200; res.end('EVENT_RECEIVED');

  try {
    const IG = process.env.IG_USER_ID, TOKEN = process.env.IG_ACCESS_TOKEN;
    const KEYWORD = (process.env.DM_KEYWORD || '금공채').trim();
    const PDF = process.env.DM_PDF_URL || '';
    const REPLY = process.env.DM_REPLY_TEXT ||
      ('요청 주신 금공채 자료 보내드려요 📎\n' + (PDF ? PDF + '\n\n' : '') + '도움이 되면 저장·공유 부탁드려요! 궁금한 점은 편하게 DM 주세요.');
    if (!IG || !TOKEN) return;

    for (const entry of (body.entry || [])) {
      for (const ch of (entry.changes || [])) {
        if (ch.field !== 'comments') continue;
        const v = ch.value || {};
        const text = String(v.text || '');
        const commentId = v.id;
        const fromId = (v.from && v.from.id) || '';
        if (!commentId) continue;
        if (fromId && String(fromId) === String(IG)) continue;         // 내 댓글엔 반응 안 함
        if (!text.includes(KEYWORD)) continue;                          // 키워드 없으면 무시
        await sendPrivateReply(IG, TOKEN, commentId, REPLY);            // 비공개 답장(DM) 발송
      }
    }
  } catch (e) { /* 이미 200 응답함 — 로깅만 생략 */ }
};
