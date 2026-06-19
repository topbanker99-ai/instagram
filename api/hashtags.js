// api/hashtags.js
// 해시태그 빌더 — 콘텐츠 종류별 태그 + 매 게시물 로테이션(묶음이 매번 달라지게).
//
// 사용법:
//   const { buildTags } = require('./hashtags.js');
//   const tags = buildTags('glossary');                       // 상식 카드
//   const tags = buildTags('specs',   { bank: '#국민은행' });  // 동적 은행명 포함
//   const tags = buildTags('essay',   { inst: '#한국은행' });  // 동적 기관명 포함
//   const tags = buildTags('corp',    { bank: '#기업은행' });  // 기업분석(동적 은행명)
//
// 종류: 'glossary' | 'specs' | 'news' | 'reel_spec' | 'reel_glossary' | 'essay' | 'corp'
//
// 구조: 항상 들어가는 [공통 코어 + 유형 필수 + 동적태그] + 로테이션으로 채우는 [은행명/취준/유형 풀].
//       게시물당 총 TOTAL개로 맞추고, 순서까지 섞어서 "복붙 도배"로 안 보이게 함.

const TOTAL = 11;   // 게시물당 목표 해시태그 수 (바꾸려면 이 숫자만 수정)

const CORE = ['#탑뱅커', '#은행취업', '#금융권취업'];   // 모든 게시물 공통(항상 포함)

// 공용 로테이션 풀 (여러 유형이 함께 쓰는 풀에서 매번 일부만 뽑음)
const BANKS = ['#국민은행', '#신한은행', '#우리은행', '#하나은행', '#농협은행', '#기업은행', '#한국은행', '#산업은행', '#수출입은행'];
const JOB   = ['#취업준비', '#취준생', '#자기소개서', '#자소서', '#면접준비', '#필기시험', '#NCS', '#공기업', '#금융공기업', '#취준', '#하반기공채', '#신입채용'];

// 유형별: must(항상 포함) / pool(유형 전용 로테이션 풀) / use(은행명·취준 풀에서 뽑을 개수)
const TYPES = {
  glossary: {
    must: ['#금융상식', '#경제상식'],
    pool: ['#금융용어', '#경제용어', '#금융지식', '#경제공부', '#은행상식', '#금융권상식', '#시사경제', '#금융이슈', '#경제뉴스', '#금융문해력', '#경제기초', '#돈공부'],
    use:  { banks: 2, job: 1 },
  },
  specs: {
    must: ['#합격스펙', '#은행스펙'],
    pool: ['#은행합격', '#합격후기', '#스펙공개', '#은행자소서', '#은행필기', '#은행면접', '#입행', '#은행원', '#서류합격', '#스펙비교', '#합격자소서', '#은행취업컨설팅'],
    use:  { banks: 2, job: 1 },
  },
  news: {
    must: ['#면접시사', '#은행면접'],
    pool: ['#금융권면접', '#시사상식', '#금융뉴스', '#면접질문', '#면접예상질문', '#경제이슈', '#면접대비', '#최신시사', '#시사이슈', '#경제시사', '#면접꿀팁', '#논술시사'],
    use:  { banks: 1, job: 1 },
  },
  reel_spec: {
    must: ['#합격스펙', '#릴스'],
    pool: ['#은행합격', '#은행스펙', '#스펙공개', '#은행자소서', '#은행면접', '#입행', '#릴스추천', '#숏폼'],
    use:  { banks: 2, job: 1 },
  },
  reel_glossary: {
    must: ['#금융상식', '#릴스'],
    pool: ['#경제상식', '#금융용어', '#금융지식', '#은행상식', '#경제공부', '#릴스추천', '#숏폼', '#금융이슈'],
    use:  { banks: 2, job: 1 },
  },
  essay: {
    must: ['#논술기출', '#은행논술'],
    pool: ['#금융공기업논술', '#논술준비', '#금융논술', '#공기업논술', '#논술작성법', '#시사논술', '#경제논술', '#논술예상문제', '#약술', '#논술공부', '#논술첨삭', '#필기시험'],
    use:  { banks: 0, job: 1 },
  },
  corp: {
    must: ['#기업분석', '#은행분석'],
    pool: ['#은행기업분석', '#경영실적', '#재무제표', '#은행자소서', '#은행면접', '#지원동기', '#은행권취업', '#금융권준비', '#취업컨설팅', '#은행지원', '#합격자소서', '#은행취업컨설팅'],
    use:  { banks: 2, job: 1 },
  },
};

function shuffle(arr){ const a = arr.slice(); for(let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function pick(arr, n){ return shuffle(arr).slice(0, Math.max(0, n | 0)); }
function uniq(arr){ return Array.from(new Set(arr)); }
function addUpTo(out, tags, total){ for(const t of tags){ if(out.length >= total) break; if(!out.includes(t)) out.push(t); } }

function buildTags(type, extra){
  const t = TYPES[type] || TYPES.glossary;
  extra = extra || {};

  // 1) 항상 들어갈 것: 공통 코어 + 유형 필수 + 동적태그(은행명/기관명)
  const dyn = [];
  if(extra.bank) dyn.push(extra.bank);
  if(extra.inst) dyn.push(extra.inst);
  let out = uniq([...CORE, ...t.must, ...dyn]);

  // 2) 로테이션으로 채우기: 은행명 일부 → 취준 일부 → 유형 풀로 나머지 채움
  addUpTo(out, pick(BANKS, (t.use && t.use.banks) || 0), TOTAL);
  addUpTo(out, pick(JOB,   (t.use && t.use.job)   || 0), TOTAL);
  addUpTo(out, shuffle(t.pool), TOTAL);

  // 3) 순서까지 섞기(같은 태그라도 위치가 매번 달라지게)
  return shuffle(out).join(' ');
}

module.exports = { buildTags };
