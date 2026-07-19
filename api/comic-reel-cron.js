// api/comic-reel-cron.js — 탑뱅커 취준생 만화 '릴스판' 자동 발행 (계정2 top_career_)
//   · 매주 화 21:00 KST (vercel.json: 0 12 * * 2), 1주 1편, 회차 번호 순서(1→18)
//   · 영상: 레포 /comic-reels/ep<no>.mp4 (9:16 세로, 정적 호스팅)
//   · 발행 직후 첫 댓글 자동 등록 시도(권한 없으면 무시)
//   · 진도: Blob comic-reel-progress.json {index}. 회차 소진 시 done 가드
//
// 환경변수: IG_USER_ID_2, IG_ACCESS_TOKEN_2, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 미리보기: ?pkey=<PREVIEW_KEY>&ep=N&dryrun=1  (발행 안 함)

const EPS = require('./comic-reels-data.js');
const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const BASE = 'https://instagram-three-wheat.vercel.app';
const CARDS_PATH = '/comic-reels';
const PROGRESS_KEY = 'comic-reel-progress.json';
const PREVIEW_KEY = 'cmr-p8k3v6z2';
const NOT_BEFORE = Date.parse('2026-07-20T15:00:00Z'); // 2026-07-21(화) 00:00 KST — 첫 발행 7/21 밤 9시

async function readProgress() {
  try {
    const { blobs } = await list({ prefix: PROGRESS_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (blobs && blobs.length) { const r = await fetch(blobs[0].url + '?t=' + Date.now()); if (r.ok) return await r.json(); }
  } catch (e) {}
  return { index: 0 };
}
async function writeProgress(o) {
  try { await put(PROGRESS_KEY, JSON.stringify(o), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN }); } catch (e) {}
}

async function publishReel(IG, TOKEN, videoUrl, caption) {
  const rC = await fetch(`${GRAPH}/${IG}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption: caption || '', thumb_offset: 1000, access_token: TOKEN }) });
  const jC = await rC.json();
  if (!rC.ok || !jC.id) throw new Error('릴스 컨테이너 실패: ' + JSON.stringify(jC.error || jC));
  let status = '';
  for (let i = 0; i < 90; i++) {
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
async function tryFirstComment(mediaId, TOKEN, message) {
  if (!message) return { tried: false };
  try {
    const r = await fetch(`${GRAPH}/${mediaId}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, access_token: TOKEN }) });
    const j = await r.json().catch(() => ({}));
    return { tried: true, ok: !!(r.ok && j.id) };
  } catch (e) { return { tried: true, ok: false }; }
}

module.exports = async (req, res) => {
  const out = (s, p) => res.status(s).json(p);
  const q = req.query || {};
  const dryrun = q.dryrun === '1' || q.dryrun === 'true';

  const auth = req.headers['authorization'] || '';
  const manual = q.secret || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  const previewOk = q.pkey === PREVIEW_KEY && dryrun;
  if (!cronOk && !manualOk && !previewOk) return out(401, { ok: false, error: '인증 실패' });

  const IG = process.env.IG_USER_ID_2, TOKEN = process.env.IG_ACCESS_TOKEN_2;

  try {
    if (!EPS.length) return out(500, { ok: false, error: 'comic-reels 데이터가 없습니다.' });
    const forcedEp = parseInt(q.ep, 10);
    if (!dryrun && !forcedEp && Date.now() < NOT_BEFORE) return out(200, { ok: true, skipped: true, reason: '시작일(7/21) 이전' });

    const prog = await readProgress();
    let idx = prog.index || 0;
    if (idx >= EPS.length && !forcedEp) return out(200, { ok: true, done: true, reason: '등록된 릴스 모두 발행 완료 — 새 회차 대기' });
    if (forcedEp) { const fi = EPS.findIndex(e => e.no === forcedEp); if (fi === -1) return out(400, { ok: false, error: '없는 회차: ' + forcedEp }); idx = fi; }
    const item = EPS[idx];
    const videoUrl = `${BASE}${CARDS_PATH}/${item.file}`;

    if (dryrun) {
      return out(200, { ok: true, dryrun: true, no: item.no, title: item.title, videoUrl,
        captionPreview: String(item.caption).slice(0, 160) + ' …', firstComment: item.firstComment || null,
        index: idx, total: EPS.length });
    }

    if (!IG || !TOKEN) return out(500, { ok: false, error: '2번 계정 환경변수(IG_USER_ID_2/IG_ACCESS_TOKEN_2)가 없습니다.' });
    const mediaId = await publishReel(IG, TOKEN, videoUrl, item.caption);
    const comment = await tryFirstComment(mediaId, TOKEN, item.firstComment);

    if (!forcedEp) {
      prog.index = idx + 1;
      prog.lastPublished = { no: item.no, title: item.title, mediaId, at: new Date().toISOString() };
      await writeProgress(prog);
    }
    return out(200, { ok: true, published: true, no: item.no, title: item.title, mediaId, firstComment: comment, nextIndex: prog.index });
  } catch (err) {
    return out(500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
