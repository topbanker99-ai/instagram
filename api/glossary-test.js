// api/glossary-test.js
// [검증 전용] 서버에서 카드 1장을 그려 PNG로 반환. canvas+폰트가 Vercel에서 작동하는지 확인용.
// 브라우저에서 /api/glossary-test 로 접속하면 카드 이미지가 보이면 성공.

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const PRETENDARD_BASE = 'https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/';
const FONT_FILES = [
  ['Pretendard-Regular.otf', 'Pretendard'],
  ['Pretendard-SemiBold.otf', 'Pretendard SemiBold'],
  ['Pretendard-Bold.otf', 'Pretendard Bold'],
];
let fontsReady = false;
async function ensureFonts() {
  if (fontsReady) return;
  for (const [file, name] of FONT_FILES) {
    const r = await fetch(PRETENDARD_BASE + file);
    if (!r.ok) throw new Error('폰트 다운로드 실패: ' + file + ' HTTP ' + r.status);
    GlobalFonts.register(Buffer.from(await r.arrayBuffer()), name);
  }
  fontsReady = true;
}

const COL = {
  WHITE:'#FFFFFF', DARK:'#1D1D1F', INK:'#1D1D1F', SOFT_L:'#3C3C3E',
  SOFT_D:'#D0D0D2', SECOND_D:'#CCCCCC', CAPTION:'#7A7A7A', BLUE_L:'#0066CC', BLUE_D:'#2997FF'
};
const fnt = (fam, size) => `${size}px "${fam}"`;

function drawTracked(ctx, x, y, text, tr) {
  for (const ch of text) { ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + tr; }
  return x;
}
function trackedWidth(ctx, text, tr) {
  let w = 0; for (const ch of text) w += ctx.measureText(ch).width + tr; return w;
}
function wrapText(ctx, text, maxw, tr) {
  const units = text.match(/[A-Za-z0-9]+|\s+|[\s\S]/g) || [];
  const lines = []; let cur = '';
  for (const u of units) {
    if (/^\s+$/.test(u)) {
      if (cur && trackedWidth(ctx, cur + ' ', tr) <= maxw) cur += ' ';
      else if (cur) { lines.push(cur.replace(/\s+$/, '')); cur = ''; }
      continue;
    }
    if (cur === '' || trackedWidth(ctx, cur + u, tr) <= maxw) cur += u;
    else { lines.push(cur.replace(/\s+$/, '')); cur = u; }
  }
  if (cur.trim()) lines.push(cur.replace(/\s+$/, ''));
  return lines;
}
function trimDef(d, limit = 165) {
  if (d.length <= limit) return d;
  const cut = d.slice(0, limit);
  const idx = Math.max(cut.lastIndexOf('다. '), cut.lastIndexOf('. '));
  return idx > limit * 0.5 ? d.slice(0, idx + 1).trim() : cut.replace(/\s+$/, '') + '…';
}

function makeCard(term, circ, page, total, dark, bg) {
  const W = 1080, M = 110, CW = W - 2 * M;
  const canvas = createCanvas(W, W); const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, W); ctx.textBaseline = 'top';
  const main = dark ? COL.WHITE : COL.INK;
  const body = dark ? COL.SOFT_D : COL.SOFT_L;
  const cap = dark ? COL.SECOND_D : COL.CAPTION;
  const accent = dark ? COL.BLUE_D : COL.BLUE_L;

  ctx.fillStyle = main; ctx.font = fnt('Pretendard Bold', 29);
  drawTracked(ctx, M, 86, 'TOP BANKER', 5);

  let y = 292;
  ctx.fillStyle = accent; ctx.font = fnt('Pretendard Bold', 46);
  drawTracked(ctx, M, y, `은행권 금융권 기출 빈출 상식 ${circ}`, -0.5);
  y += 82;

  let hs = 74, tr = -hs * 0.03;
  ctx.font = fnt('Pretendard SemiBold', hs);
  while (trackedWidth(ctx, term.name, tr) > CW && hs > 46) { hs -= 4; tr = -hs * 0.03; ctx.font = fnt('Pretendard SemiBold', hs); }
  ctx.fillStyle = main;
  for (const ln of wrapText(ctx, term.name, CW, tr)) { drawTracked(ctx, M, y, ln, tr); y += Math.round(hs * 1.12); }

  y += 10;
  let capline = (term.section || '').replace(/\s{2,}.*$/, '').trim();
  if (term.exam_tags && term.exam_tags.length) capline += '   ·   기출 ' + term.exam_tags.join(' · ');
  ctx.fillStyle = cap; ctx.font = fnt('Pretendard', 29);
  ctx.fillText(capline, M, y); y += 62;

  ctx.fillStyle = body; ctx.font = fnt('Pretendard', 41);
  for (const ln of wrapText(ctx, trimDef(term.definition), CW, 0)) { ctx.fillText(ln, M, y); y += Math.round(41 * 1.46); }

  const pg = `${String(page).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  ctx.fillStyle = cap; ctx.font = fnt('Pretendard SemiBold', 28);
  ctx.fillText(pg, W - M - trackedWidth(ctx, pg, 0), 992);

  return canvas.toBuffer('image/png');
}

module.exports = async (req, res) => {
  try {
    await ensureFonts();
    const term = {
      section: '거시경제·통화정책·경기지표',
      name: 'FED(연방준비제도)',
      exam_tags: ['KB 25하'],
      definition: '미국의 중앙은행 시스템. 워싱턴 연준이사회(Federal Reserve Board)와 12개 지역 연방준비은행으로 구성. 통화정책·금융감독·결제시스템 운영을 담당하며 의장(현 제롬 파월)이 시장에 미치는 영향력은 절대적이다.'
    };
    const dark = (req.query && (req.query.dark === '1' || req.query.dark === 'true'));
    const png = makeCard(term, '①', 1, 3, dark, dark ? COL.DARK : COL.WHITE);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.end(png);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: e.message, stack: (e.stack || '').split('\n').slice(0, 4) }, null, 2));
  }
};
