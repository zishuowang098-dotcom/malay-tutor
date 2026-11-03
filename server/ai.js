// Claude：讲义生成、引导教学、出题与批改。所有输出都基于上传课件的原文。
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

let client = null;
function getClient() {
  if (!config.anthropicKey) throw Object.assign(new Error('未配置 AI 服务：请在 .env 中设置 ANTHROPIC_API_KEY'), { status: 503 });
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey, maxRetries: 3 });
  return client;
}

// --- JSON schema 小工具（structured outputs 要求每个对象 additionalProperties:false 且字段全部 required）
const S = { type: 'string' };
const I = { type: 'integer' };
const B = { type: 'boolean' };
const E = (...v) => ({ type: 'string', enum: v });
const A = (items) => ({ type: 'array', items });
const O = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const SRC = E('slide', 'supplement');

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

async function callJSON({ system, messages, schema, effort = 'low', maxTokens = 8000, stream = false }) {
  const params = {
    model: config.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  // 服务端拒答回退（仅部分模型支持）
  if (FALLBACK_MODELS.has(config.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const c = getClient();
  let msg;
  try {
    msg = stream ? await c.beta.messages.stream(params).finalMessage() : await c.beta.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('Anthropic API Key 无效'), { status: 502 });
    if (e instanceof Anthropic.RateLimitError) throw Object.assign(new Error('AI 服务请求过于频繁，请稍后再试'), { status: 429 });
    if (e instanceof Anthropic.APIError) throw Object.assign(new Error(`AI 服务出错: ${e.message}`), { status: 502 });
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('AI 拒绝了此次请求'), { status: 502 });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('AI 输出被截断，请重试'), { status: 502 });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('AI 返回格式异常，请重试'), { status: 502 }); }
}

// ---------------- 讲义生成 ----------------
const EXAMPLE = O({ ms: S, zh: S });
const NOTES_SCHEMA = O({
  pages: A(O({
    page: I,
    title_zh: S,
    is_lesson_content: B,
    summary_zh: S,
    vocabulary: A(O({ ms: S, zh: S, part_of_speech: S, pronunciation_tip_zh: S, example_ms: S, example_zh: S, source: SRC })),
    sentence_patterns: A(O({ pattern_ms: S, meaning_zh: S, explanation_zh: S, examples: A(EXAMPLE), source: SRC })),
    grammar: A(O({ title_zh: S, explanation_zh: S, examples: A(EXAMPLE), source: SRC })),
    memory_tips: A(O({ tip_zh: S, source: SRC })),
    practice_phrases: A(O({ ms: S, zh: S })),
  })),
});

const NOTES_SYSTEM = `你是一位经验丰富的马来西亚马来语（Bahasa Melayu, ms-MY 标准马来语）老师，学生的母语是中文。
你的任务：把老师上传的课件逐页整理成详细的中文讲义。

严格规则：
1. 必须忠于课件：每一页只整理该页（及其演讲者备注）实际出现的内容。页码必须与给出的原始页码完全一致，每个给出的页码都要输出一项。
2. 来源标注：凡是课件原文中出现的单词/句型/语法，source="slide"；你为了帮助理解而补充的（课件中没有的例句、相关词、语法延伸、记忆技巧），source="supplement"。不要把补充内容伪装成课件内容。
3. vocabulary：列出该页出现的所有马来语单词/短语（不遗漏），给出中文释义、词性、给中国学生的发音提示（例如重音、元音 e 的两种读法、r 卷舌、ng/ny 等，用中文描述，可用拼音近似但要说明只是近似）、例句。若课件本身有例句则用课件例句并标 slide。
4. sentence_patterns、grammar：课件出现的句型和语法点都要讲清楚，并用中文解释用法。
5. memory_tips：给出实用的记忆技巧（通常是 supplement）。
6. practice_phrases：从该页课件原文中挑选适合跟读的马来语单词与句子（只能来自课件原文）。
7. 如果某页是封面、目录、纯图片无语言内容等，is_lesson_content=false，其他数组可以为空，summary_zh 简述该页内容。
8. 使用马来西亚标准马来语的拼写与用法；如课件中有明显拼写错误，可在 grammar 中以 supplement 形式指出，但不要改动原文。`;

