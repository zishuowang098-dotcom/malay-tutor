import { player, recorder, transcribe, settings } from './audio.js';

// ---------------- 工具 ----------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
let toastTimer;
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
async function api(url, opts = {}) {
  const o = { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...opts.headers } };
  if (o.body && typeof o.body === 'object' && !(o.body instanceof FormData)) o.body = JSON.stringify(o.body);
  const r = await fetch(url, o);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { renderLogin(); throw new Error('需要登录'); }
  if (!r.ok) throw new Error(j.error || `请求失败 (${r.status})`);
  return j;
}
const I = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  slow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17c2 0 3-1 4-3 2-5 6-7 9-5 2 1 3 4 2 6-1 1-3 2-5 2H3"/><circle cx="18.5" cy="8.5" r="1.5"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
};
// 可点读的马来语：🔊 正常 / 🐢 慢速
const sayBtns = (text, lang = 'ms') => `<span class="say"><button data-say="${esc(text)}" data-lang="${lang}" title="播放" aria-label="播放">${I.play}</button>${lang === 'ms' ? `<button data-say="${esc(text)}" data-lang="ms" data-speed="slow" title="慢速" aria-label="慢速播放">${I.slow}</button>` : ''}</span>`;
const srcTag = (s) => (s === 'supplement' ? '<span class="src supplement" title="课件之外，AI 补充的内容">AI补充</span>' : s === 'slide' ? '<span class="src slide" title="来自课件原文">课件</span>' : '');
const scoreCls = (s) => (s >= 80 ? 'good' : s >= 60 ? 'mid' : 'bad');

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-say]');
  if (!b) return;
  e.preventDefault();
  player.unlock();
  $$('.say button.playing').forEach((x) => x.classList.remove('playing'));
  b.classList.add('playing');
  player.say(b.dataset.say, b.dataset.lang || 'ms', b.dataset.speed || 'normal').catch((err) => toast(err.message)).finally(() => b.classList.remove('playing'));
});

// ---------------- 设置 ----------------
$('#btn-settings').onclick = () => {
  const d = $('#settings-dlg'), s = settings.get(), f = d.querySelector('form');
  f.msVoice.value = s.msVoice; f.zhVoice.value = s.zhVoice; f.autoMic.checked = s.autoMic !== false; f.autoStop.checked = s.autoStop !== false;
  d.showModal();
  d.onclose = () => settings.set({ msVoice: f.msVoice.value, zhVoice: f.zhVoice.value, autoMic: f.autoMic.checked, autoStop: f.autoStop.checked });
};

// ---------------- 麦克风组件 ----------------
// 点击开始录音，再点结束（或自动在停顿后结束）。完成后调用 onResult(识别结果)
function mountMic(el, { getLang, getRef = () => '', onResult, label = '点击说话' }) {
  el.innerHTML = `<div class="mic-wrap"><button class="mic" aria-label="录音">${I.mic}</button></div><div class="mic-label">${esc(label)}</div>`;
  const btn = $('.mic', el), lab = $('.mic-label', el);
  let busy = false;
  const setLabel = (t) => (lab.textContent = t);
  const ctl = {
    async start() {
      if (busy || recorder.active) return;
      player.stop(); player.unlock();
      try {
        btn.classList.add('rec'); btn.innerHTML = I.stop; setLabel('正在听…说完后点击停止');
        const rec = await recorder.start({ onLevel: (l) => btn.style.setProperty('--lvl', l) });
        btn.classList.remove('rec'); btn.innerHTML = I.mic; btn.style.setProperty('--lvl', 0);
        if (!rec.spoke || rec.seconds < 0.4) { setLabel('没有听到声音，请再试一次'); return; }
        busy = true; btn.classList.add('busy'); setLabel('识别中…');
        const res = await transcribe(rec.blob, { lang: getLang(), ref: getRef() });
        busy = false; btn.classList.remove('busy');
        if (!res.ok) { setLabel(res.message || '没有识别到内容，请再说一次'); return; }
        setLabel(label);
        await onResult(res);
      } catch (e) {
        busy = false; btn.classList.remove('busy', 'rec'); btn.innerHTML = I.mic;
        setLabel(label); toast(e.message, 5000);
      }
    },
    setLabel,
    disable(v) { btn.disabled = v; },
  };
  btn.onclick = () => (recorder.active ? recorder.stop() : ctl.start());
  return ctl;
}
const autoMic = () => settings.get().autoMic !== false;

// ---------------- 状态 / 路由 ----------------
let STATUS = null;
const state = { course: null, timers: [] };
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }

