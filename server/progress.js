// 学习进度、错题与间隔复习（Leitner 盒子）
const MIN = 60e3, DAY = 864e5;
const INTERVALS = [0, 10 * MIN, DAY, 3 * DAY, 7 * DAY, 16 * DAY];

export const normKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();

export function recordItem(p, { ms, zh = '', page = null, correct, mode, score = null, error = '', transcript = '' }) {
  const key = normKey(ms);
  if (!key) return null;
  const now = Date.now();
  const it = p.items[key] || { ms, zh, page, seen: 0, correct: 0, wrong: 0, streak: 0, box: 0, due: now, scores: [], lastError: '' };
  if (zh && !it.zh) it.zh = zh;
  if (page != null && it.page == null) it.page = page;
  it.seen++;
  if (correct) { it.correct++; it.streak++; it.box = Math.min(5, it.box + 1); }
  else { it.wrong++; it.streak = 0; it.box = 1; it.lastError = error || it.lastError; }
  it.due = now + INTERVALS[it.box];
  it.lastAt = now;
  if (score != null) it.scores = [...it.scores.slice(-9), Math.round(score)];
  p.items[key] = it;
  p.history.push({ at: now, mode, page, ms, zh, correct, error, transcript, score });
  if (p.history.length > 1000) p.history = p.history.slice(-1000);
  return it;
}

export function weakItems(p, limit = 12) {
  return Object.values(p.items)
    .filter((i) => i.wrong > 0 && (i.streak < 2 || i.box <= 2))
    .sort((a, b) => b.wrong - b.streak * 2 - (a.wrong - a.streak * 2) || a.due - b.due)
    .slice(0, limit);
}

export function reviewQueue(p, limit = 20) {
  const now = Date.now();
  const due = Object.values(p.items).filter((i) => i.due <= now && (i.wrong > 0 || i.box < 5)).sort((a, b) => a.box - b.box || a.due - b.due);
  return { due: due.slice(0, limit), weak: weakItems(p), total: Object.keys(p.items).length, nextDue: Math.min(...Object.values(p.items).map((i) => i.due).filter((d) => d > now), Infinity) };
}

// 发音评测不可用时的文本比对（基于真实识别结果的逐词 LCS 对齐）
export function compareText(ref, hyp) {
  const r = normKey(ref).split(' ').filter(Boolean);
  const h = normKey(hyp).split(' ').filter(Boolean);
  const dp = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = r.length - 1; i >= 0; i--) for (let j = h.length - 1; j >= 0; j--) dp[i][j] = r[i] === h[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ok = new Set();
  for (let i = 0, j = 0; i < r.length && j < h.length;) {
    if (r[i] === h[j]) { ok.add(i); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  const words = r.map((w, i) => ({ word: w, ok: ok.has(i) }));
  const extra = Math.max(0, h.length - ok.size);
  const score = r.length ? Math.round((100 * ok.size) / (r.length + extra * 0.5)) : 0;
  return { score: Math.min(100, score), words };
}
