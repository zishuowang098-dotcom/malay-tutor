import express from 'express';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, status } from './config.js';
import * as store from './store.js';
import { parseFile } from './parse.js';
import * as ai from './ai.js';
import { synthesize, recognize } from './speech.js';
import { recordItem, weakItems, reviewQueue, compareText } from './progress.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// ---------- 可选的访问密码 ----------
const token = config.appPassword ? crypto.createHmac('sha256', config.appPassword).update('malay-tutor').digest('hex') : null;
app.post('/api/login', (req, res) => {
  if (!token) return res.json({ ok: true });
  const a = Buffer.from(String(req.body?.password || ''));
  const b = Buffer.from(config.appPassword);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: '密码错误' });
  res.cookie('mt_auth', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 180 * 864e5 });
  res.json({ ok: true });
});
app.get('/api/status', (req, res) => res.json({ ...status(), authed: !token || req.cookies.mt_auth === token }));
app.use('/api', (req, res, next) => (!token || req.cookies.mt_auth === token ? next() : res.status(401).json({ error: '需要登录' })));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const mustCourse = async (id) => {
  const c = await store.getCourse(id);
  if (!c) throw Object.assign(new Error('课程不存在'), { status: 404 });
  return c;
};
const summary = (c) => ({ id: c.id, title: c.title, fileName: c.fileName, kind: c.kind, pageCount: c.slides.length, status: c.status, processing: c.processing, createdAt: c.createdAt });

// ---------- 课程 ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

app.get('/api/courses', wrap(async (req, res) => {
  const list = await store.listCourses();
  const out = [];
  for (const c of list) {
    const p = await store.getProgress(c.id);
    const done = Object.values(p.pages).filter((x) => x.status === 'done').length;
    out.push({ ...summary(c), donePages: done, currentPage: p.currentPage, review: reviewQueue(p).due.length });
  }
  res.json(out);
}));

app.post('/api/courses', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw Object.assign(new Error('请选择文件'), { status: 400 });
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const parsed = await parseFile(req.file.buffer, fileName);
  if (!parsed.slides.length) throw Object.assign(new Error('没有在文件中找到任何页面'), { status: 400 });
  const id = store.newId();
  const mediaDir = path.join(store.dirs.media, id);
  await fs.mkdir(mediaDir, { recursive: true });
  const slides = [];
  for (const s of parsed.slides) {
    const images = [];
    for (const [k, img] of s.images.entries()) {
      const name = `p${s.page}-${k}${path.extname(img.name)}`;
      await fs.writeFile(path.join(mediaDir, name), img.data);
      images.push({ file: name, mediaType: img.mediaType, size: img.data.length });
    }
    slides.push({ page: s.page, hidden: s.hidden, text: s.text, notes: s.notes, images, lesson: null, lessonError: null });
  }
  if (parsed.kind === 'pdf') await fs.writeFile(path.join(store.dirs.uploads, `${id}.pdf`), req.file.buffer);
  const course = {
    id, title: (req.body.title || fileName.replace(/\.(pptx|pdf)$/i, '')).slice(0, 120), fileName, kind: parsed.kind,
    slides, status: 'processing', processing: { done: 0, total: slides.length, error: null }, createdAt: Date.now(), updatedAt: Date.now(),
  };
  await store.saveCourse(course);
  res.json(summary(course));
  generateLessons(id).catch((e) => console.error('generate failed', e));
}));

app.get('/api/courses/:id', wrap(async (req, res) => res.json(await mustCourse(req.params.id))));
app.delete('/api/courses/:id', wrap(async (req, res) => {
  await mustCourse(req.params.id);
  await store.deleteCourse(req.params.id);
  await fs.rm(path.join(store.dirs.uploads, `${req.params.id}.pdf`), { force: true });
  res.json({ ok: true });
}));
app.post('/api/courses/:id/regenerate', wrap(async (req, res) => {
  const pages = Array.isArray(req.body?.pages) ? req.body.pages.map(Number) : null;
  const c = await store.updateCourse(req.params.id, (c) => {
    for (const s of c.slides) if (!pages || pages.includes(s.page)) { if (pages) s.lesson = null; s.lessonError = null; }
    c.status = 'processing';
    c.processing = { done: c.slides.filter((s) => s.lesson).length, total: c.slides.length, error: null };
  });
  if (!c) throw Object.assign(new Error('课程不存在'), { status: 404 });
  res.json(summary(c));
  generateLessons(c.id).catch((e) => console.error(e));
}));
app.get('/api/courses/:id/media/:file', wrap(async (req, res) => {
  if (!/^[\w.-]+$/.test(req.params.file)) return res.status(400).end();
  res.sendFile(path.join(store.dirs.media, req.params.id.replace(/[^a-f0-9]/g, ''), req.params.file));
}));

