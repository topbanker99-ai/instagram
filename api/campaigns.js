// api/campaigns.js — 게시물별 "키워드 → PDF" 캠페인 관리 (계정1 topbanker99)
//   여러 게시물에 각각 다른 키워드/자료(PDF)를 매칭해서 등록해두면,
//   ig-webhook.js가 댓글이 달린 "게시물"과 "키워드"가 둘 다 일치할 때만 DM을 발송합니다.
//   (게시물 지정 없이 아무 게시물에나 키워드만 달아도 발송되던 예전 방식의 업그레이드)
//
//   GET ?key=<ADMIN_KEY>&action=list
//       → 현재 등록된 캠페인 목록 확인
//   GET ?key=<ADMIN_KEY>&action=add&postUrl=<게시물 링크>&keyword=<키워드>&pdf=<PDF 링크>&reply=<선택, DM 문구>&id=<선택>
//       → 게시물 링크로 media ID를 자동 조회해서 캠페인 등록(또는 id가 같으면 갱신)
//   GET ?key=<ADMIN_KEY>&action=remove&id=<campaignId>
//       → 캠페인 삭제
//
// 환경변수: IG_USER_ID, IG_DM_TOKEN(또는 IG_ACCESS_TOKEN), CAMPAIGNS_ADMIN_KEY(선택, 기본값 있음), BLOB_READ_WRITE_TOKEN

const { put, list } = require('./blob-bundle.js');

const API_VERSION = 'v23.0';
const GRAPH = `https://graph.instagram.com/${API_VERSION}`;
const STORE_KEY = 'ig-campaigns.json';
const ADMIN_KEY = process.env.CAMPAIGNS_ADMIN_KEY || 'camp-mgmt-7f3k9';

async function readCampaigns() {
  try {
    const { blobs } = await list({ prefix: STORE_KEY, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (blobs && blobs.length) {
      const r = await fetch(blobs[0].url + '?t=' + Date.now());
      if (r.ok) { const a = await r.json(); return Array.isArray(a) ? a : []; }
    }
  } catch (e) {}
  return [];
}
async function writeCampaigns(arr) {
  await put(STORE_KEY, JSON.stringify(arr), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token: process.env.BLOB_READ_WRITE_TOKEN });
}

function extractShortcode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// 게시물 링크(shortcode) → 실제 media ID 조회 (계정의 최근 미디어 목록을 훑어서 permalink 매칭)
async function resolveMediaId(IG, TOKEN, postUrl) {
  const shortcode = extractShortcode(postUrl);
  if (!shortcode) throw new Error('게시물 링크에서 shortcode를 찾을 수 없습니다. (예: instagram.com/p/XXXXX/ 또는 /reel/XXXXX/)');
  let url = `${GRAPH}/${IG}/media?fields=id,permalink&limit=50&access_token=${encodeURIComponent(TOKEN)}`;
  for (let page = 0; page < 8 && url; page++) {
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error('미디어 목록 조회 실패: ' + JSON.stringify(j.error || j));
    const hit = (j.data || []).find(m => String(m.permalink || '').includes(shortcode));
    if (hit) return hit.id;
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  throw new Error('해당 게시물을 최근 미디어 목록에서 찾지 못했습니다 (너무 오래된 게시물이거나 다른 계정일 수 있어요).');
}

module.exports = async (req, res) => {
  const out = (s, p) => res.status(s).json(p);
  const q = req.query || {};
  if (q.key !== ADMIN_KEY) return out(401, { ok: false, error: '인증 실패' });

  try {
    if (!q.action || q.action === 'list') {
      const campaigns = await readCampaigns();
      return out(200, { ok: true, count: campaigns.length, campaigns });
    }

    if (q.action === 'add') {
      const { postUrl, keyword, pdf, reply, id } = q;
      if (!postUrl || !keyword || !pdf) return out(400, { ok: false, error: 'postUrl, keyword, pdf 파라미터는 필수입니다.' });
      const IG = process.env.IG_USER_ID;
      const TOKEN = process.env.IG_DM_TOKEN || process.env.IG_ACCESS_TOKEN;
      if (!IG || !TOKEN) return out(500, { ok: false, error: 'IG_USER_ID / IG_DM_TOKEN(또는 IG_ACCESS_TOKEN) 환경변수가 없습니다.' });

      const mediaId = await resolveMediaId(IG, TOKEN, postUrl);
      const campaigns = await readCampaigns();
      const campaignId = id || ('c-' + mediaId);
      const idx = campaigns.findIndex(c => c.id === campaignId);
      const entry = {
        id: campaignId,
        postUrl,
        mediaId,
        keyword: String(keyword).trim(),
        pdf,
        reply: reply || null,
        active: true,
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) campaigns[idx] = entry; else campaigns.push(entry);
      await writeCampaigns(campaigns);
      return out(200, { ok: true, saved: entry, total: campaigns.length });
    }

    if (q.action === 'remove') {
      if (!q.id) return out(400, { ok: false, error: 'id 파라미터가 필요합니다.' });
      const campaigns = await readCampaigns();
      const next = campaigns.filter(c => c.id !== q.id);
      await writeCampaigns(next);
      return out(200, { ok: true, removed: campaigns.length - next.length, total: next.length });
    }

    if (q.action === 'pause' || q.action === 'resume') {
      if (!q.id) return out(400, { ok: false, error: 'id 파라미터가 필요합니다.' });
      const campaigns = await readCampaigns();
      const idx = campaigns.findIndex(c => c.id === q.id);
      if (idx < 0) return out(404, { ok: false, error: '해당 id의 캠페인을 찾을 수 없습니다.' });
      campaigns[idx].active = (q.action === 'resume');
      campaigns[idx].updatedAt = new Date().toISOString();
      await writeCampaigns(campaigns);
      return out(200, { ok: true, updated: campaigns[idx] });
    }

    return out(400, { ok: false, error: '알 수 없는 action 입니다. (list | add | remove | pause | resume)' });
  } catch (err) {
    return out(500, { ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
