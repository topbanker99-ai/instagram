// api/spec-cron.js
// 국민건강보험공단 '합격 스펙' 카드뉴스 자동 발행 — 탑커리어(top_career_ · 2번 계정)
//   · 매주 수요일 10:00 KST (vercel.json: 0 1 * * 3)
//   · 캐러셀 5~6장(표지→내용→CTA) + 캡션/해시태그 20개 (spec-data.js)
//   · 진도는 Blob(spec-progress.json)에 기록, 33편 소진 후 1편부터 재순환
//
// 필요한 환경변수: IG_USER_ID_2, IG_ACCESS_TOKEN_2, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 카드 이미지: 레포 루트의 /spec-cards/<파일명> (정적 호스팅)
//
// 수동 테스트: /api/spec-cron?secret=<PUBLISH_SECRET>&dryrun=1   (미리보기)
//             /api/spec-cron?secret=<PUBLISH_SECRET>             (실제 발행)
//             &week=3 을 붙이면 특정 회차 강제 지정(1~33).

const SPECS = require('./spec-data.js');
const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const BASE = 'https://instagram-three-wheat.vercel.app';
const CARDS_PATH = '/spec-cards';
const PROGRESS_KEY = 'spec-progress.json';

/* 진도 (Blob) */
async function readProgress(){
  try{
    const { blobs } = await list({ prefix: PROGRESS_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs && blobs.length){ const r = await fetch(blobs[0].url + '?t=' + Date.now()); if(r.ok) return await r.json(); }
  }catch(e){}
  return { specIndex: 0 };
}
async function writeProgress(obj){
  try{ await put(PROGRESS_KEY, JSON.stringify(obj), { access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true, token: process.env.BLOB_READ_WRITE_TOKEN }); }catch(e){}
}

/* 캐러셀 발행 (2번 계정) — 5~6장이라 처리 대기·재시도 포함 */
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

  // 컨테이너 처리 대기 (장수 많으므로 여유) + 실패 시 1회 재시도
  await new Promise(r => setTimeout(r, 8000));
  let jPub = null;
  for(let attempt = 0; attempt < 2; attempt++){
    const rPub = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ creation_id: jP.id, access_token: token }),
    });
    jPub = await rPub.json().catch(()=>({}));
    if(rPub.ok && jPub.id) return jPub.id;
    if(attempt === 0) await new Promise(r => setTimeout(r, 10000)); // 조금 더 기다렸다 재시도
  }
  throw new Error('발행 실패: ' + JSON.stringify((jPub && jPub.error) || jPub));
}

module.exports = async (req, res) => {
  const out = (s,p)=>res.status(s).json(p);

  // 인증 (기존 크론과 동일)
  const auth = req.headers['authorization'] || '';
  const manual = (req.query && req.query.secret) || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401, { ok:false, error:'인증 실패' });

  const IG = process.env.IG_USER_ID_2;
  const TOKEN = process.env.IG_ACCESS_TOKEN_2;
  if(!IG || !TOKEN) return out(500, { ok:false, error:'2번 계정 환경변수(IG_USER_ID_2 / IG_ACCESS_TOKEN_2)가 없습니다.' });

  const dryrun = req.query && (req.query.dryrun === '1' || req.query.dryrun === 'true');

  try{
    if(!SPECS.length) return out(500, { ok:false, error:'spec 데이터가 없습니다.' });

    const prog = await readProgress();
    let idx;
    const forced = req.query && parseInt(req.query.week, 10);
    if(forced && forced >= 1 && forced <= SPECS.length){
      idx = forced - 1;
    } else {
      idx = ((prog.specIndex || 0) % SPECS.length + SPECS.length) % SPECS.length;
    }
    const item = SPECS[idx];
    const urls = item.cards.map(f => `${BASE}${CARDS_PATH}/${f}`);

    if(dryrun){
      return out(200, { ok:true, dryrun:true, week: item.week, code: item.code, title: item.title,
        index: idx, total: SPECS.length, cards: item.cards.length, images: urls,
        captionPreview: String(item.caption).slice(0, 160) + ' …' });
    }

    const mediaId = await publishCarousel(IG, TOKEN, urls, item.caption);
    prog.specIndex = (idx + 1) % SPECS.length;
    prog.lastPublished = { week: item.week, code: item.code, title: item.title, at: new Date().toISOString() };
    await writeProgress(prog);

    return out(200, { ok:true, published:true, week: item.week, code: item.code, title: item.title,
      mediaId, nextIndex: prog.specIndex, total: SPECS.length });
  }catch(err){
    return out(500, { ok:false, error:(err && err.message) ? err.message : String(err) });
  }
};
