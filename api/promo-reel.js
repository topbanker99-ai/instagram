// api/promo-reel.js
// 탑뱅커 — 하나은행 기출동형 모의고사 "홍보 릴스" (일회성, 음성 내레이션 포함)
//
// 기존 자동발행 크론(스펙/상식)과 완전히 분리된 수동 엔드포인트입니다. 크론에 등록하지 않습니다.
// 흐름: canvas로 장면 PNG 렌더 → ElevenLabs로 내레이션 mp3 생성 → ffmpeg로 (배경음악+내레이션) 합성 MP4 → Blob 업로드 → 릴스 발행.
//
// 인증:
//   - 수동: ?secret=${PUBLISH_SECRET}   또는  헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1   : 영상(음성 포함) 생성 + Blob 업로드까지만(미리보기). 발행 안 함. 영상 URL/HTML 반환.
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN, ELEVENLABS_API_KEY
//           (선택) ELEVENLABS_VOICE_ID — 없으면 아래 기본 보이스 사용
// 의존: ./blob-bundle.js, ./reel-music.js, (있으면) ./outro-image.js, @napi-rs/canvas, ffmpeg-static

const { put } = require('./blob-bundle.js');
let OUTRO = null; try { OUTRO = require('./outro-image.js'); } catch (e) {}   // 없어도 크래시 안 나도록

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';
const CIRC = ['①', '②', '③', '④', '⑤'];

// ── ElevenLabs ──
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'n2fbxG88jqAoaVPUy3IG';
const TTS_MODEL = 'eleven_multilingual_v2';   // 숫자(%·만원·연도) 읽기 안정적

// ── 내레이션 스크립트 (이 보이스가 읽을 내용) ──
const SCRIPT = "하나은행 필기, 이 문제 풀 수 있어요? 2026 하나은행 기출동형 40문항 하프 모의고사예요. NCS 네 영역과 경제, 금융, 디지털 상식까지, 실제 출제 범위 그대로 담았어요. 전 문항 정답과 상세 해설도 들어있고요. 댓글에 '하나은행'이라고 남기면, 모의고사 PDF를 무료로 보내드릴게요.";

// ── 캡션 ──
const CAPTION = `[하나은행 기출동형 하프 모의고사 — 무료 배포]

2026 하나은행 필기 대비, 기출동형 40문항 하프 모의고사를 무료로 드립니다.
NCS 의사소통·수리·문제해결·자료해석 + 경제·금융·디지털 상식, 전 문항 정답·해설 수록.

받는 법 👉 이 게시물 댓글에 '하나은행' 이라고 남겨주세요. PDF를 DM으로 보내드립니다.

자소서·필기·면접까지 — 은행·금융권 취업은 탑뱅커 @topbanker99

#하나은행 #하나은행필기 #하나은행채용 #하나은행공채 #은행취업 #은행권취업 #금융권취업 #은행필기 #NCS #금융상식 #필기시험 #은행취업준비 #취업준비 #모의고사 #하나은행기출 #기출동형 #하반기채용 #은행면접 #자기소개서 #탑뱅커`;

