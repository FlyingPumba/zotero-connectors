import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import puppeteer from 'puppeteer';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Duplicate test paper</title><h1>Duplicate test paper</h1><p>Paper content</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome',
  enableExtensions: [process.cwd() + '/build/manifestv3'], defaultViewport: {width: 1100, height: 800}});
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'));
  const worker = await target.worker();
  await worker.evaluate(async () => {
    await Zotero.initDeferred.promise;
    await Zotero.Prefs.set('firstUse', false);
    Zotero.Research.duplicateTest = {saves: [], checks: [], matches: [{key: 'EXISTING', title: 'The saved paper', library: 'My Library'}]};
    Zotero.Research.call = async (method, data) => {
      const state = Zotero.Research.duplicateTest;
      if (method === 'status') return {job: state.job || null};
      if (method === 'settings') return {model: 'test', effort: 'high', models: []};
      if (method === 'duplicates') { state.checks.push(data); return {matches: state.matches}; }
      if (method === 'start') {
        state.saves.push(data);
        return state.job = {id: data.requestID, mode: data.mode, status: 'ready', title: data.item.title,
          summary: '', messages: [], existingCollections: [], availableCollections: []};
      }
    };
  });
  let serial = 0;
  const open = async kind => {
    const page = await browser.newPage(), url = `http://127.0.0.1:${server.address().port}/${kind}-${++serial}`;
    await page.goto(url);
    const tabID = await worker.evaluate(async url => (await browser.tabs.query({url}))[0].id, url);
    await worker.evaluate(async ({tabID, kind}) => {
      Zotero.Research.duplicateTest.saves = []; Zotero.Research.duplicateTest.checks = []; Zotero.Research.duplicateTest.job = null;
      await Zotero.Research.show(await browser.tabs.get(tabID));
      // Keep real PageSaving and its duplicate checks. Stub only translation and
      // final storage, so the test can assert zero writes before confirmation.
      await browser.scripting.executeScript({target: {tabId: tabID}, func: kind => {
        Zotero.Inject.checkActionToServer = async () => true;
        Zotero.PageSaving.duplicateWrites = [];
        Zotero.PageSaving._saveAsWebpage = async data => { Zotero.PageSaving.duplicateWrites.push(data); return {ok: true}; };
        Zotero.PageSaving._saveAsStandaloneAttachment = async data => { Zotero.PageSaving.duplicateWrites.push(data); return {ok: true}; };
        if (kind === 'translated' || kind === 'multiple') {
          const itemType = kind === 'multiple' ? 'multiple' : 'journalArticle';
          Zotero.PageSaving.translators = [{translatorID: 'test-translator', itemType, label: 'Test translator'}];
          Zotero.PageSaving._initTranslate = async () => ({getProxy: async () => null});
          Zotero.TranslateWeb.translate = async () => ({items: [{itemType: 'journalArticle', title: 'Translated paper', DOI: '10.5555/test', attachments: []},
            ...(kind === 'multiple' ? [{itemType: 'journalArticle', title: 'Second selected paper', url: 'https://example.org/second', attachments: []}] : [])]});
          Zotero.ItemSaver = class { async saveItems(items) { Zotero.PageSaving.duplicateWrites.push(...items); return items; } };
        } else Zotero.PageSaving.translators = [];
      }, args: [kind]});
      const info = Zotero.Connector_Browser.getTabInfo(tabID);
      info.translators = ['translated', 'multiple'].includes(kind) ? [{translatorID: 'test-translator', itemType: kind === 'multiple' ? 'multiple' : 'journalArticle'}] : [];
    }, {tabID, kind});
    const panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
    await panel.waitForFunction(() => !document.getElementById('ingestionModel').disabled);
    const writes = async () => worker.evaluate(async tabID => (await browser.scripting.executeScript({target: {tabId: tabID},
      func: () => Zotero.PageSaving.duplicateWrites}))[0].result, tabID);
    return {page, panel, writes, tabID};
  };
  for (const mode of ['entry', 'pdf', 'categorize', 'ordinary']) {
    const {page, panel, writes} = await open('plain');
    await panel.locator('#' + mode).click();
    await panel.waitForSelector('#duplicatePrompt:not([hidden])').catch(async error => {
      console.log({mode, panel: await panel.evaluate(() => ({text: document.body.innerText, busy, job})),
        backend: await worker.evaluate(() => Zotero.Research.duplicateTest)});
      throw error;
    });
    assert.equal((await worker.evaluate(() => Zotero.Research.duplicateTest.saves)).length, 0);
    assert.equal((await writes()).length, 0, mode + ': nothing saved before the decision');
    await panel.locator('#duplicateCancel').click();
    await panel.waitForFunction(() => !busy && $('duplicatePrompt').hidden);
    assert.equal((await writes()).length, 0);
    assert.equal((await worker.evaluate(() => Zotero.Research.duplicateTest.saves)).length, 0, mode + ': Cancel creates nothing');
    assert.equal(await panel.$eval('#ordinary', node => node.hidden || node.disabled), false);
    await panel.locator('#' + mode).click();
    await panel.waitForSelector('#duplicatePrompt:not([hidden])');
    if (mode === 'entry') await (await panel.frameElement()).screenshot({path: 'dist/research-ui-test/duplicates.png'});
    await panel.locator('#duplicateYes').click();
    if (mode === 'ordinary') {
      await page.waitForFunction(() => !document.querySelector('iframe[src*="research/panel.html"]'));
      assert.equal((await writes()).length, 1);
    } else {
      await panel.waitForFunction(() => job?.status === 'ready' && !busy);
      const saves = await worker.evaluate(() => Zotero.Research.duplicateTest.saves);
      assert.equal(saves.length, 1); assert.equal(saves[0].mode, mode);
    }
    await page.close();
  }
  console.log('PASS: all four buttons wait before saving; Cancel creates nothing; Yes saves once');
  for (const kind of ['translated', 'multiple']) {
    const {page, panel, writes, tabID} = await open(kind);
    await panel.locator('#ordinary').click();
    await panel.waitForSelector('#duplicatePrompt:not([hidden])').catch(async error => {
      console.log({kind, panel: await panel.evaluate(() => ({text: document.body.innerText, busy, job})),
        backend: await worker.evaluate(() => Zotero.Research.duplicateTest),
        pageSaving: await worker.evaluate(async tabID => (await browser.scripting.executeScript({target: {tabId: tabID},
          func: () => ({translators: Zotero.PageSaving.translators, session: Zotero.PageSaving.sessionDetails,
            detecting: !!Zotero.PageSaving._detectPromise})}))[0].result, tabID)});
      throw error;
    });
    const check = await worker.evaluate(() => Zotero.Research.duplicateTest.checks.at(-1));
    assert.equal(check.items[0].DOI, '10.5555/test');
    assert.equal(check.items.length, kind === 'multiple' ? 2 : 1);
    assert.equal((await writes()).length, 0);
    await panel.locator('#duplicateYes').click();
    await page.waitForFunction(() => !document.querySelector('iframe[src*="research/panel.html"]'));
    assert.equal((await writes()).length, check.items.length);
    await page.close();
  }
  console.log('PASS: ordinary translation and multi-item selection check the actual items before ItemSaver runs');
  await worker.evaluate(() => { Zotero.Research.duplicateTest.matches = []; });
  const {page, panel} = await open('plain');
  await panel.locator('#entry').click();
  await panel.waitForFunction(() => job?.status === 'ready' && !busy);
  assert.equal(await panel.$eval('#duplicatePrompt', n => n.hidden), true);
  await page.close();
  console.log('PASS: new entries proceed without a confirmation');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
