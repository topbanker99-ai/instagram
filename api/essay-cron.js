// api/essay-cron.js
// 탑뱅커 — 논술 기출 카드뉴스 자동 발행 (매주 1문제, 기관·회차 단위)
//
// 한 게시물 = 표지 + (제시자료) + (출제 배경) + 문제(길면 자동 분할) + 논술 안내(CTA).
// 진도: Blob의 essay-progress.json 의 nextIndex (매번 +1, 끝까지 가면 0으로 순환).
//
// 인증:  Vercel Cron → Authorization: Bearer ${CRON_SECRET}  /  수동 → ?secret=${PUBLISH_SECRET}
// 옵션:  ?dryrun=1 (미리보기, 발행·진도 X) · ?index=N (특정 문제 강제)
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 의존: ./blob-bundle.js, ./essays.json, @napi-rs/canvas

const { put, list } = require('./blob-bundle.js');
const ESSAYS = require('./essays.json');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';
const PROGRESS_KEY = 'essay-progress.json';
const SITE = 'www.topbanker-ai.co.kr';
const ITEMS = (ESSAYS && ESSAYS.items) || [];

/* ───────── 헬퍼 ───────── */
const COL = { WHITE:'#FFFFFF', PARCH:'#F5F5F7', DARK:'#1D1D1F', INK:'#1D1D1F',
  SOFT_L:'#3C3C3E', SOFT_D:'#D0D0D2', CAP_L:'#8A8A8E', CAP_D:'#9A9AA0', BLUE_L:'#0066CC', BLUE_D:'#2997FF' };
