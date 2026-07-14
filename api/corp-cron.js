// api/corp-cron.js
// 탑뱅커 — 은행 기업분석 카드뉴스 자동 발행 (10일에 1개, 13개 은행 라운드로빈)
//
// 한 게시물(은행 1곳) = 캐러셀 8장:
//   ① 표지 ② SWOT(강점·약점) ③ SWOT(기회·위협) ④ 핵심 요약 ⑤ 핵심 지표(전년대비)
//   ⑥ 디지털 트렌드 ⑦ 플랫폼 분석 ⑧ 네이버 안내(outro)
//
// 데이터: 저장소 내장 api/corp-data.js (외부 API/사이트 불필요 — corp-cron이 직접 읽음)
//
// 인증:
//   - Vercel Cron: Authorization: Bearer ${CRON_SECRET}  (자동, 매일 20시 KST)
//   - 수동 테스트:  ?secret=${PUBLISH_SECRET}  또는  헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1   : 카드 생성 + 미리보기 HTML만 (발행/진도/게이트 안 건드림)
//   - ?bank=ibk   : 특정 은행 강제(미리보기/수동발행). 실제발행 시 10일 게이트 무시 + 진도 동기화
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 의존: ./blob-bundle.js, ./hashtags.js, ./outro-image.js(없어도 됨), @napi-rs/canvas

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PROGRESS_KEY = 'corp-progress.json';
const GAP_DAYS = 10;                       // 발행 간격(일). 바꾸려면 이 숫자만 수정
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';

// 발행 순서(라운드로빈) + 은행별 동적 해시태그
const BANK_ORDER = ['ibk','shinhan','kb','woori','hana','nh','sh','im','busan','gyeongnam','gwangju','jeonbuk','jeju'];
const BANK_TAG = { ibk:'#기업은행', shinhan:'#신한은행', kb:'#국민은행', woori:'#우리은행', hana:'#하나은행', nh:'#농협은행', sh:'#수협은행', im:'#iM뱅크', busan:'#부산은행', gyeongnam:'#경남은행', gwangju:'#광주은행', jeonbuk:'#전북은행', jeju:'#제주은행' };

/* ───────── 카드 렌더러 (애플 미니멀, 한글) — corp-feed 응답 필드 기준 ───────── */
const COL = { WHITE:'#FFFFFF', PARCH:'#F5F5F7', DARK:'#1D1D1F', INK:'#1D1D1F',
  SOFT_L:'#3C3C3E', SOFT_D:'#D0D0D2', CAP_L:'#8A8A8E', CAP_D:'#9A9AA0', BLUE_L:'#0066CC', BLUE_D:'#2997FF', POS:'#1F9D63', NEG:'#E0504A' };
const fnt = (f,s) => `${s}px "${f}"`;
function strip(s){ if(s==null) return ''; return String(s).replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim(); }
function tw(ctx,t,tr){ let w=0; for(const c of t) w+=ctx.measureText(c).width+tr; return w; }
function trk(ctx,x,y,t,tr){ for(const c of t){ ctx.fillText(c,x,y); x+=ctx.measureText(c).width+tr; } return x; }
function ctr(ctx,cx,y,t,tr){ const w=tw(ctx,t,tr)-tr; return trk(ctx,cx-w/2,y,t,tr); }
function wrap(ctx,text,maxw){ const u=String(text).match(/[A-Za-z0-9.,%·\-()]+|\s+|[\s\S]/g)||[]; const L=[]; let c='';
  for(const x of u){ if(/^\s+$/.test(x)){ if(c&&tw(ctx,c+' ',0)<=maxw)c+=' '; else if(c){L.push(c.trim());c='';} continue; }
    if(c===''||tw(ctx,c+x,0)<=maxw)c+=x; else{L.push(c.trim());c=x;} } if(c.trim())L.push(c.trim()); return L; }
