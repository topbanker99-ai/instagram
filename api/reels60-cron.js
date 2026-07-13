// api/reels60-cron.js
// 건보 면접 릴스 60일 연속 자동발행 — 계정 1번(topbanker99, 기존 릴스 발행 체계)
//   · 시즌1 R01→R30 → 시즌2 D-30→D-1, 하루 1편 끊김 없이 순차 발행 (reels60-data.js)
//   · 제작: ElevenLabs TTS(기존 브랜드 보이스 동일) → 배경영상 V1~V5 루프 합성(-shortest)
//           → 나레이션 싱크 자막(하단, 흰 글씨+검정 반투명) + 훅 문구(0~2초 상단 대형) 번인
//   · 자막 싱크: ElevenLabs with-timestamps 글자 단위 정렬 사용(오탈자 0% 보장).
//           실패 시 문장 비례 배분 폴백.
//   · 검수(발행 전 자동): 영상길이=음성길이(±0.5s), 1080×1920, 오디오 존재,
//           캡션 시리즈 표기+해시태그 20개, 금지어(온더탑스튜디오) 부재
//   · 발행: Blob 업로드(공개 URL) → media_type=REELS → status 폴링 → publish
//   · 이력: Blob reels60-history.csv (일차,세트,발행일시KST,미디어ID,상태)
//   · 진도: Blob reels60-progress.json (다음 발행 index)
//
// 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, ELEVENLABS_API_KEY, (선택)ELEVENLABS_VOICE_ID,
//           CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 수동:  ?secret=<PUBLISH_SECRET>&day=1&dryrun=1  → 미리보기 HTML(발행 안 함)
//        ?secret=<PUBLISH_SECRET>                 → 즉시 발행(다음 회차)
// 미리보기 전용키: ?pkey=<PREVIEW_KEY>&day=N&dryrun=1 (dryrun에서만 유효)

const SETS = require('./reels60-data.js');
const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const BASE = 'https://instagram-three-wheat.vercel.app';
const ASSETS = '/reels60-assets';
const PROGRESS_KEY = 'reels60-progress.json';
const HISTORY_KEY = 'reels60-history.csv';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'n2fbxG88jqAoaVPUy3IG';
const TTS_MODEL = 'eleven_multilingual_v2';
const PREVIEW_KEY = 'r60p-x7k2m9qe41';
const NOT_BEFORE = Date.parse('2099-01-01T00:00:00Z'); // 시작일 확정 후 교체
const BANNED = '온더탑스튜디오';
// 중앙 배너(힉스필드 생성 → Blob 캐시). ?pkey&cacheUrl=<원본URL> 로 갱신
const BANNER_URL = 'https://kznnn3ogeuwatyvq.public.blob.vercel-storage.com/reels60-assets/banner.png';
// 모든 편의 나레이션 시작 고정 문구 (사용자 지시)
const SERIES_INTRO = '건강보험공단 면접의 비밀 시리즈 연재중이야.';

/* ───────── Blob 진도/이력 ───────── */
async function blobRead(key) {
  try {
    const { blobs } = await list({ prefix: key, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (blobs && blobs.length) { const r = await fetch(blobs[0].url + '?t=' + Date.now()); if (r.ok) return await r.text(); }
  } catch (e) {}
  return null;
}
async function blobWrite(key, text, ct) {
  await put(key, text, { access: 'public', contentType: ct, addRandomSuffix: false, allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN });
}
async function readProgress() { try { return JSON.parse(await blobRead(PROGRESS_KEY) || '{}'); } catch (e) { return {}; } }
async function appendHistory(line) {
  const cur = (await blobRead(HISTORY_KEY)) || '일차,세트,발행일시,미디어ID,상태\n';
  await blobWrite(HISTORY_KEY, cur + line + '\n', 'text/csv; charset=utf-8');
}
function nowKST() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' KST'; }

/* ───────── ElevenLabs TTS (글자 타임스탬프 포함) ───────── */
async function ttsTimed(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY 환경변수가 없습니다.');
  const body = JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true } });
  // 1차: with-timestamps (글자 단위 정렬)
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body,
    });
    if (r.ok) {
      const j = await r.json();
      const al = j.alignment || j.normalized_alignment;
      if (j.audio_base64 && al && al.characters && al.characters.length) {
        return { buf: Buffer.from(j.audio_base64, 'base64'), align: al, mode: 'timestamps' };
      }
    }
  } catch (e) {}
  // 폴백: 일반 TTS (자막은 문장 비례 배분)
  const r2 = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body,
  });
  if (!r2.ok) { const t = await r2.text().catch(() => ''); throw new Error('ElevenLabs 실패 ' + r2.status + ': ' + t.slice(0, 180)); }
  return { buf: Buffer.from(await r2.arrayBuffer()), align: null, mode: 'fallback' };
}

