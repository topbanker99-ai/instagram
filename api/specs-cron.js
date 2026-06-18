// api/specs-cron.js
// 탑뱅커 — 은행권 합격자 스펙 카드뉴스 자동 발행 (격주 일요일 12:00 KST)
//
// 묶음: 은행 · 시기 · 직군(전형) 단위. 한 게시물 = 커버 1장 + 합격자 5명씩 스펙카드 (총 3~4장).
// 발행: 일요일마다 실행되지만, 마지막 발행 후 13일이 안 지났으면 건너뜀 → 결과적으로 "격주".
//
// 인증:
//   - Vercel Cron: Authorization: Bearer ${CRON_SECRET}   (자동)
//   - 수동 테스트: ?secret=${PUBLISH_SECRET}   또는  헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1 : 카드 생성 + Blob 업로드까지만(미리보기). 발행/진도 갱신 안 함.
//   - ?force=1  : 격주 대기(13일)를 무시하고 즉시 발행(수동 테스트용).
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 의존: ./blob-bundle.js, ./specs.json, @napi-rs/canvas

const { put, list } = require('./blob-bundle.js');
const { buildTags } = require('./hashtags.js');
const SPECS = require('./specs.json');
let OUTRO=null; try{ OUTRO=require('./outro-image.js'); }catch(e){}   // 없어도 크래시 안 나도록

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PROGRESS_KEY = 'specs-progress.json';
const MIN_DAYS = 13;            // 격주: 마지막 발행 후 이 일수 미만이면 스킵
const PER_CARD = 5;             // 스펙카드 1장당 인원
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';
const CIRC = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮'];

/* ───────── 공통 텍스트 헬퍼 (glossary-cron.js와 동일) ───────── */
const COL = { WHITE:'#FFFFFF', PARCH:'#F5F5F7', DARK:'#1D1D1F', INK:'#1D1D1F',
  SOFT_L:'#3C3C3E', SOFT_D:'#D0D0D2', CAP_L:'#8A8A8E', CAP_D:'#9A9AA0', BLUE_L:'#0066CC', BLUE_D:'#2997FF' };
const fnt = (fam, size) => `${size}px "${fam}"`;
function drawTracked(ctx,x,y,t,tr){ for(const c of t){ctx.fillText(c,x,y); x+=ctx.measureText(c).width+tr;} return x; }
function trackedWidth(ctx,t,tr){ let w=0; for(const c of t) w+=ctx.measureText(c).width+tr; return w; }
function drawCentered(ctx,cx,y,t,tr){ const w=trackedWidth(ctx,t,tr)-tr; return drawTracked(ctx,cx-w/2,y,t,tr); }
function wrapText(ctx,text,maxw,tr){
  const units = (text||'').match(/[A-Za-z0-9.%·\-]+|\s+|[\s\S]/g) || [];
  const lines=[]; let cur='';
  for(const u of units){
    if(/^\s+$/.test(u)){ if(cur&&trackedWidth(ctx,cur+' ',tr)<=maxw)cur+=' '; else if(cur){lines.push(cur.replace(/\s+$/,''));cur='';} continue; }
    if(cur===''||trackedWidth(ctx,cur+u,tr)<=maxw)cur+=u; else{lines.push(cur.replace(/\s+$/,''));cur=u;}
  }
  if(cur.trim())lines.push(cur.replace(/\s+$/,''));
  return lines;
}
function evenSplit(n,mx){ const k=Math.ceil(n/mx), base=Math.floor(n/k), r=n%k, a=[]; for(let i=0;i<k;i++)a.push(base+(i<r?1:0)); return a; }
const clean = (s) => (s||'').trim();
const has = (s) => { s=clean(s); return s && s!=='-' && s!=='–'; };
// "없음/미보유" 류는 표시에서 제외 (단, 괄호 등 부가정보가 있으면 유지)
function meaningful(s){
  s=clean(s); if(!s||s==='-'||s==='–') return false;
  if(/^(없음|미보유|미기재|해당\s*없음)$/.test(s)) return false;
  if(/^[가-힣A-Za-z·\s]+없음$/.test(s) && s.length<=12) return false;
  return true;
}