async function route() {
  clearTimers(); player.stop(); if (recorder.active) recorder.stop();
  try { STATUS = await api('/api/status'); } catch (e) { app.innerHTML = `<div class="banner bad">无法连接服务器：${esc(e.message)}</div>`; return; }
  if (STATUS.authRequired && !STATUS.authed) return renderLogin();
  const m = location.hash.match(/^#\/c\/([a-f0-9]{16})(?:\/(\w+))?(?:\/(\d+))?/);
  if (m) return renderCourse(m[1], m[2] || 'learn', m[3] ? Number(m[3]) : null);
  return renderHome();
}
window.addEventListener('hashchange', route);

function configBanner() {
  const miss = [];
  if (!STATUS.ai) miss.push('<code>ANTHROPIC_API_KEY</code>（AI 讲解与批改）');
  if (!STATUS.speech) miss.push('<code>AZURE_SPEECH_KEY</code> / <code>AZURE_SPEECH_REGION</code>（马来语语音）');
  return miss.length ? `<div class="banner">服务端尚未配置：${miss.join('、')}。请在 <code>.env</code> 中填写后重启服务，相关功能才能使用。</div>` : '';
}

function renderLogin() {
  app.innerHTML = `<div class="card stack" style="max-width:380px;margin:40px auto"><h2>请输入访问密码</h2><form id="lf" class="stack"><input type="password" name="pw" placeholder="APP_PASSWORD" autocomplete="current-password" required><button class="btn primary" style="width:100%">进入</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { password: e.target.pw.value } }); route(); } catch (err) { toast(err.message); }
  };
}

// ---------------- 首页 ----------------
async function renderHome() {
  app.innerHTML = `${configBanner()}
  <h1>我的马来语课程</h1>
  <p class="muted">上传老师的 PPT 或 PDF 课件，AI 会逐页生成中文讲义，并像真人老师一样用语音带你学。</p>
  <label class="drop" id="drop"><input type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation">
    <div style="font-size:2rem">📄</div><b>点击选择课件</b><div class="muted small">支持 .pptx / .pdf，或拖拽文件到这里</div></label>
  <div id="upl"></div>
  <div id="list" class="stack" style="margin-top:16px"><p class="muted">加载中…</p></div>`;
  const drop = $('#drop'), input = $('input', drop);
  input.onchange = () => input.files[0] && doUpload(input.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && doUpload(e.dataTransfer.files[0]); };
  await loadList();
  state.timers.push(setInterval(() => { if ($('#list [data-processing]')) loadList(); }, 4000));
}
async function loadList() {
  const list = await api('/api/courses').catch((e) => { toast(e.message); return []; });
  const el = $('#list'); if (!el) return;
  if (!list.length) { el.innerHTML = '<p class="muted center">还没有课程。上传第一份课件开始学习吧。</p>'; return; }
  el.innerHTML = list.map((c) => {
    const pct = c.pageCount ? Math.round((c.donePages / c.pageCount) * 100) : 0;
    const st = c.status === 'processing' ? `<span class="pill warn" data-processing><span class="spinner" style="width:12px;height:12px"></span> 生成讲义 ${c.processing.done}/${c.processing.total}</span>`
      : c.status === 'partial' ? `<span class="pill bad">部分讲义失败</span>` : `<span class="pill good">已就绪</span>`;
    return `<a class="card course" href="#/c/${c.id}"><div class="meta"><div class="title">${esc(c.title)}</div>
      <div class="row small muted">${c.kind.toUpperCase()} · ${c.pageCount} 页 · 已学 ${c.donePages} 页 ${st} ${c.review ? `<span class="pill bad">待复习 ${c.review}</span>` : ''}</div>
      <div class="progress"><i style="width:${pct}%"></i></div></div><span class="muted">›</span></a>`;
  }).join('');
}
async function doUpload(file) {
  if (!/\.(pptx|pdf)$/i.test(file.name)) return toast('只支持 .pptx 或 .pdf 文件');
  const fd = new FormData(); fd.append('file', file);
  $('#upl').innerHTML = `<div class="card row"><span class="spinner"></span> 正在上传并解析「${esc(file.name)}」…</div>`;
  try {
    const c = await api('/api/courses', { method: 'POST', body: fd });
    location.hash = `#/c/${c.id}/notes`;
  } catch (e) { $('#upl').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
}

// ---------------- 课程页 ----------------
const TABS = [['learn', '🎓 上课'], ['notes', '📖 讲义'], ['practice', '🗣️ 发音'], ['speak', '💬 口语测试'], ['listen', '🎧 听力测试'], ['review', '🔁 复习']];
async function renderCourse(id, tab, page) {
  let c;
  try { c = await api(`/api/courses/${id}`); } catch (e) { app.innerHTML = `<div class="banner bad">${esc(e.message)}</div><a href="#/">返回</a>`; return; }
  state.course = c;
  const ready = c.slides.filter((s) => s.lesson).length;
  app.innerHTML = `${configBanner()}
    <div class="row between"><div class="grow"><h1 style="margin:0">${esc(c.title)}</h1><div class="muted small">${esc(c.fileName)} · ${c.slides.length} 页</div></div>
    <button class="btn sm ghost danger" id="del">删除</button></div>
    ${c.status === 'processing' ? `<div class="card" style="margin-top:12px"><div class="row"><span class="spinner"></span> AI 正在逐页生成讲义：${ready}/${c.slides.length}</div><div class="progress"><i style="width:${(ready / c.slides.length) * 100}%"></i></div><div class="muted small" style="margin-top:6px">已生成的页面可以先开始学习。</div></div>` : ''}
    ${c.status === 'partial' ? `<div class="banner bad" style="margin-top:12px">有 ${c.slides.length - ready} 页讲义生成失败：${esc(c.processing?.error || '')} <button class="btn sm" id="regen">重试失败页</button></div>` : ''}
    <nav class="tabs" style="margin-top:12px">${TABS.map(([k, n]) => `<a class="tab ${k === tab ? 'on' : ''}" href="#/c/${id}/${k}">${n}</a>`).join('')}</nav>
    <section id="view"></section>`;
  $('#del').onclick = async () => { if (confirm('删除这门课程及其学习记录？')) { await api(`/api/courses/${id}`, { method: 'DELETE' }); location.hash = '#/'; } };
  if ($('#regen')) $('#regen').onclick = async () => { await api(`/api/courses/${id}/regenerate`, { method: 'POST', body: {} }); route(); };
  if (c.status === 'processing') state.timers.push(setInterval(async () => {
    const n = await api(`/api/courses/${id}`).catch(() => null);
    if (n && (n.status !== 'processing' || n.slides.filter((s) => s.lesson).length !== ready) && !recorder.active && !state.busy) route();
  }, 5000));
  const view = $('#view');
  ({ learn: viewLearn, notes: viewNotes, practice: viewPractice, speak: viewSpeak, listen: viewListen, review: viewReview }[tab] || viewLearn)(view, c, page);
}

// ---------------- 讲义 ----------------
function lessonHtml(s, c) {
  const L = s.lesson;
  const orig = `<div class="label">课件原文 · 第 ${s.page} 页${s.hidden ? '（隐藏页）' : ''}</div><div class="orig">${esc(s.text.join('\n')) || '<span class="muted">（本页没有可提取的文字）</span>'}</div>
    ${s.notes?.length ? `<div class="label" style="margin-top:8px">演讲者备注</div><div class="orig">${esc(s.notes.join('\n'))}</div>` : ''}
    ${s.images?.length ? `<div class="thumbs">${s.images.map((im) => `<img loading="lazy" src="/api/courses/${c.id}/media/${im.file}" alt="第${s.page}页图片">`).join('')}</div>` : ''}`;
  if (!L) return `${orig}<div class="muted small" style="margin-top:10px">${s.lessonError ? `<span class="pill bad">讲义生成失败</span> ${esc(s.lessonError)}` : '<span class="spinner"></span> 讲义生成中…'}</div>`;
  const ex = (arr) => arr?.length ? `<ul>${arr.map((e) => `<li><span class="ms">${esc(e.ms)}</span> ${sayBtns(e.ms)}<br><span class="muted">${esc(e.zh)}</span></li>`).join('')}</ul>` : '';
  return `${orig}
    <div class="note-sec"><h4>${esc(L.title_zh)}</h4><div>${esc(L.summary_zh)}</div></div>
    ${L.vocabulary.length ? `<div class="note-sec"><h4>单词与发音</h4><table class="vocab">${L.vocabulary.map((v) => `<tr><td style="width:40%"><span class="ms">${esc(v.ms)}</span>${srcTag(v.source)}<br>${sayBtns(v.ms)}</td><td>${esc(v.zh)} <span class="muted small">${esc(v.part_of_speech)}</span><div class="small">🔈 ${esc(v.pronunciation_tip_zh)}</div>${v.example_ms ? `<div class="small" style="margin-top:4px"><span class="ms">${esc(v.example_ms)}</span> ${sayBtns(v.example_ms)}<br><span class="muted">${esc(v.example_zh)}</span></div>` : ''}</td></tr>`).join('')}</table></div>` : ''}
    ${L.sentence_patterns.length ? `<div class="note-sec"><h4>句型</h4>${L.sentence_patterns.map((p) => `<div style="margin-bottom:10px"><span class="ms">${esc(p.pattern_ms)}</span>${srcTag(p.source)} — ${esc(p.meaning_zh)}<div class="small">${esc(p.explanation_zh)}</div>${ex(p.examples)}</div>`).join('')}</div>` : ''}
    ${L.grammar.length ? `<div class="note-sec"><h4>语法</h4>${L.grammar.map((g) => `<div style="margin-bottom:10px"><b>${esc(g.title_zh)}</b>${srcTag(g.source)}<div class="small">${esc(g.explanation_zh)}</div>${ex(g.examples)}</div>`).join('')}</div>` : ''}
    ${L.memory_tips.length ? `<div class="note-sec"><h4>记忆技巧</h4><ul>${L.memory_tips.map((t) => `<li>${esc(t.tip_zh)}${srcTag(t.source)}</li>`).join('')}</ul></div>` : ''}`;
}
function viewNotes(view, c) {
  view.innerHTML = `<p class="muted small">标签说明：${srcTag('slide')} 来自课件原文　${srcTag('supplement')} 课件之外由 AI 补充</p>` +
    c.slides.map((s) => `<article class="card" id="p${s.page}"><div class="row between"><h3 style="margin:0">第 ${s.page} 页</h3>${s.lesson ? `<a class="btn sm" href="#/c/${c.id}/learn/${s.page}">从这页开始上课 →</a>` : s.lessonError ? `<button class="btn sm" data-regen="${s.page}">重新生成</button>` : ''}</div><div style="margin-top:8px">${lessonHtml(s, c)}</div></article>`).join('');
  $$('[data-regen]', view).forEach((b) => (b.onclick = async () => { await api(`/api/courses/${c.id}/regenerate`, { method: 'POST', body: { pages: [Number(b.dataset.regen)] } }); route(); }));
}

// ---------------- 上课（AI 引导教学） ----------------
async function viewLearn(view, c, pageArg) {
  const prog = await api(`/api/courses/${c.id}/progress`);
  const pages = c.slides.map((s) => s.page);
  let page = pageArg || prog.currentPage || (pages.find((p) => prog.pages[p]?.status !== 'done') ?? pages[0]);
  const slide = c.slides.find((s) => s.page === page) || c.slides[0];
  page = slide.page;
  const idx = pages.indexOf(page);
  view.innerHTML = `
    <div class="pager"><a class="btn sm" ${idx > 0 ? `href="#/c/${c.id}/learn/${pages[idx - 1]}"` : 'aria-disabled="true" style="visibility:hidden"'}>‹ 上一页</a>
      <div class="center"><b>第 ${page} / ${pages.length} 页</b> ${prog.pages[page]?.status === 'done' ? '<span class="pill good">已学完</span>' : ''}<div class="small muted">${esc(slide.lesson?.title_zh || '')}</div></div>
      <a class="btn sm" ${idx < pages.length - 1 ? `href="#/c/${c.id}/learn/${pages[idx + 1]}"` : 'style="visibility:hidden"'}>下一页 ›</a></div>
    <details class="card" style="padding:10px 14px"><summary class="small muted">查看本页课件原文</summary><div style="margin-top:8px">${esc(slide.text.join('\n')) ? `<div class="orig">${esc(slide.text.join('\n'))}</div>` : '<span class="muted">（无文字）</span>'}${slide.images?.length ? `<div class="thumbs">${slide.images.map((im) => `<img src="/api/courses/${c.id}/media/${im.file}" alt="">`).join('')}</div>` : ''}</div></details>
    <div class="chat" id="chat" style="margin-top:12px"></div>
    <div class="dock" id="dock"></div>`;
  const chat = $('#chat'), dock = $('#dock');
  if (!slide.lesson) {
    dock.innerHTML = `<div class="card center muted">${slide.lessonError ? `本页讲义生成失败：${esc(slide.lessonError)}` : '<span class="spinner"></span> 本页讲义还在生成中，请稍候…'}</div>`;
    return;
  }
  let reply = null, inputLang = 'ms-MY', mic;
  const scrollEnd = () => dock.scrollIntoView({ block: 'end', behavior: 'smooth' });

  function addTeacher(r) {
    const b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = r.segments.map((s, i) => s.lang === 'ms'
      ? `<span class="seg ms-seg" data-i="${i}">${esc(s.text)} ${sayBtns(s.text)}</span>${s.source === 'supplement' ? srcTag('supplement') : ''}`
      : `<span class="seg" data-i="${i}">${esc(s.text)}</span>${s.source === 'supplement' ? srcTag('supplement') : ''} `).join('');
    chat.appendChild(b);
    return b;
  }
  function addMe(text, extra = '') {
    const b = document.createElement('div');
    b.className = 'bubble me';
    b.innerHTML = `${esc(text)}${extra}`;
    chat.appendChild(b);
  }
  async function speak(r, bubble) {
    const segs = r.segments.map((s) => ({ text: s.text, lang: s.lang }));
    try {
      const finished = await player.playSegments(segs, (i) => { $$('.seg', bubble).forEach((x) => x.classList.toggle('speaking', Number(x.dataset.i) === i)); });
      if (finished && autoMic() && ['repeat', 'answer_ms', 'answer_zh'].includes(r.expect.type) && reply === r) mic?.start();
    } catch (e) { toast(e.message, 5000); }
  }
  function renderDock() {
    const e = reply?.expect || { type: 'none' };
    inputLang = e.type === 'answer_zh' ? 'zh-CN' : 'ms-MY';
    const target = e.type === 'repeat' || e.type === 'answer_ms' ? e.target_ms : '';
    dock.innerHTML = `
      <div class="task">${e.prompt_zh ? `<div class="muted">${esc(e.prompt_zh)}</div>` : ''}
        ${e.type === 'repeat' && target ? `<div class="target">${esc(target)} ${sayBtns(target)}</div>` : ''}</div>
      ${e.type === 'continue' || e.type === 'none' || reply?.page_complete ? `<div class="center"><button class="btn primary" id="go">${reply?.page_complete ? (idx < pages.length - 1 ? '进入下一页 →' : '本课学完了 🎉 去测试') : '继续 →'}</button></div>` : ''}
      <div id="mic" style="margin-top:10px"></div>
      <div class="seg-ctl">
        <span class="toggle" id="lang"><button data-l="ms-MY" class="${inputLang === 'ms-MY' ? 'on' : ''}">我说马来语</button><button data-l="zh-CN" class="${inputLang === 'zh-CN' ? 'on' : ''}">我说中文</button></span>
        <button class="btn sm" id="replay">🔁 重听</button><button class="btn sm" id="again">没听懂</button>
        ${e.type !== 'continue' ? '<button class="btn sm" id="skip">跳过 →</button>' : ''}
        <button class="btn sm ghost" id="restart" title="清空本页对话，从头讲">从头讲</button>
      </div>
      <form class="typed" id="typed"><input name="t" placeholder="也可以打字回答…" autocomplete="off"><button class="btn sm">发送</button></form>`;
    mic = mountMic($('#mic'), {
      getLang: () => inputLang,
      getRef: () => (reply?.expect?.type === 'repeat' ? reply.expect.target_ms : ''),
      label: e.type === 'repeat' ? '点击麦克风，跟着读' : e.type === 'answer_zh' ? '点击麦克风，用中文回答' : '点击麦克风，用马来语回答',
      onResult: async (res) => {
        const a = res.assessment;
        addMe(res.text, a ? `<div class="small muted">发音得分 ${Math.round(a.pronScore)}</div><div class="words">${a.words.map((w) => `<span class="${w.errorType !== 'None' ? 'bad' : scoreCls(w.accuracy)}">${esc(w.word)}</span>`).join('')}</div>` : res.assessmentNote ? `<div class="small muted">${esc(res.assessmentNote)}</div>` : '');
        await send({ action: 'input', text: res.text, assessment: a, inputLang, target: reply?.expect?.target_ms || '' });
      },
    });
    $$('#lang button').forEach((b) => (b.onclick = () => { inputLang = b.dataset.l; $$('#lang button').forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#replay').onclick = () => { player.unlock(); const last = $$('.bubble:not(.me)', chat).pop(); if (reply && last) speak(reply, last); };
    $('#again').onclick = () => { player.unlock(); send({ action: 'repeat' }); };
    $('#restart').onclick = () => { if (confirm('清空本页的对话记录，从头开始讲？')) { chat.innerHTML = ''; player.unlock(); send({ action: 'start', restart: true }); } };
    if ($('#skip')) $('#skip').onclick = () => { player.unlock(); addMe('（跳过）'); send({ action: 'next' }); };
    if ($('#go')) $('#go').onclick = () => {
      player.unlock();
      if (reply?.page_complete) { if (idx < pages.length - 1) location.hash = `#/c/${c.id}/learn/${pages[idx + 1]}`; else location.hash = `#/c/${c.id}/speak`; }
      else send({ action: 'next' });
    };
    $('#typed').onsubmit = (ev) => { ev.preventDefault(); const t = ev.target.t.value.trim(); if (!t) return; player.unlock(); addMe(t); ev.target.t.value = ''; send({ action: 'input', text: t, typed: true, target: reply?.expect?.target_ms || '' }); };
  }
  async function send(body) {
    state.busy = true;
    const thinking = document.createElement('div');
    thinking.className = 'bubble muted'; thinking.innerHTML = '<span class="spinner"></span> 老师在想…';
    chat.appendChild(thinking); scrollEnd();
    $$('#dock button').forEach((b) => (b.disabled = true));
    try {
      const r = await api(`/api/courses/${c.id}/tutor`, { method: 'POST', body: { page, ...body } });
      thinking.remove();
      if (r.resumed && r.history) {
        // 恢复本页已保存的对话
        for (const h of r.history) { if (h.role === 'user') { if (h.text) addMe(h.text); } else addTeacher(h.reply); }
      }
      reply = r.reply;
      if (r.resumed) { addTeacher(reply); renderDock(); scrollEnd(); if (body.forceSpeak) speak(reply, $$('.bubble:not(.me)', chat).pop()); return; }
      const b = addTeacher(reply);
      renderDock(); scrollEnd();
      if (!r.resumed || body.forceSpeak) speak(reply, b);
    } catch (e) {
      thinking.remove(); toast(e.message, 6000);
      $$('#dock button').forEach((b) => (b.disabled = false));
      if (!reply) dock.innerHTML = `<div class="banner bad">${esc(e.message)}</div><div class="center"><button class="btn primary" id="retry">重试</button></div>`, ($('#retry').onclick = () => send(body));
    } finally { state.busy = false; }
  }
  dock.innerHTML = `<div class="card center stack"><div>准备好了吗？老师会先用中文讲解，再用马来语示范，然后请你跟读和回答。</div><button class="btn primary" id="begin">🎧 ${prog.pages[page] ? '继续上课' : '开始上课'}</button><div class="muted small">请打开声音；首次使用会请求麦克风权限。</div></div>`;
  $('#begin').onclick = () => { player.unlock(); send({ action: 'start', forceSpeak: true }); };
}

// ---------------- 发音练习 ----------------
function practiceItems(slide) {
  const L = slide.lesson; if (!L) return [];
  const seen = new Set(), out = [];
  const add = (ms, zh) => { const k = ms.trim().toLowerCase(); if (ms && !seen.has(k)) { seen.add(k); out.push({ ms: ms.trim(), zh }); } };
  L.practice_phrases.forEach((p) => add(p.ms, p.zh));
  L.vocabulary.filter((v) => v.source === 'slide').forEach((v) => add(v.ms, v.zh));
  return out;
}
async function viewPractice(view, c, pageArg) {
  const withItems = c.slides.filter((s) => practiceItems(s).length);
  if (!withItems.length) { view.innerHTML = '<div class="card muted center">讲义生成后，这里会出现课件中的单词和句子供你跟读。</div>'; return; }
  const prog = await api(`/api/courses/${c.id}/progress`);
  const stat = Object.fromEntries(prog.items.map((i) => [i.ms.toLowerCase(), i]));
  const slide = withItems.find((s) => s.page === pageArg) || withItems.find((s) => s.page === prog.currentPage) || withItems[0];
  view.innerHTML = `<div class="row between"><label class="grow" style="max-width:320px">选择页面<select id="pg">${withItems.map((s) => `<option value="${s.page}" ${s.page === slide.page ? 'selected' : ''}>第 ${s.page} 页 · ${esc(s.lesson.title_zh)}</option>`).join('')}</select></label></div>
    <p class="muted small">先听标准发音（可慢速），再点 🎤 跟读。评分来自 Azure 马来语（ms-MY）发音评测。</p>
    <div class="card" id="items">${practiceItems(slide).map((it, i) => {
      const st = stat[it.ms.toLowerCase()];
      const last = st?.scores?.slice(-1)[0];
      return `<div class="list-item" data-i="${i}"><div class="grow"><div class="ms" style="font-size:1.1rem">${esc(it.ms)}</div><div class="muted small">${esc(it.zh)}</div><div class="res"></div></div>
        ${last != null ? `<span class="pill ${last >= 80 ? 'good' : last >= 60 ? 'warn' : 'bad'}">上次 ${last}</span>` : ''}${sayBtns(it.ms)}<button class="btn sm rec-btn" aria-label="跟读">🎤</button></div>`;
    }).join('')}</div>`;
  $('#pg').onchange = (e) => (location.hash = `#/c/${c.id}/practice/${e.target.value}`);
  const items = practiceItems(slide);
  $$('.list-item', view).forEach((row) => {
    const it = items[Number(row.dataset.i)], btn = $('.rec-btn', row), res = $('.res', row);
    btn.onclick = async () => {
      if (recorder.active) return recorder.stop();
      player.stop(); player.unlock();
      try {
        btn.textContent = '⏹'; btn.classList.add('primary'); res.innerHTML = '<span class="small muted">正在听…</span>';
        const rec = await recorder.start();
        btn.textContent = '🎤'; btn.classList.remove('primary');
        if (!rec.spoke) { res.innerHTML = '<span class="small muted">没有听到声音</span>'; return; }
        res.innerHTML = '<span class="spinner"></span>';
        const r = await transcribe(rec.blob, { lang: 'ms-MY', ref: it.ms });
        if (!r.ok) { res.innerHTML = `<span class="small muted">${esc(r.message)}</span>`; return; }
        const a = r.assessment, tm = r.textMatch;
        const saved = await api(`/api/courses/${c.id}/practice`, { method: 'POST', body: { ms: it.ms, zh: it.zh, page: slide.page, transcript: r.text, assessment: a, textMatch: tm } });
        const s = Math.round(saved.score);
        res.innerHTML = `<div class="row" style="margin-top:6px"><span class="score ${scoreCls(s)}" style="font-size:1.3rem">${s}</span><span class="small muted">识别为：「${esc(r.text)}」</span></div>
          ${a ? `<div class="small muted">准确度 ${Math.round(a.accuracy)} · 流利度 ${Math.round(a.fluency)} · 完整度 ${Math.round(a.completeness)}</div><div class="words">${a.words.map((w) => `<span class="${w.errorType !== 'None' ? 'bad' : scoreCls(w.accuracy)}" title="${esc(w.errorType)} ${Math.round(w.accuracy ?? 0)}">${esc(w.word)}</span>`).join('')}</div>`
            : `<div class="small muted">${esc(r.assessmentNote || '')}（按识别文本逐词比对）</div><div class="words">${tm.words.map((w) => `<span class="${w.ok ? 'good' : 'bad'}">${esc(w.word)}</span>`).join('')}</div>`}
          ${s < 80 ? `<div class="small">红色/黄色的词需要再练习：先点 🐢 慢速听，再跟读一次。</div>` : '<div class="small" style="color:var(--good)">很好！</div>'}`;
      } catch (e) { btn.textContent = '🎤'; btn.classList.remove('primary'); res.innerHTML = ''; toast(e.message, 5000); }
    };
  });
}

// ---------------- 测试（口语 / 听力 / 复习共用） ----------------
function pageChooser(c, prog) {
  const learned = c.slides.filter((s) => prog.pages[s.page]?.status === 'done').map((s) => s.page);
  return `<label>测试范围<select id="scope"><option value="all">整门课（全部页面）</option>${learned.length ? `<option value="learned">已学完的页面（${learned.length} 页）</option>` : ''}${c.slides.filter((s) => s.lesson?.is_lesson_content).map((s) => `<option value="${s.page}">第 ${s.page} 页 · ${esc(s.lesson.title_zh)}</option>`).join('')}</select></label>`;
}
function scopePages(c, prog, v) {
  if (v === 'all') return [];
  if (v === 'learned') return c.slides.filter((s) => prog.pages[s.page]?.status === 'done').map((s) => s.page);
  return [Number(v)];
}

function runQuiz(view, c, { kind, questions, mode, title }) {
  let i = 0, attempt = 1, showSub = false;
  const results = [];
  const isListen = kind === 'listening';
  const ask = (q) => isListen ? player.say(q.audio_ms, 'ms').catch((e) => toast(e.message)) : player.say(q.prompt_zh, 'zh').catch((e) => toast(e.message));
  function show() {
    const q = questions[i];
    if (!q) return finish();
    let lang = isListen && q.answer_language === 'zh' ? 'zh-CN' : 'ms-MY';
    view.innerHTML = `<div class="row between"><b>${esc(title)} · 第 ${i + 1} / ${questions.length} 题</b><span class="muted small">第 ${q.page} 页 ${srcTag(q.source)}</span></div>
      <div class="progress" style="margin:8px 0 14px"><i style="width:${(i / questions.length) * 100}%"></i></div>
      <div class="card center stack">
        ${isListen ? `<div class="muted">听老师用马来语说，然后用${lang === 'zh-CN' ? '中文说出意思' : '马来语回答'}</div>
          <div class="row" style="justify-content:center"><button class="btn primary" id="hear">🔊 再听一遍</button><button class="btn" id="hear-slow">🐢 慢速</button></div>
          <div id="sub" class="${showSub ? '' : 'hidden-sub'}" title="点击显示字幕"><div class="ms" style="font-size:1.2rem">${esc(q.audio_ms)}</div><div class="muted small">${esc(q.translation_zh)}</div></div>
          <button class="btn sm ghost" id="subt">${showSub ? '隐藏字幕' : '显示字幕（默认隐藏）'}</button>`
        : `<div class="muted">请用马来语回答</div><div style="font-size:1.25rem;font-weight:600">${esc(q.prompt_zh)}</div><div><button class="btn sm" id="hear">🔊 再听题目</button></div>`}
      </div>
      <div id="fb" style="margin-top:12px"></div>
      <div class="dock"><div id="mic"></div>
        <div class="seg-ctl"><span class="toggle" id="lang"><button data-l="ms-MY" class="${lang === 'ms-MY' ? 'on' : ''}">我说马来语</button><button data-l="zh-CN" class="${lang === 'zh-CN' ? 'on' : ''}">我说中文</button></span>
        <button class="btn sm" id="skipq">跳过此题</button></div>
        <form class="typed" id="typed"><input name="t" placeholder="也可以打字回答…" autocomplete="off"><button class="btn sm">提交</button></form></div>`;
    $('#hear').onclick = () => { player.unlock(); ask(q); };
    if ($('#hear-slow')) $('#hear-slow').onclick = () => { player.unlock(); player.say(q.audio_ms, 'ms', 'slow').catch((e) => toast(e.message)); };
    if ($('#subt')) { const tog = () => { showSub = !showSub; $('#sub').classList.toggle('hidden-sub', !showSub); $('#subt').textContent = showSub ? '隐藏字幕' : '显示字幕（默认隐藏）'; }; $('#subt').onclick = tog; $('#sub').onclick = () => !showSub && tog(); }
    $$('#lang button').forEach((b) => (b.onclick = () => { lang = b.dataset.l; $$('#lang button').forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#skipq').onclick = () => { results.push({ q, skipped: true }); i++; attempt = 1; showSub = false; show(); };
    const mic = mountMic($('#mic'), { getLang: () => lang, label: '点击麦克风回答', onResult: (r) => grade(q, r.text) });
    $('#typed').onsubmit = (e) => { e.preventDefault(); const t = e.target.t.value.trim(); if (t) grade(q, t); };
    if (attempt === 1) ask(q).then(() => { if (autoMic() && questions[i] === q && !$('#fb').innerHTML) mic.start(); });
  }
  async function grade(q, transcript) {
    const fb = $('#fb');
    fb.innerHTML = `<div class="card"><div class="small muted">你的回答：「${esc(transcript)}」</div><div style="margin-top:6px"><span class="spinner"></span> 老师批改中…</div></div>`;
    state.busy = true;
    try {
      const g = await api(`/api/courses/${c.id}/grade`, { method: 'POST', body: { kind, question: q, transcript, attempt, mode } });
      const ok = isListen ? g.understood && g.correct : g.correct;
      fb.innerHTML = `<div class="card stack"><div class="row"><span class="score ${scoreCls(g.score)}">${g.score}</span><span class="pill ${ok ? 'good' : 'bad'}">${ok ? (isListen ? '听懂了 ✓' : '正确 ✓') : isListen && g.understood ? '听懂了，但表达有误' : '再试试'}</span></div>
        <div class="small muted">你的回答：「${esc(transcript)}」${g.possible_asr_error ? '（可能存在语音识别误差）' : ''}</div>
        <div>${esc(g.feedback_zh)}</div>
        ${g.errors.map((e) => `<div class="err small"><b>${esc(e.wrong || '（遗漏）')}</b> → <span class="ms">${esc(e.right)}</span><br>${esc(e.explanation_zh)}</div>`).join('')}
        ${g.corrected_ms ? `<div class="ok-box"><div class="label">参考说法</div><span class="ms">${esc(g.corrected_ms)}</span> ${sayBtns(g.corrected_ms)}</div>` : ''}
        ${!ok && g.retry_hint_zh ? `<div class="small">💡 ${esc(g.retry_hint_zh)}</div>` : ''}
        <div class="row end">${!ok ? '<button class="btn" id="retry">🎤 再试一次</button>' : ''}<button class="btn primary" id="next">${i < questions.length - 1 ? '下一题 →' : '查看结果'}</button></div></div>`;
      if (isListen) { showSub = true; $('#sub')?.classList.remove('hidden-sub'); }
      const segs = [{ text: g.feedback_zh, lang: 'zh' }];
      if (g.corrected_ms && !ok) segs.push({ text: g.corrected_ms, lang: 'ms' });
      if (!ok && g.retry_hint_zh) segs.push({ text: g.retry_hint_zh, lang: 'zh' });
      player.playSegments(segs).catch((e) => toast(e.message));
      const rec = { q, transcript, g, ok, attempt };
      $('#next').onclick = () => { player.stop(); results.push(rec); i++; attempt = 1; showSub = false; show(); };
      if ($('#retry')) $('#retry').onclick = () => { player.stop(); attempt++; fb.innerHTML = ''; $('.mic')?.click(); };
    } catch (e) { fb.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; } finally { state.busy = false; }
  }
  function finish() {
    const done = results.filter((r) => !r.skipped), right = done.filter((r) => r.ok && r.attempt === 1).length;
    const avg = done.length ? Math.round(done.reduce((n, r) => n + r.g.score, 0) / done.length) : 0;
    view.innerHTML = `<div class="card stack center"><h2>${esc(title)}完成</h2><div class="grid2"><div class="stat"><b>${right}/${questions.length}</b>一次答对</div><div class="stat"><b>${avg}</b>平均分</div><div class="stat"><b>${results.filter((r) => r.skipped).length}</b>跳过</div></div>
      <p class="muted">答错的内容已记入错题本，会在“复习”中安排。</p><div class="row" style="justify-content:center"><a class="btn" href="#/c/${c.id}/review">去复习</a><button class="btn primary" id="again">再来一组</button></div></div>
      <div class="card">${results.map((r) => `<div class="list-item"><div class="grow"><div>${esc(isListen ? r.q.audio_ms : r.q.prompt_zh)}</div><div class="small muted">${r.skipped ? '跳过' : `你答：「${esc(r.transcript)}」 · 参考：<span class="ms">${esc(r.g.corrected_ms)}</span>`}</div></div>${r.skipped ? '' : `<span class="pill ${r.ok ? 'good' : 'bad'}">${r.g.score}</span>`}</div>`).join('')}</div>`;
    $('#again').onclick = () => route();
  }
  show();
}

async function quizSetup(view, c, kind) {
  const prog = await api(`/api/courses/${c.id}/progress`);
  const isListen = kind === 'listening';
  if (!c.slides.some((s) => s.lesson)) { view.innerHTML = '<div class="card muted center">讲义生成后才能开始测试。</div>'; return; }
  view.innerHTML = `<div class="card stack"><h2>${isListen ? '听力测试' : '口语测试'}</h2>
    <p class="muted">${isListen ? 'AI 老师用马来语提问（默认隐藏字幕），你用语音回答，老师判断你是否听懂。' : 'AI 老师用中文提问，你用马来语语音回答，老师检查表达和语法、指出错误并引导你重试。'}</p>
    ${pageChooser(c, prog)}
    <label>题目数量<select id="count"><option>5</option><option selected>6</option><option>8</option><option>10</option></select></label>
    <label class="check"><input type="checkbox" id="weak" ${prog.review.weak.length ? 'checked' : ''}> 优先考我的薄弱点${prog.review.weak.length ? `（${prog.review.weak.length} 个）` : ''}</label>
    <button class="btn primary" id="go">开始测试</button></div>`;
  $('#go').onclick = async () => {
    player.unlock();
    const btn = $('#go'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> AI 正在根据课件出题…';
    try {
      const { questions } = await api(`/api/courses/${c.id}/quiz`, { method: 'POST', body: { kind, pages: scopePages(c, prog, $('#scope').value), count: Number($('#count').value), focusWeak: $('#weak').checked } });
      if (!questions.length) throw new Error('没有生成题目，请换个范围再试');
      runQuiz(view, c, { kind, questions, mode: kind, title: isListen ? '听力测试' : '口语测试' });
    } catch (e) { btn.disabled = false; btn.textContent = '开始测试'; toast(e.message, 6000); }
  };
}
const viewSpeak = (v, c) => quizSetup(v, c, 'speaking');
const viewListen = (v, c) => quizSetup(v, c, 'listening');

// ---------------- 复习 ----------------
async function viewReview(view, c) {
  const prog = await api(`/api/courses/${c.id}/progress`);
  const { due, weak, total } = prog.review;
  const fmt = (t) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const done = Object.values(prog.pages).filter((p) => p.status === 'done').length;
  const recent = prog.history.filter((h) => !h.correct).slice(-15).reverse();
  view.innerHTML = `<div class="grid2"><div class="stat"><b>${done}/${c.slides.length}</b>已学页面</div><div class="stat"><b>${total}</b>练过的知识点</div><div class="stat"><b>${due.length}</b>今天待复习</div><div class="stat"><b>${weak.length}</b>薄弱点</div></div>
    <div class="card stack" style="margin-top:12px"><h3>智能复习</h3><p class="muted small">根据你的错题和遗忘曲线（间隔重复）安排：答错的 10 分钟后再考，答对后间隔逐步拉长到 1、3、7、16 天。</p>
    ${due.length ? `<button class="btn primary" id="start">开始复习（${Math.min(10, due.length)} 题）</button>` : `<div class="muted">${total ? `暂时没有到期的复习${isFinite(prog.review.nextDue) ? `，下次复习时间：${fmt(prog.review.nextDue)}` : ''}。` : '先去上课或做测试，系统会自动记录你的薄弱点。'}</div>${weak.length ? '<button class="btn" id="start-weak">现在就练薄弱点</button>' : ''}`}</div>
    ${weak.length ? `<div class="card"><h3>薄弱知识点</h3>${weak.map((w) => `<div class="list-item"><div class="grow"><span class="ms">${esc(w.ms)}</span> ${sayBtns(w.ms)}<div class="small muted">${esc(w.zh)}${w.page ? ` · 第 ${w.page} 页` : ''}</div>${w.lastError ? `<div class="small" style="color:var(--bad)">${esc(w.lastError)}</div>` : ''}</div><span class="pill bad">错 ${w.wrong}</span></div>`).join('')}</div>` : ''}
    ${recent.length ? `<div class="card"><h3>最近的错误</h3>${recent.map((h) => `<div class="list-item"><div class="grow small"><span class="ms">${esc(h.ms)}</span> <span class="muted">${esc(h.zh || '')}</span>${h.transcript ? `<div class="muted">你说：「${esc(h.transcript)}」</div>` : ''}${h.error ? `<div>${esc(h.error)}</div>` : ''}</div><span class="muted small">${fmt(h.at)}</span></div>`).join('')}</div>` : ''}`;
  const start = (items) => {
    player.unlock();
    const qs = items.slice(0, 10).filter((w) => w.zh).map((w) => ({ page: w.page ?? 0, prompt_zh: `用马来语怎么说：「${w.zh}」`, expected_ms: w.ms, acceptable_ms: [], focus_zh: w.lastError || '复习', source: 'slide', item_ms: w.ms, item_zh: w.zh }));
    if (!qs.length) return toast('这些知识点缺少中文释义，无法出复习题');
    runQuiz(view, c, { kind: 'speaking', questions: qs, mode: 'review', title: '复习' });
  };
  if ($('#start')) $('#start').onclick = () => start(due);
  if ($('#start-weak')) $('#start-weak').onclick = () => start(weak);
}

// ---------------- 启动 ----------------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