/* ───────── 자막 세그먼트 (글자 정렬 → 구간) ───────── */
/* 자막 분할 원칙: 문장 단위(.!?…)로만 끊는다. 34자 초과 문장만 콤마→띄어쓰기 순으로
   분할하되 단어 중간에서는 절대 자르지 않는다(잘린 자막 방지). */
const SEG_MAXC = 34;
function segmentsFromAlign(align) {
  const chars = align.characters, st = align.character_start_times_seconds, en = align.character_end_times_seconds;
  const segs = [];
  const emit = (a, b) => {
    while (a <= b && !String(chars[a]).trim()) a++;
    while (b >= a && !String(chars[b]).trim()) b--;
    if (a > b) return;
    const text = chars.slice(a, b + 1).join('');
    if (text.length <= SEG_MAXC) { segs.push({ text, start: st[a], end: en[b] }); return; }
    const mid = Math.floor((a + b) / 2);
    let cut = -1;
    for (let i = a + 4; i <= b - 4; i++) if (chars[i] === ',') { if (cut === -1 || Math.abs(i - mid) < Math.abs(cut - mid)) cut = i; }
    if (cut === -1) for (let i = a + 2; i <= b - 2; i++) if (chars[i] === ' ') { if (cut === -1 || Math.abs(i - mid) < Math.abs(cut - mid)) cut = i; }
    if (cut === -1) { segs.push({ text, start: st[a], end: en[b] }); return; }
    emit(a, cut); emit(cut + 1, b);
  };
  let s = 0;
  for (let i = 0; i < chars.length; i++) {
    if (/[.!?…]/.test(chars[i])) { emit(s, i); s = i + 1; }
  }
  if (s < chars.length) emit(s, chars.length - 1);
  segs.sort((x, y) => x.start - y.start);
  for (let i = 0; i < segs.length; i++) {
    if (i < segs.length - 1) segs[i].end = Math.min(Math.max(segs[i].end + 0.12, segs[i].start + 0.6), segs[i + 1].start);
    else segs[i].end = Math.max(segs[i].end + 0.2, segs[i].start + 0.6);
  }
  return segs;
}
function chunkSentence(t) {
  t = t.trim();
  if (t.length <= SEG_MAXC) return [t];
  const mid = Math.floor(t.length / 2);
  let cut = -1;
  for (let i = 4; i <= t.length - 5; i++) if (t[i] === ',') { if (cut === -1 || Math.abs(i - mid) < Math.abs(cut - mid)) cut = i; }
  if (cut === -1) for (let i = 2; i <= t.length - 3; i++) if (t[i] === ' ') { if (cut === -1 || Math.abs(i - mid) < Math.abs(cut - mid)) cut = i; }
  if (cut === -1) return [t];
  return [...chunkSentence(t.slice(0, cut + 1)), ...chunkSentence(t.slice(cut + 1))];
}
function segmentsProportional(text, dur) {
  const sents = text.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  const chunks = sents.flatMap(chunkSentence);
  const total = chunks.reduce((a, s) => a + s.length, 0) || 1;
  let t = 0; const segs = [];
  for (const s of chunks) { const d = Math.max(0.8, dur * (s.length / total)); segs.push({ text: s, start: t, end: Math.min(t + d, dur) }); t += d; }
  return segs;
}

