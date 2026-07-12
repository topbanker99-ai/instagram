// api/mon-cron.js
// 국민건강보험공단 '면접 60일' 카드뉴스 자동 발행 — 탑커리어(top_career_ · 2번 계정)
//   · 매주 월요일 19:00 KST (vercel.json: 0 10 * * 1)
//   · 캐러셀 8장(표지→본문5→다음편예고→프리미엄) + 캡션/해시태그 20개 (mon-data.js)
//   · 진도는 Blob(mon-progress.json)에 기록, 60편 소진 후 1편부터 재순환
//   · 시작 가드: 2026-07-20(월) 이전에는 크론이 호출돼도 발행하지 않음
//
// 필요한 환경변수: IG_USER_ID_2, IG_ACCESS_TOKEN_2, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 카드 이미지: 레포 루트의 /mon-cards/<파일명> (정적 호스팅)
//
// 수동 테스트: /api/mon-cron?secret=<PUBLISH_SECRET>&dryrun=1   (미리보기)
//             /api/mon-cron?secret=<PUBLISH_SECRET>             (실제 발행)
//             &day=3 을 붙이면 특정 회차 강제 지정(1~60).

const SETS = require('./mon-data.js');
const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const BASE = 'https://instagram-three-wheat.vercel.app';
const CARDS_PATH = '/mon-cards';
const PROGRESS_KEY = 'mon-progress.json';
const NOT_BEFORE = Date.parse('2026-07-19T15:00:00Z'); // 2026-07-20 00:00 KST

/* 진도 (Blob) */
async function readProgress(){
  try{
    const { blobs } = await list({ prefix: PROGRESS_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs && blobs.length){ const r = await fetch(blobs[0].url + '?t=' + Date.now()); if(r.ok) return await r.json(); }
  }catch(e){}
  return { dayIndex: 0 };
}
async function writeProgress(obj){
  try{ await put(PROGRESS_KEY, JSON.stringify(obj), { access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true, token: process.env.BLOB_READ_WRITE_TOKEN }); }catch(e){}
}

/* 캐러셀 발행 (2번 계정) — 8장이라 처리 대기·재시도 포함 */
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

  // 컨테이너 처리 대기 (8장이므로 여유) + 실패 시 1회 재시도
  await new Promise(r => setTimeout(r, 10000));
  let jPub = null;
  for(let attempt = 0; attempt < 2; attempt++){
    const rPub = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ creation_id: jP.id, access_token: token }),
    });
    jPub = await rPub.json().catch(()=>({}));
    if(rPub.ok && jPub.id) return jPub.id;
    if(attempt === 0) await new Promise(r => setTimeout(r, 12000)); // 조금 더 기다렸다 재시도
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
  const forced = req.query && parseInt(req.query.day, 10);

  try{
    if(!SETS.length) return out(500, { ok:false, error:'mon 데이터가 없습니다.' });

    // 시작일 가드 (dryrun·강제 지정은 통과)
    if(!dryrun && !forced && Date.now() < NOT_BEFORE){
      return out(200, { ok:true, skipped:true, reason:'시작일(2026-07-20) 이전이라 발행하지 않았습니다.' });
    }

    const prog = await readProgress();
    let idx;
    if(forced && forced >= 1 && forced <= SETS.length){
      idx = forced - 1;
    } else {
      idx = ((prog.dayIndex || 0) % SETS.length + SETS.length) % SETS.length;
    }
    const item = SETS[idx];
    const urls = item.cards.map(f => `${BASE}${CARDS_PATH}/${f}`);

    if(dryrun){
      return out(200, { ok:true, dryrun:true, day: item.day, title: item.title,
        index: idx, total: SETS.length, cards: item.cards.length, images: urls,
        captionPreview: String(item.caption).slice(0, 160) + ' …' });
    }

    const mediaId = await publishCarousel(IG, TOKEN, urls, item.caption);
    prog.dayIndex = (idx + 1) % SETS.length;
    prog.lastPublished = { day: item.day, title: item.title, at: new Date().toISOString() };
    await writeProgress(prog);

    return out(200, { ok:true, published:true, day: item.day, title: item.title,
      mediaId, nextIndex: prog.dayIndex, total: SETS.length });
  }catch(err){
    return out(500, { ok:false, error:(err && err.message) ? err.message : String(err) });
  }
};
