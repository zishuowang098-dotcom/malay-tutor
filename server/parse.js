// 课件解析：PPTX（按 presentation.xml 中的真实顺序，含备注和图片）与 PDF（逐页文字）
import JSZip from 'jszip';
import path from 'node:path/posix';
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', preserveOrder: false });
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function relsOf(zip, partPath) {
  const dir = path.dirname(partPath);
  const relsPath = path.join(dir, '_rels', path.basename(partPath) + '.rels');
  return zip.file(relsPath)?.async('string').then((s) => {
    const doc = xml.parse(s);
    let rels = doc?.Relationships?.Relationship || [];
    if (!Array.isArray(rels)) rels = [rels];
    return rels.map((r) => ({
      id: r['@Id'], type: String(r['@Type'] || ''), external: r['@TargetMode'] === 'External',
      target: r['@TargetMode'] === 'External' ? r['@Target'] : path.normalize(path.join(dir, r['@Target'])),
    }));
  }) || Promise.resolve([]);
}

// 按段落提取文字（a:p 内的 a:t 拼接），保留换行；表格单元格同样是 a:p
function paragraphsFromXml(s) {
  const paras = [];
  const pRe = /<a:p[\s>][\s\S]*?<\/a:p>|<a:p\/>/g;
  let m;
  while ((m = pRe.exec(s))) {
    const texts = [...m[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\/>/g)].map((t) => (t[0].startsWith('<a:br') ? '\n' : decode(t[1])));
    const line = texts.join('').trim();
    if (line) paras.push(line);
  }
  return paras;
}
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

export async function parsePptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const presXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (!presXml) throw new Error('不是有效的 PPTX 文件（缺少 ppt/presentation.xml）');
  const presRels = await relsOf(zip, 'ppt/presentation.xml');
  const ids = [...presXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  const slides = [];
  let page = 0;
  for (const rid of ids) {
    const rel = presRels.find((r) => r.id === rid);
    if (!rel) continue;
    page += 1;
    const sx = await zip.file(rel.target)?.async('string');
    if (!sx) continue;
    const hidden = /<p:sld\b[^>]*\bshow="0"/.test(sx);
    const rels = await relsOf(zip, rel.target);
    const text = paragraphsFromXml(sx);
    let notes = [];
    const nRel = rels.find((r) => r.type.endsWith('/notesSlide'));
    if (nRel) {
      const nx = await zip.file(nRel.target)?.async('string');
      // 备注页里也包含页码占位符，只取 body 类型占位符的文字
      if (nx) notes = paragraphsFromXml(nx).filter((t) => !/^\d+$/.test(t));
    }
    const images = [];
    const usedImg = new Set([...sx.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]));
    for (const r of rels) {
      if (!r.type.endsWith('/image') || r.external || !usedImg.has(r.id)) continue;
      const ext = r.target.split('.').pop().toLowerCase();
      if (!IMG_TYPES[ext]) continue;
      const data = await zip.file(r.target)?.async('nodebuffer');
      if (data && data.length > 400) images.push({ name: path.basename(r.target), mediaType: IMG_TYPES[ext], data });
    }
    slides.push({ page, hidden, text, notes, images });
  }
  return { kind: 'pptx', slides };
}

export async function parsePdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const slides = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const lines = [];
    let cur = '';
    let lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2 && cur.trim()) { lines.push(cur.trim()); cur = ''; }
      cur += it.str;
      if (it.hasEOL) { if (cur.trim()) lines.push(cur.trim()); cur = ''; }
      lastY = y;
    }
    if (cur.trim()) lines.push(cur.trim());
    slides.push({ page: i, hidden: false, text: lines, notes: [], images: [] });
  }
  await task.destroy();
  return { kind: 'pdf', slides };
}

export async function parseFile(buf, filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pptx') return parsePptx(buf);
  if (ext === 'pdf') return parsePdf(buf);
  throw Object.assign(new Error('仅支持 .pptx 或 .pdf 文件（旧版 .ppt 请先另存为 .pptx）'), { status: 400 });
}