/* ───────── ASS 자막 생성 (하단 싱크 자막 + 훅 0~2초 상단) ───────── */
function assTime(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60); return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`; }
function assEsc(t) { return String(t).replace(/[{}]/g, '').replace(/\n/g, '\\N'); }
function wrapAss(t, maxLen) {
  t = String(t);
  if (t.length <= maxLen) return t;
  // 1) 2줄 균형 분할 시도
  const words = t.split(' '); let best = null, bd = 1e9;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    if (a.length <= maxLen && b.length <= maxLen && Math.abs(a.length - b.length) < bd) { best = a + '\\N' + b; bd = Math.abs(a.length - b.length); }
  }
  if (best) return best;
  // 2) 그리디 다중 줄 (공백 우선, 초과 시 글자 단위 강제 분할) — 화면 폭 초과 방지
  const lines = []; let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= maxLen) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const out = [];
  for (let ln of lines) {
    while (ln.length > maxLen) { out.push(ln.slice(0, maxLen)); ln = ln.slice(maxLen); }
    if (ln) out.push(ln);
  }
  return out.join('\\N');
}
/* 핵심 단어 자동 하이라이트 (숫자+단위 우선, 임팩트 단어 차선 — 줄당 1개) */
const NUMUNIT = /(D-\d+|\d+[\d.,:~대]*\s?(?:점|분|초|개|명|일|년|배|위|종|문항)?)/;
const IMPACT = /(탈락|과락|합격|만점|금지|필수|위험|무너져|폭망|끝이야|진짜|핵심|비밀|공식|함정|주의)/;
function hlLine(line, base, big) {
  const m = line.match(NUMUNIT) || line.match(IMPACT);
  if (!m || !m[0].trim()) return line;
  const w = m[0].trim();
  return line.replace(w, `{\\fs${big}\\c&H0000E5FF&}${w}{\\fs${base}\\c&HFFFFFF&}`);
}
function hlWrap(text, maxLen, base, big) {
  return wrapAss(text, maxLen).split('\\N').map(l => hlLine(l, base, big)).join('\\N');
}

function buildAss(segs, titleMain, titleSub, totalDur) {
  // 제목(노란 음영 밴드 y450~800) — 사용자 확정 A안(위계 반전): 주제(서브)를 초대형으로 위, 질문(메인)은 작게 아래
  let ev = '';
  if (titleSub) {
    const subTxt = assEsc(titleSub);
    const fsSub = Math.max(84, Math.min(126, Math.floor(1000 / titleSub.length)));
    const mainW = wrapAss(assEsc(titleMain), 18);
    const mLines = mainW.split('\\N').length;
    const fsMain = mLines > 1 ? 50 : 56;
    const subH = Math.round(fsSub * 1.18), mainH = Math.round(mLines * fsMain * 1.24), gap = 24;
    const topMargin = Math.max(468, Math.round(625 - (subH + gap + mainH) / 2));
    ev += `Dialogue: 2,${assTime(0)},${assTime(totalDur)},TMain,,0,0,${topMargin},,{\\fs${fsSub}}${subTxt}\n`;
    ev += `Dialogue: 2,${assTime(0)},${assTime(totalDur)},TMain,,0,0,${topMargin + subH + gap},,{\\fs${fsMain}}${mainW}\n`;
  } else {
    // 서브 없음 — 단독 제목 밴드 중앙
    const mainW = wrapAss(assEsc(titleMain), 12);
    const tLines = mainW.split('\\N');
    const maxLen = Math.max(...tLines.map(l => l.replace(/\{[^}]*\}/g, '').length), 1);
    const n = tLines.length;
    const fs = Math.max(48, Math.min(88, Math.floor(1040 / maxLen), Math.floor(310 / (n * 1.22))));
    const topMargin = Math.max(462, Math.round(625 - (n * fs * 1.22) / 2));
    ev += `Dialogue: 2,${assTime(0)},${assTime(totalDur)},TMain,,0,0,${topMargin},,{\\fs${fs}}${mainW}\n`;
  }
  // 하단: 예능 팝 자막 (흰 글씨+블루 테두리+그림자, 핵심어 노랑+확대) — 사용자 지시로 +2pt
  for (const s of segs) {
    ev += `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Sub,,0,0,0,,${hlWrap(assEsc(s.text), 12, 84, 104)}\n`;
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Pretendard,84,&H00FFFFFF,&H00FFFFFF,&H00D46F1A,&H78000000,1,0,0,0,100,100,0,0,1,11,4,2,50,50,470,1
Style: TMain,Black Han Sans,104,&H00401505,&H00FFFFFF,&H0000E5FF,&H00000000,0,0,0,0,100,100,1,0,1,0,0,8,40,40,505,1
Style: TSub,Black Han Sans,54,&H00401505,&H00FFFFFF,&H0000E5FF,&H00000000,0,0,0,0,100,100,1,0,1,0,0,8,40,40,652,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
` + ev;
}

