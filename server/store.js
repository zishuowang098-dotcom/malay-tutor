// 简单的 JSON 文件存储：课程、进度、语音缓存都保存在 DATA_DIR 下
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const dirs = {
  courses: path.join(config.dataDir, 'courses'),
  progress: path.join(config.dataDir, 'progress'),
  media: path.join(config.dataDir, 'media'),
  uploads: path.join(config.dataDir, 'uploads'),
  tts: path.join(config.dataDir, 'tts-cache'),
};
for (const d of Object.values(dirs)) fss.mkdirSync(d, { recursive: true });
export { dirs };

const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === next) locks.delete(key); }
}

async function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 1));
  await fs.rename(tmp, file);
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export const newId = () => crypto.randomBytes(8).toString('hex');
const safe = (id) => { if (!/^[a-f0-9]{16}$/.test(id)) throw Object.assign(new Error('bad id'), { status: 400 }); return id; };

export const courseFile = (id) => path.join(dirs.courses, `${safe(id)}.json`);
export const getCourse = (id) => readJson(courseFile(id));
export const saveCourse = (c) => withLock(`c:${c.id}`, () => writeJson(courseFile(c.id), c));
export async function updateCourse(id, fn) {
  return withLock(`c:${id}`, async () => {
    const c = await readJson(courseFile(id));
    if (!c) return null;
    await fn(c);
    c.updatedAt = Date.now();
    await writeJson(courseFile(id), c);
    return c;
  });
}
export async function listCourses() {
  const files = (await fs.readdir(dirs.courses)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const c = await readJson(path.join(dirs.courses, f));
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
export async function deleteCourse(id) {
  await fs.rm(courseFile(id), { force: true });
  await fs.rm(path.join(dirs.progress, `${safe(id)}.json`), { force: true });
  await fs.rm(path.join(dirs.media, safe(id)), { recursive: true, force: true });
}

const emptyProgress = (id) => ({ courseId: id, currentPage: null, pages: {}, items: {}, history: [], tutor: {} });
export const getProgress = async (id) => (await readJson(path.join(dirs.progress, `${safe(id)}.json`))) || emptyProgress(id);
export async function updateProgress(id, fn) {
  return withLock(`p:${id}`, async () => {
    const file = path.join(dirs.progress, `${safe(id)}.json`);
    const p = (await readJson(file)) || emptyProgress(id);
    const r = await fn(p);
    p.updatedAt = Date.now();
    await writeJson(file, p);
    return r === undefined ? p : r;
  });
}
