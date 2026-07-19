// api/promo-publish.js — 금공채 홍보 릴스 1회 발행(계정1 topbanker99) — 댓글→DM 테스트용
//   GET ?pkey=<PKEY>        → 미리보기(발행 안 함, 캡션/영상 확인)
//   GET ?pkey=<PKEY>&go=1   → 실제 발행 (1회 가드: 이미 발행됐으면 막음)
//   GET ?pkey=<PKEY>&go=1&force=1 → 가드 무시하고 재발행
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, BLOB_READ_WRITE_TOKEN

const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const BASE = 'https://instagram-three-wheat.vercel.app';
const VIDEO = BASE + '/reel-assets/gonggongchae-promo.mp4';
const PKEY = 'promo-9x4k2v';
const DONE_KEY = 'promo-publish-done.json';

const CAPTION =
`🏦 2026 금융권 공동채용박람회 현장면접, 이렇게 준비하세요

현장에서 뭘 묻고 어떻게 답해야 붙는지, 현직 컨설턴트가 완전정리한 자료를 무료로 드려요 📎

💬 이 게시물 댓글에 "금공채" 를 남겨주세요 → 자료를 DM으로 바로 보내드립니다!

은행·금융공기업 준비생이라면 꼭 챙기세요. 합격까지, 탑뱅커가 함께합니다 🙌

#금융권취업 #은행취업 #금융공기업 #공동채용박람회 #금공채 #은행면접 #금융권면접 #신입행원 #취업준비 #탑뱅커 #금융권자소서 #은행자소서 #하반기공채 #금융공기업면접 #취준생`;

async function alreadyDone() {
  try { const { blobs } = await list({ prefix: DONE_KEY, token: process.env.BLOB_READ_WRITE_TOKEN }); return !!(blobs && blobs.length); } catch (e) { return false; }
}
async function markDone(o) {
  try { await put(DONE_KEY, JSON.stringify(o), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN }); } catch (e) {}
}

async function publishReel(IG, TOKEN, videoUrl, caption) {
  const rC = await fetch(`${GRAPH}/${IG}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption: caption || '', thumb_offset: 1000, access_token: TOKEN }) });
  const jC = await rC.json();
  if (!rC.ok || !jC.id) throw new Error('릴스 컨테이너 실패: ' + JSON.stringify(jC.error || jC));
  let status = '';
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const rs = await fetch(`${GRAPH}/${jC.id}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`);
    const js = await rs.json(); status = js.status_code || '';
    if (status === 'FINISHED') break; if (status === 'ERROR') throw new Error('영상 처리 ERROR');
  }
  if (status !== 'FINISHED') throw new Error('영상 처리 시간초과');
  const rP = await fetch(`${GRAPH}/${IG}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: jC.id, access_token: TOKEN }) });
  const jP = await rP.json();
  if (!rP.ok || !jP.id) throw new Error('발행 실패: ' + JSON.stringify(jP.error || jP));
  return jP.id;
}

module.exports = async (req, res) => {
  const out = (s, p) => res.status(s).json(p);
  const q = req.query || {};
  if (q.pkey !== PKEY) return out(401, { ok: false, error: '인증 실패' });

  const go = q.go === '1' || q.go === 'true';
  if (!go) {
    return out(200, { ok: true, preview: true, account: 'topbanker99(계정1)', video: VIDEO, caption: CAPTION,
      note: '실제 발행하려면 URL 끝에 &go=1 을 붙이세요.' });
  }

  const IG = process.env.IG_USER_ID, TOKEN = process.env.IG_ACCESS_TOKEN;
  if (!IG || !TOKEN) return out(500, { ok: false, error: 'IG_USER_ID / IG_ACCESS_TOKEN 환경변수가 없습니다.' });

  const force = q.force === '1' || q.force === 'true';
  if (!force && await alreadyDone()) return out(200, { ok: true, skipped: true, reason: '이미 발행됨 — 재발행하려면 &force=1' });

  try {
    const mediaId = await publishReel(IG, TOKEN, VIDEO, CAPTION);
    await markDone({ mediaId, at: new Date().toISOString() });
    return out(200, { ok: true, published: true, account: 'topbanker99(계정1)', mediaId });
  } catch (err) {
    return out(500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
