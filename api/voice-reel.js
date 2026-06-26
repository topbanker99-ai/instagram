// api/voice-reel.js
// 탑뱅커 — 범용 "음성 자막 릴스" 생성기 (수동 엔드포인트, 크론 아님)
//
// 입력한 스크립트를 ElevenLabs 음성으로 읽고, 문장 단위 하단 자막(브랜드 블루 박스) 릴스를 생성/발행합니다.
// promo-reel.js 의 음성·합성 파이프라인을 그대로 재사용하되, 장면을 "입력 텍스트"로 자동 구성합니다.
//
// 인증: ?secret=PUBLISH_SECRET  또는  헤더 x-publish-secret  (POST 는 body.secret 도 허용)
// 사용:
//   GET  ?dryrun=1[&script=...&sub=1|0&caption=...]  → 미리보기 HTML (script 생략 시 기본 샘플 사용)
//   POST { script, showSubtitle, caption, dryrun }    → JSON  (index.html UI 가 호출)
// 옵션:
//   dryrun=1 → 영상(음성 포함) 생성 + Blob 업로드까지만(미리보기). 발행 안 함.
//   sub=1(기본)/0 → 자막 표시 ON/OFF. OFF 면 첫 문장을 제목으로 띄우고 음성만 깔림.
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN, ELEVENLABS_API_KEY
//           (선택) ELEVENLABS_VOICE_ID — 없으면 아래 기본 보이스
// 의존: ./blob-bundle.js, ./reel-music.js, (있으면) ./outro-image.js, @napi-rs/canvas, ffmpeg-static

const { put } = require('./blob-bundle.js');
let OUTRO = null; try { OUTRO = require('./outro-image.js'); } catch (e) {}   // 없어도 크래시 안 나도록

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';

// ── ElevenLabs ──
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'n2fbxG88jqAoaVPUy3IG';
const TTS_MODEL = 'eleven_multilingual_v2';

// ── 기본값(스크립트/캡션 비울 때) ──
const SAMPLE_SCRIPT = "은행 면접, 자기소개 1분이 합격을 가릅니다. 첫 문장에 지원 동기를 담으세요. 핵심 역량은 딱 하나만 강조하면 됩니다. 길게 말할수록 인상은 오히려 흐려집니다.";
const DEFAULT_CAPTION = `은행·금융권 취업은 탑뱅커 @topbanker99

#은행취업 #은행권취업 #금융권취업 #은행면접 #자기소개서 #필기시험 #NCS #취업준비 #자소서 #탑뱅커`;

/* ───────── 다크 테마 + 텍스트 헬퍼 (기존 릴스와 동일 톤) ───────── */
const COL = { BG: '#0B0B0D', WHITE: '#FFFFFF', BODY: '#C9C9CE', CAP: '#8A8A90', ACCENT: '#2997FF' };
const SUB_BOX = '#1A6FD4';   // 자막 음영(브랜드 블루)
const fnt = (fam, size) => `${size}px "${fam}"`;
function dTracked(ctx, x, y, t, tr) { for (const c of t) { ctx.fillText(c, x, y); x += ctx.measureText(c).width + tr; } return x; }
function tWidth(ctx, t, tr) { let w = 0; for (const c of t) w += ctx.measureText(c).width + tr; return w; }
function dCentered(ctx, cx, y, t, tr) { const w = tWidth(ctx, t, tr) - tr; return dTracked(ctx, cx - w / 2, y, t, tr); }
function wrap(ctx, text, maxw, tr) {
  const u = (text || '').match(/[A-Za-z0-9.,%·\-]+|\s+|[\s\S]/g) || []; const L = []; let cur = '';
  for (const x of u) {
    if (/^\s+$/.test(x)) { if (cur && tWidth(ctx, cur + ' ', tr) <= maxw) cur += ' '; else if (cur) { L.push(cur.replace(/\s+$/, '')); cur = ''; } continue; }
    if (cur === '' || tWidth(ctx, cur + x, tr) <= maxw) cur += x; else { L.push(cur.replace(/\s+$/, '')); cur = x; }
  }
  if (cur.trim()) L.push(cur.replace(/\s+$/, '')); return L;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

/* ───────── 입력 스크립트 → 문장 분리 ───────── */
function splitSentences(text) {
  return (text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?。…])\s+|\n+/)   // 문장부호 뒤 공백 또는 줄바꿈에서 끊기
    .map(s => s.trim())
    .filter(Boolean);
}

