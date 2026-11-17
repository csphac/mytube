'use strict';

// Minimal PDF writer — no dependencies.
//
// Each captured slide becomes one page with the JPEG frame filling it. JPEG
// streams are embedded as-is (/Filter /DCTDecode), so there is no re-encoding
// and no ZIP layer — just a catalog, a page tree, and one page + image per
// slide. Page size follows the video's aspect ratio (longest side 960pt), and
// each page gets a bookmark titled with the slide's timestamp in the video.

const fs = require('fs');

// width/height of a JPEG from its SOF marker
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: 16, height: 9 };
}

function fmt(n) {
  return String(Math.round(n * 100) / 100);
}

function obj(num, body) {
  return Buffer.concat([
    Buffer.from(`${num} 0 obj\n`),
    body,
    Buffer.from('\nendobj\n'),
  ]);
}

function streamObj(num, dict, data) {
  return obj(
    num,
    Buffer.concat([
      Buffer.from(`${dict}\nstream\n`),
      data,
      Buffer.from('\nendstream'),
    ])
  );
}

// slides: [{ jpeg: Buffer | file: String, label: '00-05-23' }]
function buildPdf(outPath, slides) {
  if (!slides.length) throw new Error('buildPdf: no slides');
  const images = slides.map((s) => (s.jpeg ? s.jpeg : fs.readFileSync(s.file)));
  const { width: iw, height: ih } = jpegSize(images[0]);
  const scale = 960 / Math.max(iw, ih);
  const pw = iw * scale;
  const ph = ih * scale;

  // Object layout: 1 catalog, 2 pages, 3 outlines, then per slide
  // page + content stream + image, then one bookmark per slide.
  const pageIds = slides.map((_, i) => 4 + i * 3);
  const outlineBase = 4 + slides.length * 3;

  const slideObjects = [];
  const outlineObjects = [];
  slides.forEach((slide, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const outlineId = outlineBase + i;
    const prev = i > 0 ? ` /Prev ${outlineBase + i - 1} 0 R` : '';
    const next = i < slides.length - 1 ? ` /Next ${outlineBase + i + 1} 0 R` : '';

    slideObjects.push(
      obj(
        pageId,
        Buffer.from(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pw)} ${fmt(ph)}] ` +
            `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
        )
      )
    );
    const content = `q ${fmt(pw)} 0 0 ${fmt(ph)} 0 0 cm /Im0 Do Q`;
    slideObjects.push(
      streamObj(
        contentId,
        `<< /Length ${Buffer.byteLength(content)} >>`,
        Buffer.from(content)
      )
    );
    slideObjects.push(
      streamObj(
        imageId,
        `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${images[i].length} >>`,
        images[i]
      )
    );
    outlineObjects.push(
      obj(
        outlineId,
        Buffer.from(
          `<< /Title (${slide.label.replace(/[()\\]/g, '')}) /Parent 3 0 R` +
            `${prev}${next} /Dest [${pageId} /Fit] >>`
        )
      )
    );
  });

  const objects = [
    obj(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>')),
    obj(
      2,
      Buffer.from(
        `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${slides.length} >>`
      )
    ),
    obj(
      3,
      Buffer.from(
        `<< /Type /Outlines /Count ${slides.length} /First ${outlineBase} 0 R /Last ${outlineBase + slides.length - 1} 0 R >>`
      )
    ),
    ...slideObjects,
    ...outlineObjects,
  ];

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let offset = chunks[0].length;
  const offsets = [0]; // object 0 is the free-list head
  for (const o of objects) {
    offsets.push(offset);
    chunks.push(o);
    offset += o.length;
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref +=
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  fs.writeFileSync(outPath, Buffer.concat(chunks));
  return outPath;
}

module.exports = { buildPdf, jpegSize };
