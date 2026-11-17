const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ytDlpPath, binDir } = require('./binaries');
const { buildPdf } = require('./pdf');
const {
  createSlideDetector,
  PROBE_W,
  PROBE_H,
  PROBE_FPS,
} = require('./slide-detector');
const { writeMeta, updateMeta } = require('./library');

const activeChildren = new Set();
let cancelled = false;

function cancelAll() {
  cancelled = true;
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

function run(cmd, args, { onLine, onData } = {}) {
  return new Promise((resolve, reject) => {
    if (cancelled) return reject(new Error('Cancelled'));
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let errLineBuf = '';
    child.stdout.on('data', (d) => {
      if (onData) onData(d);
      else stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (onLine) {
        errLineBuf += text;
        const lines = errLineBuf.split(/\r?\n|\r/);
        errLineBuf = lines.pop();
        for (const line of lines) if (line.trim()) onLine(line);
      }
    });
    child.on('error', (err) => {
      activeChildren.delete(child);
      reject(err);
    });
    child.on('close', (code) => {
      activeChildren.delete(child);
      if (cancelled) return reject(new Error('Cancelled'));
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.trim().split('\n').slice(-4).join('\n');
      reject(new Error(tail || `${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'youtu.be' ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com')
    );
  } catch {
    return false;
  }
}

async function fetchInfo(url) {
  const { stdout } = await run(ytDlpPath(), [
    '-J',
    '--no-playlist',
    '--no-warnings',
    url,
  ]);
  return parseVideoInfo(JSON.parse(stdout));
}

function parseVideoInfo(info) {
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    throw new Error('That URL is a playlist. Paste a link to a single video.');
  }
  const manual = Object.keys(info.subtitles || {});
  const auto = Object.keys(info.automatic_captions || {});
  const seen = new Set();
  const languages = [];
  for (const code of manual) {
    seen.add(code);
    languages.push({ code, label: code, auto: false });
  }
  for (const code of auto) {
    const base = code.split('-')[0];
    if (seen.has(code) || seen.has(base)) continue;
    seen.add(code);
    seen.add(base);
    languages.push({ code, label: `${code} (auto)`, auto: true });
  }
  languages.sort((a, b) => {
    if (a.auto !== b.auto) return a.auto ? 1 : -1;
    if (a.code.startsWith('en') !== b.code.startsWith('en'))
      return a.code.startsWith('en') ? -1 : 1;
    return a.code.localeCompare(b.code);
  });

  return {
    id: info.id,
    title: info.title,
    channel: info.channel || info.uploader || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail,
    viewCount: info.view_count,
    languages,
  };
}

function sanitizeName(name) {
  const clean = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return !clean || /^\.+$/.test(clean) ? 'video' : clean;
}

function findFile(dir, base, preferredExts = []) {
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base + '.') && !f.endsWith('.part'));
  for (const ext of preferredExts) {
    const match = candidates.find((f) => f.endsWith(ext));
    if (match) return path.join(dir, match);
  }
  let newest = null;
  let newestMtime = -1;
  for (const f of candidates) {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {}
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newest = f;
    }
  }
  return newest ? path.join(dir, newest) : null;
}

async function downloadVideo(url, folder, height, emit) {
  const fmt = height
    ? `bestvideo[height<=${height}]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
    : 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
  const args = [
    '-f', fmt,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', binDir(),
    '--no-playlist',
    '--no-mtime',
    '--newline',
    '-o', path.join(folder, 'video.%(ext)s'),
    url,
  ];
  await run(ytDlpPath(), args, {
    onLine: (line) => {
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m) {
        emit({ percent: Number(m[1]), message: 'Downloading video…' });
      } else if (/\[(Merger|Metadata|VideoConvertor)\]/.test(line)) {
        emit({ message: 'Merging video + audio…' });
      }
    },
  });
  const file = findFile(folder, 'video', ['.mp4', '.mkv', '.webm', '.mov']);
  if (!file) throw new Error('Video download finished but no file was found');
  return file;
}

function srtToText(srt) {
  const blocks = srt.replace(/\r/g, '').split(/\n\n+/);
  const lines = [];
  for (const block of blocks) {
    const rows = block.split('\n').filter((r) => r.trim());
    if (rows.length < 2) continue;
    const timeIdx = rows.findIndex((r) => r.includes('-->'));
    if (timeIdx === -1) continue;
    const text = rows
      .slice(timeIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && text !== lines[lines.length - 1]) lines.push(text);
  }
  return lines.join('\n');
}

async function downloadTranscript(url, folder, lang, emit) {
  emit({ percent: 0, message: 'Fetching transcript…' });
  const args = [
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', lang,
    '--sub-format', 'srt/vtt/best',
    '--convert-subs', 'srt',
    '--no-playlist',
    '-o', path.join(folder, 'transcript.%(ext)s'),
    url,
  ];
  await run(ytDlpPath(), args, {
    onLine: (line) => {
      if (line.startsWith('[info]')) emit({ message: line.slice(0, 160) });
    },
  });
  const srtFile = findFile(folder, 'transcript', ['.srt']);
  if (!srtFile) {
    throw new Error(
      `No transcript available for language "${lang}". Try another language.`
    );
  }
  const text = srtToText(fs.readFileSync(srtFile, 'utf8'));
  const txtFile = path.join(folder, 'transcript.txt');
  fs.writeFileSync(txtFile, text + '\n');
  emit({ percent: 100, message: 'Transcript saved' });
  return [srtFile, txtFile];
}

function fmtTime(seconds) {
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}-${pad(Math.floor((s % 3600) / 60))}-${pad(s % 60)}`;
}

// Slide capture is fully automatic (see slide-detector.js). The video is
// probed once as a tiny RGB stream to find the moments where the on-screen
// content changed and settled, then a full-resolution frame is grabbed at
// each of those timestamps and all of them are packed into a single
// slides.pdf (one page per captured frame). Videos without slides yield just
// a cover frame.
async function extractSlides(videoFile, folder, duration, emit) {
  emit({ percent: 0, message: 'Detecting slides…' });
  const detector = createSlideDetector();
  const candidates = [];
  const frameBytes = PROBE_W * PROBE_H * 3;
  let pending = Buffer.alloc(0);
  let frames = 0;

  await run(
    binDir() + '/ffmpeg',
    [
      '-hide_banner',
      '-i', videoFile,
      '-vf', `scale=${PROBE_W}:${PROBE_H},fps=${PROBE_FPS},format=rgb24`,
      '-f', 'rawvideo',
      '-',
    ],
    {
      onData: (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= frameBytes) {
          const rgb = pending.subarray(0, frameBytes);
          pending = pending.subarray(frameBytes);
          const hit = detector.push(frames / PROBE_FPS, rgb);
          frames++;
          if (hit) candidates.push(hit);
        }
      },
      onLine: (line) => {
        const t = line.match(/time=(\d+):(\d+):([\d.]+)/);
        if (t && duration) {
          const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
          emit({
            percent: Math.min(70, Math.round((secs / duration) * 70)),
            message: 'Detecting slides…',
          });
        }
      },
    }
  );
  const tail = detector.finish();
  if (tail) candidates.push(tail);

  if (candidates.length === 0) {
    emit({ percent: 100, message: 'No slides detected' });
    return null;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mytube-slides-'));
  const slides = [];
  try {
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        if (cancelled) throw new Error('Cancelled');
        const i = next++;
        const maxT = duration ? Math.max(0, duration - 0.5) : Infinity;
        const t = Math.min(candidates[i].t, maxT);
        const out = path.join(tmpDir, `s${String(i + 1).padStart(4, '0')}.jpg`);
        await run(binDir() + '/ffmpeg', [
          '-hide_banner',
          '-ss', String(t),
          '-i', videoFile,
          '-frames:v', '1',
          '-q:v', '2',
          out,
        ]);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) {
          slides[i] = { file: out, time: t };
        }
        done++;
        emit({
          percent: 70 + Math.round((done / candidates.length) * 30),
          message: 'Extracting slides…',
        });
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    const kept = slides.filter(Boolean).sort((a, b) => a.time - b.time);

    const pdfPath = path.join(folder, 'slides.pdf');
    buildPdf(
      pdfPath,
      kept.map((s) => ({ file: s.file, label: fmtTime(s.time) }))
    );
    updateMeta(folder, { slideCount: kept.length });
    emit({
      percent: 100,
      message:
        kept.length > 1
          ? `Saved slides.pdf — ${kept.length} slides`
          : 'Saved slides.pdf — cover only, no slide changes detected',
    });
    return { file: pdfPath, count: kept.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function downloadAll(opts, emit) {
  cancelled = false;
  const { url, outputDir, video, transcript, slides, info } = opts;
  const folder = path.join(outputDir, sanitizeName(info.title));
  fs.mkdirSync(folder, { recursive: true });
  writeMeta(folder, info);

  const stages = [];
  if (video.enabled) stages.push('video');
  if (transcript.enabled) stages.push('transcript');
  if (slides.enabled) stages.push('slides');

  const outputs = [];
  let videoFile = null;
  try {
    for (let i = 0; i < stages.length; i++) {
      if (cancelled) throw new Error('Cancelled');
      const stage = stages[i];
      const base = { stage, stageIndex: i, stageCount: stages.length };
      emit({ ...base, percent: 0, message: `Starting ${stage}…` });
      if (stage === 'video') {
        videoFile = await downloadVideo(url, folder, video.height, (e) =>
          emit({ ...base, ...e })
        );
        outputs.push(videoFile);
      } else if (stage === 'transcript') {
        const files = await downloadTranscript(url, folder, transcript.lang, (e) =>
          emit({ ...base, ...e })
        );
        outputs.push(...files);
      } else if (stage === 'slides') {
        if (!videoFile) throw new Error('Slides require the video to be downloaded');
        const result = await extractSlides(
          videoFile, folder, info.duration, (e) => emit({ ...base, ...e })
        );
        if (result) outputs.push(result.file);
      }
    }
  } catch (err) {
    // A failed run must not leave an empty titled folder behind, but never
    // touch a folder that already holds artifacts from an earlier download.
    try {
      const left = fs.readdirSync(folder);
      if (left.length === 1 && left[0] === 'meta.json') {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    } catch {}
    throw err;
  }
  return { folder, outputs };
}

module.exports = {
  isYouTubeUrl,
  fetchInfo,
  parseVideoInfo,
  downloadAll,
  cancelAll,
  sanitizeName,
  findFile,
  srtToText,
};