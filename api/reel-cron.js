// api/reel-cron.js
// 탑뱅커 — 합격스펙 / 금융상식 릴스 자동 발행 (세로 9:16 영상)
//
// 매 실행마다 스펙 릴스 ↔ 상식 릴스를 번갈아 1편 발행합니다.
// 영상은 서버에서 생성: canvas로 장면 PNG 렌더 → ffmpeg로 배경음악과 합쳐 MP4 → Blob 업로드 → 릴스 발행.
//
// 인증:
//   - Vercel Cron: Authorization: Bearer ${CRON_SECRET}   (자동)
//   - 수동 테스트: ?secret=${PUBLISH_SECRET}   또는  헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1        : 영상 생성 + Blob 업로드까지만(미리보기). 발행/진도 갱신 안 함. videoUrl 반환.
//   - ?kind=spec|glossary : 이번 영상 종류 강제 지정(기본은 자동 교대)
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 의존: ./blob-bundle.js, ./specs.json, ./glossary.json, ./reel-music.js, @napi-rs/canvas, ffmpeg-static

const { put, list } = require('./blob-bundle.js');
const SPECS = require('./specs.json');
const TERMS = require('./glossary.json');
let OUTRO=null; try{ OUTRO=require('./outro-image.js'); }catch(e){}   // 없어도 크래시 안 나도록

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PROGRESS_KEY = 'reel-progress.json';
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';
const CIRC = ['①','②','③','④','⑤'];

/* ───────── 다크 테마 + 텍스트 헬퍼 ───────── */
const COL = { BG:'#0B0B0D', WHITE:'#FFFFFF', BODY:'#C9C9CE', CAP:'#8A8A90', ACCENT:'#2997FF' };
const fnt = (fam, size) => `${size}px "${fam}"`;
const clean = (s)=>(s||'').trim();
const has = (s)=>{ s=clean(s); return s && s!=='-' && s!=='–'; };
function meaningful(s){ s=clean(s); if(!s||s==='-'||s==='–')return false; if(/^(없음|미보유|미기재|해당\s*없음)$/.test(s))return false; if(/^[가-힣A-Za-z·\s]+없음$/.test(s)&&s.length<=12)return false; return true; }
function drawTracked(ctx,x,y,t,tr){ for(const c of t){ctx.fillText(c,x,y); x+=ctx.measureText(c).width+tr;} return x; }
function trackedWidth(ctx,t,tr){ let w=0; for(const c of t) w+=ctx.measureText(c).width+tr; return w; }
function drawCentered(ctx,cx,y,t,tr){ const w=trackedWidth(ctx,t,tr)-tr; return drawTracked(ctx,cx-w/2,y,t,tr); }
function wrapText(ctx,text,maxw,tr){
  const units=(text||'').match(/[A-Za-z0-9.%·\-]+|\s+|[\s\S]/g)||[]; const lines=[]; let cur='';
  for(const u of units){
    if(/^\s+$/.test(u)){ if(cur&&trackedWidth(ctx,cur+' ',tr)<=maxw)cur+=' '; else if(cur){lines.push(cur.replace(/\s+$/,''));cur='';} continue; }
    if(cur===''||trackedWidth(ctx,cur+u,tr)<=maxw)cur+=u; else{lines.push(cur.replace(/\s+$/,''));cur=u;}
  }
  if(cur.trim())lines.push(cur.replace(/\s+$/,'')); return lines;
}

