// Exercise the built extension's real offscreen bridge and Chrome tab lifecycle.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import puppeteer from 'puppeteer';
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Lifecycle paper</title><meta name="citation_title" content="Lifecycle paper"><meta name="citation_author" content="Researcher, A"><h1>Lifecycle paper</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome',
  enableExtensions: [process.cwd() + '/build/manifestv3']});
try {
  const worker = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'))).worker();
  await worker.evaluate(async () => {
    await Zotero.initDeferred.promise;
    await Zotero.Prefs.set('firstUse', false);
    await Zotero.Prefs.set('connector.url', 'http://127.0.0.1:1/');
  });
  const page = await browser.newPage(), url = `http://127.0.0.1:${server.address().port}/paper`;
  await page.goto(url, {waitUntil: 'load'});
  const tabID = await worker.evaluate(async url => {
    const tab = (await browser.tabs.query({url}))[0];
    await Zotero.Connector_Browser.injectTranslationScripts(tab);
    return tab.id;
  }, url);
  const initialize = await worker.evaluate(async tabID => {
    const [{result}] = await browser.scripting.executeScript({target: {tabId: tabID}, func: async () => {
      await Zotero.PageSaving.onPageLoad();
      window.lifecycleTranslate = await Zotero.PageSaving._initTranslate();
      return (await window.lifecycleTranslate.getTranslators(true)).map(t => t.translatorID);
    }});
    return result;
  }, tabID);
  assert.ok(initialize.length, 'The real translator bridge detects the paper');
  await worker.evaluate(() => Zotero.OffscreenManager.cleanup());
  const after = await worker.evaluate(async tabID => {
    const [{result}] = await browser.scripting.executeScript({target: {tabId: tabID}, func: async () =>
      (await window.lifecycleTranslate.getTranslators(true)).map(t => t.translatorID)});
    return result;
  }, tabID);
  assert.deepEqual(after, initialize, 'The same virtual translator still works after periodic cleanup');
  const extracted = await worker.evaluate(tabID => browser.tabs.sendMessage(tabID, {research: 'extract', metadata: true}, {frameId: 0}), tabID);
  assert.equal(extracted.error, undefined);
  assert.equal(extracted.item.title, 'Lifecycle paper');
  assert.ok(extracted.item.creators.length);
  console.log('PASS: real offscreen detection and research metadata extraction survive cleanup');
  const late = await worker.evaluate(async () => {
    const tab = await browser.tabs.create({url: 'about:blank', active: false});
    await browser.tabs.remove(tab.id);
    return {
      handler: await Zotero.Messaging.sendMessage('Translate.onHandler.done', [], tab.id, 0),
      frame: await Zotero.Messaging.sendToZoteroFrames('progressWindow.close', [], tab.id)
    };
  });
  assert.equal(late.handler, undefined); assert.equal(late.frame, undefined);
  console.log('PASS: late translator and UI messages after a real tab closes do not throw');

  if (process.argv.includes('--live-arxiv')) {
    const extraction = await worker.evaluate(async () => {
      const request = Zotero.HTTP.request;
      let timeouts = 0;
      Zotero.HTTP.request = async (method, url, ...args) => {
        if (url.startsWith('https://export.arxiv.org/api/query')) {
          timeouts++;
          throw new Zotero.HTTP.TimeoutError(url, 15000);
        }
        return request.call(Zotero.HTTP, method, url, ...args);
      };
      try {
        return {extracted: await Zotero.Research.extractPaper('https://arxiv.org/abs/2606.21638'), timeouts};
      } catch (error) {
        return {error: error.message, timeouts, errors: Zotero.Errors.getErrors()};
      } finally { Zotero.HTTP.request = request; }
    });
    assert.equal(extraction.error, undefined, JSON.stringify(extraction));
    assert.ok(extraction.timeouts, 'Exercise an arXiv API failure');
    assert.equal(extraction.extracted.item.title, 'Toward Open Weight Models Without Risks: Separating Public and Private Capabilities in LLMs');
    assert.ok(extraction.extracted.item.creators.length);
    assert.ok(extraction.extracted.source.pdfURLs.includes('https://arxiv.org/pdf/2606.21638'));
    console.log('PASS: live arXiv page retains title, authors, and PDF URL through the existing API-timeout fallback');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
