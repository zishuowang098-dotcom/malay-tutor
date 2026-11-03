import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFile } from '../server/parse.js';
import { recordItem, reviewQueue, compareText, weakItems } from '../server/progress.js';

test('PPTX：按原始顺序提取每页文字、备注和图片', async () => {
  const r = await parseFile(fs.readFileSync('test/fixtures/lesson1.pptx'), 'lesson1.pptx');
  assert.equal(r.slides.length, 4);
  assert.deepEqual(r.slides.map((s) => s.page), [1, 2, 3, 4]);
  assert.deepEqual(r.slides[0].text, ['Bahasa Melayu 1', 'Pelajaran 1: Salam dan Perkenalan']);
  assert.ok(r.slides[1].text.includes('Apa khabar? – 你好吗？'));
  assert.deepEqual(r.slides[1].notes, ['Tekankan sebutan "kh" dalam khabar.']);
  assert.equal(r.slides[2].images.length, 1);
  assert.equal(r.slides[2].images[0].mediaType, 'image/png');
});

test('PDF：逐页提取并保留页码', async () => {
  const r = await parseFile(fs.readFileSync('test/fixtures/lesson2.pdf'), 'lesson2.pdf');
  assert.equal(r.slides.length, 3);
  assert.deepEqual(r.slides[1].text, ['satu 1', 'dua 2', 'tiga 3', 'empat 4', 'lima 5']);
  assert.equal(r.slides[2].page, 3);
});

test('拒绝不支持的格式', async () => {
  await assert.rejects(parseFile(Buffer.from('x'), 'a.ppt'), /pptx/);
});

test('间隔复习：答错进入复习队列，答对后拉长间隔', () => {
  const p = { items: {}, history: [] };
  recordItem(p, { ms: 'Apa khabar?', zh: '你好吗', page: 2, correct: false, mode: 'speaking', error: 'kh 发音' });
  const it = p.items['apa khabar'];
  assert.equal(it.wrong, 1);
  assert.equal(weakItems(p).length, 1);
  it.due = Date.now() - 1;
  assert.equal(reviewQueue(p).due.length, 1);
  recordItem(p, { ms: 'apa khabar', correct: true, mode: 'review' });
  assert.equal(it.box, 2);
  assert.ok(it.due > Date.now() + 20 * 3600e3);
  assert.equal(p.history.length, 2);
});

test('文本比对：逐词对齐', () => {
  const r = compareText('Selamat pagi cikgu', 'selamat pagi');
  assert.deepEqual(r.words.map((w) => w.ok), [true, true, false]);
  assert.equal(compareText('Nama saya Ali', 'nama saya ali').score, 100);
});