/* ───────── 장면 렌더 (1080×1920) ───────── */
function renderScene(createCanvas, sc){
  const W=1080,H=1920,M=100,CW=W-2*M,CX=W/2;
  const canvas=createCanvas(W,H); const ctx=canvas.getContext('2d');
  ctx.fillStyle=COL.BG; ctx.fillRect(0,0,W,H); ctx.textBaseline='top';
  const {WHITE,BODY,CAP,ACCENT}=COL;
  ctx.fillStyle=CAP; ctx.font=fnt('Pretendard SemiBold',30); drawCentered(ctx,CX,154,'TOP BANKER',6);

  if(sc.type==='hook'){
    ctx.strokeStyle=ACCENT; ctx.lineWidth=5; ctx.beginPath(); ctx.moveTo(CX-58,752); ctx.lineTo(CX+58,752); ctx.stroke();
    let hs=108; ctx.font=fnt('Pretendard Bold',hs);
    const w=()=>Math.max(...sc.lines.map(l=>trackedWidth(ctx,l.t,-1)));
    while(w()>CW&&hs>60){hs-=4;ctx.font=fnt('Pretendard Bold',hs);}
    const lh=Math.round(hs*1.2); let y=900-(sc.lines.length*lh)/2;
    for(const l of sc.lines){ ctx.fillStyle=l.accent?ACCENT:WHITE; ctx.font=fnt('Pretendard Bold',hs); drawCentered(ctx,CX,y,l.t,-1); y+=lh; }
    if(sc.sub){ ctx.fillStyle=CAP; ctx.font=fnt('Pretendard Regular',40); drawCentered(ctx,CX,y+34,sc.sub,0); }
  }
  else if(sc.type==='spec'){
    ctx.fillStyle=ACCENT; ctx.font=fnt('Pretendard SemiBold',42); drawCentered(ctx,CX,320,sc.label,0);
    let hs=88,tr=-1; ctx.font=fnt('Pretendard Bold',hs);
    while(trackedWidth(ctx,sc.identity,tr)>CW&&hs>50){hs-=4;ctx.font=fnt('Pretendard Bold',hs);}
    ctx.fillStyle=WHITE; drawCentered(ctx,CX,420,sc.identity,tr);
    let y=420+Math.round(hs*1.1)+8;
    if(sc.age){ ctx.fillStyle=CAP; ctx.font=fnt('Pretendard Regular',40); drawCentered(ctx,CX,y,sc.age,0); y+=70; }
    y+=44;
    for(const r of sc.rows){
      ctx.fillStyle=ACCENT; ctx.font=fnt('Pretendard SemiBold',38); ctx.fillText(r.label,M,y);
      const lx=M+Math.max(132,trackedWidth(ctx,r.label,0)+30);
      ctx.fillStyle=WHITE; ctx.font=fnt('Pretendard Regular',42);
      const vls=wrapText(ctx,r.value,CW-(lx-M),0); let vy=y;
      for(const vl of vls){ ctx.fillText(vl,lx,vy); vy+=56; }
      y=vy+22;
    }
  }
  else if(sc.type==='term'){
    ctx.fillStyle=ACCENT; ctx.font=fnt('Pretendard SemiBold',44); drawCentered(ctx,CX,540,sc.label,0);
    let hs=100,tr=-1; ctx.font=fnt('Pretendard Bold',hs);
    let lns=wrapText(ctx,sc.name,CW,tr);
    while((lns.length>2||Math.max(...lns.map(l=>trackedWidth(ctx,l,tr)))>CW)&&hs>54){hs-=4;ctx.font=fnt('Pretendard Bold',hs);lns=wrapText(ctx,sc.name,CW,tr);}
    let y=648; ctx.fillStyle=WHITE;
    for(const l of lns){ drawCentered(ctx,CX,y,l,tr); y+=Math.round(hs*1.14); }
    if(sc.section){ ctx.fillStyle=CAP; ctx.font=fnt('Pretendard Regular',38); for(const l of wrapText(ctx,sc.section,CW,0)){drawCentered(ctx,CX,y+20,l,0);y+=50;} }
  }
  else if(sc.type==='def'){
    let ns=46; ctx.font=fnt('Pretendard SemiBold',ns);
    let nls=wrapText(ctx,sc.name,CW,-0.5);
    while(nls.length>2&&ns>34){ns-=3;ctx.font=fnt('Pretendard SemiBold',ns);nls=wrapText(ctx,sc.name,CW,-0.5);}
    let y=300; ctx.fillStyle=ACCENT; for(const l of nls){drawCentered(ctx,CX,y,l,-0.5);y+=Math.round(ns*1.2);}
    const top=y+44, bottom=1560, avail=bottom-top;
    let bf=50,lines=[]; for(const f of [50,46,42,38,34,30]){ ctx.font=fnt('Pretendard Regular',f); const ls=wrapText(ctx,sc.def,CW,0); const h=Math.round(f*1.5); if(ls.length*h<=avail||f===30){bf=f;lines=ls;break;} }
    const lh=Math.round(bf*1.5); ctx.fillStyle=BODY; ctx.font=fnt('Pretendard Regular',bf);
    let by=top+Math.max(0,(avail-lines.length*lh)/2);
    for(const l of lines){ ctx.fillText(l,M,by); by+=lh; }
  }
  else if(sc.type==='termdef'){
    ctx.fillStyle=ACCENT; ctx.font=fnt('Pretendard SemiBold',42); drawCentered(ctx,CX,248,'오늘의 금융상식',0);
    let hs=72,tr=-1; ctx.font=fnt('Pretendard Bold',hs);
    let nls=wrapText(ctx,sc.name,CW,tr);
    while((nls.length>2||Math.max(...nls.map(l=>trackedWidth(ctx,l,tr)))>CW)&&hs>44){hs-=4;ctx.font=fnt('Pretendard Bold',hs);nls=wrapText(ctx,sc.name,CW,tr);}
    let y=332; ctx.fillStyle=WHITE;
    for(const l of nls){ drawCentered(ctx,CX,y,l,tr); y+=Math.round(hs*1.12); }
    if(sc.section){ ctx.fillStyle=CAP; ctx.font=fnt('Pretendard Regular',34); for(const l of wrapText(ctx,sc.section,CW,0)){drawCentered(ctx,CX,y+8,l,0); y+=46;} }
    y+=30;
    ctx.strokeStyle=ACCENT; ctx.globalAlpha=0.35; ctx.lineWidth=4; ctx.beginPath(); ctx.moveTo(CX-56,y); ctx.lineTo(CX+56,y); ctx.stroke(); ctx.globalAlpha=1; y+=46;
    const top=y, bottom=1584, avail=bottom-top;
    let bf=46,lines2=[]; for(const f of [46,44,42,40,38,36,34,32]){ ctx.font=fnt('Pretendard Regular',f); const ls=wrapText(ctx,sc.def,CW,0); const h=Math.round(f*1.5); if(ls.length*h<=avail||f===32){bf=f;lines2=ls;break;} }
    const lh2=Math.round(bf*1.5); ctx.fillStyle=BODY; ctx.font=fnt('Pretendard Regular',bf);
    let by2=top; for(const l of lines2){ ctx.fillText(l,M,by2); by2+=lh2; }
  }
  else if(sc.type==='cta'){
    let hs=92; ctx.font=fnt('Pretendard Bold',hs); const lh=Math.round(hs*1.18);
    let y=760-(sc.lines.length*lh)/2;
    for(const l of sc.lines){ ctx.fillStyle=l.accent?ACCENT:WHITE; ctx.font=fnt('Pretendard Bold',hs); drawCentered(ctx,CX,y,l.t,-1); y+=lh; }
    if(sc.handle){ ctx.fillStyle=ACCENT; ctx.font=fnt('Pretendard SemiBold',56); drawCentered(ctx,CX,y+34,sc.handle,0); y+=120; }
    if(sc.sub){ ctx.fillStyle=CAP; ctx.font=fnt('Pretendard Regular',38); for(const l of wrapText(ctx,sc.sub,CW,0)){drawCentered(ctx,CX,y,l,0);y+=52;} }
  }
  return canvas.toBuffer('image/png');
}

