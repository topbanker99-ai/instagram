// api/comic-cron.js — 탑뱅커 취준생 만화 카드뉴스 자동 발행 (계정2 top_career_)
//   · 화 21:00 KST 상편(1~8컷+계속카드 9장) → 수 21:00 KST 하편(9~16컷 8장) — API 캐러셀 10장 한도 대응
//   · 발행 순서 = comic-data.js order(매니페스트 발행순서). 회차 소진 시 자동 종료.
//   · 하편 발행 직후 첫 댓글 자동 등록 시도(권한 없으면 무시)
//   · 진도: Blob comic-progress.json {index, half}
//
// 환경변수: IG_USER_ID_2, IG_ACCESS_TOKEN_2, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 이미지: /comic-cards/ep<번호>/01.jpg~16.jpg + /comic-cards/continue.jpg (레포 정적 호스팅)
//
// 미리보기: ?pkey=<PREVIEW_KEY>&ep=1&half=upper&dryrun=1  (발행 안 함, HTML)
// 수동:     ?secret=<PUBLISH_SECRET>[&ep=N&half=upper|lower]

const EPS = require('./comic-data.js');
const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const BASE = 'https://instagram-three-wheat.vercel.app';
const CARDS_PATH = '/comic-cards';
const PROGRESS_KEY = 'comic-progress.json';
const PREVIEW_KEY = 'cm-x4k9p2w7q1';
const NOT_BEFORE = Date.parse('2026-07-20T15:00:00Z'); // 2026-07-21(화) 00:00 KST — 첫 발행 7/21 밤 9시 상편

/* 진도 (Blob) */
async function readProgress(){
  try{
    const { blobs } = await list({ prefix: PROGRESS_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs && blobs.length){ const r = await fetch(blobs[0].url + '?t=' + Date.now()); if(r.ok) return await r.json(); }
  }catch(e){}
  return { index: 0, half: 'upper' };
}
async function writeProgress(obj){
  try{ await put(PROGRESS_KEY, JSON.stringify(obj), { access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true, token: process.env.BLOB_READ_WRITE_TOKEN }); }catch(e){}
}

/* 상·하편 구성 */
function halfSpec(item, half){
  const pad = n => String(n).padStart(2, '0') + '.jpg';
  if(half === 'upper'){
    const files = [];
    for(let i = 1; i <= 8; i++) files.push(`${CARDS_PATH}/${item.dir}/${pad(i)}`);
    files.push(`${CARDS_PATH}/continue.jpg`);
    const caption = `${item.caption}\n\n▶ 하편은 내일 밤 9시에 이어집니다.`;
    return { label: '상편', files, caption };
  }
  const files = [];
  for(let i = 9; i <= item.count; i++) files.push(`${CARDS_PATH}/${item.dir}/${pad(i)}`);
  const tags = item.caption.split('\n').filter(l => l.trim().startsWith('#')).join('\n');
  const caption = `《${item.title}》 하편입니다.\n상편은 프로필 피드에서 볼 수 있어요.\n\n저장해뒀다가 무너지는 날 다시 꺼내보세요.\n\n${tags}`;
  return { label: '하편', files, caption };
}

/* 캐러셀 발행 (thu-cron과 동일 플로우) */
async function publishCarousel(igUserId, token, imageUrls, caption){
  const childIds = [];
  for(const url of imageUrls){
    const r = await fetch(`${GRAPH}/${igUserId}/media`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ image_url: url, is_carousel_item: true, access_token: token }),
    });
    const j = await r.json().catch(()=>({}));
    if(!r.ok || !j.id) throw new Error('카드 컨테이너 생성 실패(' + url + '): ' + JSON.stringify(j.error || j));
    childIds.push(j.id);
  }
  const rP = await fetch(`${GRAPH}/${igUserId}/media`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ media_type:'CAROUSEL', children: childIds.join(','), caption, access_token: token }),
  });
  const jP = await rP.json().catch(()=>({}));
  if(!rP.ok || !jP.id) throw new Error('캐러셀 컨테이너 생성 실패: ' + JSON.stringify(jP.error || jP));
  await new Promise(r => setTimeout(r, 9000));
  let jPub = null;
  for(let attempt = 0; attempt < 2; attempt++){
    const rPub = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ creation_id: jP.id, access_token: token }),
    });
    jPub = await rPub.json().catch(()=>({}));
    if(rPub.ok && jPub.id) return jPub.id;
    if(attempt === 0) await new Promise(r => setTimeout(r, 12000));
  }
  throw new Error('발행 실패: ' + JSON.stringify((jPub && jPub.error) || jPub));
}

