const { app } = require('electron');
const path = require('path');
const { ensureTools } = require('../src/binaries');
const { fetchInfo, downloadAll } = require('../src/downloader');

app.whenReady().then(async () => {
  try {
    await ensureTools((p) => console.log('TOOLS', JSON.stringify(p)));
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    const info = await fetchInfo(url);
    console.log(
      'INFO',
      JSON.stringify({
        title: info.title,
        duration: info.duration,
        languages: info.languages.slice(0, 5),
      })
    );
    const outDir = path.join(__dirname, 'output');
    const result = await downloadAll(
      {
        url,
        outputDir: outDir,
        info: { title: info.title, duration: info.duration },
        video: { enabled: true, height: 360 },
        transcript: { enabled: true, lang: info.languages[0]?.code || 'en' },
        slides: { enabled: true },
      },
      (e) => console.log('EVENT', JSON.stringify(e))
    );
    console.log('RESULT', JSON.stringify(result));
    app.exit(0);
  } catch (err) {
    console.error('FAIL', err);
    app.exit(1);
  }
});