// ---------- 讲义生成（后台，分批，失败可重试，重启后自动续跑） ----------
const running = new Set();
async function generateLessons(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    let course = await store.getCourse(id);
    if (!course) return;
    let pdfBase64 = null;
    if (course.kind === 'pdf') {
      try {
        const buf = await fs.readFile(path.join(store.dirs.uploads, `${id}.pdf`));
        if (buf.length < 20 * 1024 * 1024 && course.slides.length <= 300) pdfBase64 = buf.toString('base64');
      } catch {}
    }
    const todo = course.slides.filter((s) => !s.lesson);
    const batches = [];
    for (let i = 0; i < todo.length; i += 3) batches.push(todo.slice(i, i + 3));
    let lastError = null;
    const worker = async () => {
      while (batches.length) {
        const batch = batches.shift();
        const pages = [];
        for (const s of batch) {
          const imagesB64 = [];
          for (const im of s.images.slice(0, 4)) {
            if (im.size > 3.5 * 1024 * 1024) continue;
            imagesB64.push({ mediaType: im.mediaType, data: (await fs.readFile(path.join(store.dirs.media, id, im.file))).toString('base64') });
          }
          pages.push({ ...s, imagesB64 });
        }
        try {
          const result = await ai.generateNotes({ course, pages, pdfBase64 });
          await store.updateCourse(id, (c) => {
            for (const s of batch) {
              const r = result.find((x) => x.page === s.page);
              const slide = c.slides.find((x) => x.page === s.page);
              if (r) { slide.lesson = r; slide.lessonError = null; } else slide.lessonError = 'AI 未返回该页讲义';
            }
            c.processing.done = c.slides.filter((x) => x.lesson).length;
          });
        } catch (e) {
          lastError = e.message;
          console.error(`lesson batch ${batch.map((b) => b.page)} failed:`, e.message);
          await store.updateCourse(id, (c) => { for (const s of batch) c.slides.find((x) => x.page === s.page).lessonError = e.message; });
          if (e.status === 503) { batches.length = 0; }
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await store.updateCourse(id, (c) => {
      const missing = c.slides.filter((s) => !s.lesson).length;
      c.status = missing ? 'partial' : 'ready';
      c.processing = { done: c.slides.length - missing, total: c.slides.length, error: missing ? lastError || '部分页面生成失败' : null };
    });
  } finally {
    running.delete(id);
  }
}

// ---------- 语音 ----------
app.get('/api/tts', wrap(async (req, res) => {
  const buf = await synthesize({ text: req.query.text, voice: req.query.voice, speed: req.query.speed });
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=31536000' }).send(buf);
}));
app.post('/api/stt', express.raw({ type: ['audio/wav', 'audio/*', 'application/octet-stream'], limit: '8mb' }), wrap(async (req, res) => {
  const r = await recognize({ audio: req.body, language: req.query.lang, referenceText: req.query.ref, selfAssess: req.query.assess === 'self' });
  if (r.ok && req.query.ref && !r.assessment) r.textMatch = compareText(req.query.ref, r.text);
  res.json(r);
}));

// ---------- 进度 ----------
app.get('/api/courses/:id/progress', wrap(async (req, res) => {
  await mustCourse(req.params.id);
  const p = await store.getProgress(req.params.id);
  res.json({ currentPage: p.currentPage, pages: p.pages, items: Object.values(p.items), history: p.history.slice(-200), review: reviewQueue(p) });
}));
app.post('/api/courses/:id/progress/page', wrap(async (req, res) => {
  await mustCourse(req.params.id);
  const page = Number(req.body.page);
  res.json(await store.updateProgress(req.params.id, (p) => {
    p.pages[page] = { ...(p.pages[page] || {}), status: req.body.status || 'done', lastAt: Date.now() };
  }));
}));

// ---------- AI 引导教学 ----------
function describeAssessment(a) {
  if (!a) return '';
  return `\n[Azure 发音评分] 总分 ${a.pronScore}，准确度 ${a.accuracy}，流利度 ${a.fluency}，完整度 ${a.completeness}；逐词：${a.words.map((w) => `${w.word}(${w.accuracy}${w.errorType && w.errorType !== 'None' ? ',' + w.errorType : ''})`).join(' ')}`;
}
app.post('/api/courses/:id/tutor', wrap(async (req, res) => {
  const course = await mustCourse(req.params.id);
  const page = Number(req.body.page);
  const slide = course.slides.find((s) => s.page === page);
  if (!slide) throw Object.assign(new Error('页码不存在'), { status: 400 });
  const { action = 'input', text = '', assessment = null, inputLang = 'ms-MY', target = '' } = req.body;
  const p = await store.getProgress(course.id);
  let history = p.tutor?.[page] || [];
  if (action === 'start' && history.length && !req.body.restart) {
    const last = history[history.length - 1];
    const view = history.map((h) => (h.role === 'user'
      ? { role: 'user', text: (h.content.match(/「([\s\S]*)」/) || [])[1] || (h.content.startsWith('[学生] 我没听懂') ? '没听懂，请再讲一遍' : '') }
      : { role: 'assistant', reply: JSON.parse(h.content) }));
    return res.json({ reply: JSON.parse(last.content), resumed: true, history: view.slice(0, -1) });
  }
  if (req.body.restart) history = [];
  let userText;
  if (action === 'start') {
    const donePages = Object.entries(p.pages).filter(([, v]) => v.status === 'done').map(([k]) => k);
    userText = `[开始上课] 请开始讲第 ${page} 页。${donePages.length ? `（学生已学完第 ${donePages.join('、')} 页）` : '（这是学生第一次上这门课，先简短打个招呼）'}`;
  } else if (action === 'next') userText = '[学生] 好的，请继续。';
  else if (action === 'repeat') userText = '[学生] 我没听懂，请换一种更简单的方式再讲一遍，慢一点。';
  else {
    const t = String(text).trim().slice(0, 1000);
    if (!t) throw Object.assign(new Error('没有收到回答内容'), { status: 400 });
    userText = `[学生${req.body.typed ? '打字' : '语音'}回答${req.body.typed ? '' : `（${inputLang === 'zh-CN' ? '中文' : '马来语'}语音识别结果）`}]「${t}」${target ? `\n（本题目标：${target}）` : ''}${describeAssessment(assessment)}`;
  }
  const reply = await ai.tutorTurn({ course, page, history, userText, weakItems: weakItems(p, 8) });
  await store.updateProgress(course.id, (pp) => {
    let h = [...history, { role: 'user', content: userText }, { role: 'assistant', content: JSON.stringify(reply) }];
    if (h.length > 60) h = h.slice(h.length - 60);
    pp.tutor = { ...(pp.tutor || {}), [page]: h };
    pp.currentPage = page;
    pp.pages[page] = { ...(pp.pages[page] || {}), status: reply.page_complete ? 'done' : pp.pages[page]?.status === 'done' ? 'done' : 'learning', lastAt: Date.now() };
    if (reply.evaluation?.has_evaluation && reply.evaluation.item_ms) {
      recordItem(pp, { ms: reply.evaluation.item_ms, zh: reply.evaluation.item_zh, page, correct: reply.evaluation.correct, mode: 'lesson', error: reply.evaluation.error_zh, transcript: text, score: assessment?.pronScore ?? null });
    }
  });
  res.json({ reply });
}));

// ---------- 发音练习记录 ----------
app.post('/api/courses/:id/practice', wrap(async (req, res) => {
  await mustCourse(req.params.id);
  const { ms, zh, page, transcript = '', assessment = null, textMatch = null } = req.body;
  const score = assessment?.pronScore ?? textMatch?.score ?? 0;
  const bad = assessment?.words?.filter((w) => w.errorType !== 'None' || w.accuracy < 60).map((w) => w.word) || textMatch?.words?.filter((w) => !w.ok).map((w) => w.word) || [];
  const it = await store.updateProgress(req.params.id, (p) => recordItem(p, { ms, zh, page, correct: score >= 75, mode: 'pronunciation', score, transcript, error: bad.length ? `发音需加强：${bad.join(', ')}` : '' }));
  res.json({ item: it, score });
}));

// ---------- 口语 / 听力测试 ----------
app.post('/api/courses/:id/quiz', wrap(async (req, res) => {
  const course = await mustCourse(req.params.id);
  const kind = req.body.kind === 'listening' ? 'listening' : 'speaking';
  const lessonPages = course.slides.filter((s) => s.lesson?.is_lesson_content !== false).map((s) => s.page);
  let pages = Array.isArray(req.body.pages) && req.body.pages.length ? req.body.pages.map(Number) : lessonPages;
  if (!pages.length) pages = course.slides.map((s) => s.page);
  const p = await store.getProgress(course.id);
  const questions = await ai.generateQuiz({ course, pages, kind, count: Math.min(10, Number(req.body.count) || 6), weakItems: req.body.focusWeak ? weakItems(p, 8) : [] });
  res.json({ kind, questions });
}));
app.post('/api/courses/:id/grade', wrap(async (req, res) => {
  const course = await mustCourse(req.params.id);
  const { kind, question, transcript, assessment, attempt = 1, mode } = req.body;
  if (!question || !String(transcript || '').trim()) throw Object.assign(new Error('缺少题目或回答'), { status: 400 });
  const result = await ai.gradeAnswer({ course, kind: kind === 'listening' ? 'listening' : 'speaking', question, transcript, assessment, attempt });
  await store.updateProgress(course.id, (p) => {
    const ms = kind === 'listening' ? question.audio_ms : question.expected_ms;
    const zh = kind === 'listening' ? question.translation_zh : question.prompt_zh.replace(/^.*?[:：]\s*/, '');
    recordItem(p, { ms: question.item_ms || ms, zh: question.item_zh || zh, page: question.page, correct: kind === 'listening' ? result.understood && result.correct : result.correct, mode: mode || kind, score: result.score, error: result.errors.map((e) => `${e.wrong}→${e.right}：${e.explanation_zh}`).join('；'), transcript });
  });
  res.json(result);
}));

// ---------- Quiz 备考 ----------
const quizText = (q) => q.pages.map((p) => `[第 ${p.page} 页]\n${p.text.join('\n')}`).join('\n\n');
async function analyzeQuizBg(courseId, qid) {
  try {
    const course = await store.getCourse(courseId);
    const quiz = course?.quizzes?.find((q) => q.id === qid);
    if (!quiz) return;
    const analysis = await ai.analyzeQuiz({ course, quizText: quizText(quiz) });
    await store.updateCourse(courseId, (c) => { const q = c.quizzes.find((x) => x.id === qid); if (q) { q.analysis = analysis; q.status = 'ready'; q.error = null; } });
  } catch (e) {
    console.error('quiz analyze failed', e.message);
    await store.updateCourse(courseId, (c) => { const q = c.quizzes?.find((x) => x.id === qid); if (q) { q.status = 'error'; q.error = e.message; } });
  }
}
const mustQuiz = (c, qid) => {
  const q = c.quizzes?.find((x) => x.id === qid);
  if (!q) throw Object.assign(new Error('Quiz 不存在'), { status: 404 });
  if (!q.analysis) throw Object.assign(new Error('Quiz 还在分析中'), { status: 409 });
  return q;
};
app.post('/api/courses/:id/quizzes', upload.single('file'), wrap(async (req, res) => {
  await mustCourse(req.params.id);
  if (!req.file) throw Object.assign(new Error('请选择 quiz 文件'), { status: 400 });
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const parsed = await parseFile(req.file.buffer, fileName);
  const pages = parsed.slides.map((s) => ({ page: s.page, text: [...s.text, ...(s.notes || [])] }));
  if (!pages.some((p) => p.text.length)) throw Object.assign(new Error('这个文件里提取不到文字（可能是扫描图片），暂时无法分析'), { status: 400 });
  const quiz = { id: store.newId(), fileName, pages, status: 'analyzing', analysis: null, studies: {}, createdAt: Date.now() };
  await store.updateCourse(req.params.id, (c) => { c.quizzes = [...(c.quizzes || []), quiz]; });
  res.json(quiz);
  analyzeQuizBg(req.params.id, quiz.id);
}));
app.post('/api/courses/:id/quizzes/:qid/reanalyze', wrap(async (req, res) => {
  const c = await store.updateCourse(req.params.id, (c) => { const q = c.quizzes?.find((x) => x.id === req.params.qid); if (q) { q.status = 'analyzing'; q.error = null; q.studies = {}; } });
  if (!c) throw Object.assign(new Error('课程不存在'), { status: 404 });
  res.json({ ok: true });
  analyzeQuizBg(req.params.id, req.params.qid);
}));
app.delete('/api/courses/:id/quizzes/:qid', wrap(async (req, res) => {
  await store.updateCourse(req.params.id, (c) => { c.quizzes = (c.quizzes || []).filter((q) => q.id !== req.params.qid); });
  res.json({ ok: true });
}));
app.post('/api/courses/:id/quizzes/:qid/study', wrap(async (req, res) => {
  const course = await mustCourse(req.params.id);
  const quiz = mustQuiz(course, req.params.qid);
  const topic = quiz.analysis.topics.find((t) => t.id === req.body.topicId) || quiz.analysis.topics[0];
  if (!topic) throw Object.assign(new Error('这个 quiz 没有可用的话题'), { status: 400 });
  if (quiz.studies?.[topic.id] && !req.body.regenerate) return res.json({ topic, study: quiz.studies[topic.id] });
  const study = await ai.quizStudy({ course, quiz, topic });
  await store.updateCourse(course.id, (c) => { const q = c.quizzes.find((x) => x.id === quiz.id); q.studies = { ...(q.studies || {}), [topic.id]: study }; });
  res.json({ topic, study });
}));
app.post('/api/courses/:id/quizzes/:qid/mock', wrap(async (req, res) => {
  const course = await mustCourse(req.params.id);
  const quiz = mustQuiz(course, req.params.qid);
  const topic = quiz.analysis.topics.find((t) => t.id === req.body.topicId);
  const transcript = String(req.body.transcript || '').trim().slice(0, 3000);
  if (!topic || !transcript) throw Object.assign(new Error('缺少话题或回答'), { status: 400 });
  const result = await ai.gradeMock({ course, quiz, topic, transcript, assessment: req.body.assessment || null });
  await store.updateProgress(course.id, (p) => {
    p.mocks = [...(p.mocks || []), { at: Date.now(), quizId: quiz.id, topicId: topic.id, topic: topic.name_zh, score: result.score, max: result.max_score, transcript }].slice(-100);
    for (const s of result.sentences) {
      if (!s.ok && s.corrected_ms) recordItem(p, { ms: s.corrected_ms, zh: `${topic.name_zh}：${s.point_zh}`, page: null, correct: false, mode: 'mock', error: s.issue_zh, transcript: s.heard });
    }
  });
  res.json(result);
}));

// ---------- 智能复习 ----------
app.get('/api/courses/:id/review', wrap(async (req, res) => {
  await mustCourse(req.params.id);
  res.json(reviewQueue(await store.getProgress(req.params.id)));
}));

// ---------- 静态文件 ----------
app.use(express.static(path.join(here, '..', 'public'), { setHeaders: (res, f) => { if (f.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); } }));
app.use((err, req, res, next) => {
  const code = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (code >= 500) console.error(err);
  res.status(code).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '文件太大（上限 60MB）' : err.message || '服务器错误' });
});

export { app };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(config.port, '0.0.0.0', async () => {
    const s = status();
    console.log(`AI 马来语老师已启动: http://localhost:${config.port}`);
    console.log(`  Claude: ${s.ai ? '已配置 (' + s.model + ')' : '未配置 ANTHROPIC_API_KEY'} | Azure 语音: ${s.speech ? '已配置' : '未配置 AZURE_SPEECH_KEY/REGION'}`);
    for (const c of await store.listCourses()) if (c.status === 'processing') generateLessons(c.id).catch(console.error);
  });
}
