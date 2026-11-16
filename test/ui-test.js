const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get('http://127.0.0.1:9222/json', (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails)
      throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };

  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(
      `${__dirname}/${name}.png`,
      Buffer.from(res.data, 'base64')
    );
    console.log('saved', name);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await sleep(1500);
  console.log('tools status:', await evaluate(`document.getElementById('tools-status').textContent`));
  await shot('ui-01-initial');

  await evaluate(`
    document.getElementById('url').value = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    document.getElementById('fetch-btn').click();
    true;
  `);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const visible = await evaluate(`!document.getElementById('info-card').classList.contains('hidden')`);
    if (visible) break;
  }
  console.log('title:', await evaluate(`document.getElementById('title').textContent`));
  console.log('langs:', await evaluate(`document.getElementById('lang').options.length`));
  await shot('ui-02-fetched');

  await evaluate(`
    document.getElementById('opt-slides').checked = true;
    document.getElementById('opt-slides').dispatchEvent(new Event('change'));
    document.getElementById('download-btn').click();
    true;
  `);
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const done = await evaluate(`!document.getElementById('done-panel').classList.contains('hidden') || !document.getElementById('error-panel').classList.contains('hidden')`);
    if (done) break;
    if (i % 10 === 9) {
      console.log('progress:', await evaluate(`document.getElementById('stage-label').textContent + ' ' + document.getElementById('percent-label').textContent`));
      await shot('ui-03-progress-' + i);
    }
  }
  console.log('done text:', await evaluate(`document.getElementById('done-text').textContent`));
  console.log('error text:', await evaluate(`document.getElementById('error-panel').textContent`));
  await shot('ui-04-final');

  await evaluate(`document.getElementById('refresh-btn').click(); true;`);
  await sleep(1000);
  console.log('library items:', await evaluate(`document.querySelectorAll('.lib-item').length`));
  await shot('ui-05-library');

  await evaluate(`document.querySelector('.lib-item .lib-main').click(); true;`);
  await sleep(1500);
  console.log('detail title:', await evaluate(`document.getElementById('d-title').textContent`));
  console.log('slide img naturalWidth:', await evaluate(`(() => { const i = document.querySelector('#d-slide-grid img'); return i ? i.naturalWidth : -1; })()`));
  console.log('transcript preview:', await evaluate(`document.getElementById('d-transcript-text').textContent.slice(0, 60)`));
  await shot('ui-06-detail');

  await evaluate(`document.getElementById('new-download-btn').click(); true;`);
  await sleep(300);
  console.log('back to download view:', await evaluate(`!document.getElementById('download-view').classList.contains('hidden')`));

  console.log('media malformed status (want 400):', await evaluate(`fetch('media://local/%E0%A4%A').then(r => r.status)`));
  console.log('media outside roots status (want 403):', await evaluate(`fetch('media://local/etc/hosts').then(r => r.status)`));
  console.log('media inside roots status (want 200):', await evaluate(`(async () => { const lib = await window.mytube.libraryList(); const s = lib.items[0].slides; const p = s.dir + '/' + s.files[0]; return fetch('media://local' + p.split('/').map(encodeURIComponent).join('/')).then(r => r.status); })()`));

  // Closing the window must not kill an in-flight download on macOS.
  const fs = require('fs');
  const os = require('os');
  const slidesIndex = require('path').join(os.homedir(), 'Downloads/MyTube/Me at the zoo/slides/index.html');
  const before = fs.statSync(slidesIndex).mtimeMs;
  await evaluate(`document.getElementById('download-btn').click(); true;`);
  await sleep(1500);
  await Promise.race([send('Target.closeTarget', { targetId: page.id }), sleep(2000)]);
  let completed = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      if (fs.statSync(slidesIndex).mtimeMs > before) { completed = true; break; }
    } catch {}
  }
  console.log('download completed after window closed (want true):', completed);
  process.exit(completed ? 0 : 1);
}

main().catch((err) => {
  console.error('UI TEST FAIL', err);
  process.exit(1);
});