/* ───────── 커버 카드 (라이트) ───────── */
function makeCover(createCanvas, post, total){
  const W=1080,M=110,CW=W-2*M,CX=W/2;
  const main=COL.INK, body=COL.SOFT_L, cap=COL.CAP_L, accent=COL.BLUE_L;
  const canvas=createCanvas(W,W); const ctx=canvas.getContext('2d');
  ctx.fillStyle=COL.WHITE; ctx.fillRect(0,0,W,W); ctx.textBaseline='top';
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',29); drawCentered(ctx,CX,86,'TOP BANKER',5);
  let y=300;
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard Bold',40); drawCentered(ctx,CX,y,'은행권 합격자 스펙',-0.5); y+=84;
  let hs=92,tr=-hs*0.02; ctx.font=fnt('Pretendard Bold',hs);
  while(trackedWidth(ctx,post.bank,tr)>CW&&hs>52){hs-=4;tr=-hs*0.02;ctx.font=fnt('Pretendard Bold',hs);}
  ctx.fillStyle=main; drawCentered(ctx,CX,y,post.bank,tr); y+=Math.round(hs*1.08)+10;
  const partTxt=post.parts>1?`   (${post.part}/${post.parts})`:'';
  const capline=`${post.period} · ${post.group}${post.region?(' · '+post.region):''}${partTxt}`;
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',30);
  for(const ln of wrapText(ctx,capline,CW,0)){ drawCentered(ctx,CX,y,ln,0); y+=42; } y+=24;
  ctx.strokeStyle=accent; ctx.globalAlpha=0.3; ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(CX-64,y); ctx.lineTo(CX+64,y); ctx.stroke(); ctx.globalAlpha=1; y+=42;
  ctx.fillStyle=body; ctx.font=fnt('Pretendard SemiBold',33);
  drawCentered(ctx,CX,y,`합격자 ${post.people.length}명 스펙`,0);
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard Regular',26);
  drawCentered(ctx,CX,872,'학교 · 학점 · 어학 · 자격증 · 인턴 / 경력',0);
  const pg=`01 / ${String(total).padStart(2,'0')}`;
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard SemiBold',28);
  ctx.fillText(pg, W-M-trackedWidth(ctx,pg,0), 992);
  return canvas.toBuffer('image/png');
}

/* ───────── 스펙 카드 (라이트/다크 교차) ───────── */
function makeSpecCard(createCanvas, people, startNum, idx, total, dark, post){
  const W=1080,M=110,CW=W-2*M,CX=W/2;
  const bg=dark?COL.DARK:(idx%2===0?COL.PARCH:COL.WHITE);
  const main=dark?COL.WHITE:COL.INK, body=dark?COL.SOFT_D:COL.SOFT_L, cap=dark?COL.CAP_D:COL.CAP_L, accent=dark?COL.BLUE_D:COL.BLUE_L;
  const canvas=createCanvas(W,W); const ctx=canvas.getContext('2d');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,W); ctx.textBaseline='top';
  ctx.fillStyle=main; ctx.font=fnt('Pretendard Bold',29); drawCentered(ctx,CX,64,'TOP BANKER',5);
  const range=`${CIRC[startNum-1]}~${CIRC[startNum-1+people.length-1]}`;
  ctx.fillStyle=accent; ctx.font=fnt('Pretendard SemiBold',34);
  drawCentered(ctx,CX,128,`${post.bank} 합격 스펙    ${range}`,0);
  ctx.strokeStyle=cap; ctx.globalAlpha=0.3; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(M,198); ctx.lineTo(W-M,198); ctx.stroke(); ctx.globalAlpha=1;
  const bodyTop=226, bodyBottom=980, n=people.length, slotH=(bodyBottom-bodyTop)/n;
  for(let s=0;s<n;s++){
    const p=people[s]; let y=bodyTop+s*slotH+6;
    const num=CIRC[startNum-1+s]||'';
    const ident=(has(p.school)?p.school:(has(p.major)?p.major:'비공개'));
    let head=ident; if(has(p.age)) head+=`   ·   ${clean(p.age)}`;
    let hs=33; ctx.font=fnt('Pretendard SemiBold',hs);
    while(ctx.measureText(num+' ').width+trackedWidth(ctx,head,0)>CW&&hs>25){hs-=2;ctx.font=fnt('Pretendard SemiBold',hs);}
    ctx.fillStyle=accent; ctx.fillText(num+' ', M, y);
    const nx=M+ctx.measureText(num+' ').width;
    ctx.fillStyle=main; ctx.fillText(head, nx, y);
    const headLH=Math.round(hs*1.18);
    const parts=[];
    if(has(p.gpa)) parts.push('학점 '+clean(p.gpa));
    if(meaningful(p.lang)) parts.push('어학 '+clean(p.lang));
    if(meaningful(p.cert)) parts.push('자격증 '+clean(p.cert));
    if(meaningful(p.intern)) parts.push('경력 '+clean(p.intern));
    const detail=parts.join('    ·    ');
    const ds=26, dlh=35; ctx.font=fnt('Pretendard Regular',ds); ctx.fillStyle=body;
    const budget=Math.max(1,Math.floor((slotH-headLH-12)/dlh));
    let dl=wrapText(ctx,detail,CW,0);
    if(dl.length>budget){ dl=dl.slice(0,budget); dl[budget-1]=dl[budget-1].replace(/\s*\S*$/,'')+'…'; }
    let dy=y+headLH+2;
    for(const ln of dl){ ctx.fillText(ln,M,dy); dy+=dlh; }
  }
  const pg=`${String(idx).padStart(2,'0')} / ${String(total).padStart(2,'0')}`;
  ctx.fillStyle=cap; ctx.font=fnt('Pretendard SemiBold',28);
  ctx.fillText(pg, W-M-trackedWidth(ctx,pg,0), 992);
  return canvas.toBuffer('image/png');
}

