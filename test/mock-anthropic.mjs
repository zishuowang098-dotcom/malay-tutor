// 仅用于本地自动化测试：模拟 Anthropic Messages API，校验请求格式并按 schema 返回结构化结果。
// 应用本身不会使用此文件；真实运行必须配置 ANTHROPIC_API_KEY。
import http from 'node:http';

const log = [];
function respond(body) {
  const schema = body.output_config?.format?.schema;
  const keys = Object.keys(schema?.properties || {});
  const userText = JSON.stringify(body.messages.at(-1).content);
  if (keys.includes('required_points')) {
    if (!userText.includes('Nama*')) throw new Error('quiz text missing');
    return { title: 'KUIZ 1.1 – Pengenalan Diri / Keluarga / Kawan', format: 'oral_presentation', summary_zh: '口头自我介绍测验', task_zh: '抽到一个话题后，用 5 个简单马来语句子介绍', sentence_count: 5, total_marks: '10M, 10%',
      instructions_zh: ['个人测验'], rules_zh: ['考试时不能看笔记'],
      topics: [{ id: 'myself', name_ms: 'Diri Saya', name_zh: '我自己', note_zh: '' }, { id: 'family', name_ms: 'Keluarga Saya', name_zh: '我的家人（选一位）', note_zh: '' }, { id: 'friend', name_ms: 'Kawan Saya', name_zh: '我的朋友', note_zh: '' }],
      required_points: [{ name_ms: 'Nama', name_zh: '姓名', compulsory: true }, { name_ms: 'Asal', name_zh: '籍贯', compulsory: false }, { name_ms: 'Umur', name_zh: '年龄', compulsory: false }],
      criteria: [{ name_ms: 'Sebutan', name_zh: '发音', weak_zh: '错误多', good_zh: '少量错误', excellent_zh: '基本正确' }, { name_ms: 'Tatabahasa', name_zh: '语法', weak_zh: '错误多', good_zh: '少量', excellent_zh: '无错误' }],
      related_pages: [3] };
  }
  if (keys.includes('model_answer')) {
    return { intro_zh: '把范文中的信息换成你自己的。', points: [{ point_zh: '姓名', pattern_ms: 'Nama saya ___.', explanation_zh: '介绍名字', examples: [{ ms: 'Nama saya Ali.', zh: '我的名字是阿里。' }], source: 'slide', pages: [3] }],
      vocabulary: [{ ms: 'umur', zh: '年龄', source: 'quiz' }], model_answer: [{ ms: 'Nama saya Ali.', zh: '我叫阿里。', point_zh: '姓名' }, { ms: 'Saya berasal dari China.', zh: '我来自中国。', point_zh: '籍贯' }],
      criteria_tips: [{ criterion_zh: '发音', tip_zh: 'berasal 的 r 要弹舌' }], common_mistakes: [{ wrong_ms: 'Saya nama Ali', right_ms: 'Nama saya Ali', explanation_zh: '词序' }] };
  }
  if (keys.includes('sentences')) {
    return { possible_asr_error: false, sentences: [{ heard: 'nama saya ali', corrected_ms: 'Nama saya Ali.', ok: true, point_zh: '姓名', issue_zh: '' }, { heard: 'saya umur dua puluh', corrected_ms: 'Umur saya dua puluh tahun.', ok: false, point_zh: '年龄', issue_zh: '词序错误，并缺少 tahun' }],
      points: [{ name_zh: '姓名', covered: true }, { name_zh: '籍贯', covered: false }], criteria: [{ name_zh: '发音', level: 'not_assessed', comment_zh: '打字回答，无法评估' }, { name_zh: '语法', level: 'good', comment_zh: '一处词序错误' }],
      score: 6, max_score: 10, overall_zh: '名字介绍得很好，但只说了两句，还缺籍贯。', next_steps_zh: ['补足 5 句'] };
  }
  if (keys.includes('pages')) {
    const pages = [...userText.matchAll(/===== 第 (\d+) 页 =====/g)].map((m) => Number(m[1]));
    return { pages: pages.map((p) => ({
      page: p, title_zh: `第${p}页：问候语`, is_lesson_content: p !== 1, summary_zh: '本页学习马来语问候。',
      vocabulary: [{ ms: 'Selamat pagi', zh: '早上好', part_of_speech: '短语', pronunciation_tip_zh: '重音在倒数第二个音节', example_ms: 'Selamat pagi, cikgu.', example_zh: '老师早上好。', source: 'slide' },
        { ms: 'cikgu', zh: '老师', part_of_speech: '名词', pronunciation_tip_zh: 'c 读作“ch”', example_ms: '', example_zh: '', source: 'supplement' }],
      sentence_patterns: [{ pattern_ms: 'Apa khabar?', meaning_zh: '你好吗？', explanation_zh: '日常问候', examples: [{ ms: 'Apa khabar, Ali?', zh: '阿里，你好吗？' }], source: 'slide' }],
      grammar: [], memory_tips: [{ tip_zh: 'pagi 和“怕急”谐音', source: 'supplement' }],
      practice_phrases: [{ ms: 'Selamat pagi', zh: '早上好' }, { ms: 'Apa khabar?', zh: '你好吗？' }],
    })) };
  }
  if (keys.includes('segments')) {
    const isAnswer = userText.includes('语音回答') || userText.includes('打字回答');
    return {
      segments: isAnswer
        ? [{ lang: 'zh', text: '很好！你读得很清楚。', source: 'none' }, { lang: 'zh', text: '下面我们学下一句。', source: 'none' }]
        : [{ lang: 'zh', text: '我们先学“早上好”，马来语这样说：', source: 'slide' }, { lang: 'ms', text: 'Selamat pagi', source: 'slide' }, { lang: 'zh', text: '请跟我读一遍。', source: 'none' }],
      step: isAnswer ? 'feedback' : 'read_along',
      expect: { type: 'repeat', target_ms: 'Selamat pagi', prompt_zh: '请跟读' },
      evaluation: isAnswer ? { has_evaluation: true, item_ms: 'Selamat pagi', item_zh: '早上好', correct: false, error_zh: 'pagi 的 g 不清楚' } : { has_evaluation: false, item_ms: '', item_zh: '', correct: false, error_zh: '' },
      page_complete: false,
    };
  }
  if (keys.includes('questions')) {
    const listen = JSON.stringify(schema).includes('audio_ms');
    return { questions: listen
      ? [{ page: 2, audio_ms: 'Apa khabar?', translation_zh: '你好吗？', answer_language: 'ms', reference_answer_ms: 'Khabar baik.', expected_answer_zh: '回答自己很好', source: 'slide' }]
      : [{ page: 2, prompt_zh: '用马来语怎么说：早上好', expected_ms: 'Selamat pagi', acceptable_ms: [], focus_zh: '问候', source: 'slide' }] };
  }
  if (keys.includes('corrected_ms')) {
    return { correct: false, score: 55, understood: true, possible_asr_error: false, errors: [{ type: 'vocabulary', wrong: 'selamat malam', right: 'selamat pagi', explanation_zh: 'malam 是晚上' }], corrected_ms: 'Selamat pagi', feedback_zh: '意思接近，但时间说错了。', retry_hint_zh: '想想早上怎么说？' };
  }
  throw new Error('unknown schema');
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const ch of req) raw += ch;
  const body = JSON.parse(raw || '{}');
  log.push({ url: req.url, beta: req.headers['anthropic-beta'], key: req.headers['x-api-key'], model: body.model, fallbacks: body.fallbacks, effort: body.output_config?.effort, stream: body.stream, hasSchema: Boolean(body.output_config?.format?.schema) });
  if (req.url === '/__log') { res.end(JSON.stringify(log)); return; }
  let out;
  try { out = JSON.stringify(respond(body)); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: e.message } })); return; }
  const msg = { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: out }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { ...msg, content: [], stop_reason: null } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < out.length; i += 200) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: out.slice(i, i + 200) } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    ev('message_stop', {});
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  }
});
server.listen(Number(process.env.MOCK_PORT || 4010), () => console.log('mock anthropic on', server.address().port));