const fnt = (fam,size)=>`${size}px "${fam}"`;
const clean = s=>String(s==null?'':s).replace(/\s+/g,' ').trim();
function dT(ctx,x,y,t,tr){ for(const c of t){ctx.fillText(c,x,y); x+=ctx.measureText(c).width+tr;} return x; }
function tW(ctx,t,tr){ let w=0; for(const c of t) w+=ctx.measureText(c).width+tr; return w; }
function dC(ctx,cx,y,t,tr){ return dT(ctx,cx-(tW(ctx,t,tr)-tr)/2,y,t,tr); }
function wrap(ctx,t,mw,tr){
  const u=(t||'').match(/[A-Za-z0-9.,%·()'’&\-]+|\s+|[\s\S]/g)||[]; const L=[]; let cur='';
  for(const x of u){ if(/^\s+$/.test(x)){ if(cur&&tW(ctx,cur+' ',tr)<=mw)cur+=' '; else if(cur){L.push(cur.replace(/\s+$/,''));cur='';} continue; }
    if(cur===''||tW(ctx,cur+x,tr)<=mw)cur+=x; else{L.push(cur.replace(/\s+$/,''));cur=x;} }
  if(cur.trim())L.push(cur.replace(/\s+$/,'')); return L;
}
function rr(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function newCanvas(createCanvas,dark){ const W=1080; const cv=createCanvas(W,W); const ctx=cv.getContext('2d'); ctx.fillStyle=dark?COL.DARK:COL.WHITE; ctx.fillRect(0,0,W,W); ctx.textBaseline='top'; return [cv,ctx]; }
function head(ctx,main,cap,idx,total){
  const W=1080,M=96,CX=W/2;
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',28); dC(ctx,CX,58,'TOP BANKER',5);
  if(idx){ const pg=`${String(idx).padStart(2,'0')} / ${String(total).padStart(2,'0')}`; ctx.fillStyle=cap; ctx.font=fnt('Pretendard SemiBold',24); dT(ctx,W-M-tW(ctx,pg,0),60,pg,0); }
}

/* ───────── 표지 ───────── */
function makeCover(createCanvas, it, idx, total){
  const W=1080,M=100,CX=W/2; const [cv,ctx]=newCanvas(createCanvas,false);
  const main=COL.INK, body=COL.SOFT_L, cap=COL.CAP_L, accent=COL.BLUE_L;
  head(ctx,main,cap,idx,total);
  let y=240;
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard Bold',40); dC(ctx,CX,y,'이주의 논술 기출',-0.5); y+=92;
  let inst=clean(it.inst), is=96; ctx.font=fnt('Pretendard Bold',is);
  while(tW(ctx,inst,-1)>W-2*M && is>60){ is-=4; ctx.font=fnt('Pretendard Bold',is); }
  ctx.fillStyle=main; dC(ctx,CX,y,inst,-1); y+=is+22;
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',31); dC(ctx,CX,y,`${clean(it.year)} · ${clean(it.type)}`,0); y+=62;
  ctx.strokeStyle=accent; ctx.globalAlpha=0.3; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(CX-60,y+6); ctx.lineTo(CX+60,y+6); ctx.stroke(); ctx.globalAlpha=1; y+=44;
  ctx.fillStyle=body; ctx.font=fnt('Pretendard SemiBold',34); for(const l of wrap(ctx,clean(it.topic),W-2*M,0)){ dC(ctx,CX,y,l,0); y+=48; }
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',26); dC(ctx,CX,886,'은행·금융공기업 필기·면접 논술 대비',0);
  return cv.toBuffer('image/png');
}

/* ───────── 자료/배경 카드 ───────── */
function makeSection(createCanvas, it, label, text, idx, total, dark){
  const W=1080,M=96,CW=W-2*M,CX=W/2; const [cv,ctx]=newCanvas(createCanvas,dark);
  const main=dark?COL.WHITE:COL.INK, body=dark?COL.SOFT_D:COL.SOFT_L, cap=dark?COL.CAP_D:COL.CAP_L, accent=dark?COL.BLUE_D:COL.BLUE_L;
  head(ctx,main,cap,idx,total);
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard SemiBold',32); dC(ctx,CX,118,label,0);
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',27); dC(ctx,CX,166,`${clean(it.inst)} · ${clean(it.year)} · ${clean(it.type)}`,0);
  let y=240; ctx.strokeStyle=cap; ctx.globalAlpha=0.25; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(M,y); ctx.lineTo(W-M,y); ctx.stroke(); ctx.globalAlpha=1; y+=34;
  // 본문: 길이에 맞춰 글자 크기 자동 조정
  let fs=34; for(const f of [34,32,30,28]){ ctx.font=fnt('Pretendard Regular',f); const ls=wrap(ctx,clean(text),CW,0); const lh=Math.round(f*1.52); if(y+ls.length*lh<=1004||f===28){ fs=f; break; } }
  const lh=Math.round(fs*1.52); ctx.fillStyle=body; ctx.font=fnt('Pretendard Regular',fs);
  for(const l of wrap(ctx,clean(text),CW,0)){ dT(ctx,M,y,l,0); y+=lh; }
  return cv.toBuffer('image/png');
}

/* ───────── 문제 카드 (자동 분할) ───────── */
function layoutQuestions(ctx, questions){
  const W=1080,M=96,CW=W-2*M; const ss=32, lh=48, gap=28, topY=274, bottomY=1006;
  ctx.font=fnt('Pretendard Bold',ss); const numW=ctx.measureText('99.').width+16;
  const pages=[]; let page=[]; let y=topY;
  questions.forEach((q,i)=>{
    ctx.font=fnt('Pretendard Regular',ss);
    const lines=wrap(ctx,clean(q),CW-numW,0);
    const h=lines.length*lh+gap;
    if(y+h>bottomY && page.length){ pages.push(page); page=[]; y=topY; }
    page.push({num:i+1, lines, numW}); y+=h;
  });
  if(page.length) pages.push(page);
  return { pages, ss, lh, gap };
}
function makeQuestionCard(createCanvas, it, page, lay, pageNo, pagesTotal, idx, total, dark){
  const W=1080,M=96,CX=W/2; const [cv,ctx]=newCanvas(createCanvas,dark);
  const main=dark?COL.WHITE:COL.INK, body=dark?COL.SOFT_D:COL.SOFT_L, cap=dark?COL.CAP_D:COL.CAP_L, accent=dark?COL.BLUE_D:COL.BLUE_L;
  head(ctx,main,cap,idx,total);
  const label = pagesTotal>1 ? `문제 (${pageNo}/${pagesTotal})` : '문제';
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard SemiBold',32); dC(ctx,CX,118,label,0);
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',27); dC(ctx,CX,166,`${clean(it.inst)} · ${clean(it.year)} · ${clean(it.type)}`,0);
  let y=240; ctx.strokeStyle=cap; ctx.globalAlpha=0.25; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(M,y); ctx.lineTo(W-M,y); ctx.stroke(); ctx.globalAlpha=1; y+=34;
  for(const q of page){
    ctx.fillStyle=accent; ctx.font=fnt('Pretendard Bold',lay.ss); dT(ctx,M,y,`${q.num}.`,0);
    const ind=M+q.numW;
    ctx.fillStyle=body; ctx.font=fnt('Pretendard Regular',lay.ss);
    for(const l of q.lines){ dT(ctx,ind,y,l,0); y+=lay.lh; }
    y+=lay.gap;
  }
  return cv.toBuffer('image/png');
}

/* ───────── 논술 안내(CTA) ───────── */
function makeNotice(createCanvas, dark){
  const W=1080,M=100,CX=W/2; const [cv,ctx]=newCanvas(createCanvas,dark);
  const main=dark?COL.WHITE:COL.INK, body=dark?COL.SOFT_D:COL.SOFT_L, cap=dark?COL.CAP_D:COL.CAP_L, accent=dark?COL.BLUE_D:COL.BLUE_L;
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',28); dC(ctx,CX,58,'TOP BANKER',5);
  let y=232;
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard SemiBold',34); dC(ctx,CX,y,'탑뱅커 AI에서 더 공부하기',0); y+=78;
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',62);
  dC(ctx,CX,y,'논술 예상문제 &',-0.5); y+=78; dC(ctx,CX,y,'작성법까지',-0.5); y+=118;
  ctx.fillStyle=body; ctx.font=fnt('Pretendard Regular',33);
  dC(ctx,CX,y,'예상문제 풀이부터 논술 작성방법까지,',0); y+=50;
  dC(ctx,CX,y,'탑뱅커 AI에서 함께 공부해 보세요.',0); y+=86;
  ctx.font=fnt('Pretendard Bold',38); const bw=Math.min(W-2*M, tW(ctx,SITE,0)+96), bh=96, bx=CX-bw/2;
  rr(ctx,bx,y,bw,bh,22); ctx.fillStyle=dark?'rgba(41,151,255,0.18)':'#EAF2FB'; ctx.fill();
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard Bold',38); dC(ctx,CX,y+27,SITE,0); y+=bh+30;
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',29); dC(ctx,CX,y,'프로필 링크에서도 바로 갈 수 있어요!',0);
  return cv.toBuffer('image/png');
}

/* ───────── 폰트 ───────── */
let fontsReady=false;
async function ensureFonts(GlobalFonts){
  if(fontsReady) return;
  const files=[['Pretendard-Regular.otf','Pretendard Regular'],['Pretendard-SemiBold.otf','Pretendard SemiBold'],['Pretendard-Bold.otf','Pretendard Bold']];
  for(const [f,n] of files){ const r=await fetch(PRETENDARD_BASE+f); if(!r.ok) throw new Error('폰트 다운로드 실패 '+f); GlobalFonts.register(Buffer.from(await r.arrayBuffer()),n); }
  fontsReady=true;
}

/* ───────── 진도 ───────── */
async function readNext(){
  try{ const {blobs}=await list({prefix:PROGRESS_KEY, token:process.env.BLOB_READ_WRITE_TOKEN});
    if(blobs&&blobs.length){ const r=await fetch(blobs[0].url+'?t='+Date.now()); if(r.ok){ const j=await r.json(); return Number(j.nextIndex)||0; } } }catch(e){}
  return 0;
}
async function writeNext(n){
  await put(PROGRESS_KEY, JSON.stringify({nextIndex:n, updatedAt:new Date().toISOString()}), {access:'public',contentType:'application/json',addRandomSuffix:false,allowOverwrite:true,token:process.env.BLOB_READ_WRITE_TOKEN});
}

/* ───────── 캡션 ───────── */
function buildCaption(it){
  const tagInst='#'+clean(it.inst).replace(/\s+/g,'');
  const tags=`${tagInst} #은행논술 #금융공기업논술 #논술기출 #논술준비 #금융논술 #공기업논술 #필기시험 #논술작성법 #시사논술 #경제논술 #논술예상문제 #은행취업 #금융권취업 #자기소개서 #면접준비 #취업준비 #취준생 #탑뱅커`;
  return `[이주의 논술 기출] ${clean(it.inst)} · ${clean(it.year)} ${clean(it.type)}\n\n${clean(it.topic)}\n\n은행·금융공기업 논술·약술 기출입니다. 출제 배경과 문항을 카드에서 확인하고, 직접 답안 개요를 잡아보세요.\n\n✍️ 논술 출제 예상문제 풀이와 작성방법은 탑뱅커 AI(${SITE}) 또는 프로필 링크에서!\n\n${tags}`;
}

/* ───────── 캐러셀 발행 ───────── */
async function publishCarousel(imageUrls, caption){
  const IG=process.env.IG_USER_ID, TOKEN=process.env.IG_ACCESS_TOKEN; const childIds=[];
  for(const url of imageUrls){
    const r=await fetch(`${GRAPH}/${IG}/media`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_url:url,is_carousel_item:true,access_token:TOKEN})});
    const j=await r.json(); if(!r.ok||!j.id) throw new Error('자식 컨테이너 실패: '+JSON.stringify(j.error||j)); childIds.push(j.id);
  }
  const rP=await fetch(`${GRAPH}/${IG}/media`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({media_type:'CAROUSEL',children:childIds.join(','),caption,access_token:TOKEN})});
  const jP=await rP.json(); if(!rP.ok||!jP.id) throw new Error('캐러셀 컨테이너 실패: '+JSON.stringify(jP.error||jP));
  const cid=jP.id; let status='';
  for(let i=0;i<30;i++){ await new Promise(r=>setTimeout(r,2000));
    const rs=await fetch(`${GRAPH}/${cid}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`); const js=await rs.json(); status=js.status_code||'';
    if(status==='FINISHED')break; if(status==='ERROR')throw new Error('미디어 처리 ERROR'); }
  if(status!=='FINISHED') throw new Error('미디어 처리 시간초과');
  const rPub=await fetch(`${GRAPH}/${IG}/media_publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({creation_id:cid,access_token:TOKEN})});
  const jPub=await rPub.json(); if(!rPub.ok||!jPub.id) throw new Error('발행 실패: '+JSON.stringify(jPub.error||jPub));
  return jPub.id;
}

module.exports = async (req, res) => {
  const out=(s,p)=>{ res.status(s).json(p); };
  const auth=req.headers['authorization']||'';
  const manual=(req.query&&req.query.secret)||req.headers['x-publish-secret'];
  const cronOk=process.env.CRON_SECRET && auth===`Bearer ${process.env.CRON_SECRET}`;
  const manualOk=process.env.PUBLISH_SECRET && manual===process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401,{ok:false,error:'인증 실패'});
  const dryrun=req.query&&(req.query.dryrun==='1'||req.query.dryrun==='true');

  try{
    if(!ITEMS.length) return out(500,{ok:false,error:'essays.json 문제 데이터가 없습니다.'});
    if(!process.env.IG_USER_ID||!process.env.IG_ACCESS_TOKEN) return out(500,{ok:false,error:'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.'});

    let next = await readNext();
    if(req.query && req.query.index!=null){ const f=parseInt(req.query.index,10); if(!isNaN(f)) next=((f%ITEMS.length)+ITEMS.length)%ITEMS.length; }
    const it = ITEMS[next % ITEMS.length];

    let canvasMod; try{ canvasMod=require('@napi-rs/canvas'); }catch(e){ return out(500,{ok:false,error:'@napi-rs/canvas 로드 실패: '+e.message}); }
    const { createCanvas, GlobalFonts }=canvasMod;
    await ensureFonts(GlobalFonts);

    // 문제 분할 계산
    const mctx=createCanvas(1080,1080).getContext('2d');
    const lay=layoutQuestions(mctx, it.questions);

    // 페이지 번호 대상(표지+자료+배경+문제) — 안내는 제외
    const total = 1 + (it.material?1:0) + (it.background?1:0) + lay.pages.length;
    const folder=`essay/${Date.now()}`; const imageUrls=[]; let seq=1;
    const push=async (buf)=>{ const b=await put(`${folder}/${seq}.png`, buf, {access:'public',contentType:'image/png',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN}); imageUrls.push(b.url); seq++; };
    const darkFor=(i)=>(i%2===0);   // 1표지 라이트, 2다크, 3라이트…

    await push(makeCover(createCanvas, it, 1, total));
    if(it.material){ await push(makeSection(createCanvas, it, '제시자료', it.material, seq, total, darkFor(seq))); }
    if(it.background){ await push(makeSection(createCanvas, it, '출제 배경', it.background, seq, total, darkFor(seq))); }
    for(let p=0;p<lay.pages.length;p++){ await push(makeQuestionCard(createCanvas, it, lay.pages[p], lay, p+1, lay.pages.length, seq, total, darkFor(seq))); }
    // 논술 안내(CTA) — 번호 없음, 마지막
    await push(makeNotice(createCanvas, darkFor(seq)));

    const caption=buildCaption(it);

    if(dryrun){
      const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const imgs=imageUrls.map((u,i)=>`<img src="${u}" alt="card ${i+1}" style="width:100%;border-radius:12px;margin-bottom:10px;background:#000">`).join('');
      const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>미리보기</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif;text-align:center"><div style="max-width:480px;margin:0 auto;padding:18px"><div style="color:#2997ff;font-weight:700;font-size:16px">미리보기 (아직 발행 안 됨)</div><div style="color:#8a8a90;font-size:13px;margin:6px 0 14px">논술 기출 · ${esc(it.inst)} ${esc(it.year)} · ${imageUrls.length}장 (${next+1}/${ITEMS.length}번째 문제)</div>${imgs}<div style="background:#16161a;border-radius:12px;padding:14px;margin-top:8px;font-size:14px;line-height:1.5">마음에 들면 → 주소창에서 <b style="color:#fff">&amp;dryrun=1</b> 을 지우고 다시 접속하면 <b style="color:#2997ff">실제로 발행</b>됩니다.</div><details style="margin-top:14px;text-align:left"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">캡션 보기</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(caption)}</pre></details></div></body></html>`;
      res.statusCode=200; res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html); return;
    }

    const mediaId=await publishCarousel(imageUrls, caption);
    await writeNext((next+1)%ITEMS.length);
    return out(200,{ok:true,mediaId,index:next,inst:it.inst,year:it.year,cards:imageUrls.length,nextIndex:(next+1)%ITEMS.length});
  }catch(err){
    return out(500,{ok:false,error:(err&&err.message)?err.message:String(err)});
  }
};