/* ───────── 장면 구성 ───────── */
function specRows(p){
  const rows=[];
  if(has(p.gpa)) rows.push({label:'학점',value:clean(p.gpa)});
  if(meaningful(p.lang)) rows.push({label:'어학',value:clean(p.lang)});
  if(meaningful(p.cert)) rows.push({label:'자격증',value:clean(p.cert)});
  if(meaningful(p.intern)) rows.push({label:'경력',value:clean(p.intern)});
  return rows.slice(0,4);
}
function buildSpecScenes(post){
  const ppl=post.people.slice(0,5);
  const scenes=[];
  scenes.push({type:'hook', dur:2.8, lines:[{t:'이 스펙으로'},{t:post.bank,accent:true},{t:'합격했습니다'}], sub:`${post.period} · ${post.group}`});
  ppl.forEach((p,i)=>{
    const ident=(has(p.school)?p.school:(has(p.major)?p.major:'비공개'));
    scenes.push({type:'spec', dur:3.0, label:`${post.bank} 합격 스펙   ${CIRC[i]} / ${ppl.length}`,
      identity:ident, age:has(p.age)?clean(p.age):'', rows:specRows(p)});
  });
  scenes.push({type:'cta', dur:2.8, lines:[{t:'내 스펙은'},{t:'어디쯤일까?',accent:true}], handle:'@topbanker99', sub:'전체 합격 스펙은 프로필에서  ·  자소서 · 필기 · 면접 컨설팅'});
  return scenes;
}
function buildGlossaryScenes(term){
  const section=clean((term.section||'').replace(/\s{2,}.*$/,''));
  return [
    {type:'hook', dur:2.8, lines:[{t:'은행 면접'},{t:'이 단어 모르면',accent:true},{t:'탈락합니다'}], sub:'합격자는 다 아는 금융상식'},
    {type:'termdef', dur:8.4, name:term.name, section, def:clean(term.definition)},   // 제목+내용 한 페이지 · 노출 3배
    {type:'cta', dur:2.8, lines:[{t:'금융상식'},{t:'매주 월·수·금',accent:true}], handle:'@topbanker99', sub:'은행·금융권 취업 컨설팅  ·  탑뱅커'},
  ];
}

