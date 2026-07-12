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
function segmentsFromAlign(align) {
  const chars = align.characters, st = align.character_start_times_seconds, en = align.character_end_times_seconds;
  const segs = []; let buf = '', t0 = null, t1 = null;
  const flush = () => { const t = buf.trim(); if (t) segs.push({ text: t, start: t0, end: t1 }); buf = ''; t0 = null; };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (t0 === null && c.trim()) t0 = st[i];
    buf += c; if (c.trim()) t1 = en[i];
    const L = buf.trim().length;
    if ((/[.!?…]/.test(c) && L >= 10) || (/[,]/.test(c) && L >= 20) || L >= 28) flush();
  }
  flush();
  // 구간 다듬기: 최소 0.6s, 다음 시작 전까지
  for (let i = 0; i < segs.length; i++) {
    if (i < segs.length - 1) segs[i].end = Math.min(Math.max(segs[i].end + 0.15, segs[i].start + 0.6), segs[i + 1].start);
    else segs[i].end = Math.max(segs[i].end + 0.2, segs[i].start + 0.6);
  }
  return segs;
}
function segmentsProportional(text, dur) {
  const sents = text.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  const total = sents.reduce((a, s) => a + s.length, 0) || 1;
  let t = 0; const segs = [];
  for (const s of sents) { const d = Math.max(0.8, dur * (s.length / total)); segs.push({ text: s, start: t, end: Math.min(t + d, dur) }); t += d; }
  return segs;
}

