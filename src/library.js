const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function defaultRoot() {
  return path.join(app.getPath('downloads'), 'MyTube');
}

function getRoots() {
  const settings = loadSettings();
  const roots = [defaultRoot(), ...(settings.outputDirs || [])];
  return [...new Set(roots)];
}

function addRoot(dir) {
  if (dir === defaultRoot()) return;
  const settings = loadSettings();
  const dirs = settings.outputDirs || [];
  if (!dirs.includes(dir)) {
    dirs.push(dir);
    saveSettings({ ...settings, outputDirs: dirs });
  }
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInsideRoots(p) {
  const resolved = realPath(p);
  return getRoots().some((root) => {
    const r = realPath(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function inspectFolder(folder) {
  let files;
  try {
    files = fs.readdirSync(folder);
  } catch {
    return null;
  }
  const videoName = files.find((f) => /^video\.(mp4|mkv|webm|mov)$/.test(f));
  const txtName = files.includes('transcript.txt') ? 'transcript.txt' : null;
  const srtName = files.find((f) => /^transcript\..+\.srt$/.test(f));
  const slidesName = files.find((f) => /^slides.*\.(pdf|pptx)$/i.test(f));
  const slidesDir = path.join(folder, 'slides');
  let slideFiles = [];
  try {
    slideFiles = fs
      .readdirSync(slidesDir)
      .filter((f) => f.endsWith('.jpg'))
      .sort();
  } catch {}

  if (!videoName && !txtName && !srtName && !slidesName && slideFiles.length === 0)
    return null;

  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
  } catch {}

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(folder).mtimeMs;
  } catch {}

  let video = null;
  if (videoName) {
    const file = path.join(folder, videoName);
    try {
      video = { file, size: fs.statSync(file).size };
    } catch {
      video = null;
    }
  }

  return {
    folder,
    title: meta?.title || path.basename(folder),
    channel: meta?.channel || '',
    duration: meta?.duration || 0,
    thumbnail: meta?.thumbnail || null,
    downloadedAt: meta?.downloadedAt || mtimeMs,
    video,
    transcript: {
      txt: txtName ? path.join(folder, txtName) : null,
      srt: srtName ? path.join(folder, srtName) : null,
    },
    slides: {
      file: slidesName ? path.join(folder, slidesName) : null,
      count: meta?.slideCount || slideFiles.length,
      dir: slidesDir,
      files: slideFiles,
      gallery: fs.existsSync(path.join(slidesDir, 'index.html'))
        ? path.join(slidesDir, 'index.html')
        : null,
    },
  };
}

function scanLibrary() {
  const items = [];
  for (const root of getRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const item = inspectFolder(path.join(root, entry.name));
      if (item) items.push(item);
    }
  }
  items.sort((a, b) => b.downloadedAt - a.downloadedAt);
  return items;
}

function readTranscriptPreview(folder) {
  if (!isInsideRoots(folder)) throw new Error('Path outside library folders');
  const txt = path.join(folder, 'transcript.txt');
  const text = fs.readFileSync(txt, 'utf8');
  return text.length > 100000 ? text.slice(0, 100000) + '\n…' : text;
}

function deleteItem(folder) {
  if (!isInsideRoots(folder)) throw new Error('Path outside library folders');
  const resolved = realPath(folder);
  if (getRoots().some((root) => realPath(root) === resolved)) {
    throw new Error('Cannot delete a library root folder');
  }
  if (!inspectFolder(folder)) throw new Error('Not a downloaded item');
  fs.rmSync(folder, { recursive: true, force: true });
}

function writeMeta(folder, info) {
  fs.writeFileSync(
    path.join(folder, 'meta.json'),
    JSON.stringify(
      {
        title: info.title,
        channel: info.channel || '',
        duration: info.duration || 0,
        thumbnail: info.thumbnail || null,
        downloadedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function updateMeta(folder, patch) {
  const file = path.join(folder, 'meta.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...meta, ...patch }, null, 2));
}

module.exports = {
  getRoots,
  addRoot,
  isInsideRoots,
  scanLibrary,
  inspectFolder,
  readTranscriptPreview,
  deleteItem,
  writeMeta,
  updateMeta,
};