/* ───────── 영상 생성 (ffmpeg) ───────── */
async function buildReel(canvasMod, scenes){
  const { createCanvas, loadImage }=canvasMod;
  const os=require('os'), fs=require('fs'), path=require('path'), { execFileSync }=require('child_process');
  let FFMPEG=process.env.FFMPEG_PATH || require('ffmpeg-static');
  if(!process.env.FFMPEG_PATH){
    // Vercel의 /var/task는 읽기전용 → ffmpeg 바이너리를 /tmp로 복사한 뒤 실행권한 부여
    try{
      const tmpBin=path.join(os.tmpdir(),'ffmpeg');
      if(!fs.existsSync(tmpBin)) fs.copyFileSync(FFMPEG, tmpBin);
      fs.chmodSync(tmpBin, 0o755);
      FFMPEG=tmpBin;
    }catch(e){ try{ fs.chmodSync(FFMPEG,0o755); }catch(_){} }
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reel-'));
  try{
    const music=require('./reel-music.js');
    fs.writeFileSync(path.join(dir,'music.mp3'), Buffer.from(music.split(',')[1],'base64'));
    let listTxt='', total=0, outroFrame=null;
    for(let i=0;i<scenes.length;i++){
      const sc=scenes[i]; let buf;
      if(sc.type==='outro'){
        if(!OUTRO) continue;   // 마무리 이미지 파일이 없으면 그 장면만 건너뜀
        if(!outroFrame){
          const oc=createCanvas(1080,1920); const octx=oc.getContext('2d');
          octx.fillStyle='#1D1D1F'; octx.fillRect(0,0,1080,1920);
          const img=await loadImage(Buffer.from(OUTRO.split(',')[1],'base64'));
          octx.drawImage(img,0,Math.round((1920-1080)/2),1080,1080);
          outroFrame=oc.toBuffer('image/png');
        }
        buf=outroFrame;
      } else { buf=renderScene(createCanvas,sc); }
      const p=path.join(dir,`f${i}.png`); fs.writeFileSync(p,buf);
      listTxt+=`file '${p}'\nduration ${sc.dur}\n`; total+=sc.dur;
    }
    listTxt+=`file '${path.join(dir,`f${scenes.length-1}.png`)}'\n`; // concat demuxer: 마지막 프레임 반복
    fs.writeFileSync(path.join(dir,'list.txt'), listTxt);
    const out=path.join(dir,'out.mp4');
    const fadeOut=Math.max(0.1,total-0.6).toFixed(2);
    const afOut=Math.max(0.1,total-1.0).toFixed(2);
    const vf=`scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.5`;
    execFileSync(FFMPEG,['-y','-f','concat','-safe','0','-i',path.join(dir,'list.txt'),'-i',path.join(dir,'music.mp3'),
      '-vf',vf,'-af',`afade=t=out:st=${afOut}:d=1.0`,'-c:v','libx264','-profile:v','high','-pix_fmt','yuv420p','-r','30',
      '-c:a','aac','-b:a','128k','-t',total.toFixed(2),'-movflags','+faststart',out],{stdio:'ignore'});
    return fs.readFileSync(out);
  } finally {
    try{ fs.rmSync(dir,{recursive:true,force:true}); }catch(e){}
  }
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
async function readProgress(){
  try{
    const { blobs }=await list({ prefix:PROGRESS_KEY, token:process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs&&blobs.length){ const r=await fetch(blobs[0].url+'?t='+Date.now()); if(r.ok){ const j=await r.json();
      return { nextKind:j.nextKind||'spec', specIndex:Number(j.specIndex)||0, glossaryIndex:Number(j.glossaryIndex)||0 }; } }
  }catch(e){}
  return { nextKind:'spec', specIndex:0, glossaryIndex:0 };
}
async function writeProgress(p){
  await put(PROGRESS_KEY, JSON.stringify({ ...p, lastPublishedAt:new Date().toISOString() }), {
    access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true, token:process.env.BLOB_READ_WRITE_TOKEN });
}

/* ───────── 캡션 ───────── */
function specCaption(post){
  const tag='#'+post.bank.replace(/\s/g,'');
  return `[합격자 스펙 — ${post.bank}] ${post.period} · ${post.group}\n\n이 스펙으로 합격했습니다. 학교 · 학점 · 어학 · 자격증 · 경력 전부 공개.\n전체 합격 스펙은 프로필(@topbanker99)에서 확인하세요. 자소서 · 필기 · 면접 준비도 함께.\n\n#은행취업 #은행권취업 #금융권취업 #은행합격 #합격스펙 #은행스펙 ${tag} #국민은행 #신한은행 #우리은행 #하나은행 #기업은행 #농협은행 #취업준비 #취준생 #자기소개서 #은행면접 #은행필기 #입행 #탑뱅커 #릴스`;
}
function glossaryCaption(term){
  return `[은행 면접 필수 금융상식] ${term.name}\n\n면접 · 필기에 자주 나오는 핵심 개념을 30초로 정리했습니다.\n매주 월 · 수 · 금 금융상식 업데이트 — @topbanker99\n\n#은행취업 #금융권취업 #금융상식 #경제상식 #금융용어 #NCS #은행필기 #은행면접 #국민은행 #신한은행 #우리은행 #하나은행 #기업은행 #농협은행 #한국은행 #취업준비 #취준생 #자기소개서 #금융지식 #탑뱅커 #릴스`;
}

/* ───────── 릴스 발행 (instagram-reel.js와 동일 플로우) ───────── */
async function publishReel(videoUrl, caption){
  const IG=process.env.IG_USER_ID, TOKEN=process.env.IG_ACCESS_TOKEN;
  const rC=await fetch(`${GRAPH}/${IG}/media`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({media_type:'REELS',video_url:videoUrl,caption,access_token:TOKEN})});
  const jC=await rC.json(); if(!rC.ok||!jC.id) throw new Error('릴스 컨테이너 실패: '+JSON.stringify(jC.error||jC));
  const creationId=jC.id; let status='';
  for(let i=0;i<100;i++){ await new Promise(r=>setTimeout(r,2500));
    const rs=await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`); const js=await rs.json(); status=js.status_code||'';
    if(status==='FINISHED')break; if(status==='ERROR')throw new Error('영상 처리 ERROR (형식/길이 확인)'); }
  if(status!=='FINISHED') throw new Error('영상 처리 시간초과');
  const rP=await fetch(`${GRAPH}/${IG}/media_publish`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({creation_id:creationId,access_token:TOKEN})});
  const jP=await rP.json(); if(!rP.ok||!jP.id) throw new Error('발행 실패: '+JSON.stringify(jP.error||jP));
  return jP.id;
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
    if(!process.env.IG_USER_ID||!process.env.IG_ACCESS_TOKEN) return out(500,{ok:false,error:'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.'});
    let canvasMod; try{ canvasMod=require('@napi-rs/canvas'); }catch(e){ return out(500,{ok:false,error:'@napi-rs/canvas 로드 실패: '+e.message}); }
    const { createCanvas, GlobalFonts }=canvasMod;
    await ensureFonts(GlobalFonts);

    let prog=await readProgress();
    let kind=(req.query&&req.query.kind)|| prog.nextKind || 'spec';
    if(kind!=='spec'&&kind!=='glossary') kind='spec';

    let scenes, caption, label;
    if(kind==='spec'){
      const posts=SPECS.posts||[]; if(!posts.length) return out(500,{ok:false,error:'specs.json posts 없음'});
      const idx=prog.specIndex % posts.length; const post=posts[idx];
      scenes=buildSpecScenes(post); caption=specCaption(post); label=`SPEC ${post.bank} ${post.group} (#${idx+1})`;
    } else {
      if(!TERMS.length) return out(500,{ok:false,error:'glossary.json 없음'});
      const idx=prog.glossaryIndex % TERMS.length; const term=TERMS[idx];
      scenes=buildGlossaryScenes(term); caption=glossaryCaption(term); label=`GLOSSARY ${term.name} (#${idx+1})`;
    }

    scenes.push({ type:'outro', dur:3.0 });   // 마무리(프리미엄/구독 안내) 이미지 — 모든 릴스 끝에 추가
    const mp4=await buildReel(canvasMod, scenes);
    const blob=await put(`reels/${Date.now()}.mp4`, mp4, {access:'public',contentType:'video/mp4',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN});
    const videoUrl=blob.url;

    if(dryrun) return out(200,{ok:true,dryrun:true,kind,label,videoUrl,sizeKB:Math.round(mp4.length/1024),caption});

    const mediaId=await publishReel(videoUrl, caption);
    // 진도 갱신 + 종류 교대
    const next={ nextKind: kind==='spec'?'glossary':'spec',
      specIndex: prog.specIndex + (kind==='spec'?1:0),
      glossaryIndex: prog.glossaryIndex + (kind==='glossary'?1:0) };
    await writeProgress(next);
    return out(200,{ok:true,kind,label,mediaId,videoUrl,next});
  }catch(err){
    return out(500,{ok:false,error:(err&&err.message)?err.message:String(err)});
  }
};