function rr(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

const W=1080, M=110, CW=W-2*M, CX=W/2, TOTAL=8;
const RAW_ASSETS='https://raw.githubusercontent.com/topbanker99-ai/instagram/main';
let LOGO_IMG=null, CHAR_IMG=null;   // 발행 직전 프리로드됨 (없으면 그냥 생략)
function drawCharacter(ctx, cxCenter, bottom, targetH){
  if(!CHAR_IMG) return;
  const r=targetH/CHAR_IMG.height, w=Math.round(CHAR_IMG.width*r), x=Math.round(cxCenter-w/2), y=bottom-targetH;
  ctx.save(); ctx.shadowColor='rgba(0,0,0,0.45)'; ctx.shadowBlur=40; ctx.shadowOffsetY=8;
  ctx.translate(x+w,y); ctx.scale(-1,1); ctx.drawImage(CHAR_IMG,0,0,w,targetH); ctx.restore();   // 좌우반전(지시봉이 본문 방향)
}
function drawLogoChip(ctx, cx, cy, targetW, radius, pad){
  if(!LOGO_IMG) return 0;
  const r=targetW/LOGO_IMG.width, h=Math.round(LOGO_IMG.height*r), px=pad, py=Math.round(pad*0.75);
  const cw=targetW+px*2, ch=h+py*2;
  ctx.fillStyle='#FFFFFF'; rr(ctx,cx,cy,cw,ch,radius); ctx.fill(); ctx.drawImage(LOGO_IMG,cx+px,cy+py,targetW,h);
  return ch;
}
function chrome(createCanvas, mode, page){
  const bg = mode==='dark'?COL.DARK:(mode==='parch'?COL.PARCH:COL.WHITE), dark=mode==='dark';
  const c = { main:dark?COL.WHITE:COL.INK, body:dark?COL.SOFT_D:COL.SOFT_L, cap:dark?COL.CAP_D:COL.CAP_L, accent:dark?COL.BLUE_D:COL.BLUE_L,
    chipBg:dark?'#16273C':'#E9F0FA', chipT:dark?'#8FBDF1':'#0A57AC' };
  const cv=createCanvas(W,W), ctx=cv.getContext('2d');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,W); ctx.textBaseline='top';
  ctx.fillStyle=c.main; ctx.font=fnt('Pretendard Bold',40); ctr(ctx,CX,72,'TOP BANKER',10);
  const pg=`${String(page).padStart(2,'0')} / ${String(TOTAL).padStart(2,'0')}`;
  ctx.fillStyle=c.cap; ctx.font=fnt('Pretendard SemiBold',26);
  const leftPg=(page===1||page===TOTAL); ctx.fillText(pg, leftPg?M:(W-M-tw(ctx,pg,0)), 992);
  return {cv,ctx,c};
}
function head(ctx,c,txt,suffix){ ctx.fillStyle=c.main; ctx.font=fnt('Pretendard SemiBold',52); ctx.fillText(txt,M,168);
  if(suffix){ const w=tw(ctx,txt,0); ctx.fillStyle=c.cap; ctx.font=fnt('Pretendard',30); ctx.fillText(suffix,M+w+18,186); }
  ctx.fillStyle=c.accent; ctx.fillRect(M,238,64,5); }
function label(ctx,c,x,y,t){ ctx.fillStyle=c.accent; ctx.font=fnt('Pretendard Bold',28); ctx.fillText(t,x,y); }
function chips(ctx,c,y,arr){ ctx.font=fnt('Pretendard SemiBold',26); const padX=20,h=48,gap=12; let cx=M,cy=y;
  for(const t of (arr||[])){ const w=ctx.measureText(t).width+padX*2; if(cx+w>M+CW){ cx=M; cy+=h+12; }
    ctx.fillStyle=c.chipBg; rr(ctx,cx,cy,w,h,24); ctx.fill(); ctx.fillStyle=c.chipT; ctx.fillText(t,cx+padX,cy+11); cx+=w+gap; }
  return cy+h; }
