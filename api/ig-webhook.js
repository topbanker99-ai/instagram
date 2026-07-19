// api/ig-webhook.js — 인스타 댓글 → 자동 DM(비공개 답장) 웹훅 (계정1 topbanker99)
//   · GET  : Meta 웹훅 검증 (hub.verify_token 확인 → hub.challenge 반환)
//   · GET ?peek=<PEEK_KEY> : 최근 웹훅 수신·DM 발송 진단 로그 확인(발행 안 함)
//   · POST : 댓글 이벤트 수신 → 댓글에 키워드(기본 '금공채') 포함 시,
//            그 댓글 작성자에게 비공개 답장(DM)으로 자료 링크 자동 발송
//
// Instagram 비공개 답장(Private Reply) 요건(Meta 문서):
//   - 인스타 프로페셔널 계정
//   - 권한: instagram_business_manage_comments (Advanced Access → App Review 필요)
//   - 웹훅: comments 필드 구독, 개발 모드에선 앱 역할(테스터/관리자) 계정만 동작
//   - 댓글 후 7일 이내, 댓글당 1회만 발송 가능
//
// 환경변수: IG_USER_ID, IG_DM_TOKEN(또는 IG_ACCESS_TOKEN),
//           IG_WEBHOOK_VERIFY_TOKEN(웹훅 검증 문자열), DM_KEYWORD, DM_REPLY_TEXT, DM_PDF_URL,
//           BLOB_READ_WRITE_TOKEN(진단 로그 저장용)

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PEEK_KEY = 'wh-peek-7q2';
const DEBUG_KEY = 'ig-webhook-debug.json';

let _blob = null;
function blob() { if (!_blob) { try { _blob = require('./blob-bundle.js'); } catch (e) { _blob = {}; } } return _blob; }

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) { resolve(typeof req.body === 'string' ? safeParse(req.body) : req.body); return; }
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(safeParse(d)));
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

async function readDebug() {
  try {
    const { list } = blob(); if (!list) return [];
    const { blobs } = await list({ prefix: DEBUG_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (blobs && blobs.length) { const r = await fetch(blobs[0].url + '?t=' + Date.now()); if (r.ok) { const a = await r.json(); return Array.isArray(a) ? a : []; } }
  } catch (e) {}
  return [];
}
async function writeDebug(rec) {
  try {
    const { put } = blob(); if (!put) return;
    const arr = await readDebug(); arr.unshift(rec); const trimmed = arr.slice(0, 15);
    await put(DEBUG_KEY, JSON.stringify(trimmed), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (e) {}
}

async function sendPrivateReply(IG, TOKEN, commentId, text) {
  const r = await fetch(`${GRAPH}/${IG}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text }, access_token: TOKEN }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!(r.ok && (j.message_id || j.recipient_id || j.id)), status: r.status, detail: j };
}

module.exports = async (req, res) => {
  // ── GET: 검증 또는 진단 확인 ──
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.peek === PEEK_KEY) {
      const log = await readDebug();
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, count: log.length, log }, null, 2));
    }
    const mode = q['hub.mode'], token = q['hub.verify_token'], challenge = q['hub.challenge'];
    const VERIFY = process.env.IG_WEBHOOK_VERIFY_TOKEN || 'topbanker_gonggong_2026';
    if (mode === 'subscribe' && token && token === VERIFY) {
      res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end(String(challenge || ''));
    }
    res.statusCode = 403; return res.end('forbidden');
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end('method not allowed'); }

  // Meta는 200을 빠르게 받아야 재시도를 멈춤 → 먼저 응답하고 처리
  const body = await readBody(req);
  res.statusCode = 200; res.end('EVENT_RECEIVED');

  const dbg = { at: new Date().toISOString(), fields: [], actions: [] };
  try {
    const IG = process.env.IG_USER_ID;
    const TOKEN = process.env.IG_DM_TOKEN || process.env.IG_ACCESS_TOKEN;
    const usingToken = process.env.IG_DM_TOKEN ? 'IG_DM_TOKEN' : (process.env.IG_ACCESS_TOKEN ? 'IG_ACCESS_TOKEN' : 'NONE');
    const KEYWORD = (process.env.DM_KEYWORD || '금공채').trim();
    const PDF = process.env.DM_PDF_URL || 'https://instagram-three-wheat.vercel.app/reel-assets/gonggongchae-2026.pdf';
    const REPLY = process.env.DM_REPLY_TEXT ||
      ('안녕하세요! 요청 주신 2026 금융권 공동채용박람회 현장면접 완전정리 자료 보내드려요 📎\n\n' +
       PDF + '\n\n' +
       '위 링크에서 바로 받으실 수 있어요. 도움이 되면 게시물 저장해두시고, 면접 준비하다 궁금한 점 생기면 편하게 DM 주세요. 합격 응원합니다! 🙌');

    dbg.env = { hasIG: !!IG, usingToken, keyword: KEYWORD };
    if (!IG || !TOKEN) { dbg.actions.push('환경변수 없음 → 중단'); await writeDebug(dbg); return; }

    for (const entry of (body.entry || [])) {
      for (const ch of (entry.changes || [])) {
        dbg.fields.push(ch.field);
        if (ch.field !== 'comments') continue;
        const v = ch.value || {};
        const text = String(v.text || '');
        const commentId = v.id;
        const fromId = (v.from && v.from.id) || '';
        const fromName = (v.from && v.from.username) || '';
        const rec = { text, from: fromName || fromId, commentId };
        if (!commentId) { rec.skip = 'commentId 없음'; dbg.actions.push(rec); continue; }
        if (fromId && String(fromId) === String(IG)) { rec.skip = '게시물 주인 본인 댓글'; dbg.actions.push(rec); continue; }
        if (!text.includes(KEYWORD)) { rec.skip = `키워드('${KEYWORD}') 불포함`; dbg.actions.push(rec); continue; }
        const dm = await sendPrivateReply(IG, TOKEN, commentId, REPLY);
        rec.dm = { ok: dm.ok, status: dm.status, detail: dm.detail };
        dbg.actions.push(rec);
      }
    }
    if (!dbg.actions.length && !dbg.fields.length) dbg.actions.push('처리할 comments 이벤트 없음');
    await writeDebug(dbg);
  } catch (e) {
    dbg.error = String((e && e.message) || e);
    await writeDebug(dbg);
  }
};
