// Run the built connector and real DOI detection without Zotero writes or model calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import puppeteer from 'puppeteer';

const doiTranslatorID = 'c159dcfe-8a53-4301-a499-30f6549c340d';
const title = 'Reviewer Tutorial 2022';
const tutorial = 'This tutorial describes the review process and the expectations we have for ICML reviewers.';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>${title}</title><h1>Reviewer Tutorial</h1><p>${tutorial}</p>
    <p>Additional resources: <a href="https://agupubs.onlinelibrary.wiley.com/doi/epdf/10.1029/2011EO280001">A cited article</a></p>`);
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
    Zotero.Research.webpageTest = {saves: [], checks: []};
    Zotero.Research.call = async (method, data) => {
      const state = Zotero.Research.webpageTest;
      if (method === 'status') return {job: state.job || null};
      if (method === 'settings') return {model: 'test', effort: 'high', models: []};
      if (method === 'duplicates') { state.checks.push(data); return {matches: []}; }
      if (method === 'start') {
        state.saves.push(data);
        return state.job = {id: data.requestID, mode: data.mode, status: 'ready', title: data.item.title,
          summary: '', messages: [], existingCollections: [], availableCollections: []};
      }
      throw new Error('Unexpected native call: ' + method);
    };
  });
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${server.address().port}/ReviewerTutorial`;
  async function detect(sourceURL) {
    await page.goto(sourceURL, {waitUntil: 'domcontentloaded'});
    return worker.evaluate(async sourceURL => {
      const tab = (await browser.tabs.query({url: sourceURL}))[0];
      await Zotero.Connector_Browser.injectTranslationScripts(tab);
      const [{result: translators}] = await browser.scripting.executeScript({target: {tabId: tab.id}, func: async () => {
        await Zotero.PageSaving.onPageLoad();
        return Zotero.PageSaving.translators.map(({translatorID, itemType}) => ({translatorID, itemType}));
      }});
      return {tabID: tab.id, translators};
    }, sourceURL);
  }
  const sources = [url];
  if (process.argv.includes('--live')) sources.push('https://icml.cc/Conferences/2022/ReviewerTutorial');
  for (const sourceURL of sources) {
    const {tabID, translators} = await detect(sourceURL);
    assert.deepEqual(translators, [{translatorID: doiTranslatorID, itemType: 'multiple'}], 'A reference triggers the real DOI multi-item detector');
    for (const mode of ['categorize', 'entry']) {
      await worker.evaluate(async tabID => {
        Zotero.Research.webpageTest = {saves: [], checks: []};
        await Zotero.Research.show(await browser.tabs.get(tabID));
      }, tabID);
      const panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
      await panel.waitForFunction(() => !document.getElementById('ingestionModel').disabled);
      await panel.locator('#' + mode).click();
      await panel.waitForFunction(() => (job?.status === 'ready' && !busy) || !document.getElementById('error').hidden);
      assert.equal(await panel.$eval('#error', node => node.textContent), '', 'The page import should succeed');
      const state = await worker.evaluate(() => Zotero.Research.webpageTest);
      assert.equal(state.saves.length, 1);
      const saved = state.saves[0];
      assert.equal(saved.mode, mode);
      assert.equal(saved.item.itemType, 'webpage');
      assert.equal(saved.item.title, title);
      assert.equal(saved.item.url, sourceURL);
      assert.equal(saved.item.DOI, undefined, 'Do not attribute a cited paper\'s DOI to the tutorial');
      assert.deepEqual(saved.item.attachments, []);
      assert.equal(saved.source.url, sourceURL);
      assert.ok(saved.source.pageText.includes(tutorial));
      assert.deepEqual(saved.source.pdfURLs, [], 'A cited PDF is not the tutorial\'s PDF');
      assert.deepEqual(state.checks[0].items, [saved.item], 'Duplicate detection checks the page being saved');
      await panel.locator('#close').click();
      await page.waitForFunction(() => !document.querySelector('iframe[src*="research/panel.html"]'));
    }
    const [{result: after}] = await worker.evaluate(tabID => browser.scripting.executeScript({target: {tabId: tabID},
      func: () => Zotero.PageSaving.translators.map(({translatorID, itemType}) => ({translatorID, itemType}))}), tabID);
    assert.deepEqual(after, translators, 'Leave the ordinary Zotero translator choices intact');
    console.log(`PASS: both Add entry actions submit the tutorial itself, its text, and duplicate metadata: ${sourceURL}`);
  }

  // Preserve actual list detection and single-paper translation, including DOI URLs.
  const {tabID} = await detect(url);
  const translatedItem = {itemType: 'journalArticle', title: 'An individual paper', DOI: '10.5555/paper', attachments: []};
  async function extractWith(translators) {
    return worker.evaluate(async ({tabID, translators, translatedItem}) => {
      await browser.scripting.executeScript({target: {tabId: tabID}, args: [translators, translatedItem], func: (translators, item) => {
        Zotero.PageSaving.translators = translators;
        Zotero.PageSaving._initTranslate = async () => ({});
        Zotero.TranslateWeb.translate = async options => {
          if (JSON.stringify(options.translators) !== JSON.stringify(translators)) throw new Error('Single-paper translator fallbacks changed');
          return {items: [item]};
        };
      }});
      return browser.tabs.sendMessage(tabID, {research: 'extract', metadata: true}, {frameId: 0});
    }, {tabID, translators, translatedItem});
  }
  assert.match((await extractWith([{translatorID: 'site-paper-list', itemType: 'multiple'}])).error, /Open an individual paper/);
  assert.deepEqual((await extractWith([{translatorID: doiTranslatorID, itemType: 'journalArticle'}])).item, translatedItem);
  assert.deepEqual((await extractWith([{translatorID: 'site-paper', itemType: 'journalArticle'},
    {translatorID: doiTranslatorID, itemType: 'multiple'}])).item, translatedItem);
  console.log('PASS: site-specific paper lists and single-paper translators retain their existing behavior');
} catch (error) {
  for (const page of await browser.pages()) for (const frame of page.frames()) {
    if (frame.url().includes('/research/panel.html')) console.error('Panel at failure:', await frame.evaluate(() => ({
      text: document.body.innerText, busy, job, connection: document.body.dataset.connection
    })).catch(error => error.message));
  }
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