function paras(ctx,c,items,y,maxItems,descLines){   // items: [{title, body}]
  for(const it of (items||[]).slice(0,maxItems)){
    ctx.fillStyle=c.main; ctx.font=fnt('Pretendard SemiBold',32); for(const ln of wrap(ctx,strip(it.title),CW).slice(0,2)){ ctx.fillText(ln,M,y); y+=44; }
    ctx.fillStyle=c.body; ctx.font=fnt('Pretendard',28); let dl=wrap(ctx,strip(it.body),CW); if(dl.length>descLines){ dl=dl.slice(0,descLines); dl[descLines-1]=dl[descLines-1].slice(0,-1)+'…'; }
    for(const ln of dl){ ctx.fillText(ln,M,y); y+=39; } y+=26;
  } return y;
}

// ① 표지 (로고 흰 칩 + 캐릭터)
function cover(createCanvas, bank, metrics){
  const {cv,ctx,c}=chrome(createCanvas,'dark',1);
  ctx.font=fnt('Pretendard Bold',34); const lab='기업분석'; const lw=ctx.measureText(lab).width;
  ctx.fillStyle=c.chipBg; rr(ctx,M,178,lw+56,68,34); ctx.fill(); ctx.fillStyle=c.chipT; ctx.fillText(lab,M+28,196);
  const chH=drawLogoChip(ctx,M,300,300,18,22); const base=chH?300+chH:300;
  ctx.fillStyle=c.main; ctx.font=fnt('Pretendard SemiBold',88); ctx.fillText(strip(bank.name),M,base+40);
  ctx.fillStyle=c.cap; ctx.font=fnt('Pretendard',38); ctx.fillText(strip(bank.eng||''),M+4,base+152);
  const m0=(metrics&&metrics[0])?`${strip(metrics[0].label)}  ${strip(metrics[0].value)}`:'2026 대비 결산 핵심 요약';
  ctx.fillStyle=c.accent; ctx.font=fnt('Pretendard SemiBold',38); ctx.fillText(m0,M+4,base+216);
  drawCharacter(ctx,852,W,440);
  return cv.toBuffer('image/png');
}
// ②③ SWOT (2개 카테고리 세로, 카테고리당 최대 3개)
function swotCard(createCanvas, swot, pairs, page, mode, part){
  const {cv,ctx,c}=chrome(createCanvas,mode,page); head(ctx,c,'SWOT 분석',`(${part}/2)`);
  let y=296; const sw=swot||{};
  for(const [lab,key] of pairs){
    ctx.fillStyle=c.accent; ctx.font=fnt('Pretendard Bold',36); ctx.fillText(lab,M,y); y+=58;
    ctx.font=fnt('Pretendard',30);
    for(const p of (sw[key]||[]).slice(0,3)){ ctx.fillStyle=c.body; let lns=wrap(ctx,'· '+strip(p),CW); if(lns.length>2){ lns=lns.slice(0,2); lns[1]=lns[1].slice(0,-1)+'…'; }
      for(const ln of lns){ ctx.fillText(ln,M,y); y+=42; } y+=10; }
    y+=30;
  }
  return cv.toBuffer('image/png');
}
// ④ 핵심 요약
function summaryCard(createCanvas, text){
  const {cv,ctx,c}=chrome(createCanvas,'white',4); head(ctx,c,'핵심 요약');
  ctx.fillStyle=c.body; ctx.font=fnt('Pretendard',41); let y=300;
  for(const ln of wrap(ctx,strip(text),CW)){ ctx.fillText(ln,M,y); y+=60; if(y>910)break; }
  return cv.toBuffer('image/png');
}
// ⑤ 핵심 지표 (전년 대비 ▲▼ — 데이터에 있는 항목만)
function splitMetric(m){ const v=String(m.value!=null?m.value:''); const mt=v.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  let base=v.trim(), chg=''; if(mt){ base=mt[1].trim(); chg=mt[2].trim(); }
  if(chg){ if(chg[0]==='+')chg='▲'+chg.slice(1); else if(chg[0]==='-')chg='▼'+chg.slice(1); }
  return { base, chg, trend:m.trend||'' };
}
function metricsCard(createCanvas, metrics){
  const {cv,ctx,c}=chrome(createCanvas,'dark',5); head(ctx,c,'핵심 지표','전년 대비');
  const picks=(metrics||[]).slice(0,6).map(m=>({ label:m.label, ...splitMetric(m) }));
  const colX=[M, M+CW/2+10], rowY=[300,490,680];
  picks.forEach((m,i)=>{ const x=colX[i%2], y=rowY[Math.floor(i/2)];
    ctx.fillStyle=c.cap; ctx.font=fnt('Pretendard',27); ctx.fillText(String(m.label||'').replace('(연결)',''),x,y);
    // 값 자체가 증감(±/▲▼)이면 부호색 적용, 아니면 강조 파랑
    let baseShown=m.base, valColor=c.accent;
    if(/^[+▲]/.test(m.base)){ baseShown=m.base.replace(/^\+/,'▲'); valColor=COL.POS; }
    else if(/^[-▼]/.test(m.base)){ baseShown=m.base.replace(/^-/,'▼'); valColor=COL.NEG; }
    ctx.fillStyle=valColor; ctx.font=fnt('Pretendard SemiBold',50); ctx.fillText(baseShown,x,y+42);
    if(m.chg){ const bw=ctx.measureText(baseShown).width; ctx.font=fnt('Pretendard SemiBold',28);
      ctx.fillStyle=m.trend==='down'?COL.NEG:(m.trend==='up'?COL.POS:c.cap); ctx.fillText(m.chg,x+bw+16,y+62); } });
  ctx.fillStyle=c.cap; ctx.font=fnt('Pretendard',26); ctx.fillText('※ 2025 결산 · 금감원 기준',M,992);
  return cv.toBuffer('image/png');
}
// ⑥ 디지털 트렌드
function digitalCard(createCanvas, d){
  const {cv,ctx,c}=chrome(createCanvas,'white',6); head(ctx,c,'디지털 트렌드'); d=d||{};
  let y=300; label(ctx,c,M,y,'핵심 키워드'); y+=44; y=chips(ctx,c,y,d.keywords)+34; paras(ctx,c,d.items,y,2,2);
  return cv.toBuffer('image/png');
}
// ⑦ 플랫폼 분석
function platformCard(createCanvas, p){
  const {cv,ctx,c}=chrome(createCanvas,'dark',7); head(ctx,c,'플랫폼 분석'); p=p||{};
  let y=296; ctx.fillStyle=c.body; ctx.font=fnt('Pretendard',29); for(const ln of wrap(ctx,strip(p.intro),CW).slice(0,2)){ ctx.fillText(ln,M,y); y+=40; } y+=24;
  for(const app of (p.items||[]).slice(0,3)){
    ctx.fillStyle=c.accent; ctx.font=fnt('Pretendard SemiBold',32); ctx.fillText(strip(app.name),M,y);
    const nw=ctx.measureText(strip(app.name)).width; ctx.fillStyle=c.cap; ctx.font=fnt('Pretendard',24); ctx.fillText('  '+strip(app.stat),M+nw+10,y+9); y+=46;
    ctx.fillStyle=c.body; ctx.font=fnt('Pretendard',27); const b=(app.bullets&&app.bullets[0])?strip(app.bullets[0]):''; for(const ln of wrap(ctx,'· '+b,CW).slice(0,2)){ ctx.fillText(ln,M,y); y+=37; } y+=22;
  }
  return cv.toBuffer('image/png');
}
// ⑧ 아웃트로 (팔로우 유도 + 캐릭터)
function outroCard(createCanvas, bank){
  const {cv,ctx,c}=chrome(createCanvas,'dark',TOTAL);
  drawLogoChip(ctx, W-M-182, 150, 150, 16, 16);
  ctx.fillStyle=c.main; ctx.font=fnt('Pretendard SemiBold',56);
  ctx.fillText('매주 새로운 은행',M,300); ctx.fillText('기업분석 카드뉴스',M,372);
  ctx.fillStyle=c.body; ctx.font=fnt('Pretendard',36); ctx.fillText('놓치지 말고 팔로우하세요',M,470);
  ctx.font=fnt('Pretendard SemiBold',34); const cta='＋ 팔로우  @topbanker99'; const cw3=ctx.measureText(cta).width+64;
  ctx.fillStyle=c.accent; rr(ctx,M,560,cw3,92,46); ctx.fill(); ctx.fillStyle='#0B0B0D'; ctx.fillText(cta,M+32,588);
  drawCharacter(ctx,852,W,470);
  return cv.toBuffer('image/png');
}

