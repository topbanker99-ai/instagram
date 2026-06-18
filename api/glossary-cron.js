// api/glossary-cron.js
// 탑뱅커 — 은행권·금융권 기출 빈출 상식 카드뉴스 자동 발행 (월·수·금 주 3회)
//
// 인증:
//   - Vercel Cron: Authorization: Bearer ${CRON_SECRET}  (자동)
//   - 수동 테스트: ?secret=${PUBLISH_SECRET}  또는  헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1 : 카드 생성+Blob 업로드까지만 하고, 인스타 발행/진도 갱신은 하지 않음(미리보기)
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 의존: ./blob-bundle.js, ./glossary.json, @napi-rs/canvas

const { put, list } = require('./blob-bundle.js');
const TERMS = require('./glossary.json');
let OUTRO=null; try{ OUTRO=require('./outro-image.js'); }catch(e){}   // 없어도 크래시 안 나도록

const PER_POST = 3;
const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PROGRESS_KEY = 'glossary-progress.json';
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';
const CIRC = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];

/* ───────── 카드 렌더러 (애플 미니멀, 한글) ───────── */
const COL = { WHITE:'#FFFFFF', PARCH:'#F5F5F7', DARK:'#1D1D1F', INK:'#1D1D1F',
  SOFT_L:'#3C3C3E', SOFT_D:'#D0D0D2', CAP_L:'#8A8A8E', CAP_D:'#9A9AA0', BLUE_L:'#0066CC', BLUE_D:'#2997FF' };
const fnt = (fam, size) => `${size}px "${fam}"`;
function drawTracked(ctx,x,y,t,tr){ for(const c of t){ctx.fillText(c,x,y); x+=ctx.measureText(c).width+tr;} return x; }
function trackedWidth(ctx,t,tr){ let w=0; for(const c of t) w+=ctx.measureText(c).width+tr; return w; }
function drawCentered(ctx,cx,y,t,tr){ const w=trackedWidth(ctx,t,tr)-tr; return drawTracked(ctx,cx-w/2,y,t,tr); }
function wrapText(ctx,text,maxw,tr){
  const units = text.match(/[A-Za-z0-9.%·\-]+|\s+|[\s\S]/g) || [];
  const lines=[]; let cur='';
  for(const u of units){
    if(/^\s+$/.test(u)){ if(cur&&trackedWidth(ctx,cur+' ',tr)<=maxw)cur+=' '; else if(cur){lines.push(cur.replace(/\s+$/,''));cur='';} continue; }
    if(cur===''||trackedWidth(ctx,cur+u,tr)<=maxw)cur+=u; else{lines.push(cur.replace(/\s+$/,''));cur=u;}
  }
  if(cur.trim())lines.push(cur.replace(/\s+$/,''));
  return lines;
}
function makeCard(createCanvas, term, idx, total, dark){
  const W=1080,M=110,CW=W-2*M,CX=W/2;
  const bg = dark?COL.DARK:(idx%2===0?COL.PARCH:COL.WHITE);
  const main=dark?COL.WHITE:COL.INK, body=dark?COL.SOFT_D:COL.SOFT_L, cap=dark?COL.CAP_D:COL.CAP_L, accent=dark?COL.BLUE_D:COL.BLUE_L;
  const canvas=createCanvas(W,W); const ctx=canvas.getContext('2d');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,W); ctx.textBaseline='top';
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',29); drawCentered(ctx,CX,86,'TOP BANKER',5);
  let y=292;
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard Bold',46);
  drawCentered(ctx,CX,y,`은행권 금융권 기출 빈출 상식 ${CIRC[idx-1]||''}`,-0.5); y+=82;
  let hs=74,tr=-hs*0.03; ctx.font=fnt('Pretendard SemiBold',hs);
  while(trackedWidth(ctx,term.name,tr)>CW&&hs>44){hs-=4;tr=-hs*0.03;ctx.font=fnt('Pretendard SemiBold',hs);}
  ctx.fillStyle=main;
  for(const ln of wrapText(ctx,term.name,CW,tr)){drawCentered(ctx,CX,y,ln,tr); y+=Math.round(hs*1.12);}
  y+=14;
  let capline=(term.section||'').replace(/\s{2,}.*$/,'').trim();
  if(term.exam_tags&&term.exam_tags.length) capline+='   ·   기출 '+term.exam_tags.join(' · ');
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard',28);
  for(const ln of wrapText(ctx,capline,CW,0)){drawCentered(ctx,CX,y,ln,0); y+=40;} y+=30;
  const BODY_BOTTOM=928, avail=BODY_BOTTOM-y;
  let bf=41,lh=60,lines=[];
  for(const f of [41,39,37,35,33,31,29]){ ctx.font=fnt('Pretendard',f); const ls=wrapText(ctx,term.definition,CW,0); const h=Math.round(f*1.46); if(ls.length*h<=avail||f===29){bf=f;lh=h;lines=ls;break;} }
  ctx.fillStyle=body; ctx.font=fnt('Pretendard',bf);
  for(const ln of lines){ctx.fillText(ln,M,y); y+=lh;}
  const pg=`${String(idx).padStart(2,'0')} / ${String(total).padStart(2,'0')}`;
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard SemiBold',28);
  ctx.fillText(pg, W-M-trackedWidth(ctx,pg,0), 992);
  return canvas.toBuffer('image/png');
}

