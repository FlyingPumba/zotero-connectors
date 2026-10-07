// Exercise ordinary PDF saves and extension reloads in isolated Chrome profiles.
// Only Zotero backend calls are stubbed; no library items or research jobs are created.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
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
  res.setHeader('Content-Type', 'application/pdf');
  res.end(pdf);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/paper`;
const cases = ['normal', 'reload-before-close', 'reload-while-open'];
try {
  for (const mode of cases) {
    const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome', enableExtensions: true});
    const errors = [];
    try {
      const page = await browser.newPage();
      const diagnostics = await page.createCDPSession();
      diagnostics.on('Runtime.exceptionThrown', ({exceptionDetails}) => {
        errors.push(exceptionDetails.exception?.description || exceptionDetails.text);
      });
      diagnostics.on('Runtime.consoleAPICalled', e => {
        if (e.type === 'error') errors.push(e.args.map(a => a.value || a.description).join(' '));
      });
      await diagnostics.send('Runtime.enable');
      await browser.installExtension(root + '/build/manifestv3');
      const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'));
      const worker = await target.worker();
      await worker.evaluate(async () => {
        await Zotero.initDeferred.promise;
        await Zotero.Prefs.set('firstUse', false);
        Zotero.pdfSaveTest = {saves: [], syncDelays: 0};
        Zotero.Connector.checkIsOnline = async () => true;
        Zotero.Connector.callMethod = async (options, data) => {
          const method = typeof options === 'string' ? options : options.method;
          if (method === 'getSelectedCollection') return {
            id: 'L1', libraryID: 1, name: 'My Library', libraryEditable: true, filesEditable: true,
            targets: [{id: 'L1', name: 'My Library', level: 0, filesEditable: true}], tags: {}
          };
          if (method === 'saveStandaloneAttachment') {
            Zotero.pdfSaveTest.saves.push({metadata: JSON.parse(options.headers['X-Metadata']), bytes: data.byteLength});
            return {canRecognize: false};
          }
          if (method === 'delaySync') { Zotero.pdfSaveTest.syncDelays++; return {}; }
          throw new Error('Unexpected backend call: ' + method);
        };
        Zotero.Research.call = async () => { throw new Error('An ordinary save must not start research'); };
      });
      const pdfURL = new URL('/paper.pdf', url).href;
      await page.goto(pdfURL);
      const tabID = await worker.evaluate(async url => (await browser.tabs.query({url}))[0].id, pdfURL);
      await worker.waitForFunction(id => Zotero.Connector_Browser.getTabInfo(id).isPDF, {timeout: 15000}, tabID);
      await worker.evaluate(async tabID => {
        // Capture the real right-click handler when the menu is rebuilt. Chrome ignores
        // duplicate registration of the same callback; restore its event methods afterward.
        const event = browser.contextMenus.onClicked;
        const {hasListener, addListener} = event;
        try {
          event.hasListener = () => false;
          event.addListener = callback => { Zotero.pdfSaveTest.click = callback; addListener.call(event, callback); };
          const tab = await browser.tabs.get(tabID);
          await Zotero.Connector_Browser._updateExtensionUI(tab);
          await Zotero.pdfSaveTest.click({menuItemId: 'zotero-context-menu-pdf-save'}, tab);
        } finally {
          event.hasListener = hasListener;
          event.addListener = addListener;
        }
      }, tabID);
      await worker.waitForFunction(() => Zotero.pdfSaveTest.saves.length === 1);
      const popup = await page.waitForFrame(f => f.url().includes('progressWindow/progressWindow.html'));
      await popup.waitForSelector('select');
      const iframe = await popup.frameElement();
      assert.equal(await iframe.evaluate(n => n.style.display), 'block');
      const [save] = await worker.evaluate(() => Zotero.pdfSaveTest.saves);
      assert.equal(save.metadata.url, pdfURL);
      assert.equal(save.metadata.contentType, 'application/pdf');
      assert.equal(save.bytes, Buffer.byteLength(pdf), 'The real PDF fetch and upload preparation still run');
      assert.equal(page.frames().some(f => f.url().includes('research/panel.html')), false);
      if (mode === 'reload-while-open') {
        // Hovering keeps the actual save popup open and cancels its auto-close timer.
        await worker.evaluate(id => Zotero.Messaging.sendMessage('progressWindowIframe.mouseenter', null, id), tabID);
        await worker.waitForFunction(() => Zotero.pdfSaveTest.syncDelays > 0, {timeout: 12000});
        assert.equal(await iframe.evaluate(n => n.style.display), 'block');
      }
      assert.equal(await worker.evaluate(() => Zotero.pdfSaveTest.saves.length), 1);
      assert.deepEqual(errors, []);
      if (mode !== 'normal') await browser.installExtension(root + '/build/manifestv3');
      await page.waitForFunction(n => n.style.display === 'none', {timeout: 12000}, iframe);
      // Flush the queued iframe update, which used to reject after the popup hid.
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(errors, [], mode);
      console.log(`PASS: ordinary PDF save and popup lifecycle (${mode})`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
