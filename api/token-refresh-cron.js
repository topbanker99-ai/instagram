// api/token-refresh-cron.js
// 탑뱅커 — 인스타 장기 액세스 토큰 자동 갱신 (매주 1회)
//
// 하는 일:
//   1) 현재 IG_ACCESS_TOKEN 으로 그래프 API에서 새 60일 토큰을 발급받고
//   2) 새 토큰이 실제로 동작하는지 확인한 뒤
//   3) Vercel 환경변수 IG_ACCESS_TOKEN 값을 새 토큰으로 교체하고
//   4) 자동 재배포를 걸어 새 토큰을 적용시킨다.
//   → 토큰이 항상 50일 이상 여유가 남게 유지되어, 사람이 60일마다 챙길 필요가 없음.
//
// 인증(기존 크론들과 동일):
//   - Vercel Cron: Authorization: Bearer ${CRON_SECRET}  (자동)
//   - 수동 테스트: ?secret=${PUBLISH_SECRET}  또는 헤더 x-publish-secret
// 옵션:
//   - ?dryrun=1 : 아무것도 바꾸지 않고 "준비 상태"만 점검(읽기 전용). 토큰 갱신/재배포 안 함.
//
// 필요한 환경변수: IG_USER_ID, IG_ACCESS_TOKEN, CRON_SECRET, PUBLISH_SECRET,
//                  BLOB_READ_WRITE_TOKEN, VERCEL_API_TOKEN, VERCEL_DEPLOY_HOOK_URL, VERCEL_TEAM_ID
// 의존: ./blob-bundle.js  (상태 기록용 — 없거나 실패해도 갱신 자체엔 지장 없음)

const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';
const VERCEL_API = 'https://api.vercel.com';
const PROJECT = 'instagram';            // Vercel 프로젝트 이름
const ENV_KEY = 'IG_ACCESS_TOKEN';      // 교체할 환경변수
const META_KEY = 'token-refresh-meta.json';

/* ───────── Vercel API 헬퍼 ───────── */
function teamQuery(){ return process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : ''; }
function vHeaders(){ return { 'Authorization': `Bearer ${process.env.VERCEL_API_TOKEN}`, 'Content-Type': 'application/json' }; }

async function findEnvId(){
  const r = await fetch(`${VERCEL_API}/v9/projects/${PROJECT}/env${teamQuery()}`, { headers: vHeaders() });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error('Vercel 환경변수 목록 조회 실패: ' + JSON.stringify(j.error || j));
  let envs = [];
  if(Array.isArray(j)) envs = j;
  else if(Array.isArray(j.envs)) envs = j.envs;
  else if(Array.isArray(j.env)) envs = j.env;
  const found = envs.find(e => e && e.key === ENV_KEY);
  if(!found) throw new Error(`Vercel에서 ${ENV_KEY} 환경변수를 찾지 못했습니다.`);
  return found.id;
}

async function updateEnv(envId, value){
  const r = await fetch(`${VERCEL_API}/v9/projects/${PROJECT}/env/${envId}${teamQuery()}`, {
    method: 'PATCH', headers: vHeaders(), body: JSON.stringify({ value }),
  });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error('Vercel 환경변수 교체 실패: ' + JSON.stringify(j.error || j));
  return true;
}

async function triggerDeploy(){
  const url = process.env.VERCEL_DEPLOY_HOOK_URL;
  const r = await fetch(url, { method: 'POST' });
  if(!r.ok){ let t=''; try{ t = await r.text(); }catch(e){} throw new Error('자동 재배포 트리거 실패 (HTTP ' + r.status + ') ' + String(t).slice(0,200)); }
  return true;
}

/* ───────── 인스타 토큰 갱신 / 검증 ───────── */
async function refreshToken(current){
  const r = await fetch(`${REFRESH_URL}?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`);
  const j = await r.json().catch(()=> ({}));
  if(!r.ok || !j.access_token) throw new Error('토큰 갱신 실패: ' + JSON.stringify(j.error || j));
  return j; // { access_token, token_type, expires_in }
}
async function tokenWorks(tok){
  try{
    const r = await fetch(`${GRAPH}/${process.env.IG_USER_ID}?fields=username&access_token=${encodeURIComponent(tok)}`);
    const j = await r.json().catch(()=> ({}));
    return r.ok && !j.error;
  }catch(e){ return false; }
}