/* ───────── 장면 렌더 (1080×1920) ───────── */
const W = 1080, H = 1920, M = 110, CW = W - 2 * M, CX = W / 2;
function drawBase(ctx) {
  ctx.fillStyle = COL.BG; ctx.fillRect(0, 0, W, H); ctx.textBaseline = 'top';
  ctx.fillStyle = COL.CAP; ctx.font = fnt('Pretendard SemiBold', 30); dCentered(ctx, CX, 150, 'TOP BANKER', 6);
  ctx.fillStyle = COL.CAP; ctx.font = fnt('Pretendard Regular', 34); dCentered(ctx, CX, 1772, '@topbanker99', 1);
}
function renderScene(createCanvas, sc) {
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d'); drawBase(ctx);

  if (sc.type === 'sub') {
    // 하단 자막 + 줄별 둥근 블루 음영 박스 (승인된 B 스타일)
    let hs = 80; ctx.font = fnt('Pretendard Bold', hs);
    let lns = wrap(ctx, sc.text, CW - 90, -1);
    while (lns.length > 3 && hs > 56) { hs -= 4; ctx.font = fnt('Pretendard Bold', hs); lns = wrap(ctx, sc.text, CW - 90, -1); }
    const padX = 40, padY = 20, gap = 22; const bh = hs + padY * 2; const step = bh + gap;
    const blockH = lns.length * step - gap; let y = 1610 - blockH;   // 하단 정렬
    for (const ln of lns) {
      ctx.font = fnt('Pretendard Bold', hs);
      const bw = tWidth(ctx, ln, -1) + 1 + padX * 2; const bx = CX - bw / 2;
      ctx.save(); ctx.shadowColor = 'rgba(0,80,180,0.40)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 6;
      ctx.fillStyle = SUB_BOX; roundRect(ctx, bx, y, bw, bh, 24); ctx.fill(); ctx.restore();
      ctx.fillStyle = COL.WHITE; dCentered(ctx, CX, y + padY, ln, -1);
      y += step;
    }
  }
  else if (sc.type === 'title') {
    // 자막 OFF 모드: 중앙 큰 제목 + 가는 파란 라인 (미니멀)
    ctx.strokeStyle = COL.ACCENT; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(CX - 56, 760); ctx.lineTo(CX + 56, 760); ctx.stroke();
    let hs = 104; ctx.font = fnt('Pretendard Bold', hs);
    let lns = wrap(ctx, sc.text, CW, -1);
    while (lns.length > 4 && hs > 60) { hs -= 4; ctx.font = fnt('Pretendard Bold', hs); lns = wrap(ctx, sc.text, CW, -1); }
    const lh = Math.round(hs * 1.2); let y = 900 - (lns.length * lh) / 2;
    for (const ln of lns) { ctx.fillStyle = COL.WHITE; ctx.font = fnt('Pretendard Bold', hs); dCentered(ctx, CX, y, ln, -1); y += lh; }
  }
  return canvas.toBuffer('image/png');
}

/* ───────── 카드 프레임 렌더 (업로드 카드 이미지 → 1080×1920, 배경 흐림/네이비/흰색) ───────── */
function renderCardFrame(createCanvas, img, bg) {
  const c = createCanvas(W, H); const ctx = c.getContext('2d');
  const iw = img.width || img.naturalWidth || 1080, ih = img.height || img.naturalHeight || 1080;
  // 배경
  if (bg === 'white') { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H); }
  else if (bg === 'navy') { ctx.fillStyle = '#1B3A5C'; ctx.fillRect(0, 0, W, H); }
  else { // blur: 다운스케일 → 업스케일(부드러운 흐림) + 어둡게
    ctx.fillStyle = COL.BG; ctx.fillRect(0, 0, W, H);
    const sw = 60, sh = Math.max(1, Math.round(sw * ih / iw));
    const small = createCanvas(sw, sh); const sx = small.getContext('2d');
    sx.drawImage(img, 0, 0, sw, sh);
    const r = Math.max(W / sw, H / sh), dw = sw * r, dh = sh * r;
    ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = 'high'; } catch (e) {}
    ctx.drawImage(small, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, W, H);
  }
  // 전경 카드 (contain, 중앙, 둥근 모서리 + 그림자)
  const margin = 24, r = Math.min((W - margin * 2) / iw, (H - margin * 2) / ih);
  const dw = iw * r, dh = ih * r, dx = (W - dw) / 2, dy = (H - dh) / 2, rad = 26;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 10;
  roundRect(ctx, dx, dy, dw, dh, rad); ctx.fillStyle = '#000'; ctx.fill(); ctx.restore();
  ctx.save(); roundRect(ctx, dx, dy, dw, dh, rad); ctx.clip(); ctx.drawImage(img, dx, dy, dw, dh); ctx.restore();
  return c.toBuffer('image/png');
}

