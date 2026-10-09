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

  // Use the real translation engine with an intentionally failing translator,
  // followed by the page's normal metadata translator. No library writes.
  await worker.evaluate(() => {
    Zotero.Debug.setStore(true);
    Zotero.testOriginalCode = Zotero.Translators.getCodeForTranslator;
    Zotero.Translators.getCodeForTranslator = function(translator) {
      if (translator.translatorID.startsWith('test-failure-')) {
        return Promise.resolve(JSON.stringify({translatorID: translator.translatorID})
          + `;function detectWeb() { return 'journalArticle'; } function doWeb() { throw new Error('${translator.translatorID}'); }`);
      }
      return Zotero.testOriginalCode.call(this, translator);
    };
  });
  try {
    const run = failAll => worker.evaluate(async ({tabID, failAll}) => {
      await browser.scripting.executeScript({target: {tabId: tabID}, func: failAll => {
        Zotero.testOriginalTranslators ||= Zotero.PageSaving.translators;
        const original = Zotero.testOriginalTranslators[0];
        const failing = id => new Zotero.Translator({...original,
          translatorID: id, label: id, inRepository: false, code: undefined});
        Zotero.PageSaving.translators = [failing('test-failure-first'),
          ...(failAll ? [failing('test-failure-last')] : Zotero.testOriginalTranslators)];
      }, args: [failAll]});
      return browser.tabs.sendMessage(tabID, {research: 'extract', metadata: true}, {frameId: 0});
    }, {tabID, failAll});
    const recovered = await run(false);
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.item.title, 'Lifecycle paper');
    assert.ok(recovered.item.creators.length);
    await worker.waitForFunction(async () => (await Zotero.Debug.get()).includes('test-failure-first'));
    const recoveredLogs = await worker.evaluate(() => Zotero.Errors.getErrors());
    assert.equal(recoveredLogs.filter(e => e.includes('test-failure-')).length, 0,
      'A recovered translator failure belongs only in debug output');
    const failed = await run(true);
    assert.match(failed.error, /test-failure-last/);
    await worker.waitForFunction(async () => {
      const errors = await Zotero.Errors.getErrors();
      return ['test-failure-first', 'test-failure-last'].every(id => errors.some(e => e.includes(id)));
    });
    const failedLogs = await worker.evaluate(() => Zotero.Errors.getErrors());
    for (const id of ['test-failure-first', 'test-failure-last']) {
      assert.equal(failedLogs.filter(e => e.includes(id)).length, 1, 'Preserve each failure once when no translator succeeds');
    }
    console.log('PASS: recovered errors stay in debug output; unrecovered errors remain visible with their causes');
  } finally {
    await worker.evaluate(async tabID => {
      Zotero.Translators.getCodeForTranslator = Zotero.testOriginalCode;
      delete Zotero.testOriginalCode;
      await browser.scripting.executeScript({target: {tabId: tabID}, func: () => {
        Zotero.PageSaving.translators = Zotero.testOriginalTranslators;
        delete Zotero.testOriginalTranslators;
      }});
    }, tabID);
  }

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
        return {error: error.message, timeouts, errors: await Zotero.Errors.getErrors()};
      } finally { Zotero.HTTP.request = request; }
    });
    assert.equal(extraction.error, undefined, JSON.stringify(extraction));
    assert.ok(extraction.timeouts, 'Exercise an arXiv API failure');
    assert.equal(extraction.extracted.item.title, 'Toward Open Weight Models Without Risks: Separating Public and Private Capabilities in LLMs');
    assert.ok(extraction.extracted.item.creators.length);
    assert.ok(extraction.extracted.source.pdfURLs.includes('https://arxiv.org/pdf/2606.21638'));
    const arxivErrors = (await worker.evaluate(() => Zotero.Errors.getErrors()))
      .filter(error => error.includes('export.arxiv.org/api/query'));
    assert.deepEqual(arxivErrors, [], 'The recovered arXiv timeout is absent from error reports');
    assert.match(await worker.evaluate(() => Zotero.Debug.get()), /export\.arxiv\.org\/api\/query/,
      'The recovered arXiv timeout remains in debug output');
    console.log('PASS: live arXiv fallback preserves title, authors, and PDF URL without logging a recovered timeout as an error');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
