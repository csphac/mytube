// UI proof of the library delete flow. Requires the app running with
//   npx electron . --remote-debugging-port=9222
// Creates a synthetic library item, then drives: trash icon -> dialog ->
// Escape/Cancel (files kept) -> detail-view Delete -> confirm (files removed).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const probeDir = path.join(os.homedir(), 'Downloads/MyTube/UI Delete Probe');

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
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(
    path.join(probeDir, 'meta.json'),
    JSON.stringify({
      title: 'UI Delete Probe',
      channel: 'test',
      duration: 1,
      downloadedAt: new Date().toISOString(),
    })
  );
  fs.writeFileSync(path.join(probeDir, 'transcript.txt'), 'probe transcript');

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
    fs.writeFileSync(`${__dirname}/${name}.png`, Buffer.from(res.data, 'base64'));
    console.log('saved', name);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = `[...document.querySelectorAll('.lib-item')].find(r => r.querySelector('.lib-title').textContent === 'UI Delete Probe')`;
  const overlayHidden = `document.getElementById('delete-overlay').classList.contains('hidden')`;

  await sleep(1000);
  await evaluate(`document.getElementById('refresh-btn').click(); true;`);
  await sleep(800);
  if (!(await evaluate(`!!${row}`))) throw new Error('probe item not in library');
  console.log('PASS probe item appears in library');

  await evaluate(`${row}.querySelector('.del-btn').focus(); true;`);
  await sleep(200);
  const opacity = await evaluate(`getComputedStyle(${row}.querySelector('.del-btn')).opacity`);
  console.log('trash opacity on focus (want 1):', opacity);
  if (opacity !== '1') throw new Error('trash icon not revealed on focus');
  await shot('ui-delete-01-row');

  await evaluate(`${row}.querySelector('.del-btn').click(); true;`);
  await sleep(300);
  const dlgText = await evaluate(`document.getElementById('delete-text').textContent`);
  console.log('dialog visible (want false):', await evaluate(overlayHidden));
  console.log('dialog text:', dlgText.slice(0, 90));
  if ((await evaluate(overlayHidden)) || !dlgText.includes('UI Delete Probe'))
    throw new Error('delete dialog did not open with the right title');
  await shot('ui-delete-02-dialog');

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true;`);
  await sleep(200);
  console.log('Escape closes dialog (want true):', await evaluate(overlayHidden));
  if (!(await evaluate(overlayHidden))) throw new Error('Escape did not close dialog');

  await evaluate(`${row}.querySelector('.del-btn').click(); true;`);
  await sleep(200);
  await evaluate(`document.getElementById('delete-cancel').click(); true;`);
  await sleep(200);
  console.log('Cancel closes dialog (want true):', await evaluate(overlayHidden));
  console.log('folder intact after cancel (want true):', fs.existsSync(probeDir));
  if (!(await evaluate(overlayHidden)) || !fs.existsSync(probeDir))
    throw new Error('cancel did not keep the download');
  console.log('PASS Escape and Cancel keep the download');

  await evaluate(`${row}.querySelector('.lib-main').click(); true;`);
  await sleep(600);
  console.log('detail title:', await evaluate(`document.getElementById('d-title').textContent`));
  await evaluate(`document.getElementById('d-delete').click(); true;`);
  await sleep(300);
  if (await evaluate(overlayHidden)) throw new Error('detail Delete button did not open dialog');
  await shot('ui-delete-03-detail-dialog');

  await evaluate(`document.getElementById('delete-confirm').click(); true;`);
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (!fs.existsSync(probeDir)) { gone = true; break; }
  }
  console.log('folder removed from disk (want true):', gone);
  await sleep(400);
  const rowGone = await evaluate(`!${row}`);
  const backToDownload = await evaluate(
    `!document.getElementById('download-view').classList.contains('hidden')`
  );
  console.log('row removed (want true):', rowGone);
  console.log('back to download view (want true):', backToDownload);
  console.log('toast:', await evaluate(`document.getElementById('toast').textContent`));
  await shot('ui-delete-04-after');
  if (!gone || !rowGone || !backToDownload) throw new Error('delete flow failed');
  console.log('PASS confirm removes folder, row, and returns to download view');
  console.log('UI DELETE TEST PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('UI DELETE TEST FAIL', err);
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});