/* ───────── ElevenLabs 내레이션 생성 ───────── */
async function genVoice(text) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY 환경변수가 없습니다.');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true } }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('ElevenLabs 실패 ' + r.status + ': ' + t.slice(0, 200)); }
  return Buffer.from(await r.arrayBuffer());
}

/* ───────── 영상 생성 (ffmpeg) — 음성 먼저 → 길이 측정 → 자막 타이밍 자동 배분 ───────── */
async function buildReel(canvasMod, opts) {
  const { createCanvas, loadImage } = canvasMod;
  const os = require('os'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  let FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
  if (!process.env.FFMPEG_PATH) {
    try { const tmpBin = path.join(os.tmpdir(), 'ffmpeg'); if (!fs.existsSync(tmpBin)) fs.copyFileSync(FFMPEG, tmpBin); fs.chmodSync(tmpBin, 0o755); FFMPEG = tmpBin; }
    catch (e) { try { fs.chmodSync(FFMPEG, 0o755); } catch (_) {} }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vreel-'));
  try {
    // 1) 내레이션 mp3 + 길이 측정
    const narrBuf = await genVoice(opts.script);
    const narrPath = path.join(dir, 'narration.mp3'); fs.writeFileSync(narrPath, narrBuf);
    let narrDur = 0;
    try { execFileSync(FFMPEG, ['-i', narrPath], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { const s = (e.stderr || '').toString(); const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if (m) narrDur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); }

    // 2) 장면 구성 (음성 길이에 맞춰 자막 시간 비례 배분)
    let scenes;
    if (opts.showSubtitle) {
      const sents = splitSentences(opts.script);
      const totalChars = sents.reduce((a, s) => a + s.length, 0) || 1;
      const base = narrDur > 0 ? narrDur : sents.length * 3;
      scenes = sents.map(s => ({ type: 'sub', text: s, dur: Math.max(0.8, base * (s.length / totalChars)) }));
    } else {
      const title = (splitSentences(opts.script)[0] || opts.script || '').slice(0, 60);
      scenes = [{ type: 'title', text: title, dur: Math.max(2, narrDur || 4) }];
    }
    if (OUTRO) scenes.push({ type: 'outro', dur: 3.0 });   // 마무리 안내 — OUTRO 없으면 자동 생략

    // 3) 배경음악
    const music = require('./reel-music.js');
    const musicPath = path.join(dir, 'music.mp3'); fs.writeFileSync(musicPath, Buffer.from(music.split(',')[1], 'base64'));

    // 4) 프레임 렌더 + concat 리스트
    let listTxt = '', scenesTotal = 0, outroFrame = null, lastPng = null;
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i]; let buf;
      if (sc.type === 'outro') {
        if (!OUTRO) continue;
        if (!outroFrame) {
          const oc = createCanvas(1080, 1920); const octx = oc.getContext('2d');
          octx.fillStyle = '#1D1D1F'; octx.fillRect(0, 0, 1080, 1920);
          const img = await loadImage(Buffer.from(OUTRO.split(',')[1], 'base64'));
          octx.drawImage(img, 0, Math.round((1920 - 1080) / 2), 1080, 1080);
          outroFrame = oc.toBuffer('image/png');
        }
        buf = outroFrame;
      } else { buf = renderScene(createCanvas, sc); }
      const p = path.join(dir, `f${i}.png`); fs.writeFileSync(p, buf); lastPng = p;
      listTxt += `file '${p}'\nduration ${sc.dur}\n`; scenesTotal += sc.dur;
    }

    // 5) 영상이 내레이션 길이를 덮도록 마지막 프레임 패딩
    const minDur = (narrDur || scenesTotal) + 0.6;
    const pad = Math.max(0, minDur - scenesTotal);
    if (pad > 0.05) { listTxt += `file '${lastPng}'\nduration ${pad.toFixed(2)}\n`; }
    listTxt += `file '${lastPng}'\n`;   // concat demuxer: 마지막 프레임 고정
    const total = Math.max(scenesTotal, minDur);
    fs.writeFileSync(path.join(dir, 'list.txt'), listTxt);

    // 6) 합성: 영상 + (음악 22% + 내레이션) 믹스, 끝부분 페이드아웃
    const out = path.join(dir, 'out.mp4');
    const fadeOut = Math.max(0.1, total - 0.6).toFixed(2);
    const afOut = Math.max(0.1, total - 1.0).toFixed(2);
    const fc = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,fade=t=out:st=${fadeOut}:d=0.5[v];`
      + `[1:a]volume=0.22[bg];[2:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest:normalize=0,afade=t=out:st=${afOut}:d=1.0[a]`;
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
      '-stream_loop', '-1', '-i', musicPath, '-i', narrPath,
      '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '128k', '-t', total.toFixed(2), '-movflags', '+faststart', out], { stdio: 'ignore' });
    return { mp4: fs.readFileSync(out), durationSec: total, narrDur, sceneCount: scenes.filter(s => s.type !== 'outro').length };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ───────── 카드 + 음성 릴스 (업로드 카드 이미지 + 카드별 ElevenLabs 음성) ─────────
   스크립트를 '---'(하이픈 3개 이상)로 카드 수만큼 분리 → 카드별 음성 생성/길이 측정 →
   각 카드를 "그 카드 음성이 끝날 때까지" 표시. 음성이 카드 전환 타이밍을 결정한다. */
async function buildReelCards(canvasMod, opts) {
  const { createCanvas, loadImage } = canvasMod;
  const os = require('os'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const log = (m) => { try { console.log('[vreel-card] ' + m); } catch (e) {} };
  let FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
  if (!process.env.FFMPEG_PATH) {
    try { const tmpBin = path.join(os.tmpdir(), 'ffmpeg'); if (!fs.existsSync(tmpBin)) fs.copyFileSync(FFMPEG, tmpBin); fs.chmodSync(tmpBin, 0o755); FFMPEG = tmpBin; }
    catch (e) { try { fs.chmodSync(FFMPEG, 0o755); } catch (_) {} }
  }
  log('start ffmpeg=' + FFMPEG + ' images=' + (opts.images ? opts.images.length : 0) + ' bg=' + (opts.bg || 'blur'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcard-'));
  const GAP = 0.45;   // 카드 사이 숨 쉴 틈(초)
  const ffdur = (p) => { let d = 0; try { execFileSync(FFMPEG, ['-i', p], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { const s = (e.stderr || '').toString(); const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if (m) d = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); } return d; };
  try {
    // 1) 카드 수 확인 (이미지는 메모리 절약 위해 렌더 단계에서 한 장씩 디코드/해제)
    const n = Array.isArray(opts.images) ? opts.images.length : 0;
    if (!n) throw new Error('카드 이미지가 없습니다.');
    log('start n=' + n);

    // 2) 스크립트를 '---' 로 카드 수만큼 분리 (남으면 마지막 카드에 합침)
    let chunks = String(opts.script || '').split(/\n?\s*-{3,}\s*\n?/).map(s => s.trim()).filter(Boolean);
    if (chunks.length === 0) chunks = [String(opts.script || '').trim()];
    const texts = [];
    for (let i = 0; i < n; i++) texts.push(chunks[i] || '');
    if (chunks.length > n) { const extra = chunks.slice(n).join(' '); texts[n - 1] = (texts[n - 1] ? texts[n - 1] + ' ' : '') + extra; }
    log('chunks=' + chunks.length + ' textLens=' + texts.map(t => t.length).join(','));

    // 3) 카드별 음성 → 오디오 세그먼트(정확히 카드 길이로 패딩) + 카드 표시 길이
    //    ※ ElevenLabs 동시 요청 제한(3개)에 맞춰 한 번에 최대 3개씩 묶어서 병렬 호출
    const TTS_CONCURRENCY = 3;
    log('tts start n=' + texts.filter(Boolean).length + ' conc=' + TTS_CONCURRENCY);
    const voiceBufs = new Array(n).fill(null);
    for (let s = 0; s < n; s += TTS_CONCURRENCY) {
      const batch = [];
      for (let i = s; i < Math.min(s + TTS_CONCURRENCY, n); i++) {
        if (texts[i]) batch.push(genVoice(texts[i]).then(function (buf) { voiceBufs[i] = buf; }));
      }
      if (batch.length) { await Promise.all(batch); log('tts batch ' + (s / TTS_CONCURRENCY + 1) + ' done'); }
    }
    const segPaths = [], durs = []; let narrTotal = 0;
    for (let i = 0; i < n; i++) {
      const seg = path.join(dir, `a${i}.m4a`);
      if (voiceBufs[i]) {
        const vp = path.join(dir, `v${i}.mp3`); fs.writeFileSync(vp, voiceBufs[i]); voiceBufs[i] = null;
        const vd = ffdur(vp) || 3; const cd = vd + GAP;
        log('card ' + i + ' dur=' + vd.toFixed(2));
        execFileSync(FFMPEG, ['-y', '-i', vp, '-af', 'apad', '-t', cd.toFixed(2), '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', seg], { stdio: 'ignore' });
        durs.push(cd); narrTotal += vd;
      } else {
        const cd = 2.5;
        execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', cd.toFixed(2), '-c:a', 'aac', '-b:a', '128k', seg], { stdio: 'ignore' });
        durs.push(cd);
      }
      segPaths.push(seg);
    }
    log('all voices done durs=' + durs.map(d => d.toFixed(1)).join(','));

    // 4) 오디오 세그먼트 이어붙여 내레이션 트랙(재인코딩으로 이음새 제거)
    fs.writeFileSync(path.join(dir, 'alist.txt'), segPaths.map(p => `file '${p}'`).join('\n') + '\n');
    const narrPath = path.join(dir, 'narration.m4a');
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'alist.txt'), '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', narrPath], { stdio: 'ignore' });
    log('narration assembled');

    // 5) 카드 프레임 렌더 — 이미지를 한 장씩 디코드 → 렌더 → 즉시 해제
    const framePaths = []; let total = 0;
    for (let i = 0; i < n; i++) {
      const b64 = String(opts.images[i]).split(',').pop();
      let img = await loadImage(Buffer.from(b64, 'base64'));
      const buf = renderCardFrame(createCanvas, img, opts.bg || 'blur');
      img = null; opts.images[i] = null;   // 디코드 이미지·원본 문자열 즉시 해제
      const p = path.join(dir, `f${i}.png`); fs.writeFileSync(p, buf); framePaths.push(p);
      total += durs[i];
      log('frame ' + i + ' rendered');
    }
    log('frames done total=' + total.toFixed(1));

    // 6) 배경음악 → 영상 길이만큼만 유한 반복+트림한 "음악 베드" (과다 읽기/무한 버퍼 방지)
    const music = require('./reel-music.js');
    const musicPath = path.join(dir, 'music.mp3'); fs.writeFileSync(musicPath, Buffer.from(music.split(',')[1], 'base64'));
    const musicDur = ffdur(musicPath) || 30;
    const loops = Math.max(0, Math.ceil(total / musicDur));
    const afOut = Math.max(0.1, total - 1.0).toFixed(2);
    const bedPath = path.join(dir, 'bed.m4a');
    execFileSync(FFMPEG, ['-y', '-stream_loop', String(loops), '-i', musicPath, '-t', total.toFixed(2), '-af', 'volume=0.22', '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', bedPath], { stdio: 'ignore' });
    log('music bed ready dur=' + musicDur.toFixed(1) + ' loops=' + loops);

    // 6b) 음악 베드 + 내레이션 → 최종 오디오 (둘 다 정확히 total 길이 → 가볍고 경계 명확)
    const finalAudio = path.join(dir, 'final_audio.m4a');
    execFileSync(FFMPEG, ['-y', '-i', bedPath, '-i', narrPath,
      '-filter_complex', `[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,afade=t=out:st=${afOut}:d=1.0[a]`,
      '-map', '[a]', '-t', total.toFixed(2), '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', finalAudio], { stdio: 'ignore' });
    log('final audio ready, video mux start');

    // 7) 카드를 한 장씩 짧은 영상 조각으로 인코딩 (메모리 폭발 방지: 항상 카드 1장 분량만 처리)
    let clipList = '';
    for (let i = 0; i < n; i++) {
      const clip = path.join(dir, `c${i}.mp4`);
      let vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p';
      if (i === n - 1) { const segFade = Math.max(0.1, durs[i] - 0.5).toFixed(2); vf += `,fade=t=out:st=${segFade}:d=0.5`; }   // 마지막 카드 끝만 페이드아웃
      execFileSync(FFMPEG, ['-y', '-loop', '1', '-i', framePaths[i], '-t', durs[i].toFixed(2),
        '-vf', vf, '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-threads', '1', clip], { stdio: 'ignore' });
      clipList += `file '${clip}'\n`;
      log('clip ' + i + ' done');
    }
    fs.writeFileSync(path.join(dir, 'clips.txt'), clipList);

    // 8) 조각 이어붙이기(재인코딩 없이 복사) → 영상 트랙
    const videoOnly = path.join(dir, 'video.mp4');
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'clips.txt'), '-c', 'copy', videoOnly], { stdio: 'ignore' });
    log('clips concatenated');

    // 9) 영상(복사) + 완성 오디오 결합 → 매우 가벼움
    const out = path.join(dir, 'out.mp4');
    execFileSync(FFMPEG, ['-y', '-i', videoOnly, '-i', finalAudio,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-t', total.toFixed(2), '-movflags', '+faststart', out], { stdio: 'ignore' });
    log('mux done');
    return { mp4: fs.readFileSync(out), durationSec: total, narrDur: narrTotal, sceneCount: n };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ───────── 폰트 ───────── */
let fontsReady = false;
async function ensureFonts(GlobalFonts) {
  if (fontsReady) return;
  const files = [['Pretendard-Regular.otf', 'Pretendard Regular'], ['Pretendard-SemiBold.otf', 'Pretendard SemiBold'], ['Pretendard-Bold.otf', 'Pretendard Bold']];
  for (const [f, n] of files) { const r = await fetch(PRETENDARD_BASE + f); if (!r.ok) throw new Error('폰트 다운로드 실패 ' + f); GlobalFonts.register(Buffer.from(await r.arrayBuffer()), n); }
  fontsReady = true;
}

/* ───────── 릴스 발행 (reel-cron.js / promo-reel.js 와 동일 플로우) ───────── */
async function publishReel(videoUrl, caption) {
  const IG = process.env.IG_USER_ID, TOKEN = process.env.IG_ACCESS_TOKEN;
  const rC = await fetch(`${GRAPH}/${IG}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption, thumb_offset: 1000, access_token: TOKEN }) });
  const jC = await rC.json(); if (!rC.ok || !jC.id) throw new Error('릴스 컨테이너 실패: ' + JSON.stringify(jC.error || jC));
  const creationId = jC.id; let status = '';
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const rs = await fetch(`${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`); const js = await rs.json(); status = js.status_code || '';
    if (status === 'FINISHED') break; if (status === 'ERROR') throw new Error('영상 처리 ERROR (형식/길이 확인)');
  }
  if (status !== 'FINISHED') throw new Error('영상 처리 시간초과');
  const rP = await fetch(`${GRAPH}/${IG}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: TOKEN }) });
  const jP = await rP.json(); if (!rP.ok || !jP.id) throw new Error('발행 실패: ' + JSON.stringify(jP.error || jP));
  return jP.id;
}

/* ───────── POST body 읽기 (Vercel 미파싱 대비) ───────── */
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = ''; req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  const out = (s, p) => { res.status(s).json(p); };
  const isPost = req.method === 'POST';
  let body = {};
  if (isPost) body = await readBody(req);

  // 인증
  const manual = (req.query && req.query.secret) || body.secret || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && (req.headers['authorization'] || '') === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  if (!cronOk && !manualOk) return out(401, { ok: false, error: '인증 실패' });

  const dryrun = (req.query && (req.query.dryrun === '1' || req.query.dryrun === 'true')) || body.dryrun === true || body.dryrun === '1';

  // 입력 파싱 (GET: 쿼리/기본샘플 · POST: body)
  const script = (isPost ? body.script : req.query.script) || (!isPost ? SAMPLE_SCRIPT : '');
  const showSubtitle = isPost
    ? (body.showSubtitle !== false && body.showSubtitle !== '0' && body.showSubtitle !== 0)
    : (req.query.sub !== '0');
  const caption = (isPost ? body.caption : req.query.caption) || DEFAULT_CAPTION;
  // 카드 모드: 카드 이미지 배열(base64 dataURL)이 오면 "카드+음성", 없으면 기존 "자막+음성"
  const images = (isPost && Array.isArray(body.images))
    ? body.images.map(function (x) { return String(x && x.data ? x.data : x); }).filter(Boolean)
    : [];
  const bg = (isPost ? body.bg : req.query.bg) || 'blur';

  try {
    console.log('[vreel] enter mode=' + (images.length ? 'card' : 'subtitle') + ' images=' + images.length + ' dryrun=' + dryrun + ' scriptLen=' + String(script).length);
    if (!script || !String(script).trim()) return out(400, { ok: false, error: '스크립트(script)가 비었습니다.' });
    if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) return out(500, { ok: false, error: 'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.' });
    if (images.length && !process.env.ELEVENLABS_API_KEY) return out(500, { ok: false, error: 'ELEVENLABS_API_KEY 환경변수가 없습니다. (Vercel 설정 필요)' });
    let canvasMod; try { canvasMod = require('@napi-rs/canvas'); } catch (e) { return out(500, { ok: false, error: '@napi-rs/canvas 로드 실패: ' + e.message }); }
    const { GlobalFonts } = canvasMod;
    if (images.length === 0) await ensureFonts(GlobalFonts);   // 카드 모드는 서버에서 텍스트를 안 그리므로 폰트 불필요

    const builder = images.length ? buildReelCards : buildReel;
    const { mp4, durationSec, narrDur, sceneCount } = await builder(canvasMod, { script: String(script), showSubtitle, caption, images, bg });
    console.log('[vreel] build done bytes=' + (mp4 ? mp4.length : 0) + ' dur=' + durationSec);
    const blob = await put(`reels/voice-${Date.now()}.mp4`, mp4, { access: 'public', contentType: 'video/mp4', addRandomSuffix: true, token: process.env.BLOB_READ_WRITE_TOKEN });
    const videoUrl = blob.url;
    console.log('[vreel] blob uploaded ' + videoUrl);

    if (dryrun) {
      if (isPost) return out(200, { ok: true, dryrun: true, videoUrl, durationSec, narrDur, sceneCount, showSubtitle });
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>음성 자막 릴스 미리보기</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif;text-align:center"><div style="max-width:520px;margin:0 auto;padding:18px"><div style="color:#2997ff;font-weight:700;font-size:16px">▶ 음성 자막 릴스 미리보기 (아직 발행 안 됨)</div><div style="color:#8a8a90;font-size:13px;margin:6px 0 14px">자막 ${showSubtitle ? 'ON' : 'OFF'} · 영상 ${durationSec.toFixed(1)}초 · 내레이션 ${narrDur ? narrDur.toFixed(1) + '초' : '측정실패'} · 장면 ${sceneCount}개</div><video src="${videoUrl}" controls autoplay playsinline loop style="width:100%;border-radius:14px;background:#000"></video><div style="color:#9a9aa0;font-size:12px;margin-top:8px">▶ 재생 후 소리를 켜서 음성을 확인하세요.</div><div style="background:#16161a;border-radius:12px;padding:14px;margin-top:16px;font-size:14px;line-height:1.5">마음에 들면 → 주소창에서 <b style="color:#fff">&amp;dryrun=1</b> 을 지우고 다시 접속하면 <b style="color:#2997ff">실제로 발행</b>됩니다.</div><details style="margin-top:14px;text-align:left"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">캡션 보기</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(caption)}</pre></details></div></body></html>`;
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return;
    }

    const mediaId = await publishReel(videoUrl, caption);
    return out(200, { ok: true, mediaId, videoUrl, durationSec });
  } catch (err) {
    try { console.error('[vreel] FATAL ' + (err && err.stack ? err.stack : err)); } catch (e) {}
    return out(500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
