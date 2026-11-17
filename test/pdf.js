// Unit tests for the PDF writer. Run: npm run test:slides
// Plain Node — builds a slides.pdf from synthetic JPEGs and validates the
// xref table, page tree, and embedded image streams byte-for-byte.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPdf, jpegSize } = require('../src/pdf');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

function fakeJpeg(w, h, seed = 0) {
  const buf = Buffer.alloc(256, seed);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4);
  buf[6] = 8; // precision
  buf.writeUInt16BE(h, 7);
  buf.writeUInt16BE(w, 9);
  buf[254] = 0xff;
  buf[255] = 0xd9; // EOI
  return buf;
}

// Walks the xref table and checks every in-use entry points at its object.
function readXref(buf) {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-'), 'PDF header');
  assert.ok(s.trimEnd().endsWith('%%EOF'), 'PDF EOF marker');
  const start = s.lastIndexOf('startxref');
  assert.ok(start > -1, 'startxref present');
  const xrefOff = Number(s.slice(start + 9).trim().split(/\s+/)[0]);
  assert.equal(s.slice(xrefOff, xrefOff + 4), 'xref', 'startxref points at xref');
  const lines = s.slice(xrefOff).split('\n');
  const count = Number(lines[1].split(' ')[1]);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const [offset, , inUse] = lines[2 + i].split(' ');
    entries.push({ offset: Number(offset), inUse: inUse === 'n' });
    if (inUse === 'n') {
      assert.ok(
        s.slice(Number(offset)).startsWith(`${i} 0 obj`),
        `xref entry ${i} points at object ${i}`
      );
    }
  }
  return { s, entries };
}

test('jpegSize reads the SOF marker', () => {
  assert.deepEqual(jpegSize(fakeJpeg(1280, 720)), { width: 1280, height: 720 });
});

test('buildPdf produces a well-formed multi-page PDF', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mytube-pdf-'));
  const jpgOnDisk = path.join(tmp, 'frame.jpg');
  fs.writeFileSync(jpgOnDisk, fakeJpeg(1920, 1080, 7));
  const out = path.join(tmp, 'slides.pdf');
  buildPdf(out, [
    { jpeg: fakeJpeg(1920, 1080, 1), label: '00-00-00' },
    { file: jpgOnDisk, label: '00-05-23' },
  ]);

  const buf = fs.readFileSync(out);
  const { s, entries } = readXref(buf);

  // xref has the free-list head + catalog + pages + outlines
  // + 2 * (page, content, image) + 2 bookmarks
  assert.equal(entries.length, 1 + 3 + 6 + 2);

  // Page tree covers both pages, sized to the video aspect (16:9 -> 960x540).
  assert.ok(s.includes('/Kids [4 0 R 7 0 R] /Count 2'), 'page tree');
  assert.equal((s.match(/\/Type \/Page[^s]/g) || []).length, 2);
  assert.equal((s.match(/\/MediaBox \[0 0 960 540\]/g) || []).length, 2);

  // Both JPEGs are embedded byte-for-byte behind DCTDecode.
  assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 2);
  assert.equal((s.match(/\/Filter \/DCTDecode/g) || []).length, 2);
  assert.ok(buf.includes(fakeJpeg(1920, 1080, 1)), 'first jpeg embedded');
  assert.ok(buf.includes(fakeJpeg(1920, 1080, 7)), 'second jpeg embedded');

  // Bookmarks carry the timestamps and point at the right pages.
  assert.ok(s.includes('/Outlines 3 0 R'));
  assert.ok(s.includes('/Title (00-00-00)'));
  assert.ok(s.includes('/Title (00-05-23)'));
  assert.ok(s.includes('/Dest [4 /Fit]'));
  assert.ok(s.includes('/Dest [7 /Fit]'));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildPdf keeps portrait aspect ratios', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mytube-pdf-'));
  const out = path.join(tmp, 'slides.pdf');
  buildPdf(out, [{ jpeg: fakeJpeg(1080, 1920), label: '00-00-00' }]);
  const { s } = readXref(fs.readFileSync(out));
  assert.ok(s.includes('/MediaBox [0 0 540 960]'), s.match(/MediaBox[^\]]*\]/)?.[0]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildPdf rejects an empty deck', () => {
  assert.throws(() => buildPdf('/tmp/nope.pdf', []), /no slides/);
});

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall pdf tests passed');
