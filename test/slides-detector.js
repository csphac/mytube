// Unit tests for the automatic slide detector. Run: npm run test:slides
// Plain Node — no electron or ffmpeg required; frames are synthesised.
const assert = require('assert/strict');
const {
  createSlideDetector,
  frameHash,
  hamming,
  PROBE_W,
  PROBE_H,
  PROBE_FPS,
} = require('../src/slide-detector');

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

function frame(fill = [255, 255, 255]) {
  const buf = Buffer.alloc(PROBE_W * PROBE_H * 3);
  for (let i = 0; i < PROBE_W * PROBE_H; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  return buf;
}

function patch(buf, x0, y0, w, h, color) {
  for (let y = y0; y < Math.min(y0 + h, PROBE_H); y++) {
    for (let x = x0; x < Math.min(x0 + w, PROBE_W); x++) {
      const o = (y * PROBE_W + x) * 3;
      buf[o] = color[0];
      buf[o + 1] = color[1];
      buf[o + 2] = color[2];
    }
  }
  return buf;
}

// Feed `makeFrame(t)` to a detector for `seconds`, return captured slides.
function run(makeFrame, seconds, det = createSlideDetector()) {
  const hits = [];
  const n = Math.round(seconds * PROBE_FPS);
  for (let i = 0; i < n; i++) {
    const t = i / PROBE_FPS;
    const hit = det.push(t, makeFrame(t));
    if (hit) hits.push(hit);
  }
  const tail = det.finish();
  if (tail) hits.push(tail);
  return hits;
}

test('slide deck: cover plus one capture per slide change', () => {
  const slides = [
    [255, 255, 255],
    [20, 20, 20],
    [200, 30, 30],
  ];
  const hits = run((t) => frame(slides[Math.min(2, Math.floor(t / 5))]), 15);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].t, 0);
  assert.ok(Math.abs(hits[1].t - 5.2) < 1, `got ${hits[1].t}`);
  assert.ok(Math.abs(hits[2].t - 10.2) < 1, `got ${hits[2].t}`);
});

test('slide builds: small ink changes added over time are captured', () => {
  const hits = run((t) => {
    const buf = frame([255, 255, 255]);
    if (t >= 5) patch(buf, 10, 10, 40, 30, [20, 20, 20]); // first bullet block
    if (t >= 10) patch(buf, 60, 10, 40, 30, [20, 20, 20]); // second bullet block
    return buf;
  }, 15);
  assert.equal(hits.length, 3, JSON.stringify(hits));
  assert.ok(Math.abs(hits[1].t - 5.2) < 1, `got ${hits[1].t}`);
  assert.ok(Math.abs(hits[2].t - 10.2) < 1, `got ${hits[2].t}`);
});

test('slow handwriting: ink accumulating in small strokes is captured', () => {
  const hits = run((t) => {
    const buf = frame([250, 250, 250]);
    const stroke = Math.min(29, Math.floor(t / 0.25)); // one stroke per 0.25s
    for (let s = 0; s <= stroke; s++) {
      patch(buf, (s * 17) % 110, 6 + ((s * 23) % 40), 8, 6, [30, 30, 30]);
    }
    return buf;
  }, 15);
  assert.ok(hits.length >= 3, `got only ${hits.length}: ${JSON.stringify(hits)}`);
});

test('talking head: moving colourful region never becomes a slide', () => {
  const hits = run((t) => {
    const buf = frame([120, 120, 120]);
    // A "face" moves and jitters, pausing every other second.
    const phase = t % 2; // 1.5s moving, 0.5s pause
    const step = phase < 1.5 ? Math.floor(phase * 4) : 6;
    patch(buf, 40 + step * 3, 20 + step, 26, 26, [210, 150, 130]);
    return buf;
  }, 20);
  assert.equal(hits.length, 1, JSON.stringify(hits));
});

test('subtitles: bottom-band changes never trigger captures', () => {
  const hits = run((t) => {
    const buf = frame([255, 255, 255]);
    const line = Math.floor(t) % 3;
    patch(buf, 20, 58 + line * 2, 88, 8, [0, 0, 0]);
    return buf;
  }, 12);
  assert.equal(hits.length, 1, JSON.stringify(hits));
});

test('non-slide video with scene cuts: one frame per scene change', () => {
  const scenes = [
    [40, 90, 160],
    [160, 100, 40],
    [30, 120, 60],
  ];
  const hits = run((t) => frame(scenes[Math.min(2, Math.floor(t / 5))]), 15);
  assert.equal(hits.length, 3, JSON.stringify(hits));
});

test('near-identical recapture is dropped by the perceptual hash', () => {
  const det = createSlideDetector();
  const hits = run((t) => {
    const buf = frame([255, 255, 255]);
    if (t >= 5) patch(buf, 10, 10, 40, 30, [20, 20, 20]);
    return buf;
  }, 12, det);
  assert.equal(hits.length, 2, JSON.stringify(hits));
  assert.equal(det.stats.dropped, 0);
});

test('frame hash is stable and discriminative', () => {
  const a = frameHash(makeGray([255, 255, 255]));
  const b = frameHash(makeGray([255, 255, 255]));
  assert.equal(hamming(a, b), 0);
  // Uniform frames have no gradients — the cell means must tell them apart.
  const c = frameHash(makeGray([20, 20, 20]));
  assert.ok(hamming(a, c) >= 32, `hamming ${hamming(a, c)}`);
});

function makeGray(fill) {
  const rgb = frame(fill);
  const gray = new Uint8Array(PROBE_W * PROBE_H);
  for (let i = 0; i < PROBE_W * PROBE_H; i++) {
    gray[i] = (rgb[i * 3] * 77 + rgb[i * 3 + 1] * 151 + rgb[i * 3 + 2] * 28) >> 8;
  }
  return gray;
}

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall slide-detector tests passed');