/* 첫 댓글 (권한 없으면 조용히 넘어감) */
async function tryFirstComment(mediaId, token, message){
  if(!message) return { tried:false };
  try{
    const r = await fetch(`${GRAPH}/${mediaId}/comments`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message, access_token: token }),
    });
    const j = await r.json().catch(()=>({}));
    return { tried:true, ok: !!(r.ok && j.id), detail: j.id ? j.id : JSON.stringify(j.error || j).slice(0, 120) };
  }catch(e){ return { tried:true, ok:false, detail: String(e.message).slice(0, 120) }; }
}

module.exports = async (req, res) => {
  const out = (s,p)=>res.status(s).json(p);
  const q = req.query || {};
  const dryrun = q.dryrun === '1' || q.dryrun === 'true';

  // 인증: 크론/시크릿 + 미리보기 전용키(dryrun 한정)
  const auth = req.headers['authorization'] || '';
  const manual = q.secret || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  const previewOk = q.pkey === PREVIEW_KEY && dryrun;
  if(!cronOk && !manualOk && !previewOk) return out(401, { ok:false, error:'인증 실패' });

  const IG = process.env.IG_USER_ID_2;
  const TOKEN = process.env.IG_ACCESS_TOKEN_2;

  try{
    if(!EPS.length) return out(500, { ok:false, error:'comic 데이터가 없습니다.' });

    // 시작일 가드 (dryrun·강제 지정 통과)
    const forcedEp = parseInt(q.ep, 10);
    if(!dryrun && !forcedEp && Date.now() < NOT_BEFORE){
      return out(200, { ok:true, skipped:true, reason:'시작일(7/21) 이전 — 발행 안 함' });
    }

    const prog = await readProgress();
    let idx = ((prog.index || 0) % Math.max(EPS.length, 1) + EPS.length) % EPS.length;
    let half = prog.half === 'lower' ? 'lower' : 'upper';
    if((prog.index || 0) >= EPS.length && !forcedEp){
      return out(200, { ok:true, done:true, reason:'등록된 회차 모두 발행 완료 — 새 회차 추가 대기' });
    }
    if(forcedEp){
      const fi = EPS.findIndex(e => e.no === forcedEp);
      if(fi === -1) return out(400, { ok:false, error:'없는 회차: ' + forcedEp });
      idx = fi; half = (q.half === 'lower') ? 'lower' : 'upper';
    }
    const item = EPS[idx];
    const spec = halfSpec(item, half);
    const urls = spec.files.map(f => BASE + f);
    if(urls.length < 2 || urls.length > 10) return out(500, { ok:false, error:'캐러셀 장수 이상: ' + urls.length });

    if(dryrun){
      if(q.json === '1') return out(200, { ok:true, dryrun:true, order:item.order, no:item.no, title:item.title,
        half: spec.label, cards: urls.length, images: urls, captionPreview: spec.caption.slice(0, 200) + ' …',
        firstComment: half === 'lower' ? item.firstComment : null });
      const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const imgs = urls.map((u,i)=>`<img src="${u}" alt="${i+1}" style="width:100%;border-radius:12px;margin-bottom:10px;background:#000">`).join('');
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>만화 미리보기</title></head>
<body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif"><div style="max-width:480px;margin:0 auto;padding:18px">
<div style="color:#2997ff;font-weight:700">취준생 만화 ${item.no}회차 ${spec.label} 미리보기 (발행 안 됨)</div>
<div style="color:#8a8a90;font-size:13px;margin:6px 0 12px">${esc(item.title)} · ${urls.length}장 캐러셀 · 발행순서 ${item.order}</div>
${imgs}
<details open style="margin-top:8px"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">캡션</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(spec.caption)}</pre></details>
${half==='lower' && item.firstComment ? `<div style="background:#16273C;border-radius:10px;padding:12px;margin-top:10px;font-size:13px"><b style="color:#8FBDF1">첫 댓글(자동)</b><br>${esc(item.firstComment)}</div>` : ''}
</div></body></html>`;
      res.statusCode = 200; res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(html);
    }

    if(!IG || !TOKEN) return out(500, { ok:false, error:'2번 계정 환경변수(IG_USER_ID_2 / IG_ACCESS_TOKEN_2)가 없습니다.' });
    const mediaId = await publishCarousel(IG, TOKEN, urls, spec.caption);
    let comment = { tried:false };
    if(half === 'lower') comment = await tryFirstComment(mediaId, TOKEN, item.firstComment);

    if(!forcedEp){
      if(half === 'upper'){ prog.half = 'lower'; }
      else { prog.half = 'upper'; prog.index = idx + 1; }
      prog.lastPublished = { no:item.no, title:item.title, half: spec.label, mediaId, at:new Date().toISOString() };
      await writeProgress(prog);
    }
    return out(200, { ok:true, published:true, no:item.no, title:item.title, half: spec.label,
      cards: urls.length, mediaId, firstComment: comment, next: { index: prog.index, half: prog.half } });
  }catch(err){
    return out(500, { ok:false, error:(err && err.message) ? err.message : String(err) });
  }
};