/* ───────── 다크 테마 + 텍스트 헬퍼 (기존 릴스와 동일 톤) ───────── */
const COL = { BG: '#0B0B0D', WHITE: '#FFFFFF', BODY: '#C9C9CE', CAP: '#8A8A90', ACCENT: '#2997FF' };
const { WHITE, BODY, CAP, ACCENT } = COL;
const fnt = (fam, size) => `${size}px "${fam}"`;
function drawTracked(ctx, x, y, t, tr) { for (const c of t) { ctx.fillText(c, x, y); x += ctx.measureText(c).width + tr; } return x; }
function trackedWidth(ctx, t, tr) { let w = 0; for (const c of t) w += ctx.measureText(c).width + tr; return w; }
function drawCentered(ctx, cx, y, t, tr) { const w = trackedWidth(ctx, t, tr) - tr; return drawTracked(ctx, cx - w / 2, y, t, tr); }
function wrapText(ctx, text, maxw, tr) {
  const units = (text || '').match(/[A-Za-z0-9.,%·\-]+|\s+|[\s\S]/g) || []; const lines = []; let cur = '';
  for (const u of units) {
    if (/^\s+$/.test(u)) { if (cur && trackedWidth(ctx, cur + ' ', tr) <= maxw) cur += ' '; else if (cur) { lines.push(cur.replace(/\s+$/, '')); cur = ''; } continue; }
    if (cur === '' || trackedWidth(ctx, cur + u, tr) <= maxw) cur += u; else { lines.push(cur.replace(/\s+$/, '')); cur = u; }
  }
  if (cur.trim()) lines.push(cur.replace(/\s+$/, '')); return lines;
}