/* ───────── 폰트 1회 로드 ───────── */
let fontsReady=false;
async function ensureFonts(GlobalFonts){
  if(fontsReady) return;
  const files=[['Pretendard-Regular.otf','Pretendard'],['Pretendard-SemiBold.otf','Pretendard SemiBold'],['Pretendard-Bold.otf','Pretendard Bold']];
  for(const [f,n] of files){
    const r=await fetch(PRETENDARD_BASE+f);
    if(!r.ok) throw new Error('폰트 다운로드 실패 '+f+' HTTP '+r.status);
    GlobalFonts.register(Buffer.from(await r.arrayBuffer()), n);
  }
  fontsReady=true;
}

/* ───────── 진도 읽기/쓰기 (Vercel Blob) ───────── */
async function readProgress(){
  try{
    const { blobs } = await list({ prefix: PROGRESS_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs && blobs.length){
      const r = await fetch(blobs[0].url + '?t=' + Date.now());
      if(r.ok){ const j = await r.json(); return Number(j.nextIndex)||0; }
    }
  }catch(e){}
  return 0;
}
async function writeProgress(nextIndex){
  await put(PROGRESS_KEY, JSON.stringify({ nextIndex, updatedAt:new Date().toISOString() }), {
    access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/* ───────── 캡션 ───────── */
function buildCaption(picks){
  const lines = picks.map((t,i)=>`${CIRC[i]} ${t.name}`).join('\n');
  const tags = '#은행취업 #금융권취업 #은행권 #금융상식 #경제상식 #금융용어 #경제용어 #NCS #농협은행 #신한은행 #국민은행 #우리은행 #하나은행 #기업은행 #한국은행 #은행원 #취업준비 #취준생 #자기소개서 #필기시험 #금융권채용 #은행시험 #공기업 #탑뱅커 #금융지식';
  return `[오늘의 은행권·금융권 기출 빈출 상식]\n\n${lines}\n\n매주 월·수·금, 시험에 자주 나오는 금융·경제 상식을 카드뉴스로 정리합니다.\n캡처해두고 복습하세요.\n\n${tags}`;
}

/* ───────── IG 캐러셀 발행 (instagram-publish.js와 동일 플로우) ───────── */
async function publishCarousel(imageUrls, caption){
  const IG=process.env.IG_USER_ID, TOKEN=process.env.IG_ACCESS_TOKEN;
  const childIds=[];
  for(const url of imageUrls){
    const r=await fetch(`${GRAPH}/${IG}/media`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_url:url,is_carousel_item:true,access_token:TOKEN})});
    const j=await r.json(); if(!r.ok||!j.id) throw new Error('자식 컨테이너 실패: '+JSON.stringify(j.error||j)); childIds.push(j.id);
  }
  const rP=await fetch(`${GRAPH}/${IG}/media`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({media_type:'CAROUSEL',children:childIds.join(','),caption,access_token:TOKEN})});
  const jP=await rP.json(); if(!rP.ok||!jP.id) throw new Error('캐러셀 컨테이너 실패: '+JSON.stringify(jP.error||jP));
  const creationId=jP.id; let status='';
  for(let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,2000));
    const rs=await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`); const js=await rs.json(); status=js.status_code||'';
    if(status==='FINISHED')break; if(status==='ERROR')throw new Error('미디어 처리 ERROR'); }
  if(status!=='FINISHED') throw new Error('미디어 처리 시간초과');
  const rPub=await fetch(`${GRAPH}/${IG}/media_publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({creation_id:creationId,access_token:TOKEN})});
  const jPub=await rPub.json(); if(!rPub.ok||!jPub.id) throw new Error('발행 실패: '+JSON.stringify(jPub.error||jPub));
  return jPub.id;
}

