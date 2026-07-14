// api/news-cron.js
// 탑뱅커 — 금융뉴스 "면접 출제 예상질문" 카드뉴스 자동 발행 (매주 목요일, 3건)
//
// 데이터: https://topbanker-ai.co.kr/api/news-feed  (categories.bank + categories.job 사용)
// 한 게시물 = 커버(자동 구성) + 뉴스 3장(면접 포인트) + 마무리(네이버 프리미엄 안내) 이미지.
// 중복 방지: 이미 올린 기사(link)는 Blob의 news-posted.json 에 저장, 새 기사만 발행.
//
// 인증:
//   - Vercel Cron: Authorization: Bearer ${CRON_SECRET}  (자동)
//   - 수동: ?secret=${PUBLISH_SECRET}  또는 헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1 : 카드 생성+업로드까지(미리보기, 발행/중복기록 안 함). 브라우저에서 카드가 바로 보임.
//   - ?n=3      : 이번에 올릴 기사 수(기본 3)
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 의존: ./blob-bundle.js, ./outro-image.js, @napi-rs/canvas

const { put, list } = require('./blob-bundle.js');
const { buildTags } = require('./hashtags.js');
let OUTRO=null; try{ OUTRO=require('./outro-image.js'); }catch(e){}

const NEWS_URL = 'https://topbanker-ai.co.kr/api/news-feed';
const POSTED_KEY = 'news-posted.json';
const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PER_POST = 3;
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';
const CIRC = ['①','②','③','④','⑤'];

/* ───────── 색/텍스트 헬퍼 (기존 카드와 동일 톤) ───────── */
const COL = { WHITE:'#FFFFFF', PARCH:'#F5F5F7', DARK:'#1D1D1F', INK:'#1D1D1F',
  SOFT_L:'#3C3C3E', SOFT_D:'#D0D0D2', CAP_L:'#8A8A8E', CAP_D:'#9A9AA0', BLUE_L:'#0066CC', BLUE_D:'#2997FF' };