/* ───────── 원본 데이터(corp-data.js) → 렌더용 정규화 ───────── */
const stripArr = a => (Array.isArray(a) ? a.map(strip) : []);
const mapTD = a => (Array.isArray(a) ? a.map(it => ({ title:strip(it.t), body:strip(it.d) })) : []);
function bankObj(key, raw){ return { key, name:raw.name, short:raw.short||null, eng:raw.eng||null }; }
function buildBiz(key, raw){
  return { bank:bankObj(key,raw), summary:strip(raw.bizSummary),
    metrics:(raw.metrics||[]).map(m => { const o={label:m.k, value:m.v}; if(m.cls) o.trend=m.cls; return o; }),
    swot:{ strength:stripArr(raw.swot&&raw.swot.s), weakness:stripArr(raw.swot&&raw.swot.w), opportunity:stripArr(raw.swot&&raw.swot.o), threat:stripArr(raw.swot&&raw.swot.t) } };
}
function buildDigital(key, raw){ const o=raw.digital||{}; return { bank:bankObj(key,raw), keywords:o.keywords||[], items:mapTD(o.items) }; }
function buildPlatform(key, raw){ const o=raw.platform||{}; return { bank:bankObj(key,raw), intro:strip(o.intro),
  items:(o.items||[]).map(p => ({ name:strip(p.name), eng:p.eng||null, stat:strip(p.stat), bullets:stripArr(p.bullets) })) }; }