/* ───────── ffmpeg 헬퍼 ───────── */
function getFFmpeg() {
  const os = require('os'), fs = require('fs'), path = require('path');
  let F = process.env.FFMPEG_PATH || require('ffmpeg-static');
  if (!process.env.FFMPEG_PATH) {
    try { const t = path.join(os.tmpdir(), 'ffmpeg'); if (!fs.existsSync(t)) fs.copyFileSync(F, t); fs.chmodSync(t, 0o755); F = t; }
    catch (e) { try { fs.chmodSync(F, 0o755); } catch (_) {} }
  }
  return F;
}
function ffDur(FF, p) {
  const { execFileSync } = require('child_process');
  try { execFileSync(FF, ['-i', p], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { const s = (e.stderr || '').toString(); const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/); if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); }
  return 0;
}
function ffInfo(FF, p) {
  const { execFileSync } = require('child_process');
  try { execFileSync(FF, ['-i', p], { stdio: ['ignore', 'ignore', 'pipe'] }); return ''; }
  catch (e) { return (e.stderr || '').toString(); }
}
async function fetchTo(url, dest) {
  const fs = require('fs');
  const r = await fetch(url); if (!r.ok) throw new Error('에셋 다운로드 실패 ' + url + ' ' + r.status);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

/* ───────── 한 편 제작 ─────────
   구조: [배경영상+배너+제목+쇼츠자막 — 처음부터 바로] → [아웃트로 카드(음성 마지막 1.5s에 등장, +1.6s 홀드)] */
const OUTRO_LEAD = 1.5, OUTRO_TAIL = 1.6;
const BLOB_ASSETS = 'https://kznnn3ogeuwatyvq.public.blob.vercel-storage.com/reels60-assets';
const BLOB_BGS = ['V6', 'V7', 'V8', 'V9', 'V10']; // 힉스필드 추가 생성분 — Blob에서 서빙
async function buildEpisode(item) {
  const os = require('os'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const FF = getFFmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r60-'));
  try {
    // 1) 에셋: 배경영상 + 폰트 + 카드용 이미지(로고·캐릭터)
    // 배경 3개 조합(사용자 지시): 테마 영상 1개 + 나머지 9개 중 랜덤 2개를 이어붙임
    const ALL_BGS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10'];
    const others = ALL_BGS.filter(v => v !== item.bg);
    for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
    const bgs = [item.bg, others[0], others[1]];
    const bgPaths = [];
    for (const v of bgs) {
      const p = path.join(dir, v + '.mp4');
      const u = BLOB_BGS.includes(v) ? `${BLOB_ASSETS}/${v}.mp4` : `${BASE}${ASSETS}/${v}.mp4`;
      await fetchTo(u, p); bgPaths.push(p);
    }
    const fontsDir = path.join(dir, 'fonts'); fs.mkdirSync(fontsDir);
    const fBold = path.join(fontsDir, 'Pretendard-Bold.otf');
    const fReg = path.join(fontsDir, 'Pretendard-Regular.otf');
    await fetchTo(`${BASE}${ASSETS}/fonts/Pretendard-Bold.otf`, fBold);
    await fetchTo(`${BASE}${ASSETS}/fonts/Pretendard-Regular.otf`, fReg);
    await fetchTo(`${BASE}${ASSETS}/fonts/BlackHanSans-Regular.ttf`, path.join(fontsDir, 'BlackHanSans-Regular.ttf'));
    const bandPath = path.join(dir, 'band.png');
    await fetchTo(`${BASE}${ASSETS}/band_yellow_mid.png`, bandPath);
    const logoPath = path.join(dir, 'logo.png'), charPath = path.join(dir, 'char.png');
    await fetchTo(`${BASE}${ASSETS}/nhis_logo_box.png`, logoPath);
    await fetchTo(`${BASE}/character.png`, charPath);
    // 중앙 배너(선택) — Blob에 캐시된 힉스필드 배너. 없으면 배너 없이 진행
    let bannerPath = null;
    try {
      const bp = path.join(dir, 'banner.png');
      await fetchTo(BANNER_URL, bp);
      bannerPath = bp;
    } catch (e) { bannerPath = null; }

    // 2) 아웃트로 카드 렌더 (@napi-rs/canvas) — 인트로 카드는 사용자 지시로 제거
    const canvasMod = require('@napi-rs/canvas');
    const { GlobalFonts, loadImage } = canvasMod;
    GlobalFonts.register(fs.readFileSync(fBold), 'Pretendard Bold');
    GlobalFonts.register(fs.readFileSync(fReg), 'Pretendard Regular');
    const cards = require('./reels60-cards.js');
    const assets = { logo: await loadImage(logoPath), char: await loadImage(charPath) };
    const outroPath = path.join(dir, 'outro.png');
    const outroBuf = cards.renderOutro(canvasMod, item, assets);
    fs.writeFileSync(outroPath, outroBuf);

    // 3) TTS — 시리즈 인트로 고정 문구 + 원문 나레이션 (60편 동일 보이스)
    const narrText = SERIES_INTRO + ' ' + item.narration;
    const { buf, align, mode } = await ttsTimed(narrText);
    const narrPath = path.join(dir, 'narr.mp3'); fs.writeFileSync(narrPath, buf);
    const narrDur = ffDur(FF, narrPath);
    if (!narrDur) throw new Error('나레이션 길이 측정 실패');
    const total = narrDur + OUTRO_TAIL;
    const outroStart = Math.max(2, narrDur - OUTRO_LEAD);

    // 4) 자막(ASS): 예능 팝 자막(핵심어 하이라이트) + 상단 초대형 제목(의문문 메인/서브)
    const segs = align ? segmentsFromAlign(align) : segmentsProportional(narrText, narrDur);
    const tparts = String(item.qtitle || item.title).split(/\s+—\s+/);
    const titleMain = tparts[0].trim(), titleSub = (tparts[1] || '').trim();
    const assPath = path.join(dir, 'subs.ass');
    fs.writeFileSync(assPath, buildAss(segs, titleMain, titleSub, total));

    // 5) 합성: 배경 3클립 순차 연결(각각 루프→트림) + 밴드 (+배너) + 자막 → 아웃트로 카드 → 음성
    const out = path.join(dir, 'out.mp4');
    const seg = Math.max(3, total / 3);
    const segLast = Math.max(3, total - 2 * seg + 1.0); // 마지막은 여유(-t로 컷)
    const inputs = [
      '-stream_loop', '-1', '-i', bgPaths[0],
      '-stream_loop', '-1', '-i', bgPaths[1],
      '-stream_loop', '-1', '-i', bgPaths[2],
      '-i', narrPath,                       // 3: 음성
      '-loop', '1', '-i', outroPath,        // 4: 아웃트로
      '-loop', '1', '-i', bandPath];        // 5: 노란 밴드
    let chain =
      `[0:v]trim=duration=${seg.toFixed(2)},setpts=PTS-STARTPTS,scale=1080:1920:flags=lanczos[c0];` +
      `[1:v]trim=duration=${seg.toFixed(2)},setpts=PTS-STARTPTS,scale=1080:1920:flags=lanczos[c1];` +
      `[2:v]trim=duration=${segLast.toFixed(2)},setpts=PTS-STARTPTS,scale=1080:1920:flags=lanczos[c2];` +
      `[c0][c1][c2]concat=n=3:v=1:a=0,fps=30[bg];` +
      `[bg][5:v]overlay=0:0[bb];`;
    let last = 'bb';
    if (bannerPath) {
      // 배너(투명 PNG)는 화면 최상단 중앙 — 그 아래 노란 음영 제목, 그 아래 자막 순서
      inputs.push('-loop', '1', '-i', bannerPath);
      chain += `[6:v]scale=920:-1[bn];[${last}][bn]overlay=(main_w-overlay_w)/2:20[bw];`;
      last = 'bw';
    }
    chain += `[${last}]subtitles=${assPath}:fontsdir=${fontsDir}[sv];` +
      `[sv][4:v]overlay=0:0:enable='gte(t,${outroStart.toFixed(2)})'[v2];` +
      `[v2]format=yuv420p[vout]`;
    execFileSync(FF, ['-y', ...inputs,
      '-filter_complex', chain, '-map', '[vout]', '-map', '3:a', '-af', 'apad',
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-r', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-t', total.toFixed(2),
      '-movflags', '+faststart', out], { stdio: 'ignore' });

    // 6) 검수(QA)
    const outDur = ffDur(FF, out);
    const info = ffInfo(FF, out);
    const qa = [];
    const durDiff = Math.abs(outDur - total);
    qa.push(['길이 일치(음성+아웃트로 ±0.5s)', durDiff <= 0.5, `영상 ${outDur.toFixed(2)}s / 음성 ${narrDur.toFixed(2)}s+${OUTRO_TAIL}s / 차이 ${durDiff.toFixed(2)}s`]);
    qa.push(['아웃트로 카드', outroBuf.length > 5000, `${(outroBuf.length / 1024) | 0}KB`]);
    qa.push(['상단 배너', true, bannerPath ? '적용' : '없음(Blob 캐시 전)']);
    qa.push(['배경 3클립 조합', bgs.length === 3 && new Set(bgs).size === 3, bgs.join('→')]);
    qa.push(['해상도 1080×1920', /1080x1920/.test(info), '']);
    qa.push(['오디오 스트림', /Audio:\s*aac/.test(info), '']);
    const marker = item.season === 1 ? `[건보 면접 30일 릴스 ${item.code}]` : `[건보 면접 D-30 스프린트 ${item.code}]`;
    qa.push(['캡션 시리즈 표기', item.caption.startsWith(marker), marker]);
    qa.push(['해시태그 20개', (item.caption.match(/#/g) || []).length === 20, '']);
    qa.push(['금지어 부재', ![item.caption, item.narration, item.hook].some(t => t.includes(BANNED) || t.includes('온더탑')), '']);
    qa.push(['자막=나레이션 동기', segs.map(s => s.text).join('').replace(/\s/g, '') === narrText.replace(/\s/g, ''), align ? '글자 타임스탬프' : '문장 비례(폴백)']);
    const failed = qa.filter(q => !q[1]);
    if (failed.length) throw new Error('QA 실패: ' + failed.map(f => f[0] + (f[2] ? `(${f[2]})` : '')).join(', '));

    return { mp4: fs.readFileSync(out), outDur, narrDur, segCount: segs.length, ttsMode: mode, qa, bgs };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ───────── 릴스 발행 (계정1 — 기존 voice-reel과 동일 플로우) ───────── */
async function publishReel(videoUrl, caption) {
  const IG = process.env.IG_USER_ID, TOKEN = process.env.IG_ACCESS_TOKEN;
  if (!IG || !TOKEN) throw new Error('IG_USER_ID/IG_ACCESS_TOKEN 환경변수가 없습니다.');
  const rC = await fetch(`${GRAPH}/${IG}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption, thumb_offset: 1000, access_token: TOKEN }) });
  const jC = await rC.json(); if (!rC.ok || !jC.id) throw new Error('릴스 컨테이너 실패: ' + JSON.stringify(jC.error || jC));
  let status = '';
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const rs = await fetch(`${GRAPH}/${jC.id}?fields=status_code&access_token=${encodeURIComponent(TOKEN)}`);
    const js = await rs.json(); status = js.status_code || '';
    if (status === 'FINISHED') break; if (status === 'ERROR') throw new Error('영상 처리 ERROR');
  }
  if (status !== 'FINISHED') throw new Error('영상 처리 시간초과');
  const rP = await fetch(`${GRAPH}/${IG}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: jC.id, access_token: TOKEN }) });
  const jP = await rP.json(); if (!rP.ok || !jP.id) throw new Error('발행 실패: ' + JSON.stringify(jP.error || jP));
  return jP.id;
}

module.exports = async (req, res) => {
  const out = (s, p) => res.status(s).json(p);
  const q = req.query || {};
  const dryrun = q.dryrun === '1' || q.dryrun === 'true';

  // 인증: 크론/시크릿, 또는 미리보기 전용키(dryrun 한정)
  const auth = req.headers['authorization'] || '';
  const manual = q.secret || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  const previewOk = q.pkey === PREVIEW_KEY && (dryrun || q.cacheUrl);
  if (!cronOk && !manualOk && !previewOk) return out(401, { ok: false, error: '인증 실패' });

  const forced = parseInt(q.day, 10);
  try {
    // 에셋 캐시 액션: 외부 URL(힉스필드 등)을 받아 Blob 고정 경로에 저장 (?name=V6.mp4, 기본 banner.png)
    if (q.cacheUrl) {
      const name = /^[A-Za-z0-9._-]{1,40}$/.test(q.name || '') ? q.name : 'banner.png';
      const ct = name.endsWith('.mp4') ? 'video/mp4' : 'image/png';
      const r = await fetch(q.cacheUrl);
      if (!r.ok) return out(400, { ok: false, error: '원본 다운로드 실패 ' + r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      const b = await put('reels60-assets/' + name, buf, { access: 'public', contentType: ct, addRandomSuffix: false, allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN });
      return out(200, { ok: true, cached: true, name, bytes: buf.length, url: b.url });
    }
    // 시작일 가드 (dryrun·강제 지정은 통과)
    if (!dryrun && !forced && Date.now() < NOT_BEFORE) {
      return out(200, { ok: true, skipped: true, reason: '시작일 이전 — 발행 안 함' });
    }
    const prog = await readProgress();
    let idx;
    if (forced && forced >= 1 && forced <= SETS.length) idx = forced - 1;
    else idx = ((prog.index || 0) % SETS.length + SETS.length) % SETS.length;
    const item = SETS[idx];

    const t0 = Date.now();
    const ep = await buildEpisode(item);
    const blob = await put(`reels60/${dryrun ? 'preview-' : ''}${item.code}-${Date.now()}.mp4`, ep.mp4,
      { access: 'public', contentType: 'video/mp4', addRandomSuffix: true, token: process.env.BLOB_READ_WRITE_TOKEN });
    const buildSec = ((Date.now() - t0) / 1000).toFixed(1);

    if (dryrun) {
      if (q.json === '1') {
        return out(200, { ok: true, dryrun: true, idx: idx + 1, code: item.code, title: item.title, bgs: ep.bgs,
          videoUrl: blob.url, durationSec: ep.outDur, narrDur: ep.narrDur, segCount: ep.segCount,
          ttsMode: ep.ttsMode, buildSec, qa: ep.qa.map(x => ({ name: x[0], pass: x[1], note: x[2] })) });
      }
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const qaHtml = ep.qa.map(x => `<li style="color:${x[1] ? '#7ee787' : '#ff7b72'}">${x[1] ? 'PASS' : 'FAIL'} · ${esc(x[0])} ${x[2] ? '— ' + esc(x[2]) : ''}</li>`).join('');
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>릴스 60일 미리보기 ${item.code}</title></head>
<body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif"><div style="max-width:520px;margin:0 auto;padding:18px">
<div style="color:#2997ff;font-weight:700">건보 면접 릴스 60일 — ${item.code} 미리보기 (발행 안 됨)</div>
<div style="color:#8a8a90;font-size:13px;margin:6px 0 12px">${esc(item.title)} · 배경 ${item.bg} · ${ep.outDur.toFixed(1)}초 · 자막 ${ep.segCount}개(${ep.ttsMode === 'timestamps' ? '글자 타임스탬프 싱크' : '문장 비례'}) · 빌드 ${buildSec}s</div>
<video src="${blob.url}" controls autoplay playsinline loop style="width:100%;border-radius:14px;background:#000"></video>
<div style="color:#9a9aa0;font-size:12px;margin-top:6px">소리를 켜고 확인하세요.</div>
<div style="color:#6a6a70;font-size:11px;word-break:break-all;margin-top:4px">영상 URL: ${blob.url}</div>
<ul style="font-size:13px;line-height:1.6;padding-left:18px">${qaHtml}</ul>
<details open style="margin-top:8px"><summary style="color:#8a8a90;font-size:12px;cursor:pointer">발행 캡션</summary><pre style="white-space:pre-wrap;background:#111;padding:12px;border-radius:8px;font-size:12px;color:#bbb">${esc(item.caption)}</pre></details>
</div></body></html>`;
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html);
    }

    // 발행 + 이력
    let mediaId;
    try {
      mediaId = await publishReel(blob.url, item.caption);
    } catch (err) {
      await appendHistory([idx + 1, item.code, nowKST(), '', 'ERROR: ' + String(err.message).replace(/[,\n]/g, ' ').slice(0, 120)].join(','));
      throw err;
    }
    prog.index = (idx + 1) % SETS.length;
    prog.lastPublished = { idx: idx + 1, code: item.code, title: item.title, mediaId, at: new Date().toISOString() };
    await blobWrite(PROGRESS_KEY, JSON.stringify(prog), 'application/json');
    await appendHistory([idx + 1, item.code, nowKST(), mediaId, 'PUBLISHED'].join(','));

    return out(200, { ok: true, published: true, idx: idx + 1, code: item.code, title: item.title, mediaId, videoUrl: blob.url, nextIndex: prog.index });
  } catch (err) {
    return out(500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
