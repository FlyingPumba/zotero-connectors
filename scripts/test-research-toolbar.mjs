// Exercise Chrome's toolbar event and real content-script messaging in a temporary profile.
// Only the Zotero backend is stubbed: these tests never save library items or run Codex.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(root + '/package.json');
const {default: puppeteer} = await import(require.resolve('puppeteer'));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Toolbar test paper</title><h1>Toolbar test paper</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/paper`;
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome', enableExtensions: true});
const errors = [];
try {
  // This tab must predate the extension: navigating after installation hides the bug.
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(() => { window.paperPageMarker = 'preserve this page'; });
  const id = await browser.installExtension(root + '/build/manifestv3');
  const client = await browser.target().createCDPSession();
  const {targetInfos} = await client.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}]});
  const tabTarget = targetInfos.find(t => t.url === url).targetId;
  async function initializeWorker() {
    const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'));
    const diagnostics = await target.createCDPSession();
    diagnostics.on('Runtime.exceptionThrown', ({exceptionDetails}) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
    diagnostics.on('Runtime.consoleAPICalled', event => {
      if (event.type === 'error') errors.push(event.args.map(a => a.description || a.value).join(' '));
    });
    await diagnostics.send('Runtime.enable');
    const worker = await target.worker();
    await worker.evaluate(async () => {
      await Zotero.initDeferred.promise;
      await Zotero.Prefs.set('firstUse', false);
      Zotero.Research.call = async () => ({job: null});
      Zotero.Research.toolbarCompleted = 0;
      const show = Zotero.Research.show;
      Zotero.Research.show = async function(tab) {
        const result = await show.call(this, tab);
        this.toolbarCompleted++;
        return result;
      };
    });
    return worker;
  }
  const worker = await initializeWorker();
  const tabID = await worker.evaluate(async url => (await browser.tabs.query({url}))[0].id, url);
  async function openFromToolbar(clicks = 1) {
    const before = await worker.evaluate(() => Zotero.Research.toolbarCompleted);
    for (let i = 0; i < clicks; i++) {
      await client.send('Extensions.triggerAction', {id, targetId: tabTarget});
    }
    try {
      await worker.waitForFunction(expected => Zotero.Research.toolbarCompleted === expected,
        {timeout: 15000}, before + clicks);
    } catch (error) {
      throw new Error(`Toolbar did not complete: ${errors.join('\n') || error.message}`);
    }
    const panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
    await panel.waitForFunction(() => !document.getElementById('entry').hidden && document.getElementById('progress').hidden);
    assert.equal(page.frames().filter(f => f.url().includes('/research/panel.html')).length, 1);
    assert.equal(await page.evaluate(() => window.paperPageMarker), 'preserve this page');
    assert.deepEqual(errors, []);
    return panel;
  }
  async function closePanel(panel) {
    await panel.click('#close');
    await worker.waitForFunction(async id => {
      const frames = await browser.webNavigation.getAllFrames({tabId: id});
      return !frames.some(f => f.url.includes('/research/panel.html'));
    }, {}, tabID);
  }
  assert.equal(await worker.evaluate(id => Zotero.Messaging.sendMessage('ping', null, id), tabID), undefined);
  let panel = await openFromToolbar(2);
  await closePanel(panel);
  console.log('PASS: rapid toolbar clicks on a pre-existing tab complete and open one panel without reloading the page');

  panel = await openFromToolbar();
  await closePanel(panel);
  console.log('PASS: toolbar reopens the panel using existing listeners');

  await page.reload();
  await page.evaluate(() => { window.paperPageMarker = 'preserve this page'; });
  panel = await openFromToolbar();
  await closePanel(panel);
  console.log('PASS: toolbar still opens on a freshly loaded page');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