// 한 은행의 8장(아웃트로 제외 7장) 버퍼 생성. byId = {biz, digital, platform, ...}
function buildBankBuffers(createCanvas, byId){
  const biz=byId.biz||{}, dig=byId.digital||{}, plat=byId.platform||{};
  const bank=(biz.bank)||(dig.bank)||(plat.bank)||{ name:'', eng:'' };
  return [
    cover(createCanvas, bank, biz.metrics),
    swotCard(createCanvas, biz.swot, [['강점','strength'],['약점','weakness']], 2, 'parch', 1),
    swotCard(createCanvas, biz.swot, [['기회','opportunity'],['위협','threat']], 3, 'dark', 2),
    summaryCard(createCanvas, biz.summary),
    metricsCard(createCanvas, biz.metrics),
    digitalCard(createCanvas, dig),
    platformCard(createCanvas, plat),
    outroCard(createCanvas, bank),
  ];
}

/* ───────── 폰트 1회 로드 ───────── */
let fontsReady=false;
async function ensureFonts(GlobalFonts){
  if(fontsReady) return;
  for(const [f,n] of [['Pretendard-Regular.otf','Pretendard'],['Pretendard-SemiBold.otf','Pretendard SemiBold'],['Pretendard-Bold.otf','Pretendard Bold']]){
    const r=await fetch(PRETENDARD_BASE+f); if(!r.ok) throw new Error('폰트 다운로드 실패 '+f+' HTTP '+r.status);
    GlobalFonts.register(Buffer.from(await r.arrayBuffer()), n);
  }
  fontsReady=true;
}

