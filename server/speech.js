// Azure AI Speech：ms-MY 语音合成（TTS）、语音识别（STT）与发音评测
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { dirs } from './store.js';

export const VOICES = {
  'ms-female': { name: 'ms-MY-YasminNeural', lang: 'ms-MY' },
  'ms-male': { name: 'ms-MY-OsmanNeural', lang: 'ms-MY' },
  'zh-female': { name: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN' },
  'zh-male': { name: 'zh-CN-YunxiNeural', lang: 'zh-CN' },
};

function requireSpeech() {
  if (!config.azureKey || !config.azureRegion) {
    throw Object.assign(new Error('未配置 Azure 语音服务：请在 .env 中设置 AZURE_SPEECH_KEY 和 AZURE_SPEECH_REGION'), { status: 503 });
  }
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function synthesize({ text, voice = 'ms-female', speed = 'normal' }) {
  requireSpeech();
  text = String(text || '').trim().slice(0, 1500);
  if (!text) throw Object.assign(new Error('text 为空'), { status: 400 });
  const v = VOICES[voice] || VOICES['ms-female'];
  const rate = speed === 'slow' ? '-40%' : speed === 'slower' ? '-60%' : '0%';
  const key = crypto.createHash('sha1').update(`${v.name}|${rate}|${text}`).digest('hex');
  const file = path.join(dirs.tts, `${key}.mp3`);
  try { return await fs.readFile(file); } catch {}
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${v.lang}"><voice name="${v.name}"><prosody rate="${rate}">${esc(text)}</prosody></voice></speak>`;
  const res = await fetch(`https://${config.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.azureKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'malay-tutor',
    },
    body: ssml,
  });
  if (!res.ok) throw Object.assign(new Error(`Azure TTS 失败 (${res.status}): ${(await res.text()).slice(0, 200)}`), { status: 502 });
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file, buf);
  return buf;
}

function pick(obj, k) { return obj?.[k] ?? obj?.PronunciationAssessment?.[k]; }

// audio: 16kHz 16bit 单声道 WAV（由前端录音并编码）
export async function recognize({ audio, language = 'ms-MY', referenceText = '', selfAssess = false }) {
  requireSpeech();
  if (!audio?.length || audio.length < 3200) throw Object.assign(new Error('录音太短，请再说一次'), { status: 400 });
  const lang = ['ms-MY', 'zh-CN', 'en-US'].includes(language) ? language : 'ms-MY';
  const url = `https://${config.azureRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${lang}&format=detailed`;
  const headers = {
    'Ocp-Apim-Subscription-Key': config.azureKey,
    'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
    Accept: 'application/json',
  };
  const ref = String(referenceText || '').trim();
  let assessmentNote = null;
  const call = async (withPA) => {
    const h = { ...headers };
    if (withPA) {
      h['Pronunciation-Assessment'] = Buffer.from(JSON.stringify({
        ReferenceText: ref, GradingSystem: 'HundredMark', Granularity: 'Word', Dimension: 'Comprehensive', EnableMiscue: 'True',
      })).toString('base64');
    }
    return fetch(url, { method: 'POST', headers: h, body: audio });
  };
  if (selfAssess && !ref) {
    // 自由说话（如模拟考试）：先识别，再以识别结果为参考文本做一次发音评测
    const first = await recognize({ audio, language: lang });
    if (!first.ok || !first.lexical) return first;
    const second = await recognize({ audio, language: lang, referenceText: first.lexical });
    return { ...first, assessment: second.assessment || null, assessmentNote: second.assessmentNote || null };
  }
  let res = await call(Boolean(ref));
  if (!res.ok && ref) {
    // 若该区域/语言暂不支持发音评测，退回为纯识别，并明确告知前端
    assessmentNote = `发音评测不可用（Azure 返回 ${res.status}），本次仅做识别与文本比对`;
    res = await call(false);
  }
  if (!res.ok) throw Object.assign(new Error(`Azure 语音识别失败 (${res.status}): ${(await res.text()).slice(0, 200)}`), { status: 502 });
  const data = await res.json();
  if (data.RecognitionStatus !== 'Success') {
    const msg = { NoMatch: '没有听清楚，请靠近麦克风再说一次', InitialSilenceTimeout: '没有检测到声音，请再试一次', BabbleTimeout: '背景噪音太大，请换个安静的地方', Error: '识别服务出错' }[data.RecognitionStatus] || data.RecognitionStatus;
    return { ok: false, text: '', status: data.RecognitionStatus, message: msg };
  }
  const best = data.NBest?.[0] || {};
  let assessment = null;
  if (ref && pick(best, 'AccuracyScore') !== undefined) {
    assessment = {
      referenceText: ref,
      accuracy: pick(best, 'AccuracyScore'),
      fluency: pick(best, 'FluencyScore'),
      completeness: pick(best, 'CompletenessScore'),
      pronScore: pick(best, 'PronScore'),
      words: (best.Words || []).map((w) => ({ word: w.Word, accuracy: pick(w, 'AccuracyScore'), errorType: pick(w, 'ErrorType') || 'None' })),
    };
  } else if (ref && !assessmentNote) {
    assessmentNote = 'Azure 未返回发音评分（该语言可能暂不支持），本次仅做识别与文本比对';
  }
  return { ok: true, text: data.DisplayText || best.Display || '', lexical: best.Lexical || '', confidence: best.Confidence, assessment, assessmentNote };
}