/* ───────── 장면 렌더 (1080×1920) ───────── */
function renderScene(createCanvas, sc) {
  const W = 1080, H = 1920, M = 100, CW = W - 2 * M, CX = W / 2;
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  ctx.fillStyle = COL.BG; ctx.fillRect(0, 0, W, H); ctx.textBaseline = 'top';
  ctx.fillStyle = CAP; ctx.font = fnt('Pretendard SemiBold', 30); drawCentered(ctx, CX, 154, 'TOP BANKER', 6);

  if (sc.type === 'hook') {
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(CX - 58, 752); ctx.lineTo(CX + 58, 752); ctx.stroke();
    let hs = 108; ctx.font = fnt('Pretendard Bold', hs);
    const w = () => Math.max(...sc.lines.map(l => trackedWidth(ctx, l.t, -1)));
    while (w() > CW && hs > 56) { hs -= 4; ctx.font = fnt('Pretendard Bold', hs); }
    const lh = Math.round(hs * 1.2); let y = 900 - (sc.lines.length * lh) / 2;
    for (const l of sc.lines) { ctx.fillStyle = l.accent ? ACCENT : WHITE; ctx.font = fnt('Pretendard Bold', hs); drawCentered(ctx, CX, y, l.t, -1); y += lh; }
    if (sc.sub) { ctx.fillStyle = CAP; ctx.font = fnt('Pretendard Regular', 40); drawCentered(ctx, CX, y + 34, sc.sub, 0); }
  }
  else if (sc.type === 'q') {
    ctx.fillStyle = ACCENT; ctx.font = fnt('Pretendard SemiBold', 42); drawCentered(ctx, CX, 300, sc.label, 2);
    let fsz = 50; ctx.font = fnt('Pretendard SemiBold', fsz);
    let lns = wrapText(ctx, sc.stem, CW, 0);
    while (lns.length > 5 && fsz > 38) { fsz -= 2; ctx.font = fnt('Pretendard SemiBold', fsz); lns = wrapText(ctx, sc.stem, CW, 0); }
    let y = 450; const lh = Math.round(fsz * 1.42); ctx.fillStyle = WHITE;
    for (const l of lns) { ctx.fillText(l, M, y); y += lh; }
    y += 70;
    for (let i = 0; i < sc.options.length; i++) {
      ctx.fillStyle = ACCENT; ctx.font = fnt('Pretendard Bold', 52); ctx.fillText(CIRC[i], M, y);
      ctx.fillStyle = BODY; ctx.font = fnt('Pretendard Regular', 50); ctx.fillText(sc.options[i], M + 82, y + 2);
      y += 92;
    }
  }
  else if (sc.type === 'feat') {
    ctx.fillStyle = WHITE; ctx.font = fnt('Pretendard Bold', 66); drawCentered(ctx, CX, 320, sc.title, -1);
    ctx.strokeStyle = ACCENT; ctx.globalAlpha = 0.4; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(CX - 56, 440); ctx.lineTo(CX + 56, 440); ctx.stroke(); ctx.globalAlpha = 1;
    let y = 560;
    for (const it of sc.items) {
      ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(M + 8, y + 26, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = BODY; ctx.font = fnt('Pretendard Regular', 48);
      const lns = wrapText(ctx, it, CW - 60, 0); let ly = y;
      for (const l of lns) { ctx.fillText(l, M + 52, ly); ly += 64; }
      y = ly + 52;
    }
  }
  else if (sc.type === 'cta') {
    let hs = 92; ctx.font = fnt('Pretendard Bold', hs);
    const w = () => Math.max(...sc.lines.map(l => trackedWidth(ctx, l.t, -1)));
    while (w() > CW && hs > 56) { hs -= 4; ctx.font = fnt('Pretendard Bold', hs); }
    const lh = Math.round(hs * 1.18); let y = 760 - (sc.lines.length * lh) / 2;
    for (const l of sc.lines) { ctx.fillStyle = l.accent ? ACCENT : WHITE; ctx.font = fnt('Pretendard Bold', hs); drawCentered(ctx, CX, y, l.t, -1); y += lh; }
    if (sc.handle) { ctx.fillStyle = ACCENT; ctx.font = fnt('Pretendard SemiBold', 56); drawCentered(ctx, CX, y + 34, sc.handle, 0); y += 120; }
    if (sc.sub) { ctx.fillStyle = CAP; ctx.font = fnt('Pretendard Regular', 38); for (const l of wrapText(ctx, sc.sub, CW, 0)) { drawCentered(ctx, CX, y, l, 0); y += 52; } }
  }
  return canvas.toBuffer('image/png');
}

/* ───────── 장면 구성 ───────── */
function buildScenes() {
  return [
    { type: 'hook', dur: 3.5, lines: [{ t: '하나은행 필기' }, { t: '기출동형 모의고사', accent: true }], sub: '이 문제, 풀 수 있나요?' },
    { type: 'q', dur: 8.0, label: '은행 필기 맛보기', stem: '원금 1,000만 원을 연 복리로 2년간 예치했더니 원리금이 1,210만 원이 되었습니다. 적용된 연이율은?', options: ['5%', '10%', '15%', '21%'] },
    { type: 'feat', dur: 8.0, title: '이런 모의고사예요', items: ['40문항 · 4지선다 객관식', 'NCS 4영역 — 의사소통 · 수리 · 문제해결 · 자료해석', '경제 · 금융 · 디지털 상식', '전 문항 정답 + 상세 해설 수록'] },
    { type: 'cta', dur: 7.0, lines: [{ t: "댓글에 '하나은행'" }, { t: '무료로 보내드려요', accent: true }], handle: '@topbanker99', sub: '40문항 모의고사 + 정답 · 해설 PDF를 DM으로' },
    { type: 'outro', dur: 3.0 },   // 마무리(프리미엄/구독 안내) 이미지 — OUTRO 없으면 자동 생략
  ];
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

/* ───────── 영상 생성 (ffmpeg) — 배경음악 + 내레이션 합성 ───────── */
async function buildReel(canvasMod, scenes, narrationText) {
  const { createCanvas, loadImage } = canvasMod;
  const os = require('os'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  let FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
  if (!process.env.FFMPEG_PATH) {
    try { const tmpBin = path.join(os.tmpdir(), 'ffmpeg'); if (!fs.existsSync(tmpBin)) fs.copyFileSync(FFMPEG, tmpBin); fs.chmodSync(tmpBin, 0o755); FFMPEG = tmpBin; }
    catch (e) { try { fs.chmodSync(FFMPEG, 0o755); } catch (_) {} }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-'));
  try {
    // 1) 내레이션 mp3
    const narrBuf = await genVoice(narrationText);
    const narrPath = path.join(dir, 'narration.mp3'); fs.writeFileSync(narrPath, narrBuf);
    // 내레이션 길이 측정 (ffmpeg -i 의 Duration 파싱)
    let narrDur = 0;
    try { execFileSync(FFMPEG, ['-i', narrPath], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { const s = (e.stderr || '').toString(); const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if (m) narrDur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); }

    // 2) 배경음악
    const music = require('./reel-music.js');
    const musicPath = path.join(dir, 'music.mp3'); fs.writeFileSync(musicPath, Buffer.from(music.split(',')[1], 'base64'));

    // 3) 장면 프레임
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

    // 4) 영상이 내레이션 길이를 덮도록 마지막 프레임을 패딩
    const minDur = (narrDur || scenesTotal) + 0.6;
    const pad = Math.max(0, minDur - scenesTotal);
    if (pad > 0.05) { listTxt += `file '${lastPng}'\nduration ${pad.toFixed(2)}\n`; }
    listTxt += `file '${lastPng}'\n`;   // concat demuxer: 마지막 프레임 고정
    const total = Math.max(scenesTotal, minDur);
    fs.writeFileSync(path.join(dir, 'list.txt'), listTxt);

    // 5) 합성: 영상 + (음악 22% + 내레이션) 믹스, 끝부분 페이드아웃
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
    return { mp4: fs.readFileSync(out), durationSec: total, narrDur };
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

/* ───────── 릴스 발행 (reel-cron.js와 동일 플로우) ───────── */
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

module.exports = async (req, res) => {
  const out = (s, p) => { res.status(s).json(p); };
  const manual = (req.query && req.query.secret) || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && (req.headers['authorization'] || '') === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  if (!cronOk && !manualOk) return out(401, { ok: false, error: '인증 실패' });

  const dryrun = req.query && (req.query.dryrun === '1' || req.query.dryrun === 'true');
  try {
    if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) return out(500, { ok: false, error: 'IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.' });
    let canvasMod; try { canvasMod = require('@napi-rs/canvas'); } catch (e) { return out(500, { ok: false, error: '@napi-rs/canvas 로드 실패: ' + e.message }); }
    const { GlobalFonts } = canvasMod;
    await ensureFonts(GlobalFonts);

    const scenes = buildScenes();
    const { mp4, durationSec, narrDur } = await buildReel(canvasMod, scenes, SCRIPT);
    const blob = await put(`reels/promo-hana-${Date.now()}.mp4`, mp4, { access: 'public', contentType: 'video/mp4', addRandomSuffix: true, token: process.env.BLOB_READ_WRITE_TOKEN });
    const videoUrl = blob.url;

    if (dryrun) {
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>홍보 릴스 미리보기</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif;text-align:center"><div style="max-width:520px;margin:0 auto;padding:18px"><div style="color:#2997ff;font-weight:700;font-size:16px">▶ 하나은행 홍보 릴스 미리보기 (아직 발행 안 됨)</div><div style="color:#8a8a90;font-size:13px;margin:6px 0 14px">영상 길이 ${durationSec.toFixed(1)}초 · 내레이션 ${narrDur ? narrDur.toFixed(1) + '초' : '측정실패'}</div><video src="${videoUrl}" controls autoplay playsinline loop style="width:100%;border-radius:14px;background:#000"></video><div style="color:#9a9aa0;font-size:12px;margin-top:8px">▶ 재생 후 소리를 켜서 음성을 확인하세요.</div><div style="background:#16161a;border-radius:12px;padding:14px;margin-top:16px;font-size:14px;line-height:1.5">마음에 들면 → 주소창에서 <b style="color:#fff">&amp;dryrun=1</b> 을 지우고 다시 접속하면 <b style="color:#2997ff">실제로 발행</b>됩니다.</div><details style="margin-top:14px;text-align:left"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">캡션 보기</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(CAPTION)}</pre></details></div></body></html>`;
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return;
    }

    const mediaId = await publishReel(videoUrl, CAPTION);
    return out(200, { ok: true, mediaId, videoUrl, durationSec });
  } catch (err) {
    return out(500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