export async function generateNotes({ course, pages, pdfBase64 }) {
  const content = [];
  if (pdfBase64) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }, cache_control: { type: 'ephemeral' } });
  }
  let imgCount = 0;
  const parts = [];
  for (const s of pages) {
    parts.push(`===== 第 ${s.page} 页 =====\n[页面文字]\n${s.text.join('\n') || '（无文字，可能是图片）'}${s.notes?.length ? `\n[演讲者备注]\n${s.notes.join('\n')}` : ''}`);
  }
  content.push({ type: 'text', text: `课程：《${course.title}》\n下面是课件的第 ${pages[0].page}–${pages[pages.length - 1].page} 页${pdfBase64 ? '（完整 PDF 已附上，可参考对应页的版面与图片）' : ''}。\n\n${parts.join('\n\n')}` });
  for (const s of pages) {
    for (const img of s.imagesB64 || []) {
      if (imgCount >= 12) break;
      content.push({ type: 'text', text: `（第 ${s.page} 页中的图片：）` });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      imgCount++;
    }
  }
  content.push({ type: 'text', text: `请为第 ${pages.map((p) => p.page).join('、')} 页生成讲义（每页一项，页码保持原样）。图片中的文字也属于课件原文。` });
  const out = await callJSON({ system: NOTES_SYSTEM, messages: [{ role: 'user', content }], schema: NOTES_SCHEMA, effort: 'medium', maxTokens: 32000, stream: true });
  return out.pages;
}

// ---------------- 引导教学 ----------------
const TUTOR_SCHEMA = O({
  segments: A(O({ lang: E('zh', 'ms'), text: S, source: E('slide', 'supplement', 'none') })),
  step: E('explain', 'demo', 'read_along', 'question', 'feedback', 'summary'),
  expect: O({ type: E('repeat', 'answer_ms', 'answer_zh', 'continue', 'none'), target_ms: S, prompt_zh: S }),
  evaluation: O({ has_evaluation: B, item_ms: S, item_zh: S, correct: B, error_zh: S }),
  page_complete: B,
});

function pageContext(course, page) {
  const s = course.slides.find((x) => x.page === page);
  const n = s?.lesson;
  return `【课件原文 · 第 ${page} 页（共 ${course.slides.length} 页）】\n${s?.text?.join('\n') || '（无文字）'}${s?.notes?.length ? `\n【演讲者备注】\n${s.notes.join('\n')}` : ''}\n\n【已生成的讲义（JSON，source=slide 为课件原文，supplement 为补充）】\n${n ? JSON.stringify(n) : '（无）'}`;
}

