import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import puppeteer from 'puppeteer';

const server = createServer((req, res) => {
  if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('h1 { color: rgb(23, 93, 77); }'); }
  else if (req.url === '/figure.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="green"/></svg>'); }
  else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Reviewer tutorial</title><link rel="stylesheet" href="/style.css">'
      + (req.url.startsWith('/pdf') ? '<meta name="citation_pdf_url" content="/paper.pdf">' : '')
      + '<h1>Reviewer tutorial</h1><p>Give constructive feedback to the authors.</p><img src="/figure.svg" alt="Test figure">');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome',
  enableExtensions: [process.cwd() + '/build/manifestv3'], defaultViewport: {width: 1100, height: 900}});
try {
  const worker = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'))).worker();
  await worker.evaluate(async () => {
    await Zotero.initDeferred.promise; await Zotero.Prefs.set('firstUse', false);
    await Zotero.Prefs.set('connector.url', 'http://127.0.0.1:1/');
    Zotero.Research.contentTest = {};
    Zotero.Research.call = async (method, data) => {
      const state = Zotero.Research.contentTest;
      if (method === 'status') return {job: state.job || null};
      if (method === 'settings') return {model: 'test', effort: 'high', models: []};
      if (method === 'duplicates') return {matches: []};
      if (method === 'start') {
        state.saved = data;
        return state.job = {id: data.requestID, mode: data.mode, status: 'ready', title: data.item.title,
          summary: 'Test summary', messages: [], existingCollections: [], availableCollections: []};
      }
      throw new Error('Unexpected method: ' + method);
    };
  });
  const page = await browser.newPage();
  let captured;
  for (const [path, mode] of [['/entry', 'entry'], ['/categorize', 'categorize'], ['/content', 'pdf'], ['/pdf', 'pdf']]) {
    await page.goto(url + path);
    await worker.evaluate(async sourceURL => {
      Zotero.Research.contentTest = {};
      const tab = (await browser.tabs.query({url: sourceURL}))[0];
      await Zotero.Research.show(tab);
      await browser.scripting.executeScript({target: {tabId: tab.id}, func: () => Zotero.PageSaving.onPageLoad()});
    }, url + path);
    const panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
    await panel.waitForFunction(() => !document.getElementById('ingestionModel').disabled
      && innerHeight === Math.ceil(document.body.getBoundingClientRect().height));
    assert.equal(await panel.$eval('#pdf', node => node.textContent), 'Add entry with content & Summarize');
    if (path === '/content') {
      await mkdir('dist/research-ui-test', {recursive: true});
      await (await panel.frameElement()).screenshot({path: 'dist/research-ui-test/content-ready.png'});
    }
    await panel.locator('#' + mode).click();
    await panel.waitForFunction(() => (job?.status === 'ready' && !busy) || !document.getElementById('error').hidden);
    assert.equal(await panel.$eval('#error', node => node.textContent), '');
    const saved = await worker.evaluate(() => Zotero.Research.contentTest.saved);
    assert.equal(saved.mode, mode);
    assert.ok(saved.source.pageText.includes('Give constructive feedback'));
    if (path === '/content') {
      captured = saved;
      const snapshot = await page.evaluate(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return {title: doc.title, text: doc.body.textContent, image: doc.querySelector('img').src,
          style: [...doc.querySelectorAll('style')].map(node => node.textContent).join('\n'),
          panel: !!doc.querySelector('iframe[src*="research/panel.html"]')};
      }, saved.source.snapshotContent);
      assert.equal(snapshot.title, 'Reviewer tutorial');
      assert.ok(snapshot.text.includes('Give constructive feedback'));
      assert.match(snapshot.image, /^data:image\//, 'Snapshot embeds the image');
      assert.match(snapshot.style, /color:/, 'Snapshot embeds the stylesheet');
      assert.equal(snapshot.panel, false, 'The Research panel must not appear in the snapshot');
    } else assert.equal(saved.source.snapshotContent, undefined, path + ': preserve existing PDF and metadata-only behavior');
  }
  console.log('PASS: content button captures page text, styles, and images; excludes the panel; prefers identified PDFs; other Add modes keep no snapshot');
  const linked = await worker.evaluate(url => Zotero.Research.extractPaper(url, true, true), url + '/linked');
  assert.ok(linked.source.snapshotContent.includes('Give constructive feedback'), 'Linked/Twitter imports capture the selected page');
  assert.equal(linked.source.url, url + '/linked');
  const tabID = await worker.evaluate(async sourceURL => (await browser.tabs.query({url: sourceURL}))[0].id, url + '/pdf');
  await page.goto(url + '/retry');
  const retry = await worker.evaluate(async tabID => {
    await Zotero.Connector_Browser.injectTranslationScripts(await browser.tabs.get(tabID));
    return browser.tabs.sendMessage(tabID, {research: 'extract', metadata: false, snapshot: true}, {frameId: 0});
  }, tabID);
  assert.ok(retry.source.snapshotContent.includes('Give constructive feedback'), 'Retries capture a fresh snapshot without re-translating metadata');
  console.log('PASS: hidden linked-page imports and retry extraction capture the intended source');
  if (process.argv.includes('--native')) {
    const response = await fetch('http://127.0.0.1:23129/connector/research-test/content', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(captured)
    });
    const result = await response.json();
    assert.ok(response.ok && result.passed, JSON.stringify(result));
    console.log('PASS: isolated Zotero storage', JSON.stringify(result));
  }
} catch (error) {
  for (const page of await browser.pages()) for (const frame of page.frames()) if (frame.url().includes('/research/panel.html')) {
    console.error('Panel at failure:', await frame.evaluate(() => document.body.innerText).catch(error => error.message));
  }
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
