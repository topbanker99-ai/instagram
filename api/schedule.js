// api/schedule.js — 예약 발행 큐 (즉시 발행 앱의 예약 기능 백엔드)
//   action=add    : 예약 등록 (secret 인증)  {account,type,videoUrl,caption,publishAt}
//   action=list   : 예약 목록 (secret 인증)
//   action=cancel : 예약 취소 (secret 인증)  {id}
//   action=run    : 큐 점검·발행 (크론/secret) — 15분마다 vercel cron 호출
//
// 저장: Vercel Blob  schedule-queue.json  (배열)
// 발행 계정: account=1 → IG_USER_ID/IG_ACCESS_TOKEN, account=2 → IG_USER_ID_2/IG_ACCESS_TOKEN_2
// 환경변수: PUBLISH_SECRET, CRON_SECRET, IG_USER_ID(_2), IG_ACCESS_TOKEN(_2), BLOB_READ_WRITE_TOKEN

const { put, list, del } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const QUEUE_KEY = 'schedule-queue.json';
const KEEP_DONE_MS = 7 * 24 * 3600 * 1000; // 완료·실패 항목 7일 보관 후 정리

function j(res, s, p) { res.status(s).json(p); }
async function readQueue() {
  try {
    const { blobs } = await list({ prefix: QUEUE_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (blobs && blobs.length) { const r = await fetch(blobs[0].url + '?t=' + Date.now()); if (r.ok) { const a = await r.json(); return Array.isArray(a) ? a : []; } }
  } catch (e) {}
  return [];
}
async function writeQueue(arr) {
  await put(QUEUE_KEY, JSON.stringify(arr), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN });
}
function acctEnv(account) {
  if (String(account) === '2') return { IG: process.env.IG_USER_ID_2, TOKEN: process.env.IG_ACCESS_TOKEN_2, name: 'top_career_' };
  return { IG: process.env.IG_USER_ID, TOKEN: process.env.IG_ACCESS_TOKEN, name: 'topbanker99' };
}

/* 릴스 발행 (instagram-reel.js와 동일 플로우, 크론용으로 폴링 축소) */
async function publishReel(IG, TOKEN, videoUrl, caption) {
  const rC = await fetch(`${GRAPH}/${IG}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: TOKEN }) });
  const jC = await rC.json();
  if (!rC.ok || !jC.id) throw new Error('컨테이너 생성 실패: ' + JSON.stringify(jC.error || jC));
  let status = '';
  for (let i = 0; i < 70; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const rs = await fetch(`${GRAPH}/${jC.id}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`);
    const js = await rs.json(); status = js.status_code || '';
    if (status === 'FINISHED') break;
    if (status === 'ERROR') throw new Error('영상 처리 ERROR (형식·길이 확인)');
  }
  if (status !== 'FINISHED') throw new Error('영상 처리 시간초과');
  const rP = await fetch(`${GRAPH}/${IG}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: jC.id, access_token: TOKEN }) });
  const jP = await rP.json();
  if (!rP.ok || !jP.id) throw new Error('발행 실패: ' + JSON.stringify(jP.error || jP));
  return jP.id;
}