const TUTOR_SYSTEM = `你是学生的一对一马来语私人老师，像真人老师一样用中文讲解、用马来西亚标准马来语（ms-MY）示范，通过语音一步步教会学生。你的回复会被转换成语音播放：lang="zh" 的片段用中文语音读，lang="ms" 的片段用马来语语音读。

教学原则：
- 严格围绕当前页课件教学，按“讲解 → 示范发音 → 带读 → 提问 → 纠错”的节奏推进。
- 每次只讲一个小知识点（一个单词、一个短语或一个句型），说 1–4 个短片段，然后停下来让学生开口。绝不一次讲太多。
- 中文片段里不要夹带马来语单词——需要说马来语时单独开一个 lang="ms" 片段（例如：zh「“你好”用马来语说：」 ms「Selamat pagi」）。马来语片段只放纯马来语。
- 每个片段标注 source：讲解课件原文内容 = "slide"；你额外补充的例句/知识 = "supplement"（补充内容在中文里要明确说“补充一下/课件之外再补充”）；纯过渡语 = "none"。
- 需要学生跟读时 expect.type="repeat"，target_ms 填要读的马来语原文；需要学生用马来语回答时 "answer_ms"（target_ms 填参考答案）；需要学生用中文回答（如问意思）时 "answer_zh"；只需学生说“继续”时 "continue"。prompt_zh 是给学生看的简短提示。
- 学生的回答会以识别文字（以及 Azure 发音评分）告诉你。语音识别可能有误差：若识别文字与目标接近但略有出入，结合发音评分判断；分数低或单词标为 Mispronunciation/Omission 时要具体指出哪个音、怎么发，再请学生重试。答对就简短表扬并前进。
- 每次对学生的回答做出判断时 evaluation.has_evaluation=true，并填写 item_ms（考察的马来语单词/句子）、item_zh、correct、error_zh（错误说明，正确则为空字符串）。不评判时 has_evaluation=false，其余字段填空字符串/false。
- 同一个点学生连续错 3 次，就给出正确答案，放慢示范，然后继续，稍后再回顾。
- 本页所有知识点都教完并做过检查后，做一个简短总结，page_complete=true，expect.type="continue"，告诉学生可以进入下一页。
- 学生说“没听懂/再说一遍/慢一点”时，换一种更简单的说法重新讲。
- 语气亲切、简洁、口语化，像面对面上课。`;

export async function tutorTurn({ course, page, history, userText, weakItems }) {
  const sys = `${TUTOR_SYSTEM}\n\n课程：《${course.title}》\n${pageContext(course, page)}${weakItems?.length ? `\n\n【学生之前的薄弱点（可以在合适时机顺带复习）】\n${weakItems.map((w) => `${w.ms}（${w.zh}）错${w.wrong}次`).join('；')}` : ''}`;
  const messages = [...history, { role: 'user', content: userText }];
  return callJSON({ system: sys, messages, schema: TUTOR_SCHEMA, effort: 'low', maxTokens: 6000 });
}

// ---------------- 出题 ----------------
const SPEAK_Q = O({ questions: A(O({ page: I, prompt_zh: S, expected_ms: S, acceptable_ms: A(S), focus_zh: S, source: SRC })) });
const LISTEN_Q = O({ questions: A(O({ page: I, audio_ms: S, translation_zh: S, answer_language: E('ms', 'zh'), reference_answer_ms: S, expected_answer_zh: S, source: SRC })) });

function coursePagesText(course, pages) {
  return course.slides.filter((s) => pages.includes(s.page)).map((s) => `===== 第 ${s.page} 页 =====\n${s.text.join('\n')}${s.lesson ? `\n[讲义要点] 单词：${s.lesson.vocabulary.map((v) => `${v.ms}=${v.zh}`).join('；')}；句型：${s.lesson.sentence_patterns.map((p) => p.pattern_ms).join('；')}` : ''}`).join('\n\n');
}

export async function generateQuiz({ course, pages, kind, count = 6, weakItems = [] }) {
  const isListen = kind === 'listening';
  const system = `你是马来西亚标准马来语老师，正在为中文母语学生出${isListen ? '听力' : '口语'}测试题。题目必须基于下面给出的课件内容（考察课件中的单词、句型、语法）。如题目超出课件原文（例如把课件单词组合成新句子），source 标 "supplement"，否则 "slide"。page 填该题考察内容所在的原始页码。`;
  const instr = isListen
    ? `出 ${count} 道听力题：audio_ms 是老师用马来语说的一个问题或一句话（用课件里学过的词汇，难度适中，像真实对话，例如问候、问名字、问数量等）；学生听后用语音回答。answer_language：若是可以用马来语直接回答的问题则 "ms"，若是让学生说出意思则 "zh"（大部分用 "ms"）。reference_answer_ms 给出一个合格的马来语回答示例（answer_language=zh 时也给）；expected_answer_zh 用中文描述怎样的回答算听懂了；translation_zh 是 audio_ms 的中文翻译。`
    : `出 ${count} 道口语题：prompt_zh 是老师用中文提的问题（例如“用马来语怎么说：早上好，老师”或“用马来语介绍你的名字”），学生用马来语口头回答。expected_ms 是标准答案，acceptable_ms 列出其他也可接受的说法，focus_zh 说明考察点。`;
  const weak = weakItems.length ? `\n优先覆盖这些学生的薄弱点：${weakItems.map((w) => w.ms).join('；')}` : '';
  const out = await callJSON({
    system,
    messages: [{ role: 'user', content: `课程：《${course.title}》\n${coursePagesText(course, pages)}\n\n${instr}${weak}` }],
    schema: isListen ? LISTEN_Q : SPEAK_Q,
    effort: 'low',
    maxTokens: 8000,
  });
  return out.questions;
}

