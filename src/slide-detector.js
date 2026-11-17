'use strict';

// Automatic slide detection — no user-facing settings.
//
// The video is probed once as a tiny RGB stream (128x72 @ 5 fps) and every
// frame is analysed in three ways:
//
//   1. Wide-area change after stillness (the screen was calm, then a big
//      fraction of it changed at once) marks a slide/scene change and is
//      always captured — this catches every real slide change regardless of
//      colour or contrast. Motion that never rests (faces, handheld footage)
//      never qualifies, even when something big moves.
//   2. Persistent small change ("sticky" blocks that keep differing from the
//      last captured frame) marks slide builds or handwritten notes appearing;
//      captured when the change looks like ink/text (low saturation) rather
//      than camera footage (faces, motion — usually colourful).
//   3. Anything happening only in the bottom band is ignored, so burned-in
//      subtitles never trigger captures.
//
// A capture only happens once the frame has settled after the change, so
// transitions/dissolves land on the finished slide, and near-identical frames
// are dropped via a perceptual hash. Videos without slides produce
// just the cover frame (t = 0) — no junk gallery.

const PROBE_W = 128;
const PROBE_H = 72;
const PROBE_FPS = 5;
const BLOCK = 8;
const COLS = PROBE_W / BLOCK; // 16
const CONTENT_ROWS = PROBE_H / BLOCK - 2; // ignore bottom band (subtitles)
const BAND = CONTENT_ROWS * BLOCK; // pixels above the subtitle band
const CONTENT_BLOCKS = COLS * CONTENT_ROWS;

const SETTLE = 0.6; // seconds of quiet that end a change burst
const MAX_BURST = 25; // bursts longer than this are continuous camera motion
const MIN_GAP = 1.0; // minimum seconds between captures
const WIDE = 0.2; // changed content blocks -> definitely a slide/scene change
const START = 0.02; // changed content blocks -> a burst starts
const KEEP = 0.01; // changed content blocks -> a burst stays alive
const MOTION_START = 1.5; // mean abs pixel diff -> a burst starts
const MOTION_KEEP = 1.0; // mean abs pixel diff -> a burst stays alive
const STICKY = 0.04; // blocks changed vs last capture -> slide build / notes
const PRE_STILL = 2.0; // seconds of stillness before a wide change counts
const ACHROMA = 30; // block saturation below this looks like ink/text
const INK = 0.6; // fraction of changed blocks that must look like ink/text
const QUIET = 3; // per-block mean abs diff considered "changed"
const DEDUPE = 3; // frame-hash distance below this = same slide as the last

function toGrayChroma(rgb, gray, chroma) {
  for (let y = 0; y < BAND; y++) {
    for (let x = 0; x < PROBE_W; x++) {
      const p = y * PROBE_W + x;
      const o = p * 3;
      const r = rgb[o];
      const g = rgb[o + 1];
      const b = rgb[o + 2];
      gray[p] = (r * 77 + g * 151 + b * 28) >> 8;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      chroma[p] = (mx - mn) >> 1;
    }
  }
}

function analyze(prevGray, gray, chroma, baselineGray) {
  let motionSum = 0;
  let changedBlocks = 0;
  let stickyBlocks = 0;
  let stickyInk = 0;
  for (let by = 0; by < CONTENT_ROWS; by++) {
    for (let bx = 0; bx < COLS; bx++) {
      let diff = 0;
      let baseDiff = 0;
      let inkSum = 0;
      let inkN = 0;
      for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y++) {
        for (let x = bx * BLOCK; x < bx * BLOCK + BLOCK; x++) {
          const p = y * PROBE_W + x;
          diff += Math.abs(gray[p] - prevGray[p]);
          if (baselineGray) {
            const d = Math.abs(gray[p] - baselineGray[p]);
            baseDiff += d;
            if (d > QUIET) {
              inkSum += chroma[p];
              inkN++;
            }
          }
        }
      }
      motionSum += diff;
      if (diff / 64 > QUIET) changedBlocks++;
      if (baselineGray && baseDiff / 64 > QUIET) {
        stickyBlocks++;
        // "Ink" = only the pixels that actually changed look like text/ink
        // (low saturation). Colourful change (faces, footage) is never ink.
        if (inkN === 0 || inkSum / inkN <= ACHROMA) stickyInk++;
      }
    }
  }
  return {
    motion: motionSum / (BAND * PROBE_W),
    changedRatio: changedBlocks / CONTENT_BLOCKS,
    stickyRatio: stickyBlocks / CONTENT_BLOCKS,
    inkRatio: stickyBlocks ? stickyInk / stickyBlocks : 1,
  };
}

// Perceptual signature of the content band: 8x8 gradient bits plus 8x8 cell
// means. The cell means matter because uniform frames (white vs black slide)
// have identical gradients but are obviously different slides.
function frameHash(gray) {
  const bits = new Uint8Array(64);
  const cells = new Uint8Array(64);
  const cellW = PROBE_W / 9;
  const cellH = BAND / 8;
  const vals = new Array(9);
  for (let r = 0; r < 8; r++) {
    const y0 = Math.floor(r * cellH);
    const y1 = Math.floor((r + 1) * cellH);
    for (let c = 0; c < 9; c++) {
      const x0 = Math.floor(c * cellW);
      const x1 = Math.floor((c + 1) * cellW);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * PROBE_W + x];
          n++;
        }
      }
      vals[c] = sum / n;
    }
    for (let c = 0; c < 8; c++) {
      bits[r * 8 + c] = vals[c] > vals[c + 1] ? 1 : 0;
      cells[r * 8 + c] = Math.round((vals[c] + vals[c + 1]) / 2);
    }
  }
  return { bits, cells };
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 64; i++) {
    if (a.bits[i] !== b.bits[i]) d++;
    if (Math.abs(a.cells[i] - b.cells[i]) > 15) d++;
  }
  return d;
}