/* ───────── 폰트 1회 로드 ───────── */
let fontsReady=false;
async function ensureFonts(GlobalFonts){
  if(fontsReady) return;
  const files=[['Pretendard-Regular.otf','Pretendard Regular'],['Pretendard-SemiBold.otf','Pretendard SemiBold'],['Pretendard-Bold.otf','Pretendard Bold']];
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
      if(r.ok){ const j = await r.json(); return { nextPostIndex:Number(j.nextPostIndex)||0, lastPublishedAt:j.lastPublishedAt||null }; }
    }
  }catch(e){}
  return { nextPostIndex:0, lastPublishedAt:null };
}
async function writeProgress(nextPostIndex){
  await put(PROGRESS_KEY, JSON.stringify({ nextPostIndex, lastPublishedAt:new Date().toISOString() }), {
    access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/* ───────── 캡션 ───────── */
function buildCaption(post){
  const partTxt=post.parts>1?` (${post.part}/${post.parts})`:'';
  const bankTag='#'+post.bank.replace(/\s/g,'');
  const tags = buildTags('specs', { bank: bankTag });
  return `[은행권 합격자 스펙 — ${post.bank}]\n${post.period} · ${post.group}${partTxt}\n\n해당 전형 합격자 ${post.groupCount}명의 학교 · 학점 · 어학 · 자격증 · 인턴/경력을 정리했습니다.\n캡처해두고 본인 스펙과 비교해보세요. 자소서 · 필기 · 면접 준비는 프로필 링크에서.\n\n${tags}`;
}

/* ───────── IG 캐러셀 발행 (glossary-cron.js와 동일) ───────── */
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
  const auth=req.headers['authorization']||'';
  const manual=(req.query&&req.query.secret)||req.headers['x-publish-secret'];
  const cronOk=process.env.CRON_SECRET && auth===`Bearer ${process.env.CRON_SECRET}`;
  const manualOk=process.env.PUBLISH_SECRET && manual===process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401,{ok:false,error:'인증 실패'});

  const dryrun=req.query&&(req.query.dryrun==='1'||req.query.dryrun==='true');
  const force=req.query&&(req.query.force==='1'||req.query.force==='true');
  try{
    if(!process.env.IG_USER_ID||!process.env.IG_ACCESS_TOKEN) return out(500,{ok:false,error:'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.'});
    const posts=SPECS.posts||[]; const total=posts.length;
    if(!total) return out(500,{ok:false,error:'specs.json 에 posts가 없습니다.'});

    let { nextPostIndex, lastPublishedAt } = await readProgress();
    if(nextPostIndex>=total||nextPostIndex<0) nextPostIndex=0;

    // 격주 게이트: 마지막 발행 후 13일 미만이면 스킵 (dryrun/force 제외)
    if(!dryrun && !force && lastPublishedAt){
      const days=(Date.now()-Date.parse(lastPublishedAt))/86400000;
      if(days < MIN_DAYS) return out(200,{ok:true,skipped:true,reason:`격주 대기중 (마지막 발행 후 ${days.toFixed(1)}일, ${MIN_DAYS}일 경과 시 발행)`,nextPostIndex});
    }

    let canvasMod;
    try{ canvasMod=require('@napi-rs/canvas'); }catch(e){ return out(500,{ok:false,error:'@napi-rs/canvas 로드 실패: '+e.message}); }
    const { createCanvas, GlobalFonts }=canvasMod;
    await ensureFonts(GlobalFonts);

    const post=posts[nextPostIndex];
    const sizes=evenSplit(post.people.length, PER_CARD);
    const totalCards=1+sizes.length;

    const folder=`specs/${Date.now()}`;
    const imageUrls=[];
    // 커버
    let buf=makeCover(createCanvas, post, totalCards);
    let blob=await put(`${folder}/1.png`, buf, {access:'public',contentType:'image/png',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN});
    imageUrls.push(blob.url);
    // 스펙 카드들
    let startNum=1, cardIdx=2;
    for(const sz of sizes){
      const chunk=post.people.slice(startNum-1, startNum-1+sz);
      const dark=(cardIdx%2===0);                         // 커버(1)라이트 → 2다크/3라이트/4다크
      const b=makeSpecCard(createCanvas, chunk, startNum, cardIdx, totalCards, dark, post);
      const bl=await put(`${folder}/${cardIdx}.png`, b, {access:'public',contentType:'image/png',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN});
      imageUrls.push(bl.url);
      startNum+=sz; cardIdx++;
    }
    // 마무리(프리미엄/구독 안내) 이미지 — 모든 게시물 끝에 추가
    try{
      const ob=Buffer.from(OUTRO.split(',')[1],'base64');
      const obl=await put('assets/outro.png', ob, {access:'public',contentType:'image/png',addRandomSuffix:false,allowOverwrite:true,token:process.env.BLOB_READ_WRITE_TOKEN});
      imageUrls.push(obl.url);
    }catch(e){}
    const caption=buildCaption(post);

    if(dryrun){
      const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const imgs=imageUrls.map((u,i)=>`<img src="${u}" alt="card ${i+1}" style="width:100%;border-radius:12px;margin-bottom:10px;background:#000">`).join('');
      const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>미리보기</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif;text-align:center"><div style="max-width:480px;margin:0 auto;padding:18px"><div style="color:#2997ff;font-weight:700;font-size:16px">미리보기 (아직 발행 안 됨)</div><div style="color:#8a8a90;font-size:13px;margin:6px 0 14px">${esc(post.bank+' · '+post.period+' · '+post.group+(post.parts>1?' ('+post.part+'/'+post.parts+')':''))}</div>${imgs}<div style="background:#16161a;border-radius:12px;padding:14px;margin-top:8px;font-size:14px;line-height:1.5">마음에 들면 → 주소창에서 <b style="color:#fff">&amp;dryrun=1</b> 을 지우고 다시 접속하면 <b style="color:#2997ff">실제로 발행</b>됩니다.</div><details style="margin-top:14px;text-align:left"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">캡션 보기</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(caption)}</pre></details></div></body></html>`;
      res.statusCode=200; res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html); return;
    }

    const mediaId=await publishCarousel(imageUrls, caption);
    const next=(nextPostIndex+1)%total;
    await writeProgress(next);
    return out(200,{ok:true,forced:!!force,mediaId,post:`${post.bank} · ${post.period} · ${post.group} (${post.part}/${post.parts})`,cards:totalCards,index:nextPostIndex,nextPostIndex:next,totalPosts:total,imageUrls});
  }catch(err){
    return out(500,{ok:false,error:(err&&err.message)?err.message:String(err)});
  }
};