// ---------------- 批改 ----------------
const GRADE_SCHEMA = O({
  correct: B,
  score: I,
  understood: B,
  possible_asr_error: B,
  errors: A(O({ type: E('vocabulary', 'grammar', 'word_order', 'pronunciation', 'missing', 'meaning', 'other'), wrong: S, right: S, explanation_zh: S })),
  corrected_ms: S,
  feedback_zh: S,
  retry_hint_zh: S,
});

export async function gradeAnswer({ course, kind, question, transcript, assessment, attempt = 1 }) {
  const isListen = kind === 'listening';
  const system = `你是耐心、严格的马来西亚标准马来语老师，正在批改中文母语学生的${isListen ? '听力' : '口语'}测试语音回答。学生回答经过语音识别转成文字，识别可能有小误差（例如同音词、漏掉轻读词）；如果你判断错误很可能是识别造成的，possible_asr_error=true 并在反馈中说明。
批改要求：
- correct：意思和表达基本正确即为 true（拼写/大小写/标点不扣分；可接受的同义说法算对）。
- score 0–100。understood：${isListen ? '学生是否听懂了问题（即使马来语表达有小错，只要回答切题就算听懂）' : '学生是否理解了题意'}。
- errors：逐条指出错误（词汇、语法、词序、遗漏、发音等），给出正确说法与中文解释。正确时为空数组。
- corrected_ms：标准/改正后的马来语回答。
- feedback_zh：用中文给出简短、口语化的点评（会被读出来），先肯定做对的部分，再指出问题。
- retry_hint_zh：若不正确，给一个引导学生再试一次的提示（不要直接说出完整答案${attempt >= 3 ? '；学生已经尝试多次，这次可以直接给出答案并鼓励' : ''}）；正确时为空字符串。`;
  const q = isListen
    ? `听力题（老师用马来语说）：${question.audio_ms}\n中文意思：${question.translation_zh}\n要求用${question.answer_language === 'zh' ? '中文' : '马来语'}回答。\n合格回答示例：${question.reference_answer_ms}\n听懂的标准：${question.expected_answer_zh}`
    : `口语题（老师用中文问）：${question.prompt_zh}\n标准答案：${question.expected_ms}\n也可接受：${(question.acceptable_ms || []).join('；') || '无'}\n考察点：${question.focus_zh || ''}`;
  const pa = assessment ? `\nAzure 发音评分：总分 ${assessment.pronScore}，准确度 ${assessment.accuracy}，流利度 ${assessment.fluency}，完整度 ${assessment.completeness}；单词：${assessment.words.map((w) => `${w.word}(${w.accuracy}${w.errorType !== 'None' ? ',' + w.errorType : ''})`).join(' ')}` : '';
  return callJSON({
    system,
    messages: [{ role: 'user', content: `课程：《${course.title}》（第 ${question.page} 页）\n${q}\n\n学生第 ${attempt} 次回答（语音识别结果）：「${transcript}」${pa}` }],
    schema: GRADE_SCHEMA,
    effort: 'low',
    maxTokens: 4000,
  });
}
