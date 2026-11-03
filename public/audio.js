// 语音播放（Azure TTS 音频）与录音（16kHz 单声道 WAV，供 Azure 识别/评测）
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

export const settings = {
  get() { try { return { msVoice: 'ms-female', zhVoice: 'zh-female', autoStop: true, ...JSON.parse(localStorage.getItem('mt_settings') || '{}') }; } catch { return { msVoice: 'ms-female', zhVoice: 'zh-female', autoStop: true }; } },
  set(patch) { try { localStorage.setItem('mt_settings', JSON.stringify({ ...settings.get(), ...patch })); } catch {} },
};

export function ttsUrl(text, lang = 'ms', speed = 'normal') {
  const s = settings.get();
  const voice = lang === 'zh' ? s.zhVoice : s.msVoice;
  return `/api/tts?${new URLSearchParams({ text, voice, speed })}`;
}

class Player {
  constructor() { this.el = new Audio(); this.el.preload = 'auto'; this.token = 0; this.onstate = null; }
  unlock() { // iOS 需要在用户点击时先播放一次
    if (this.unlocked) return;
    this.el.src = SILENT; const p = this.el.play(); if (p) p.catch(() => {}); this.unlocked = true;
  }
  stop() { this.token++; this.el.pause(); this.onstate?.(null); }
  async playUrl(url, tok) {
    // 先用 fetch 取音频，便于拿到服务端的错误信息
    const r = await fetch(url);
    if (!r.ok) { let m = `语音播放失败 (${r.status})`; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
    const blob = await r.blob();
    if (tok !== this.token) return;
    const src = URL.createObjectURL(blob);
    try {
      await new Promise((res, rej) => {
        this.el.onended = res; this.el.onerror = () => rej(new Error('音频无法播放'));
        this.el.src = src;
        const p = this.el.play(); if (p) p.catch(rej);
      });
    } finally { URL.revokeObjectURL(src); }
  }
  // segments: [{lang:'zh'|'ms', text, speed}]
  async playSegments(segments, onSegment) {
    this.stop();
    const tok = this.token;
    const urls = segments.map((s) => ttsUrl(s.text, s.lang, s.speed));
    urls.slice(0, 3).forEach((u) => fetch(u).catch(() => {})); // 预取，命中服务端缓存
    for (let i = 0; i < segments.length; i++) {
      if (tok !== this.token) return false;
      onSegment?.(i); this.onstate?.(segments[i]);
      if (urls[i + 1]) fetch(urls[i + 1]).catch(() => {});
      await this.playUrl(urls[i], tok);
    }
    if (tok === this.token) { onSegment?.(-1); this.onstate?.(null); }
    return tok === this.token;
  }
  say(text, lang = 'ms', speed = 'normal') { return this.playSegments([{ text, lang, speed }]); }
}
export const player = new Player();

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
function resample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to, out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) { // 区间平均（简易低通）
    const a = Math.floor(i * ratio), b = Math.min(data.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b; j++) sum += data[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

class Recorder {
  constructor() { this.ctx = null; this.stream = null; this.active = false; this.releaseTimer = null; }
  async ensure() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('此浏览器不支持录音。iPhone 需使用 Safari 并通过 HTTPS 访问');
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.stream || !this.stream.active) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) { throw new Error(e.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器设置中允许麦克风' : `无法打开麦克风：${e.message}`); }
    }
    clearTimeout(this.releaseTimer);
  }
  // 返回 Promise<Blob>；onLevel(0..1) 用于音量动画；自动在说完后静音约 1.6 秒时停止
  async start({ onLevel, autoStop = settings.get().autoStop, maxMs = 30000 } = {}) {
    await this.ensure();
    const ctx = this.ctx, src = ctx.createMediaStreamSource(this.stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = []; let spoke = false, silentFor = 0, total = 0;
    this.active = true;
    return new Promise((resolve) => {
      const finish = () => {
        if (!this.active) return; this.active = false;
        proc.disconnect(); src.disconnect();
        const len = chunks.reduce((n, c) => n + c.length, 0), all = new Float32Array(len);
        let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
        this.releaseTimer = setTimeout(() => this.release(), 90000);
        resolve({ blob: encodeWav(resample(all, ctx.sampleRate, 16000), 16000), seconds: len / ctx.sampleRate, spoke });
      };
      this._finish = finish;
      proc.onaudioprocess = (e) => {
        if (!this.active) return;
        const d = new Float32Array(e.inputBuffer.getChannelData(0)); chunks.push(d);
        let rms = 0; for (let i = 0; i < d.length; i++) rms += d[i] * d[i]; rms = Math.sqrt(rms / d.length);
        onLevel?.(Math.min(1, rms * 8));
        const dur = d.length / ctx.sampleRate; total += dur;
        if (rms > 0.02) { spoke = true; silentFor = 0; } else silentFor += dur;
        if ((autoStop && spoke && silentFor > 1.6) || total * 1000 > maxMs || (autoStop && !spoke && total > 8)) finish();
      };
      src.connect(proc); proc.connect(ctx.destination);
    });
  }
  stop() { this._finish?.(); }
  release() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }
}
export const recorder = new Recorder();

export async function transcribe(blob, { lang = 'ms-MY', ref = '' } = {}) {
  const r = await fetch(`/api/stt?${new URLSearchParams({ lang, ref })}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `识别失败 (${r.status})`);
  return j;
}
