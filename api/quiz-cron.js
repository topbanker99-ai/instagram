// api/quiz-cron.js
// 국민건강보험공단 필기 카드뉴스 자동 발행 — 탑커리어(top_career_ · 2번 계정)
//   · NCS 주 1회(화), 법령 주 1회(금)  ← vercel.json 크론으로 스케줄
//   · 캐러셀 2장(문제카드 → 정답·해설카드) + 캡션/해시태그(발행표에 이미 작성됨)
//   · 진도는 Blob(quiz-progress.json)에 기록하여 매주 다음 회차로 순환
//
// 필요한 환경변수: IG_USER_ID_2, IG_ACCESS_TOKEN_2, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 카드 이미지: 레포 루트의  /quiz-cards/<파일명>  (정적 호스팅)
//
// 수동 테스트: /api/quiz-cron?secret=<PUBLISH_SECRET>&type=ncs        (또는 type=law)
//   ?dryrun=1 을 붙이면 발행하지 않고 "무엇을 올릴지"만 미리보기.

const QUIZ = require('./quiz-data.js');
const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const BASE = 'https://instagram-three-wheat.vercel.app'; // 카드 이미지 도메인
const CARDS_PATH = '/quiz-cards';
const PROGRESS_KEY = 'quiz-progress.json';

const LAW = QUIZ.filter(x => x.cat === 'law');
const NCS = QUIZ.filter(x => x.cat === 'ncs');

/* 진도 (Blob) */
async function readProgress(){
  try{
    const { blobs } = await list({ prefix: PROGRESS_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs && blobs.length){ const r = await fetch(blobs[0].url + '?t=' + Date.now()); if(r.ok) return await r.json(); }
  }catch(e){}
  return { lawIndex: 0, ncsIndex: 0 };
}
async function writeProgress(obj){
  try{ await put(PROGRESS_KEY, JSON.stringify(obj), { access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true, token: process.env.BLOB_READ_WRITE_TOKEN }); }catch(e){}
}

/* 캐러셀 발행 (2번 계정) */
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
  await new Promise(r => setTimeout(r, 3000)); // 컨테이너 처리 대기
  const rPub = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ creation_id: jP.id, access_token: token }),
  });
  const jPub = await rPub.json().catch(()=>({}));
  if(!rPub.ok || !jPub.id) throw new Error('발행 실패: ' + JSON.stringify(jPub.error || jPub));
  return jPub.id;
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

  // 종류 결정: 쿼리(type) 우선, 없으면 KST 요일로 (금=법령, 그 외=NCS)
  let type = (req.query && req.query.type) || '';
  if(type !== 'ncs' && type !== 'law'){
    const kstDay = new Date(Date.now() + 9*3600*1000).getUTCDay(); // 0일~6토
    type = (kstDay === 5) ? 'law' : 'ncs';
  }
  const dryrun = req.query && (req.query.dryrun === '1' || req.query.dryrun === 'true');

  try{
    const arr = (type === 'law') ? LAW : NCS;
    if(!arr.length) return out(500, { ok:false, error: type + ' 데이터가 없습니다.' });

    const prog = await readProgress();
    const key = (type === 'law') ? 'lawIndex' : 'ncsIndex';
    const idx = ((prog[key] || 0) % arr.length + arr.length) % arr.length;
    const item = arr[idx];
    const urls = [ `${BASE}${CARDS_PATH}/${item.card1}`, `${BASE}${CARDS_PATH}/${item.card2}` ];

    if(dryrun){
      return out(200, { ok:true, dryrun:true, type, index: idx, total: arr.length,
        code: item.code, topic: item.topic, images: urls,
        captionPreview: String(item.caption).slice(0, 140) + ' …' });
    }

    const mediaId = await publishCarousel(IG, TOKEN, urls, item.caption);
    prog[key] = (idx + 1) % arr.length;
    prog.lastPublished = { type, code: item.code, at: new Date().toISOString() };
    await writeProgress(prog);

    return out(200, { ok:true, published:true, type, code: item.code, topic: item.topic, mediaId, nextIndex: prog[key], total: arr.length });
  }catch(err){
    return out(500, { ok:false, error:(err && err.message) ? err.message : String(err) });
  }
};
