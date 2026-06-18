// api/blob-cleanup-cron.js
// 탑뱅커 — 발행에 쓰고 남은 임시 이미지/영상(Blob) 자동 청소 (매주 1회)
//
// 하는 일:
//   발행 크론들은 카드 PNG·릴스 MP4를 Blob에 올린 뒤 인스타에 발행합니다.
//   인스타는 발행 시점에 미디어를 자기 서버로 복사해 가므로, 우리 Blob의 원본은
//   발행이 끝나면 더 이상 필요 없습니다. 그동안 한 번도 지우지 않아 계속 쌓였는데,
//   이 크론이 일정 기간(기본 3일)이 지난 임시 파일을 지워 저장공간·요금을 줄입니다.
//
// 안전장치(중요):
//   - 청소 대상 폴더: glossary/  specs/  news/  essay/  reels/  뿐입니다.
//   - 공용 마무리 이미지(assets/outro.png)와 진도·상태 JSON(glossary-progress.json,
//     specs-progress.json, news-posted.json, essay-progress.json, reel-progress.json,
//     token-refresh-meta.json)은 폴더 밖에 있어 절대 지워지지 않습니다.
//   - 최근(기본 3일 이내) 파일은 혹시 모를 처리중 대비로 남깁니다.
//   - 날짜를 알 수 없는 파일은 안전을 위해 지우지 않고 남깁니다.
//
// 인증(기존 크론과 동일):
//   - Vercel Cron: Authorization: Bearer ${CRON_SECRET}   (자동)
//   - 수동 테스트:  ?secret=${PUBLISH_SECRET}   또는  헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1 : 아무것도 지우지 않고 "이만큼 정리됩니다"만 미리보기(HTML).
//   - ?days=N   : 며칠 지난 것부터 지울지(기본 3). days=0 이면 폴더 안 전부 정리.
//
// 필요한 환경변수: CRON_SECRET, PUBLISH_SECRET, BLOB_READ_WRITE_TOKEN
// 의존: ./blob-bundle.js  (list, del)

const { list, del } = require('./blob-bundle.js');

const PREFIXES = ['glossary/', 'specs/', 'news/', 'essay/', 'reels/'];
const DEFAULT_DAYS = 3;
const DEL_CHUNK = 100;   // 한 번에 지우는 개수(너무 크면 시간초과 위험)

const fmtMB = (b) => (b / 1048576).toFixed(1);
function fmtKST(d){ try{ return new Date(d).toLocaleString('ko-KR', { timeZone:'Asia/Seoul' }); }catch(e){ return String(d); } }

/* 대상 폴더들을 훑어 "오래된 파일"과 "남길 최근 파일"을 분류 */
async function scan(cutoffMs){
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const old = [];                 // { url, size, uploadedAt }
  let keptCount = 0, keptBytes = 0;
  for(const prefix of PREFIXES){
    let cursor;
    do {
      const r = await list({ prefix, cursor, limit: 1000, token });
      for(const b of (r.blobs || [])){
        const t = new Date(b.uploadedAt).getTime();
        if(isFinite(t) && t < cutoffMs){
          old.push({ url: b.url, size: b.size || 0, uploadedAt: b.uploadedAt });
        } else {
          keptCount++; keptBytes += (b.size || 0);   // 최근 파일 or 날짜불명 → 남김
        }
      }
      cursor = r.hasMore ? r.cursor : undefined;
    } while(cursor);
  }
  return { old, keptCount, keptBytes };
}

/* URL 목록을 100개씩 끊어서 삭제 */
async function deleteUrls(urls){
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let done = 0;
  for(let i = 0; i < urls.length; i += DEL_CHUNK){
    const chunk = urls.slice(i, i + DEL_CHUNK);
    await del(chunk, { token });
    done += chunk.length;
  }
  return done;
}

