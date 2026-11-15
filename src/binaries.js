const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const YT_DLP_ASSETS = {
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp_linux',
  win32: 'yt-dlp.exe',
};
const YT_DLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${
  YT_DLP_ASSETS[process.platform] || 'yt-dlp'
}`;

function binDir() {
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unpacked(p) {
  return p.replace('app.asar', 'app.asar.unpacked');
}

function ffmpegPath() {
  return unpacked(require('ffmpeg-static'));
}

function ytDlpPath() {
  return path.join(binDir(), 'yt-dlp');
}

function linkTool(name, target) {
  const link = path.join(binDir(), name);
  try {
    fs.unlinkSync(link);
  } catch {}
  fs.symlinkSync(target, link);
}

function httpDownload(url, dest, onProgress, redirectsLeft = 5, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error('Too many redirects'));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'MyTube/1.0' }, timeout: timeoutMs },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(
            httpDownload(next, dest, onProgress, redirectsLeft - 1, timeoutMs)
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        const tmp = dest + '.part';
        const fail = (err) => {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          reject(err);
        };
        const out = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total && onProgress) {
            onProgress(Math.min(99, Math.round((received / total) * 100)));
          }
        });
        res.on('error', fail);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              fs.renameSync(tmp, dest);
              fs.chmodSync(dest, 0o755);
            } catch (err) {
              fail(err);
              return;
            }
            resolve();
          });
        });
        out.on('error', fail);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}

async function ensureTools(onProgress) {
  linkTool('ffmpeg', ffmpegPath());
  const yt = ytDlpPath();
  if (!fs.existsSync(yt)) {
    if (onProgress) onProgress({ message: 'Downloading yt-dlp…', percent: 0 });
    await httpDownload(YT_DLP_URL, yt, (percent) => {
      if (onProgress) onProgress({ message: 'Downloading yt-dlp…', percent });
    });
  }
  try {
    await execFileAsync(yt, ['--version'], { timeout: 15000 });
  } catch {
    try {
      fs.unlinkSync(yt);
    } catch {}
    throw new Error(
      'yt-dlp is corrupt or not executable. It was removed — try again to re-download it.'
    );
  }
  return { ytDlp: yt, ffmpegDir: binDir() };
}

module.exports = { ensureTools, ytDlpPath, binDir, ffmpegPath, httpDownload };