const fnt = (fam, size) => `${size}px "${fam}"`;
const clean = (s)=>String(s==null?'':s).replace(/\s+/g,' ').trim();
function drawTracked(ctx,x,y,t,tr){ for(const c of t){ctx.fillText(c,x,y); x+=ctx.measureText(c).width+tr;} return x; }
function trackedWidth(ctx,t,tr){ let w=0; for(const c of t) w+=ctx.measureText(c).width+tr; return w; }
function drawCentered(ctx,cx,y,t,tr){ const w=trackedWidth(ctx,t,tr)-tr; return drawTracked(ctx,cx-w/2,y,t,tr); }
function wrapText(ctx,text,maxw,tr){
  const units=(text||'').match(/[A-Za-z0-9.,%·\-]+|\s+|[\s\S]/g)||[]; const lines=[]; let cur='';
  for(const u of units){
    if(/^\s+$/.test(u)){ if(cur&&trackedWidth(ctx,cur+' ',tr)<=maxw)cur+=' '; else if(cur){lines.push(cur.replace(/\s+$/,''));cur='';} continue; }
    if(cur===''||trackedWidth(ctx,cur+u,tr)<=maxw)cur+=u; else{lines.push(cur.replace(/\s+$/,''));cur=u;}
  }
  if(cur.trim())lines.push(cur.replace(/\s+$/,'')); return lines;
}
function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function fmtDate(s){ if(!s) return ''; const d=new Date(s); if(isNaN(d.getTime())) return clean(s).slice(0,10); return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`; }

const RAW_ASSETS='https://raw.githubusercontent.com/topbanker99-ai/instagram/main';
let CHAR_IMG=null;   // 좌우반전 캐릭터 — 커버 우하단 (로드 실패 시 그냥 생략)
function drawCharFlipped(ctx, cxCenter, bottom, targetH, shadowAlpha){
  if(!CHAR_IMG) return;
  const r=targetH/CHAR_IMG.height, w=Math.round(CHAR_IMG.width*r), x=Math.round(cxCenter-w/2), y=bottom-targetH;
  ctx.save(); ctx.shadowColor=`rgba(0,0,0,${shadowAlpha})`; ctx.shadowBlur=36; ctx.shadowOffsetY=8;
  ctx.translate(x+w,y); ctx.scale(-1,1); ctx.drawImage(CHAR_IMG,0,0,w,targetH); ctx.restore();
}

/* ───────── 커버(자동 구성) ───────── */
function makeCover(createCanvas, dateLabel){
  const W=1080,M=100,CX=W/2;
  const main=COL.INK, body=COL.SOFT_L, cap=COL.CAP_L, accent=COL.BLUE_L;
  const canvas=createCanvas(W,W); const ctx=canvas.getContext('2d');
  ctx.fillStyle=COL.WHITE; ctx.fillRect(0,0,W,W); ctx.textBaseline='top';
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',29); drawCentered(ctx,CX,86,'TOP BANKER',5);
  let y=288;
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard Bold',40); drawCentered(ctx,CX,y,'이번 주 은행·금융 시사',-0.5); y+=88;
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',106);
  drawCentered(ctx,CX,y,'면접 출제',-1); y+=120;
  drawCentered(ctx,CX,y,'예상 질문',-1); y+=132;
  if(dateLabel){ ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',30); drawCentered(ctx,CX,y,dateLabel,0); y+=52; }
  ctx.strokeStyle=accent; ctx.globalAlpha=0.3; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(CX-64,y+6); ctx.lineTo(CX+64,y+6); ctx.stroke(); ctx.globalAlpha=1; y+=48;
  ctx.fillStyle=body; ctx.font=fnt('Pretendard SemiBold',34); drawCentered(ctx,CX,y,'면접관이 꼭 물어볼 이슈 3선',0);
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',26); drawCentered(ctx,CX,884,'은행·금융권 면접 대비 시사 카드',0);
  drawCharFlipped(ctx, 884, 1080, 380, 0.22);   // 커버 우하단 캐릭터
  return canvas.toBuffer('image/png');
}

/* ───────── 뉴스 카드 (라이트/다크 교차) ───────── */
function makeNewsCard(createCanvas, art, idx, total, dark){
  const W=1080,M=96,CW=W-2*M,CX=W/2;
  const bg=dark?COL.DARK:(idx%2===0?COL.PARCH:COL.WHITE);
  const main=dark?COL.WHITE:COL.INK, body=dark?COL.SOFT_D:COL.SOFT_L, cap=dark?COL.CAP_D:COL.CAP_L, accent=dark?COL.BLUE_D:COL.BLUE_L;
  const canvas=createCanvas(W,W); const ctx=canvas.getContext('2d');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,W); ctx.textBaseline='top';
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',28); drawCentered(ctx,CX,58,'TOP BANKER',5);
  const pg=`${String(idx).padStart(2,'0')} / ${String(total).padStart(2,'0')}`;
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard SemiBold',24); ctx.fillText(pg, W-M-trackedWidth(ctx,pg,0), 60);
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard SemiBold',31); drawCentered(ctx,CX,118,`면접 출제 예상질문   ${CIRC[idx-1]} / ${total}`,0);
  // 주제(타이틀) — 작은 캡션, 한 줄로 자동축소
  let topic=clean(art.title), ts=29; ctx.font=fnt('Pretendard Regular',ts);
  while(trackedWidth(ctx,topic,0)>CW&&ts>22){ ts-=2; ctx.font=fnt('Pretendard Regular',ts); }
  ctx.fillStyle=cap; drawCentered(ctx,CX,170,topic,0);
  // 예상 질문(히어로) — 블록을 가운데 두고, 블록 안에서는 좌측정렬(둘째 줄이 첫 줄 왼쪽에 맞춰짐)
  const q=clean(art.ai_comment).replace(/^예상\s*질문\s*[:：]\s*/,'');
  let hs=52,tr=-0.5; ctx.font=fnt('Pretendard Bold',hs); let ql=wrapText(ctx,q,CW,tr);
  while((ql.length>3||Math.max(...ql.map(l=>trackedWidth(ctx,l,tr)))>CW)&&hs>34){hs-=3;ctx.font=fnt('Pretendard Bold',hs);ql=wrapText(ctx,q,CW,tr);}
  ql=ql.slice(0,3);
  let y=262; ctx.fillStyle=main;
  const maxw=Math.max(...ql.map(l=>trackedWidth(ctx,l,tr)-tr)); const bl=Math.round(CX-maxw/2);
  for(const l of ql){ let x=bl; for(const ch of l){ ctx.fillText(ch,x,y); x+=ctx.measureText(ch).width+tr; } y+=Math.round(hs*1.22); }
  y+=22;
  ctx.strokeStyle=accent; ctx.globalAlpha=0.35; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(CX-54,y); ctx.lineTo(CX+54,y); ctx.stroke(); ctx.globalAlpha=1; y+=40;
  // 답변 포인트 박스(하단)
  const sm=clean(art.summary); const tint=dark?'rgba(41,151,255,0.16)':'#EAF2FB';
  const boxTop=Math.max(y,560);
  let ss=30, sl=[]; for(const f of [30,28,26,25,24]){ ctx.font=fnt('Pretendard Regular',f); const ls=wrapText(ctx,sm,CW-8,0); const h=Math.round(f*1.46); if(boxTop+96+ls.length*h<=1010||f===24){ ss=f; sl=ls; break; } }
  const lh=Math.round(ss*1.46);
  const maxLines=Math.max(1,Math.floor((1010-boxTop-96)/lh));
  if(sl.length>maxLines){ sl=sl.slice(0,maxLines); sl[maxLines-1]=sl[maxLines-1].replace(/\s*\S*$/,'')+'…'; }
  const boxH=96+sl.length*lh;
  roundRect(ctx,M-18,boxTop,CW+36,boxH,20); ctx.fillStyle=tint; ctx.fill();
  let by=boxTop+24; ctx.fillStyle=accent; ctx.font=fnt('Pretendard Bold',27); ctx.fillText('답변 포인트',M,by); by+=46;
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Regular',ss);
  for(const l of sl){ ctx.fillText(l,M,by); by+=lh; }
  return canvas.toBuffer('image/png');
}

/* ───────── 폰트 ───────── */
let fontsReady=false;
async function ensureFonts(GlobalFonts){
  if(fontsReady) return;
  const files=[['Pretendard-Regular.otf','Pretendard Regular'],['Pretendard-SemiBold.otf','Pretendard SemiBold'],['Pretendard-Bold.otf','Pretendard Bold']];
  for(const [f,n] of files){ const r=await fetch(PRETENDARD_BASE+f); if(!r.ok) throw new Error('폰트 다운로드 실패 '+f); GlobalFonts.register(Buffer.from(await r.arrayBuffer()),n); }
  fontsReady=true;
}

/* ───────── 뉴스 fetch / 선별 ───────── */
async function fetchNews(){
  const r=await fetch(NEWS_URL,{headers:{'accept':'application/json'}});
  if(!r.ok) throw new Error('뉴스 API 응답 오류 HTTP '+r.status);
  const j=await r.json(); const cats=(j&&j.categories)||{};
  const arr=k=>Array.isArray(cats[k])?cats[k]:[];
  return { updated_at:j&&j.updated_at, issue:arr('issue'), bank:arr('bank'), job:arr('job') };
}
function pickArticles(feed, posted, n){
  const pool=(feed.issue&&feed.issue.length)?feed.issue:[...feed.bank,...feed.job];  // '면접 시사' 우선
  const all=pool.filter(a=>a&&clean(a.title)&&clean(a.ai_comment));
  const seen=new Set(); const uniq=[];
  for(const a of all){ const k=a.link||a.title; if(seen.has(k))continue; seen.add(k); uniq.push(a); }
  const fresh=uniq.filter(a=>!posted.has(a.link||a.title));
  fresh.sort((x,y)=>{ const dx=Date.parse(x.pub_date)||0, dy=Date.parse(y.pub_date)||0; return dy-dx; });
  return fresh.slice(0,n);
}
async function readPosted(){
  try{ const {blobs}=await list({prefix:POSTED_KEY, token:process.env.BLOB_READ_WRITE_TOKEN});
    if(blobs&&blobs.length){ const r=await fetch(blobs[0].url+'?t='+Date.now()); if(r.ok){ const j=await r.json(); return new Set(j.links||[]); } } }catch(e){}
  return new Set();
}
async function writePosted(set){
  const links=[...set].slice(-800);
  await put(POSTED_KEY, JSON.stringify({links, updatedAt:new Date().toISOString()}), {access:'public',contentType:'application/json',addRandomSuffix:false,allowOverwrite:true,token:process.env.BLOB_READ_WRITE_TOKEN});
}

/* ───────── 캡션 ───────── */
function buildCaption(arts){
  const lines=arts.map((a,i)=>{ const q=clean(a.ai_comment).replace(/^예상\s*질문\s*[:：]\s*/,''); return `${CIRC[i]} ${clean(a.title)}\n   예상 질문: ${q}`; }).join('\n\n');
  const links=arts.map(a=>clean(a.link)).filter(Boolean);
  const linkBlock=links.length?`\n\n🔗 원문\n${links.join('\n')}`:'';
  const tags = buildTags('news');
  return `[면접관이 묻는다 — 이번 주 출제 예상 시사]\n은행·금융권 면접에서 나올 수 있는 핵심 이슈 ${arts.length}가지와 예상 질문을 정리했습니다. 캡처해두고 면접 전 답변을 미리 정리해보세요.\n\n${lines}${linkBlock}\n\n${tags}`;
}

/* ───────── 캐러셀 발행 (기존과 동일) ───────── */
async function publishCarousel(imageUrls, caption){
  const IG=process.env.IG_USER_ID, TOKEN=process.env.IG_ACCESS_TOKEN; const childIds=[];
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
  const auth=req.headers['authorization']||'';
  const manual=(req.query&&req.query.secret)||req.headers['x-publish-secret'];
  const cronOk=process.env.CRON_SECRET && auth===`Bearer ${process.env.CRON_SECRET}`;
  const manualOk=process.env.PUBLISH_SECRET && manual===process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401,{ok:false,error:'인증 실패'});

  const dryrun=req.query&&(req.query.dryrun==='1'||req.query.dryrun==='true');
  const n=Math.max(1,Math.min(5,parseInt((req.query&&req.query.n)||PER_POST,10)||PER_POST));
  try{
    if(!process.env.IG_USER_ID||!process.env.IG_ACCESS_TOKEN) return out(500,{ok:false,error:'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.'});

    const feed=await fetchNews();
    const posted=await readPosted();
    const arts=pickArticles(feed, posted, n);
    if(!arts.length) return out(200,{ok:true,skipped:true,reason:'새로 올릴 기사가 없습니다(이미 모두 발행).',posted:posted.size});

    let canvasMod; try{ canvasMod=require('@napi-rs/canvas'); }catch(e){ return out(500,{ok:false,error:'@napi-rs/canvas 로드 실패: '+e.message}); }
    const { createCanvas, GlobalFonts }=canvasMod;
    await ensureFonts(GlobalFonts);
    if(!CHAR_IMG){ try{ const r=await fetch(`${RAW_ASSETS}/character.png`); if(r.ok) CHAR_IMG=await canvasMod.loadImage(Buffer.from(await r.arrayBuffer())); }catch(e){} }

    const dateLabel=`${fmtDate(feed.updated_at||new Date().toISOString())} 기준`;
    const total=1+arts.length;            // 페이지 번호용(커버+뉴스). 마무리 이미지는 별도.
    const folder=`news/${Date.now()}`; const imageUrls=[];
    // 커버
    let cov=await put(`${folder}/1.png`, makeCover(createCanvas,dateLabel), {access:'public',contentType:'image/png',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN});
    imageUrls.push(cov.url);
    // 뉴스 카드
    for(let i=0;i<arts.length;i++){
      const idx=i+2, dark=(idx%2===0);
      const b=makeNewsCard(createCanvas, arts[i], i+1, arts.length, dark);
      const bl=await put(`${folder}/${idx}.png`, b, {access:'public',contentType:'image/png',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN});
      imageUrls.push(bl.url);
    }
    // 마무리(네이버 프리미엄 안내) 이미지
    if(OUTRO){ try{
      const ob=Buffer.from(OUTRO.split(',')[1],'base64');
      const obl=await put('assets/outro.png', ob, {access:'public',contentType:'image/png',addRandomSuffix:false,allowOverwrite:true,token:process.env.BLOB_READ_WRITE_TOKEN});
      imageUrls.push(obl.url);
    }catch(e){} }
    const caption=buildCaption(arts);

    if(dryrun){
      const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const imgs=imageUrls.map((u,i)=>`<img src="${u}" alt="card ${i+1}" style="width:100%;border-radius:12px;margin-bottom:10px;background:#000">`).join('');
      const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>미리보기</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif;text-align:center"><div style="max-width:480px;margin:0 auto;padding:18px"><div style="color:#2997ff;font-weight:700;font-size:16px">미리보기 (아직 발행 안 됨)</div><div style="color:#8a8a90;font-size:13px;margin:6px 0 14px">금융뉴스 면접 예상질문 · ${esc(arts.length)}건</div>${imgs}<div style="background:#16161a;border-radius:12px;padding:14px;margin-top:8px;font-size:14px;line-height:1.5">마음에 들면 → 주소창에서 <b style="color:#fff">&amp;dryrun=1</b> 을 지우고 다시 접속하면 <b style="color:#2997ff">실제로 발행</b>됩니다.</div><details style="margin-top:14px;text-align:left"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">캡션 보기</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(caption)}</pre></details></div></body></html>`;
      res.statusCode=200; res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html); return;
    }

    const mediaId=await publishCarousel(imageUrls, caption);
    for(const a of arts) posted.add(a.link||a.title);
    await writePosted(posted);
    return out(200,{ok:true,mediaId,count:arts.length,titles:arts.map(a=>clean(a.title)),cards:imageUrls.length});
  }catch(err){
    return out(500,{ok:false,error:(err&&err.message)?err.message:String(err)});
  }
};