function pubItem(it) { // UI에 내려줄 안전한 형태
  return { id: it.id, account: it.account, type: it.type, caption: (it.caption || '').slice(0, 80),
    publishAt: it.publishAt, status: it.status, mediaId: it.mediaId || null, error: it.error || null, createdAt: it.createdAt };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-publish-secret');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const q = req.query || {};
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } } body = body || {};
  const action = q.action || body.action || 'list';

  const auth = req.headers['authorization'] || '';
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.headers['x-publish-secret'] || body.secret || q.key;
  const secretOk = process.env.PUBLISH_SECRET && secret === process.env.PUBLISH_SECRET;

  // ── 크론: 큐 점검·발행 ──
  if (action === 'run') {
    if (!cronOk && !secretOk) return j(res, 401, { ok: false, error: '인증 실패' });
    try {
      const queue = await readQueue();
      const now = Date.now();
      const due = queue.filter(x => x.status === 'pending' && Date.parse(x.publishAt) <= now)
                       .sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt));
      const results = [];
      let processed = 0;
      for (const it of due) {
        if (processed >= 2) break;                 // 한 번에 최대 2건 (타임아웃 방지)
        const { IG, TOKEN } = acctEnv(it.account);
        if (!IG || !TOKEN) { it.status = 'failed'; it.error = '계정 환경변수 없음'; results.push(pubItem(it)); continue; }
        try {
          if (it.type === 'reel') {
            it.mediaId = await publishReel(IG, TOKEN, it.videoUrl, it.caption); it.status = 'published'; it.publishedAt = new Date().toISOString();
            try { await del(it.videoUrl, { token: process.env.BLOB_READ_WRITE_TOKEN }); } catch (e) {} // 발행 후 예약 영상 정리
          }
          else { it.status = 'failed'; it.error = '지원하지 않는 형식: ' + it.type; }
        } catch (e) { it.status = 'failed'; it.error = String(e.message).slice(0, 200); }
        results.push(pubItem(it)); processed++;
      }
      // 오래된 완료/실패 정리
      const pruned = queue.filter(x => x.status === 'pending' || (now - Date.parse(x.createdAt || x.publishAt)) < KEEP_DONE_MS);
      await writeQueue(pruned);
      return j(res, 200, { ok: true, processed, results, pending: pruned.filter(x => x.status === 'pending').length });
    } catch (err) { return j(res, 500, { ok: false, error: (err && err.message) || String(err) }); }
  }

  // ── UI 액션 (secret 인증) ──
  if (!secretOk) return j(res, 401, { ok: false, error: '인증 실패: 올바른 비밀키가 필요합니다.' });

  if (action === 'list') {
    const queue = await readQueue();
    const items = queue.map(pubItem).sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt));
    return j(res, 200, { ok: true, items });
  }

  if (action === 'add') {
    const type = body.type || 'reel';
    const account = String(body.account) === '2' ? '2' : '1';
    const videoUrl = body.videoUrl;
    const publishAt = body.publishAt;
    if (type !== 'reel') return j(res, 400, { ok: false, error: '현재는 릴스(영상) 예약만 지원합니다.' });
    if (!videoUrl) return j(res, 400, { ok: false, error: '영상 주소(videoUrl)가 없습니다.' });
    const t = Date.parse(publishAt);
    if (!t || isNaN(t)) return j(res, 400, { ok: false, error: '발행 시각(publishAt)이 올바르지 않습니다.' });
    if (t < Date.now() - 60 * 1000) return j(res, 400, { ok: false, error: '발행 시각이 과거입니다.' });
    const { IG, TOKEN } = acctEnv(account);
    if (!IG || !TOKEN) return j(res, 500, { ok: false, error: '해당 계정 환경변수가 없습니다.' });
    const queue = await readQueue();
    const id = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const item = { id, account, type, videoUrl, caption: body.caption == null ? '' : String(body.caption),
      publishAt: new Date(t).toISOString(), createdAt: new Date().toISOString(), status: 'pending' };
    queue.push(item);
    await writeQueue(queue);
    return j(res, 200, { ok: true, id, item: pubItem(item) });
  }

  if (action === 'cancel') {
    const id = body.id || q.id;
    if (!id) return j(res, 400, { ok: false, error: 'id가 없습니다.' });
    const queue = await readQueue();
    const it = queue.find(x => x.id === id);
    if (!it) return j(res, 404, { ok: false, error: '해당 예약을 찾을 수 없습니다.' });
    if (it.status !== 'pending') return j(res, 400, { ok: false, error: '이미 처리된 예약입니다(' + it.status + ').' });
    it.status = 'canceled'; it.canceledAt = new Date().toISOString();
    await writeQueue(queue);
    return j(res, 200, { ok: true, id });
  }

  return j(res, 400, { ok: false, error: '알 수 없는 action: ' + action });
};