/* ───────── ASS 자막 생성 (하단 싱크 자막 + 훅 0~2초 상단) ───────── */
function assTime(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60); return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`; }
function assEsc(t) { return String(t).replace(/[{}]/g, '').replace(/\n/g, '\\N'); }
function wrapAss(t, maxLen) {
  if (t.length <= maxLen) return t;
  const words = t.split(' '); let best = null, bd = 1e9;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    if (a.length <= maxLen && b.length <= maxLen && Math.abs(a.length - b.length) < bd) { best = a + '\\N' + b; bd = Math.abs(a.length - b.length); }
  }
  return best || t;
}
function buildAss(segs, hook) {
  let ev = '';
  // 훅: 0~2초 상단 대형 (이모지 없음 — DB 원문 그대로)
  ev += `Dialogue: 1,${assTime(0)},${assTime(2)},Hook,,0,0,0,,${wrapAss(assEsc(hook), 12)}\n`;
  for (const s of segs) {
    ev += `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Sub,,0,0,0,,${wrapAss(assEsc(s.text), 16)}\n`;
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Pretendard,58,&H00FFFFFF,&H00FFFFFF,&H78000000,&H78000000,1,0,0,0,100,100,0,0,3,16,0,2,60,60,215,1
Style: Hook,Pretendard,86,&H00FFFFFF,&H00FFFFFF,&H8C000000,&H8C000000,1,0,0,0,100,100,0,0,3,20,0,8,50,50,190,1

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

/* ───────── 한 편 제작 ───────── */
async function buildEpisode(item) {
  const os = require('os'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const FF = getFFmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r60-'));
  try {
    // 1) 에셋: 배경영상 + 폰트
    const bgPath = path.join(dir, item.bg + '.mp4');
    await fetchTo(`${BASE}${ASSETS}/${item.bg}.mp4`, bgPath);
    const fontsDir = path.join(dir, 'fonts'); fs.mkdirSync(fontsDir);
    await fetchTo(`${BASE}${ASSETS}/fonts/Pretendard-Bold.otf`, path.join(fontsDir, 'Pretendard-Bold.otf'));
    await fetchTo(`${BASE}${ASSETS}/fonts/Pretendard-Regular.otf`, path.join(fontsDir, 'Pretendard-Regular.otf'));

    // 2) TTS (전문 그대로, 60편 동일 보이스)
    const { buf, align, mode } = await ttsTimed(item.narration);
    const narrPath = path.join(dir, 'narr.mp3'); fs.writeFileSync(narrPath, buf);
    const narrDur = ffDur(FF, narrPath);
    if (!narrDur) throw new Error('나레이션 길이 측정 실패');

    // 3) 자막(ASS): 싱크 세그먼트 + 훅 오버레이
    const segs = align ? segmentsFromAlign(align) : segmentsProportional(item.narration, narrDur);
    const assPath = path.join(dir, 'subs.ass');
    fs.writeFileSync(assPath, buildAss(segs, item.hook));

    // 4) 합성: 배경 무한 루프 + 음성 길이 컷(-shortest), 1080×1920/30fps, 자막 번인
    const out = path.join(dir, 'out.mp4');
    const vf = `scale=1080:1920:flags=lanczos,fps=30,subtitles=${assPath}:fontsdir=${fontsDir},format=yuv420p`;
    execFileSync(FF, ['-y', '-stream_loop', '-1', '-i', bgPath, '-i', narrPath, '-shortest',
      '-map', '0:v', '-map', '1:a', '-vf', vf,
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-r', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { stdio: 'ignore' });

    // 5) 검수(QA)
    const outDur = ffDur(FF, out);
    const info = ffInfo(FF, out);
    const qa = [];
    const durDiff = Math.abs(outDur - narrDur);
    qa.push(['길이 일치(±0.5s)', durDiff <= 0.5, `영상 ${outDur.toFixed(2)}s / 음성 ${narrDur.toFixed(2)}s / 차이 ${durDiff.toFixed(2)}s`]);
    qa.push(['해상도 1080×1920', /1080x1920/.test(info), '']);
    qa.push(['오디오 스트림', /Audio:\s*aac/.test(info), '']);
    const marker = item.season === 1 ? `[건보 면접 30일 릴스 ${item.code}]` : `[건보 면접 D-30 스프린트 ${item.code}]`;
    qa.push(['캡션 시리즈 표기', item.caption.startsWith(marker), marker]);
    qa.push(['해시태그 20개', (item.caption.match(/#/g) || []).length === 20, '']);
    qa.push(['금지어 부재', ![item.caption, item.narration, item.hook].some(t => t.includes(BANNED) || t.includes('온더탑')), '']);
    qa.push(['자막=나레이션 동기', segs.map(s => s.text).join('').replace(/\s/g, '') === item.narration.replace(/\s/g, ''), align ? '글자 타임스탬프' : '문장 비례(폴백)']);
    const failed = qa.filter(q => !q[1]);
    if (failed.length) throw new Error('QA 실패: ' + failed.map(f => f[0] + (f[2] ? `(${f[2]})` : '')).join(', '));

    return { mp4: fs.readFileSync(out), outDur, narrDur, segCount: segs.length, ttsMode: mode, qa };
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
  const previewOk = dryrun && q.pkey === PREVIEW_KEY;
  if (!cronOk && !manualOk && !previewOk) return out(401, { ok: false, error: '인증 실패' });

  const forced = parseInt(q.day, 10);
  try {
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
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const qaHtml = ep.qa.map(x => `<li style="color:${x[1] ? '#7ee787' : '#ff7b72'}">${x[1] ? 'PASS' : 'FAIL'} · ${esc(x[0])} ${x[2] ? '— ' + esc(x[2]) : ''}</li>`).join('');
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>릴스 60일 미리보기 ${item.code}</title></head>
<body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif"><div style="max-width:520px;margin:0 auto;padding:18px">
<div style="color:#2997ff;font-weight:700">건보 면접 릴스 60일 — ${item.code} 미리보기 (발행 안 됨)</div>
<div style="color:#8a8a90;font-size:13px;margin:6px 0 12px">${esc(item.title)} · 배경 ${item.bg} · ${ep.outDur.toFixed(1)}초 · 자막 ${ep.segCount}개(${ep.ttsMode === 'timestamps' ? '글자 타임스탬프 싱크' : '문장 비례'}) · 빌드 ${buildSec}s</div>
<video src="${blob.url}" controls autoplay playsinline loop style="width:100%;border-radius:14px;background:#000"></video>
<div style="color:#9a9aa0;font-size:12px;margin-top:6px">소리를 켜고 확인하세요.</div>
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