/* ───────── 진도 읽기/쓰기 (Vercel Blob) ───────── */
async function readProgress(){
  try{
    const { list } = require('./blob-bundle.js');
    const { blobs } = await list({ prefix: PROGRESS_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs && blobs.length){ const r=await fetch(blobs[0].url+'?t='+Date.now()); if(r.ok){ const j=await r.json(); return { nextIndex:Number(j.nextIndex)||0, lastPublishedAt:j.lastPublishedAt||null }; } }
  }catch(e){}
  return { nextIndex:0, lastPublishedAt:null };
}
async function writeProgress(nextIndex, lastPublishedAt){
  const { put } = require('./blob-bundle.js');
  await put(PROGRESS_KEY, JSON.stringify({ nextIndex, lastPublishedAt, updatedAt:new Date().toISOString() }), {
    access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true, token:process.env.BLOB_READ_WRITE_TOKEN });
}

/* ───────── 캡션 ───────── */
function buildCaption(bankName, bankTag){
  const { buildTags } = require('./hashtags.js');
  const tags = buildTags('corp', bankTag?{bank:bankTag}:undefined);
  return `[은행 기업분석] ${bankName}\n\n2026 대비 결산 핵심 요약 — SWOT 분석, 핵심 지표(전년 대비), 디지털 트렌드, 플랫폼 전략까지 한 번에 정리했습니다.\n자소서 지원동기와 면접 답변에 그대로 활용하세요.\n\n※ 취업 준비 참고용으로 재구성한 자료입니다. 지원 전 DART(dart.fss.or.kr)와 각 은행 홈페이지에서 최신 공시를 확인하세요.\n자세한 컨설팅은 프로필 링크 참고.\n\n${tags}`;
}

/* ───────── IG 캐러셀 발행 ───────── */
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

/* ───────── 핸들러 ───────── */
async function handler(req, res){
  const out=(s,p)=>{ res.status(s).json(p); };
  const auth=req.headers['authorization']||'';
  const manual=(req.query&&req.query.secret)||req.headers['x-publish-secret'];
  const cronOk=process.env.CRON_SECRET && auth===`Bearer ${process.env.CRON_SECRET}`;
  const manualOk=process.env.PUBLISH_SECRET && manual===process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401,{ok:false,error:'인증 실패'});

  const dryrun=req.query&&(req.query.dryrun==='1'||req.query.dryrun==='true');
  const forceBank=(req.query&&req.query.bank)?String(req.query.bank).toLowerCase().trim():'';
  try{
    if(!process.env.IG_USER_ID||!process.env.IG_ACCESS_TOKEN) return out(500,{ok:false,error:'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.'});
    let canvasMod; try{ canvasMod=require('@napi-rs/canvas'); }catch(e){ return out(500,{ok:false,error:'@napi-rs/canvas 로드 실패: '+e.message}); }
    const { createCanvas, GlobalFonts, loadImage }=canvasMod; await ensureFonts(GlobalFonts);

    const prog=await readProgress();
    let idx = forceBank ? BANK_ORDER.indexOf(forceBank) : (prog.nextIndex % BANK_ORDER.length);
    if(idx<0) return out(400,{ok:false,error:'알 수 없는 은행 key. 허용: '+BANK_ORDER.join(', ')});
    const bankKey = BANK_ORDER[idx];

    // 10일 게이트 (실제 발행만, forceBank면 무시)
    if(!dryrun && !forceBank && prog.lastPublishedAt){
      const elapsed = Date.now() - new Date(prog.lastPublishedAt).getTime();
      const gapMs = GAP_DAYS*24*60*60*1000;
      if(elapsed < gapMs){
        const daysLeft = Math.ceil((gapMs-elapsed)/(24*60*60*1000));
        return out(200,{ok:true, skipped:true, reason:`아직 ${GAP_DAYS}일 안 됨`, daysLeft, nextBank:bankKey, lastPublishedAt:prog.lastPublishedAt});
      }
    }

    // 데이터: 저장소 내장 corp-data.js (외부 API/사이트 불필요)
    let CORP_RAW; try{ CORP_RAW=require('./corp-data.js'); }catch(e){ return out(500,{ok:false,error:'corp-data.js 로드 실패: '+e.message}); }
    const raw=CORP_RAW[bankKey];
    if(!raw||!raw.bizSummary) throw new Error(`'${bankKey}' 데이터가 없습니다.`);
    const byId={ biz:buildBiz(bankKey,raw), digital:buildDigital(bankKey,raw), platform:buildPlatform(bankKey,raw) };
    const bankName=raw.name||bankKey;

    // 로고·캐릭터 프리로드 (실패해도 카드 생성은 계속 — 이미지만 빠짐)
    async function _load(u){ try{ const r=await fetch(u); if(!r.ok) return null; return await loadImage(Buffer.from(await r.arrayBuffer())); }catch(e){ return null; } }
    LOGO_IMG = await _load(`${RAW_ASSETS}/logos/${bankKey}.png`);
    CHAR_IMG = await _load(`${RAW_ASSETS}/character.png`);

    // 렌더 → Blob 업로드
    const { put } = require('./blob-bundle.js');
    const buffers=buildBankBuffers(createCanvas, byId);
    const folder=`corp/${bankKey}-${Date.now()}`; const imageUrls=[];
    for(let i=0;i<buffers.length;i++){ const blob=await put(`${folder}/${i+1}.png`, buffers[i], {access:'public',contentType:'image/png',addRandomSuffix:true,token:process.env.BLOB_READ_WRITE_TOKEN}); imageUrls.push(blob.url); }
    // 아웃트로는 이제 outroCard(캔버스)로 위에서 함께 렌더됩니다.

    const caption=buildCaption(bankName, BANK_TAG[bankKey]);

    if(dryrun){
      const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const imgs=imageUrls.map((u,i)=>`<img src="${u}" alt="card ${i+1}" style="width:100%;border-radius:12px;margin-bottom:10px;background:#000">`).join('');
      const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>미리보기</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif;text-align:center"><div style="max-width:480px;margin:0 auto;padding:18px"><div style="color:#2997ff;font-weight:700;font-size:16px">미리보기 (아직 발행 안 됨)</div><div style="color:#8a8a90;font-size:13px;margin:6px 0 14px">은행 기업분석 · ${esc(bankName)} (${esc(bankKey)})</div>${imgs}<div style="background:#16161a;border-radius:12px;padding:14px;margin-top:8px;font-size:14px;line-height:1.5">마음에 들면 → 주소창에서 <b style="color:#fff">&amp;dryrun=1</b> 을 지우고 다시 접속하면 <b style="color:#2997ff">실제로 발행</b>됩니다.</div><details style="margin-top:14px;text-align:left"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">캡션 보기</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(caption)}</pre></details></div></body></html>`;
      res.statusCode=200; res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(html); return;
    }

    const mediaId=await publishCarousel(imageUrls, caption);
    const nextIndex=(idx+1)%BANK_ORDER.length;
    await writeProgress(nextIndex, new Date().toISOString());
    return out(200,{ok:true, mediaId, bank:bankKey, bankName, nextIndex, nextBank:BANK_ORDER[nextIndex], imageUrls});
  }catch(err){
    return out(500,{ok:false,error:(err&&err.message)?err.message:String(err)});
  }
}

module.exports = handler;
module.exports._render = { buildBankBuffers, cover, outroCard, swotCard, summaryCard, metricsCard, digitalCard, platformCard, setAssets:(l,ch)=>{LOGO_IMG=l;CHAR_IMG=ch;} };
