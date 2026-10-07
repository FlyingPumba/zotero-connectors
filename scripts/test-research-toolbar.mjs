// Exercise Chrome's toolbar event and real content-script messaging in a temporary profile.
// Only the Zotero backend is stubbed: these tests never save library items or run Codex.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {checkPanelDocking} from './research-panel-docking-checks.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(root + '/package.json');
const {default: puppeteer} = await import(require.resolve('puppeteer'));
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'];
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += 'xref\n0 4\n0000000000 65535 f \n' + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
  + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const server = createServer((req, res) => {
  if (req.url === '/paper.pdf' || req.url.startsWith('/download?')) {
    res.setHeader('Content-Type', 'application/pdf'); res.end(pdf); return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/embedded') { res.end('<!doctype html><title>Embedded PDF</title><iframe src="/paper.pdf"></iframe>'); return; }
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

  await worker.evaluate(() => {
    Zotero.Research.pdfJob = null;
    Zotero.Research.pdfStarts = [];
    Zotero.Research.ordinarySaves = [];
    Zotero.Research.call = async (method, data) => {
      if (method === 'status') return {job: Zotero.Research.pdfJob};
      if (method === 'start') {
        Zotero.Research.pdfStarts.push(data);
        return Zotero.Research.pdfJob = {id: data.requestID, title: data.item.title, status: 'ready',
          stage: 'Ready to discuss', summary: 'A test summary.', messages: [], existingCollections: [], availableCollections: []};
      }
      throw new Error('Unexpected test backend method: ' + method);
    };
    Zotero.Connector_Browser.saveAsWebpage = async (tab, frameId, options) => {
      Zotero.Research.ordinarySaves.push({url: tab.url, frameId, options});
    };
  });
  const base = new URL(url).origin;
  const cases = [['entry', base + '/paper.pdf'], ['pdf', base + '/download?id=123'], ['ordinary', base + '/paper.pdf']];
  if (process.argv.includes('--live-pdf')) cases.push(['entry', 'https://www.bu.edu/teaching-writing/files/2020/03/Sentence-Clarity-Script.pdf']);
  for (const [mode, pdfURL] of cases) {
    const pdfPage = await browser.newPage();
    await pdfPage.goto(pdfURL);
    const pdfTabID = await worker.evaluate(async url => (await browser.tabs.query({url}))[0].id, pdfURL);
    await worker.waitForFunction(id => Zotero.Connector_Browser.getTabInfo(id).isPDF, {timeout: 15000}, pdfTabID);
    const info = await worker.evaluate(id => Zotero.Connector_Browser.getTabInfo(id), pdfTabID);
    assert.ok(!info.frameId, 'This is a top-level PDF, not an embedded frame');
    await worker.evaluate(() => { Zotero.Research.pdfJob = null; Zotero.Research.ordinarySaves = []; });
    const targets = await client.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}]});
    const pdfTarget = targets.targetInfos.find(t => t.url === pdfURL).targetId;
    await client.send('Extensions.triggerAction', {id, targetId: pdfTarget});
    const pdfPanel = await pdfPage.waitForFrame(f => f.url().includes('/research/panel.html'));
    await pdfPanel.waitForFunction(() => document.getElementById('progress').hidden);
    assert.equal(await worker.evaluate(() => Zotero.Research.ordinarySaves.length), 0, 'Opening the toolbar must not save a PDF automatically');
    assert.equal(await pdfPanel.$eval('#entry', n => n.getClientRects().length > 0), true);
    assert.equal(await pdfPanel.$eval('#pdf', n => n.getClientRects().length > 0), true);
    assert.equal(await pdfPanel.$eval('#ordinary', n => n.getClientRects().length > 0), true);
    await pdfPanel.locator('#' + mode).click();
    if (mode === 'ordinary') {
      await worker.waitForFunction(() => Zotero.Research.ordinarySaves.length === 1);
      const [saved] = await worker.evaluate(() => Zotero.Research.ordinarySaves);
      assert.equal(saved.url, pdfURL);
      assert.equal(saved.frameId, info.frameId);
      assert.deepEqual(saved.options, {snapshot: true}, 'Usual workflow keeps the original PDF save options');
    } else {
      await pdfPanel.waitForFunction(() => job?.status === 'ready' && !busy);
      const request = await worker.evaluate(() => Zotero.Research.pdfStarts.at(-1));
      assert.equal(request.mode, mode);
      assert.ok(request.item.title && request.requestID);
      assert.equal(request.item.itemType, 'webpage', 'Direct PDFs reach the existing native metadata recognizer');
      assert.equal(request.source.url, pdfURL);
      assert.ok(request.source.pdfURLs.includes(pdfURL), 'The actual PDF URL reaches text extraction');
      assert.equal(await worker.evaluate(() => Zotero.Research.ordinarySaves.length), 0);
      if (mode === 'entry' && pdfURL.startsWith(base)) await checkPanelDocking(pdfPage, pdfPanel);
    }
    await pdfPage.close();
    console.log(`PASS: PDF toolbar ${mode} opens the research panel and follows the selected workflow (${pdfURL})`);
  }
  const embedded = await browser.newPage();
  const embeddedURL = base + '/embedded';
  await embedded.goto(embeddedURL);
  const embeddedID = await worker.evaluate(async url => (await browser.tabs.query({url}))[0].id, embeddedURL);
  await worker.waitForFunction(id => Zotero.Connector_Browser.getTabInfo(id).frameId > 0, {timeout: 15000}, embeddedID);
  await worker.evaluate(async id => {
    Zotero.Research.ordinarySaves = [];
    await Zotero.Connector_Browser.onZoteroButtonElementClick(await browser.tabs.get(id));
  }, embeddedID);
  await worker.waitForFunction(() => Zotero.Research.ordinarySaves.length === 1);
  assert.ok(await worker.evaluate(() => Zotero.Research.ordinarySaves[0].frameId > 0), 'Embedded PDFs retain their frame-specific save path');
  assert.equal(embedded.frames().some(f => f.url().includes('/research/panel.html')), false);
  await embedded.close();
  assert.deepEqual(errors, []);
  console.log('PASS: embedded PDF saving remains unchanged');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