module.exports = async (req, res) => {
  const out=(s,p)=>{ res.status(s).json(p); };
  // 인증
  const auth=req.headers['authorization']||'';
  const manual=(req.query&&req.query.secret)||req.headers['x-publish-secret'];
  const cronOk=process.env.CRON_SECRET && auth===`Bearer ${process.env.CRON_SECRET}`;
  const manualOk=process.env.PUBLISH_SECRET && manual===process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401,{ok:false,error:'인증 실패'});

  const dryrun=req.query&&(req.query.dryrun==='1'||req.query.dryrun==='true');
  try{
    if(!process.env.IG_USER_ID||!process.env.IG_ACCESS_TOKEN) return out(500,{ok:false,error:'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.'});
    let canvasMod;
    try{ canvasMod=require('@napi-rs/canvas'); }catch(e){ return out(500,{ok:false,error:'@napi-rs/canvas 로드 실패: '+e.message}); }
    const { createCanvas, GlobalFonts }=canvasMod;
    await ensureFonts(GlobalFonts);

    const total=TERMS.length;
    let start=await readProgress(); if(start>=total||start<0) start=0;
    const picks=[], indices=[];
    for(let k=0;k<PER_POST;k++){ const idx=(start+k)%total; picks.push(TERMS[idx]); indices.push(idx); }

    const folder=`glossary/${Date.now()}`;
    const imageUrls=[];
    for(let i=0;i<picks.length;i++){
      const dark=(i===1);                       // ① 라이트 / ② 다크 / ③ 라이트
      const buf=makeCard(createCanvas, picks[i], i+1, PER_POST, dark);
      const blob=await put(`${folder}/${i+1}.png`, buf, {access:'public',contentType:'image/png',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN});
      imageUrls.push(blob.url);
    }
    // 마무리(프리미엄/구독 안내) 이미지 — 모든 게시물 끝에 추가
    try{
      const ob=Buffer.from(OUTRO.split(',')[1],'base64');
      const obl=await put('assets/outro.png', ob, {access:'public',contentType:'image/png',addRandomSuffix:false,allowOverwrite:true,token:process.env.BLOB_READ_WRITE_TOKEN});
      imageUrls.push(obl.url);
    }catch(e){}
    const caption=buildCaption(picks);

    if(dryrun) return out(200,{ok:true,dryrun:true,picked:picks.map(t=>t.name),indices,imageUrls,caption,nextWouldBe:(start+PER_POST)%total});

    const mediaId=await publishCarousel(imageUrls, caption);
    let nextIndex=start+PER_POST; if(nextIndex>=total) nextIndex=0;
    await writeProgress(nextIndex);
    return out(200,{ok:true,mediaId,published:picks.map(t=>t.name),indices,nextIndex,imageUrls});
  }catch(err){
    return out(500,{ok:false,error:(err&&err.message)?err.message:String(err)});
  }
};