function createSlideDetector(opts = {}) {
  const dedupeLimit = opts.dedupe ?? DEDUPE;

  let prevGray = null;
  let baselineGray = null;
  let lastGray = null;
  let lastMetrics = null;
  let lastHash = null;
  let lastTime = 0;
  let lastActivity = 0;
  let lastCapture = -Infinity;
  let state = 'idle'; // 'idle' | 'burst'
  let burstStart = 0;
  let burstStill = 0; // stillness (s) before the current burst started
  let calmSince = 0; // start of the current calm stretch
  let strong = false;

  const stats = { kept: 0, dropped: 0, bursts: 0 };

  function copyOf(gray) {
    return Uint8Array.from(gray);
  }

  function capture(t, gray) {
    const hash = frameHash(gray);
    baselineGray = copyOf(gray);
    if (lastHash && hamming(lastHash, hash) < dedupeLimit) {
      stats.dropped++;
      return null;
    }
    lastHash = hash;
    lastCapture = t;
    stats.kept++;
    return { t: Number(Math.max(0, t).toFixed(2)) };
  }

  // Quiet-moment capture: the frame is calm *now* and persistent ink-like
  // change has accumulated since the last capture (slide builds, handwriting).
  // Failure leaves the baseline alone so small additions keep adding up; it
  // never fires on colourful change (faces/footage), which cannot accumulate.
  function captureInk(t, gray, m) {
    if (!(m.stickyRatio >= STICKY && m.inkRatio >= INK)) return null;
    if (t - lastCapture < MIN_GAP) return null;
    return capture(t, gray);
  }

  // End of a change burst: capture if the burst was a real slide/scene
  // change (strong) or if persistent ink change accumulated.
  function decide(t, gray, m) {
    const slideLike = strong || (m.stickyRatio >= STICKY && m.inkRatio >= INK);
    if (!slideLike) {
      // Camera footage (colourful/localised change): reset so it cannot
      // accumulate. A tiny ink change: keep the baseline so small additions
      // add up until they are worth capturing.
      const tinyInkChange = m.stickyRatio < STICKY && m.inkRatio >= INK;
      if (!tinyInkChange) baselineGray = copyOf(gray);
      return null;
    }
    if (t - lastCapture < MIN_GAP) return null; // retry on a later frame
    return capture(Math.min(lastActivity + 0.2, t), gray);
  }

  function push(t, rgb) {
    const gray = new Uint8Array(PROBE_W * PROBE_H);
    const chroma = new Uint8Array(PROBE_W * PROBE_H);
    toGrayChroma(rgb, gray, chroma);

    if (!prevGray) {
      prevGray = gray;
      baselineGray = copyOf(gray);
      lastGray = gray;
      lastMetrics = { stickyRatio: 0, inkRatio: 1, changedRatio: 0, motion: 0 };
      lastHash = frameHash(gray);
      lastCapture = t;
      stats.kept++;
      return { t: 0 };
    }

    const m = analyze(prevGray, gray, chroma, baselineGray);
    prevGray = gray;
    lastGray = gray;
    lastMetrics = m;
    lastTime = t;

    const calm = m.changedRatio < START && m.motion < MOTION_START;
    const stillBefore = t - calmSince;
    if (calm) {
      if (calmSince == null) calmSince = t;
    } else {
      calmSince = null;
    }

    if (calm) {
      const hit = captureInk(t, gray, m);
      if (hit) return hit;
    }

    const active = m.changedRatio >= KEEP || m.motion >= MOTION_KEEP;
    if (state === 'idle') {
      if (!calm) {
        state = 'burst';
        burstStart = t;
        burstStill = stillBefore;
        lastActivity = t;
        strong = m.changedRatio >= WIDE && burstStill >= PRE_STILL;
        stats.bursts++;
      }
    } else {
      if (m.changedRatio >= WIDE && burstStill >= PRE_STILL) strong = true;
      if (active) lastActivity = t;
      if (t - burstStart > MAX_BURST) {
        state = 'idle';
        strong = false;
        baselineGray = copyOf(gray);
      } else if (t - lastActivity >= SETTLE) {
        state = 'idle';
        const hit = decide(t, gray, m);
        strong = false;
        return hit;
      }
    }
    return null;
  }

  function finish() {
    if (state !== 'burst') return null;
    state = 'idle';
    const hit = decide(lastTime, lastGray, lastMetrics);
    strong = false;
    return hit;
  }

  return { push, finish, stats };
}

module.exports = {
  createSlideDetector,
  frameHash,
  hamming,
  analyze,
  toGrayChroma,
  PROBE_W,
  PROBE_H,
  PROBE_FPS,
};
