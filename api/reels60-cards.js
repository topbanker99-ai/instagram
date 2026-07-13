// api/reels60-cards.js — 릴스 60일: 인트로(훅)·아웃트로(연재 안내) 카드 렌더러 (1080×1920, 건보 카드뉴스 룩)
// 색: 네이비(24,45,82)/오렌지(224,122,30)/크림(253,243,232) — 카드뉴스 시리즈와 동일

const W = 1080, H = 1920;
const NAVY = '#182D52', ORANGE = '#E07A1E', CREAM = '#FDF3E8';
const CHIP_LIGHT = '#F0F5FC', GRAY = '#787E8A', SUBTLE = '#C4CFE0', WHITE = '#FFFFFF';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrap(ctx, text, maxw) {
  const out = []; let cur = '';
  for (const ch of String(text)) {
    if (ch === '\n') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    if (ctx.measureText(cur + ch).width <= maxw) cur += ch;
    else {
      let cut = cur.length - 1;
      while (cut > 0 && cur[cut] !== ' ') cut--;
      if (cut > cur.length * 0.5) { out.push(cur.slice(0, cut).trim()); cur = cur.slice(cut + 1) + ch; }
      else { out.push(cur.trim()); cur = ch; }
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function chrome(ctx, assets) {
  ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = NAVY; ctx.fillRect(0, 0, W, 250);
  if (assets.logo) ctx.drawImage(assets.logo, 48, 45, 315, 160);
  ctx.textBaseline = 'top';
  ctx.fillStyle = WHITE; ctx.font = '700 62px "Pretendard Bold"'; ctx.textAlign = 'right';
  ctx.fillText('건보 면접 릴스', 1032, 62);
  ctx.fillStyle = SUBTLE; ctx.font = '500 34px "Pretendard Regular"';
  ctx.fillText('하루 30초 · 60일 연재', 1032, 152);
  ctx.textAlign = 'left';
  ctx.fillStyle = ORANGE; ctx.fillRect(0, 250, W, 14);
  ctx.fillStyle = GRAY; ctx.font = '400 34px "Pretendard Regular"';
  ctx.fillText('@top_career_  ·  건보 합격 정보 연재', 48, 1830);
}
function chips(ctx, c1, c2, y) {
  ctx.font = '700 44px "Pretendard Bold"';
  const p = 34, h = 84;
  const w1 = ctx.measureText(c1).width + p * 2;
  ctx.fillStyle = NAVY; roundRect(ctx, 48, y, w1, h, 22); ctx.fill();
  ctx.fillStyle = WHITE; ctx.fillText(c1, 48 + p, y + 18);
  const x2 = 48 + w1 + 20, w2 = ctx.measureText(c2).width + p * 2;
  ctx.fillStyle = CHIP_LIGHT; roundRect(ctx, x2, y, w2, h, 22); ctx.fill();
  ctx.fillStyle = NAVY; ctx.fillText(c2, x2 + p, y + 18);
}
function drawCharacter(ctx, img, hgt, bottom) {
  if (!img) return;
  const w = img.width * (hgt / img.height);
  ctx.save(); ctx.translate(1032, bottom - hgt); ctx.scale(-1, 1);   // 좌우반전(막대 왼쪽)
  ctx.drawImage(img, 0, 0, w, hgt); ctx.restore();
}

/* 인트로(0~1초): 훅 카드 */
function renderIntro(canvasMod, item, assets) {
  const { createCanvas } = canvasMod;
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  chrome(ctx, assets);
  chips(ctx, item.code, item.season === 1 ? '면접 30일 릴스' : 'D-30 스프린트', 340);
  const hook = String(item.hook).replace(/^「[^」]*」\s*/, '');
  let size = 104; ctx.font = `700 ${size}px "Pretendard Bold"`;
  let lines = wrap(ctx, hook, 940);
  while (lines.length > 4 && size > 64) { size -= 6; ctx.font = `700 ${size}px "Pretendard Bold"`; lines = wrap(ctx, hook, 940); }
  let y = 520; ctx.fillStyle = NAVY;
  for (const ln of lines) { ctx.fillText(ln, 48, y); y += Math.round(size * 1.3); }
  // 오렌지 필
  const pillT = '지금 30초만 봐 →';
  ctx.font = '700 46px "Pretendard Bold"';
  const pw = ctx.measureText(pillT).width + 88;
  const py = Math.max(y + 70, 1080);
  ctx.fillStyle = '#FDECD6'; roundRect(ctx, 48, py, pw, 104, 52); ctx.fill();
  ctx.fillStyle = ORANGE; ctx.fillText(pillT, 48 + 44, py + 26);
  drawCharacter(ctx, assets.char, 620, 1800);
  return c.toBuffer('image/png');
}

/* 아웃트로(마지막 ~3초): 연재 안내 + 다음 편 예고 */
function renderOutro(canvasMod, item, assets) {
  const { createCanvas } = canvasMod;
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  chrome(ctx, assets);
  chips(ctx, '건보 면접 릴스', '매일 1편 연재', 340);
  ctx.fillStyle = NAVY; ctx.font = '700 88px "Pretendard Bold"';
  ctx.fillText('건보 합격 정보,', 48, 500);
  ctx.fillText('릴스로 매일 연재해요', 48, 614);
  // 다음 편 예고 패널
  const m = String(item.ending).match(/^(?:다음\s*편|내일[^:：]*)[:：]\s*(.+)$/);
  let teaser = m ? m[1] : String(item.ending);
  teaser = teaser.replace(/\s*—\s*팔로우.*$/, '').replace(/\s*—\s*합격 후기.*$/, '').trim();
  const label = m ? '다음 편 예고' : '마지막 인사';
  ctx.font = '700 52px "Pretendard Bold"';
  const tl = wrap(ctx, teaser, 850).slice(0, 2);
  const ph = 120 + tl.length * 72;
  ctx.fillStyle = WHITE; roundRect(ctx, 48, 800, 984, ph, 28); ctx.fill();
  ctx.fillStyle = ORANGE; ctx.fillRect(49, 830, 12, ph - 60);
  ctx.font = '700 38px "Pretendard Bold"'; ctx.fillStyle = ORANGE;
  ctx.fillText(label, 110, 838);
  ctx.font = '700 52px "Pretendard Bold"'; ctx.fillStyle = NAVY;
  let ty = 896; for (const ln of tl) { ctx.fillText(ln, 110, ty); ty += 72; }
  // CTA
  const cta = '팔로우하고 다음 편 받기 →';
  ctx.font = '700 46px "Pretendard Bold"';
  const cw = ctx.measureText(cta).width + 96;
  const cy = 800 + ph + 56;
  ctx.fillStyle = NAVY; roundRect(ctx, 48, cy, cw, 112, 28); ctx.fill();
  ctx.fillStyle = WHITE; ctx.fillText(cta, 48 + 48, cy + 30);
  drawCharacter(ctx, assets.char, 560, 1800);
  return c.toBuffer('image/png');
}

module.exports = { renderIntro, renderOutro };
