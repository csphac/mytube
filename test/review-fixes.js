// Regression suite for the code-review fixes. Run:
//   NODE_TLS_REJECT_UNAUTHORIZED=0 npx electron test/review-fixes.js
// The env var only affects this test process (local self-signed fault servers).
const { app } = require('electron');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mytube-review-'));
app.setPath('userData', path.join(tmp, 'userData'));

const {
  downloadAll,
  parseVideoInfo,
  sanitizeName,
  findFile,
  srtToText,
} = require('../src/downloader');
const { ensureTools, ytDlpPath, binDir, httpDownload } = require('../src/binaries');
const { addRoot, isInsideRoots, inspectFolder } = require('../src/library');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

function faultServer(handler) {
  const key = path.join(tmp, 'key.pem');
  const cert = path.join(tmp, 'cert.pem');
  if (!fs.existsSync(cert)) {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 1 -subj "/CN=localhost" 2>/dev/null`
    );
  }
  const server = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    handler
  );
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const noStages = { video: { enabled: false }, transcript: { enabled: false }, slides: { enabled: false } };

async function main() {
  await test('1 dot-only titles cannot escape the output folder', async () => {
    for (const title of ['..', '.', '...', undefined]) {
      const out = path.join(tmp, 'out-' + String(title));
      const res = await downloadAll(
        { url: 'https://youtu.be/x', outputDir: out, info: { title }, ...noStages },
        () => {}
      );
      assert.equal(res.folder, path.join(out, 'video'));
      assert.ok(fs.existsSync(path.join(res.folder, 'meta.json')));
      assert.ok(!fs.existsSync(path.join(tmp, 'video.mp4')));
      assert.ok(!fs.existsSync(path.join(tmp, 'meta.json')));
    }
    assert.equal(sanitizeName('..'), 'video');
    assert.equal(sanitizeName('a/b:c'), 'abc');
  });

  await test('3 playlist JSON rejected with a clear message', async () => {
    assert.throws(() => parseVideoInfo({ _type: 'playlist', entries: [{}] }), /playlist/i);
    assert.throws(() => parseVideoInfo({ entries: [] }), /playlist/i);
    const ok = parseVideoInfo({ id: 'x', title: 'T', subtitles: {}, automatic_captions: {} });
    assert.equal(ok.title, 'T');
  });

  await test('4 findFile prefers merged container over newer fragment', async () => {
    const dir = path.join(tmp, 'findfile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'video.mp4'), 'merged');
    fs.writeFileSync(path.join(dir, 'video.f251.webm'), 'fragment');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(dir, 'video.mp4'), old, old);
    const picked = findFile(dir, 'video', ['.mp4', '.mkv', '.webm', '.mov']);
    assert.equal(picked, path.join(dir, 'video.mp4'));
    fs.unlinkSync(path.join(dir, 'video.mp4'));
    assert.equal(findFile(dir, 'video', ['.mp4']), path.join(dir, 'video.f251.webm'));
  });

  await test('11 srt entities decoded once, ampersand last', async () => {
    const srt = '1\n00:00:00,000 --> 00:00:01,000\n&amp;lt;b&amp;gt; hi &amp; bye\n\n';
    assert.equal(srtToText(srt), '&lt;b&gt; hi & bye');
  });

  await test('7 vanished video file degrades to item without video, not a crash', async () => {
    const folder = path.join(tmp, 'race', 'Some Video');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'video.mp4'), 'x');
    fs.writeFileSync(path.join(folder, 'transcript.txt'), 'hello');
    const orig = fs.statSync;
    fs.statSync = (p, ...rest) => {
      if (String(p).endsWith('video.mp4')) throw new Error('ENOENT (simulated)');
      return orig(p, ...rest);
    };
    try {
      const item = inspectFolder(folder);
      assert.equal(item.video, null);
      assert.ok(item.transcript.txt.endsWith('transcript.txt'));
    } finally {
      fs.statSync = orig;
    }
  });

  await test('15 symlink escaping a library root is rejected', async () => {
    const root = path.join(tmp, 'roots');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'ok.jpg'), 'x');
    fs.symlinkSync('/etc/hosts', path.join(root, 'escape'));
    addRoot(root);
    assert.equal(isInsideRoots(path.join(root, 'ok.jpg')), true);
    assert.equal(isInsideRoots(path.join(root, 'escape')), false);
    assert.equal(isInsideRoots('/etc/hosts'), false);
    assert.equal(isInsideRoots(path.join(root, '..', 'key.pem')), false);
  });

  await test('12 hanging server: download times out instead of hanging forever', async () => {
    const server = await faultServer(() => {});
    const port = server.address().port;
    const dest = path.join(tmp, 'hang.bin');
    await assert.rejects(
      httpDownload(`https://127.0.0.1:${port}/x`, dest, null, 5, 400),
      /timed out/i
    );
    server.close();
  });

  await test('2 connection killed mid-body: clean rejection, no crash, no .part left', async () => {
    const server = await faultServer((req, res) => {
      res.writeHead(200, { 'content-length': '1000000' });
      res.write('x'.repeat(1024));
      setTimeout(() => res.socket.destroy(), 30);
    });
    const port = server.address().port;
    const dest = path.join(tmp, 'reset.bin');
    await assert.rejects(
      httpDownload(`https://127.0.0.1:${port}/x`, dest, null, 5, 5000),
      /aborted|reset|premature|socket/i
    );
    assert.ok(!fs.existsSync(dest + '.part'));
    assert.ok(!fs.existsSync(dest));
    server.close();
    // reaching this line proves the main process survived the stream error
  });

  await test('8 failed download removes its empty folder', async () => {
    if (!fs.existsSync(ytDlpPath())) {
      const real = path.join(
        os.homedir(),
        'Library/Application Support/mytube/bin/yt-dlp'
      );
      if (fs.existsSync(real)) {
        fs.mkdirSync(binDir(), { recursive: true });
        fs.copyFileSync(real, ytDlpPath());
        fs.chmodSync(ytDlpPath(), 0o755);
      } else {
        await ensureTools();
      }
    }
    const out = path.join(tmp, 'fail-out');
    await assert.rejects(
      downloadAll(
        {
          url: 'https://www.youtube.com/watch?v=00000000000',
          outputDir: out,
          info: { title: 'Fail Case', duration: 0 },
          video: { enabled: true, height: 360 },
          transcript: { enabled: false },
          slides: { enabled: false },
        },
        () => {}
      )
    );
    assert.ok(!fs.existsSync(path.join(out, 'Fail Case')));
  });

  await test('12 corrupt yt-dlp binary is detected, removed, and reported', async () => {
    fs.mkdirSync(binDir(), { recursive: true });
    fs.writeFileSync(ytDlpPath(), 'this is not a binary');
    await assert.rejects(ensureTools(), /corrupt/i);
    assert.ok(!fs.existsSync(ytDlpPath()));
  });

  console.log(failures === 0 ? 'ALL REVIEW-FIX TESTS PASSED' : `${failures} FAILURES`);
  app.exit(failures === 0 ? 0 : 1);
}

app.whenReady().then(main);