/* ───────── 상태 기록 (Blob; 실패해도 무시) ───────── */
async function readMeta(){
  try{
    const { blobs } = await list({ prefix: META_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if(blobs && blobs.length){ const r = await fetch(blobs[0].url + '?t=' + Date.now()); if(r.ok) return await r.json(); }
  }catch(e){}
  return null;
}
async function writeMeta(obj){
  try{
    await put(META_KEY, JSON.stringify(obj), { access:'public', contentType:'application/json', addRandomSuffix:false, allowOverwrite:true, token: process.env.BLOB_READ_WRITE_TOKEN });
  }catch(e){}
}

/* ───────── 유틸 ───────── */
function daysLeft(iso){ if(!iso) return null; return Math.round((new Date(iso).getTime() - Date.now()) / 86400000); }
function fmtKST(iso){ if(!iso) return '-'; try{ return new Date(iso).toLocaleString('ko-KR', { timeZone:'Asia/Seoul' }); }catch(e){ return iso; } }

module.exports = async (req, res) => {
  const out = (s, p) => { res.status(s).json(p); };

  // 인증 (기존 크론과 동일)
  const auth = req.headers['authorization'] || '';
  const manual = (req.query && req.query.secret) || req.headers['x-publish-secret'];
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const manualOk = process.env.PUBLISH_SECRET && manual === process.env.PUBLISH_SECRET;
  if(!cronOk && !manualOk) return out(401, { ok:false, error:'인증 실패' });

  const dryrun = req.query && (req.query.dryrun === '1' || req.query.dryrun === 'true');

  try{
    /* ───────── 미리보기(읽기 전용): 아무것도 바꾸지 않고 준비 상태만 점검 ───────── */
    if(dryrun){
      const has = k => !!process.env[k];
      const rows = [
        ['IG_ACCESS_TOKEN', has('IG_ACCESS_TOKEN')],
        ['VERCEL_API_TOKEN', has('VERCEL_API_TOKEN')],
        ['VERCEL_DEPLOY_HOOK_URL', has('VERCEL_DEPLOY_HOOK_URL')],
        ['VERCEL_TEAM_ID', has('VERCEL_TEAM_ID')],
      ];
      let vercelOk = false, vercelMsg = '';
      try{ await findEnvId(); vercelOk = true; vercelMsg = 'Vercel 연결 OK · IG_ACCESS_TOKEN 항목 확인됨'; }
      catch(e){ vercelOk = false; vercelMsg = e.message; }
      const meta = await readMeta();
      const ready = rows.every(r => r[1]) && vercelOk;

      const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const dot = ok => ok ? '<span style="color:#34c759">●</span>' : '<span style="color:#ff453a">●</span>';
      const rowHtml = rows.map(r => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1f1f24"><span>${esc(r[0])}</span><span>${dot(r[1])} ${r[1] ? '있음' : '없음'}</span></div>`).join('');
      const dl = meta ? daysLeft(meta.expiresAt) : null;
      const metaHtml = meta
        ? `<div style="background:#16161a;border-radius:12px;padding:14px;margin-top:14px;font-size:14px;line-height:1.6">마지막 자동 갱신: <b style="color:#fff">${esc(fmtKST(meta.refreshedAt))}</b><br>현재 토큰 만료 예정: <b style="color:#fff">${esc(fmtKST(meta.expiresAt))}</b>${dl != null ? ` <span style="color:#8a8a90">(약 ${dl}일 남음)</span>` : ''}</div>`
        : `<div style="background:#16161a;border-radius:12px;padding:14px;margin-top:14px;font-size:14px;line-height:1.6;color:#c9c9cf">아직 자동 갱신 기록이 없습니다.<br>아래 안내대로 <b>한 번 실제 실행</b>하면 그때부터 만료일이 표시됩니다.</div>`;
      const banner = ready
        ? `<div style="background:#0f2e16;border:1px solid #1f7a33;color:#9be7ad;border-radius:12px;padding:14px;font-weight:600">준비 완료 ✓ — 모든 설정이 정상입니다.</div>`
        : `<div style="background:#3a1414;border:1px solid #a13030;color:#ffb4b4;border-radius:12px;padding:14px;font-weight:600">설정이 더 필요합니다 — 아래 빨간 항목을 확인하세요.</div>`;
      const action = `<div style="background:#16161a;border-radius:12px;padding:14px;margin-top:14px;font-size:14px;line-height:1.6">이상이 없으면, 주소창에서 <b style="color:#fff">&dryrun=1</b> (또는 <b style="color:#fff">?dryrun=1</b>) 을 지우고 다시 접속하세요.<br>→ 토큰을 새로 갱신하고 Vercel에 적용(자동 재배포)합니다. <b style="color:#2997ff">평소엔 매주 자동</b> 실행되므로, 이 수동 실행은 처음 한 번만 하면 됩니다.</div>`;

      const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>토큰 자동갱신 점검</title></head><body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:-apple-system,system-ui,sans-serif"><div style="max-width:480px;margin:0 auto;padding:20px"><div style="color:#2997ff;font-weight:700;font-size:18px;margin-bottom:4px">인스타 토큰 자동갱신 — 상태 점검</div><div style="color:#8a8a90;font-size:13px;margin-bottom:16px">읽기 전용 점검입니다. 아무것도 변경하지 않았습니다.</div>${banner}<div style="background:#111;border-radius:12px;padding:6px 14px;margin-top:14px;font-size:14px">${rowHtml}<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Vercel 연결 점검</span><span>${dot(vercelOk)} ${vercelOk ? 'OK' : '실패'}</span></div></div><div style="color:#8a8a90;font-size:12px;margin-top:6px;padding:0 4px">${esc(vercelMsg)}</div>${metaHtml}${action}</div></body></html>`;
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return;
    }

    /* ───────── 실제 실행 ───────── */
    const need = ['IG_USER_ID','IG_ACCESS_TOKEN','VERCEL_API_TOKEN','VERCEL_DEPLOY_HOOK_URL','VERCEL_TEAM_ID'];
    const miss = need.filter(k => !process.env[k]);
    if(miss.length) return out(500, { ok:false, error:'환경변수 누락: ' + miss.join(', ') });

    // 1) 새 토큰 발급
    const refreshed = await refreshToken(process.env.IG_ACCESS_TOKEN);
    const newToken = refreshed.access_token;
    const expiresIn = Number(refreshed.expires_in) || 0;
    const now = Date.now();
    const expiresAt = expiresIn ? new Date(now + expiresIn * 1000).toISOString() : null;

    // 2) 새 토큰 검증 (깨진 토큰을 덮어써서 발행이 멈추는 것 방지)
    if(!(await tokenWorks(newToken))){
      return out(500, { ok:false, error:'새로 받은 토큰 검증 실패 — 기존 토큰을 그대로 두었습니다.' });
    }

    // 3) Vercel 환경변수 교체
    const envId = await findEnvId();
    await updateEnv(envId, newToken);

    // 4) 자동 재배포 (새 토큰 적용)
    await triggerDeploy();

    // 5) 상태 기록 (실패해도 무시)
    await writeMeta({ refreshedAt: new Date(now).toISOString(), expiresIn, expiresAt, source:'token-refresh-cron' });

    return out(200, {
      ok: true,
      message: '토큰을 갱신하고 Vercel에 적용했습니다(자동 재배포 시작).',
      refreshedAt: new Date(now).toISOString(),
      expiresAt,
      expiresInDays: expiresIn ? Math.round(expiresIn / 86400) : null,
      redeployed: true,
    });
  }catch(err){
    return out(500, { ok:false, error:(err && err.message) ? err.message : String(err) });
  }
};