module.exports = async (req, res) => {
  const out = (s, p) => { res.status(s).json(p); };

  // 인증 (기존 크론과 동일)
  const auth = req.headers['authorization'] || '';
  const manual = (req.query && req.query.secret) || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401, { ok:false, error:'인증 실패' });

  if(!process.env.BLOB_READ_WRITE_TOKEN) return out(500, { ok:false, error:'BLOB_READ_WRITE_TOKEN 환경변수가 없습니다.' });

  const dryrun = req.query && (req.query.dryrun === '1' || req.query.dryrun === 'true');
  let days = DEFAULT_DAYS;
  if(req.query && req.query.days != null){ const n = parseInt(req.query.days, 10); if(!isNaN(n) && n >= 0) days = n; }
  const cutoffMs = Date.now() - days * 86400000;

  try{
    const { old, keptCount, keptBytes } = await scan(cutoffMs);
    const delBytes = old.reduce((s, o) => s + o.size, 0);
    const times = old.map(o => new Date(o.uploadedAt).getTime()).filter(isFinite);
    const oldest = times.length ? new Date(Math.min(...times)).toISOString() : null;

    /* ───────── 미리보기(읽기 전용) ───────── */
    if(dryrun){
      const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const summary = old.length
        ? `<div><b style="color:#fff;font-size:24px">${old.length.toLocaleString()}개</b> <span style="color:#8a8a90">·</span> <b style="color:#fff">${fmtMB(delBytes)} MB</b> 정리 예정</div>
           <div style="color:#8a8a90;font-size:13px;margin-top:6px">기준: ${days}일 지난 임시 파일 (glossary · specs · news · essay · reels)</div>`
        : `<div style="color:#9be7ad;font-weight:600">지울 게 없습니다. 이미 깨끗합니다 ✓</div>`;
      const action = old.length
        ? `<div style="background:#16161a;border:1px solid #2a2a30;border-radius:12px;padding:14px;margin-top:12px;font-size:14px;line-height:1.6">이대로 정리하려면 주소창에서 <b style="color:#fff">&amp;dryrun=1</b> (또는 <b style="color:#fff">?dryrun=1</b>) 을 지우고 다시 접속하세요.<br>→ <b style="color:#2997ff">${old.length.toLocaleString()}개</b>를 삭제합니다. <span style="color:#8a8a90">평소엔 매주 자동 청소되므로 이 수동 실행은 처음 한 번만 하면 됩니다.</span></div>`
        : '';
      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>저장공간 청소 점검</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif"><div style="max-width:480px;margin:0 auto;padding:20px"><div style="color:#2997ff;font-weight:700;font-size:18px;margin-bottom:4px">저장공간(Blob) 청소 — 미리보기</div><div style="color:#8a8a90;font-size:13px;margin-bottom:16px">읽기 전용 점검입니다. 아무것도 변경하지 않았습니다.</div><div style="background:#111;border-radius:12px;padding:16px;font-size:15px;line-height:1.6">${summary}</div><div style="background:#16161a;border-radius:12px;padding:14px;margin-top:12px;font-size:14px;line-height:1.7;color:#c9c9cf">남겨둘 최근 파일: <b style="color:#fff">${keptCount.toLocaleString()}개</b> (${fmtMB(keptBytes)} MB)<br>가장 오래된 정리 대상: ${oldest ? esc(fmtKST(oldest)) : '-'}</div>${action}<div style="color:#8a8a90;font-size:12px;margin-top:12px;line-height:1.6">공용 마무리 이미지(outro)와 진도·상태 파일은 폴더 밖에 있어 건드리지 않습니다.</div></div></body></html>`;
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return;
    }

    /* ───────── 실제 실행 ───────── */
    const deleted = old.length ? await deleteUrls(old.map(o => o.url)) : 0;
    return out(200, {
      ok: true,
      deleted,
      freedMB: Number(fmtMB(delBytes)),
      days,
      keptCount,
      oldestDeleted: oldest,
      note: deleted >= 1000 ? '많이 쌓여 있었습니다. 혹시 시간초과(타임아웃)가 나면 한 번 더 실행하면 나머지가 정리됩니다.' : undefined,
    });
  }catch(err){
    return out(500, { ok:false, error:(err && err.message) ? err.message : String(err) });
  }
};
