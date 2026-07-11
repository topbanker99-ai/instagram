// api/ig-stats.js
// 탑뱅커 대시보드용 — 실제 인스타그램 계정 통계 + 최근 게시물 불러오기
// 서버에서 IG_ACCESS_TOKEN 으로 호출하고, 공개 프로필 데이터(JSON)만 반환합니다 (토큰은 노출 안 됨).
// 필요한 권한: instagram_business_basic (팔로워 수·게시물 읽기). 발행 토큰에 이미 포함된 경우가 많습니다.
//
// 계정 선택: ?acct=1 (기본, @topbanker99) / ?acct=2 (@top_career_)
//   - acct=1 → IG_USER_ID  / IG_ACCESS_TOKEN
//   - acct=2 → IG_USER_ID_2 / IG_ACCESS_TOKEN_2

const V = 'v23.0';
const G = `https://graph.instagram.com/${V}`;

module.exports = async (req, res) => {
  try {
    // 계정 번호 파싱 (req.query 우선, 없으면 URL 에서 직접 파싱)
    let acct = (req.query && req.query.acct) ? String(req.query.acct) : null;
    if (!acct) {
      try {
        const u = new URL(req.url, 'http://x');
        acct = u.searchParams.get('acct');
      } catch (_) { /* noop */ }
    }
    const isTwo = String(acct) === '2';

    const IG = isTwo ? process.env.IG_USER_ID_2 : process.env.IG_USER_ID;
    const TOKEN = isTwo ? process.env.IG_ACCESS_TOKEN_2 : process.env.IG_ACCESS_TOKEN;
    const fallbackUser = isTwo ? 'top_career_' : 'topbanker99';

    if (!IG || !TOKEN) {
      res.status(500).json({
        ok: false,
        acct: isTwo ? 2 : 1,
        error: isTwo
          ? 'IG_USER_ID_2 / IG_ACCESS_TOKEN_2 환경변수가 없습니다.'
          : 'IG_USER_ID / IG_ACCESS_TOKEN 환경변수가 없습니다.'
      });
      return;
    }

    // 1) 계정 정보
    const accFields = 'username,followers_count,follows_count,media_count,profile_picture_url';
    const accRes = await fetch(`${G}/${IG}?fields=${accFields}&access_token=${encodeURIComponent(TOKEN)}`);
    const acc = await accRes.json();

    // 2) 최근 게시물
    const medFields = 'id,media_type,media_url,thumbnail_url,permalink,like_count,comments_count,caption,timestamp';
    const medRes = await fetch(`${G}/${IG}/media?fields=${medFields}&limit=12&access_token=${encodeURIComponent(TOKEN)}`);
    const med = await medRes.json();

    const posts = (med.data || []).map(m => ({
      id: m.id,
      type: m.media_type, // IMAGE | VIDEO | CAROUSEL_ALBUM
      thumb: (m.media_type === 'VIDEO') ? (m.thumbnail_url || m.media_url) : (m.media_url || m.thumbnail_url),
      permalink: m.permalink || null,
      likes: (typeof m.like_count === 'number') ? m.like_count : null,
      comments: (typeof m.comments_count === 'number') ? m.comments_count : null,
      caption: (m.caption || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      timestamp: m.timestamp || null
    }));

    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.status(200).json({
      ok: true,
      acct: isTwo ? 2 : 1,
      username: acc.username || fallbackUser,
      profilePic: acc.profile_picture_url || null,
      followers: (typeof acc.followers_count === 'number') ? acc.followers_count : null,
      following: (typeof acc.follows_count === 'number') ? acc.follows_count : null,
      mediaCount: (typeof acc.media_count === 'number') ? acc.media_count : null,
      posts,
      // 권한/필드 문제 진단용 (문제 없으면 null)
      errors: { account: acc.error || null, media: med.error || null }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
