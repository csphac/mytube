const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ytDlpPath, binDir } = require('./binaries');
const { writeMeta } = require('./library');

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

function run(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (cancelled) return reject(new Error('Cancelled'));
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let errLineBuf = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
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

async function extractSlides(videoFile, folder, threshold, duration, emit) {
  const slidesDir = path.join(folder, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  emit({ percent: 0, message: 'Extracting slides…' });
  const times = [];
  const args = [
    '-hide_banner',
    '-i', videoFile,
    '-vf', `select='eq(n,0)+gt(scene,${threshold})',showinfo`,
    '-fps_mode', 'vfr',
    '-q:v', '2',
    path.join(slidesDir, 'slide_%04d.jpg'),
  ];
  await run(binDir() + '/ffmpeg', args, {
    onLine: (line) => {
      const pts = line.match(/pts_time:([\d.]+)/);
      if (pts) times.push(Number(pts[1]));
      const t = line.match(/time=(\d+):(\d+):([\d.]+)/);
      if (t && duration) {
        const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        emit({
          percent: Math.min(99, Math.round((secs / duration) * 100)),
          message: 'Extracting slides…',
        });
      }
    },
  });

  const files = fs
    .readdirSync(slidesDir)
    .filter((f) => /^slide_\d+\.jpg$/.test(f))
    .sort();
  const slides = [];
  files.forEach((file, i) => {
    const time = times[i] != null ? times[i] : null;
    const newName =
      time != null
        ? `slide_${String(i + 1).padStart(4, '0')}_${fmtTime(time)}.jpg`
        : file;
    if (newName !== file) {
      fs.renameSync(path.join(slidesDir, file), path.join(slidesDir, newName));
    }
    slides.push({ file: newName, time });
  });

  const html = [
    '<!doctype html><meta charset="utf-8"><title>Slides</title>',
    '<style>body{font-family:system-ui;background:#111;color:#eee;margin:24px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}',
    'figure{margin:0}img{width:100%;border-radius:8px}figcaption{color:#999;font-size:13px;margin-top:4px}</style>',
    `<h1>Slides (${slides.length})</h1><div class="grid">`,
    ...slides.map(
      (s) =>
        `<figure><img src="${s.file}" loading="lazy"><figcaption>${
          s.time != null ? fmtTime(s.time).replace(/-/g, ':') : ''
        }</figcaption></figure>`
    ),
    '</div>',
  ].join('\n');
  fs.writeFileSync(path.join(slidesDir, 'index.html'), html);
  fs.writeFileSync(
    path.join(slidesDir, 'slides.json'),
    JSON.stringify(slides, null, 2)
  );
  emit({ percent: 100, message: `Extracted ${slides.length} slides` });
  return slidesDir;
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
        const dir = await extractSlides(
          videoFile, folder, slides.threshold, info.duration, (e) =>
            emit({ ...base, ...e })
        );
        outputs.push(dir);
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