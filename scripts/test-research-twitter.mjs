// Actual extension messaging and paper navigation in a temporary Chrome profile.
// Synthetic Twitter DOM follows the observed post/card/photo structure; no real library writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
// A real PDF response, including a URL with no PDF suffix.
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'];
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += 'xref\n0 4\n0000000000 65535 f \n' + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
  + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const paperRequests = [];
const server = createServer((req, res) => {
  paperRequests.push({url: req.url, method: req.method});
  if (req.url.startsWith('/downloads/') || req.url.startsWith('/download?')) {
    res.setHeader('Content-Type', 'application/pdf'); res.end(pdf); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Linked research paper</title><meta name="citation_title" content="Linked research paper"><meta name="citation_author" content="Researcher, A"><h1>Linked research paper</h1><p>The paper, not the Twitter post.</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const paperURL = `http://127.0.0.1:${server.address().port}/paper.pdf`;
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome', enableExtensions: [root + '/build/manifestv3']});
const post = (id, text, extra = '', author = 'researcher') => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}">${author}</a><a href="/${author}">@${author}</a><a href="/${author}/status/${id}"><time datetime="2026-10-06T10:00:00Z">Oct 6</time></a></div><div data-testid="tweetText">${text}</div>${extra}</article>`;
const card = `<div data-testid="card.wrapper"><a href="https://t.co/paper">arxiv.org<br>Linked research paper</a></div>`;
const photo = `<div data-testid="tweetPhoto"><img alt="Result chart" src="https://pbs.twimg.com/media/test?format=png&name=medium"></div>`;
const first = post('101', '1/ New paper. <a href="https://github.com/example/code">Code</a>', photo);
const second = post('102', '2/ Paper:', card + '<div role="link"><div data-testid="User-Name">Quoted author</div><div data-testid="tweetText">Quoted context</div></div>');
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'));
  const worker = await target.worker();
  // Optional network check using Chrome's real User-Agent against the reported
  // thread's short links. It resolves URLs only, without saving or reading papers.
  if (process.argv.includes('--live-twitter-links')) {
    const live = await worker.evaluate(async () => {
      await Zotero.initDeferred.promise;
      return Zotero.Research.paperLinks({posts: [
        {text: '10/ Concurrent works', links: [
          {url: 'https://t.co/XESTOV3qgF', label: 'https://arxiv.org/abs/2605.02105'},
          {url: 'https://t.co/P2SHfJW76x', label: 'https://arxiv.org/abs/2603.16127'}]},
        {text: '11/ With the authors.\nPaper:', links: [
          {url: 'https://t.co/AamI5PZHvk', label: 'arxiv.org(How) Learning Rates Regulate Catastrophic Overtraining', card: true}]}
      ]});
    });
    assert.deepEqual(live.map(p => p.url), ['https://arxiv.org/abs/2605.02105', 'https://arxiv.org/abs/2603.16127', 'https://arxiv.org/abs/2604.13627']);
    console.log('PASS: real Chrome requests resolve all three paper links in the reported thread for selection');
  }
  await worker.evaluate(async paperURL => {
    await Zotero.initDeferred.promise; await Zotero.Prefs.set('firstUse', false);
    await Zotero.Prefs.set('connector.url', 'http://127.0.0.1:1/');
    const originalFetch = fetch;
    Zotero.Research.testLinkRequests = []; Zotero.Research.testStarts = []; Zotero.Research.testOrdinary = 0;
    Zotero.Research.testRedirectMode = 'html';
    self.fetch = async (url, options) => {
      if (String(url).startsWith('https://t.co/')) {
        Zotero.Research.testLinkRequests.push({url, method: options?.method, redirect: options?.redirect});
        if (url === 'https://t.co/unavailable') throw new Error('Redirect unavailable');
        if (url === 'https://t.co/solearxiv') return {url: 'https://arxiv.org/abs/2605.02105', headers: new Headers({'Content-Type': 'text/html'})};
        if (Zotero.Research.testRedirectMode === 'http') return {url: paperURL, headers: new Headers({'Content-Type': 'application/pdf'})};
        // Actual t.co browser response: HEAD stays on t.co; GET returns a script
        // redirect. Parsing its JSON string must never execute the script.
        return {url, headers: new Headers({'Content-Type': 'text/html'}),
          text: async () => `<head><noscript><META http-equiv="refresh" content="0;URL=${paperURL}"></noscript><title>${paperURL}</title></head><script>window.opener = null; location.replace(${JSON.stringify(paperURL).replaceAll('/', '\\/')})</script>`};
      }
      return originalFetch(url, options);
    };
    Zotero.Research.call = async (method, data) => {
      if (method === 'status') return {job: data.id ? Zotero.Research.testJob : null};
      if (method === 'start') {
        Zotero.Research.testStarts.push(data);
        return Zotero.Research.testJob = {id: data.requestID, mode: data.mode, title: data.item.title, url: data.source.url,
          status: 'ready', stage: 'Ready to discuss', summary: 'Summary of the paper.', existingCollections: [], availableCollections: [], messages: []};
      }
    };
    Zotero.Connector_Browser.saveWithTranslator = Zotero.Connector_Browser.saveAsWebpage = async () => { Zotero.Research.testOrdinary++; };
  }, paperURL);
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  let html = '<!doctype html><title>Twitter thread</title>' + first + second
    + post('201', 'Unrelated reply with a paper', card, 'someone_else') + post('103', 'Author responding to that reply', card);
  page.on('request', req => {
    if (req.isNavigationRequest() && req.url().startsWith('https://x.com/')) req.respond({status: 200, contentType: 'text/html', body: html});
    else if (req.url().startsWith('https://pbs.twimg.com/')) req.respond({status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRDsAAAAASUVORK5CYII=', 'base64')});
    else req.continue();
  });
  async function openPanel(url = 'https://x.com/researcher/status/101') {
    await worker.evaluate(() => browser.storage.session.clear());
    await page.goto(url);
    const tab = await worker.evaluate(async url => (await browser.tabs.query({url}))[0], url);
    await worker.evaluate(tab => Zotero.Research.show(tab), tab);
    const panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
    await panel.waitForFunction(() => document.getElementById('progress').hidden
      && innerHeight === Math.ceil(document.body.getBoundingClientRect().height));
    return {panel, tab};
  }
  for (const mode of ['entry', 'pdf']) {
    const {panel} = await openPanel();
    const count = await worker.evaluate(() => Zotero.Research.testStarts.length);
    await panel.locator('#' + mode).click();
    await panel.waitForSelector('#paperChoice:not([hidden])');
    assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), count, 'A labelled paper card still requires a choice');
    assert.equal(await panel.$$eval('#paperChoices button', nodes => nodes.length), 2, 'Include the code URL too');
    await panel.locator('#paperChoices button:nth-child(2)').click();
    await panel.waitForFunction(() => !document.getElementById('paper').hidden || !document.getElementById('error').hidden, {timeout: 60000});
    assert.equal(await panel.$eval('#error', e => e.hidden ? '' : e.textContent), '');
    const request = await worker.evaluate(() => Zotero.Research.testStarts.at(-1));
    assert.equal(request.mode, mode); assert.equal(request.source.url, paperURL);
    assert.equal(request.item.title, 'Linked research paper');
    assert.equal(request.twitterThread.posts.length, 2, 'Exclude replies, including later author replies');
    assert.equal(request.twitterThread.posts[0].pictures[0].alt, 'Result chart');
    assert.equal(request.twitterThread.posts[1].quotes[0].text, 'Quoted context');
    assert.equal(await page.url(), 'https://x.com/researcher/status/101', 'Keep the original Twitter tab');
    assert.ok(!(await browser.pages()).some(p => p.url() === paperURL), 'Temporary paper tab is closed');
    await panel.locator('#close').click();
  }
  const linkRequests = await worker.evaluate(() => Zotero.Research.testLinkRequests);
  assert.deepEqual(linkRequests.map(r => r.method), ['HEAD', 'GET', 'HEAD', 'GET']);
  assert.ok(linkRequests.every(r => r.url === 'https://t.co/paper'));
  assert.ok(linkRequests.filter(r => r.method === 'GET').every(r => r.redirect === 'manual'), 'Never download other linked pages while resolving destinations');
  const httpRedirect = await worker.evaluate(async () => {
    Zotero.Research.testRedirectMode = 'http';
    try { return await Zotero.Research.resolveTwitterLink('https://t.co/paper'); }
    finally { Zotero.Research.testRedirectMode = 'html'; }
  });
  assert.equal(httpRedirect.url, paperURL);
  console.log('PASS: both Add modes require a choice, follow the selected paper, and capture only the main thread with pictures/quotes');

  html = '<!doctype html><title>Twitter</title>' + first + post('102', `Related work: <a href="${paperURL}">First.pdf</a> and <a href="${paperURL}?v=2">Second.pdf</a>`)
    + post('201', 'Reply', '', 'someone_else');
  let {panel} = await openPanel();
  const count = await worker.evaluate(() => Zotero.Research.testStarts.length);
  await panel.locator('#entry').click();
  await panel.waitForSelector('#paperChoice:not([hidden])');
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), count, 'Ambiguous links do not create an item');
  assert.equal(await panel.$$eval('#paperChoices button', nodes => nodes.length), 3);
  await panel.locator('#paperChoices button:nth-child(3)').click();
  await panel.waitForSelector('#paper:not([hidden])');
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.at(-1).source.url), paperURL + '?v=2');
  console.log('PASS: ambiguous links offer a choice before saving; selection continues normally');

  for (const [mode, path] of [['entry', '/downloads/paper.pdf'], ['pdf', '/download?id=123']]) {
    const url = new URL(path, paperURL).href;
    html = '<!doctype html><title>Twitter</title>' + post('101', `Our paper: <a href="${url}">Download</a>`);
    ({panel} = await openPanel());
    const starts = await worker.evaluate(() => Zotero.Research.testStarts.length), requests = paperRequests.length;
    await panel.locator('#' + mode).click();
    await panel.waitForSelector('#paperChoice:not([hidden])');
    assert.equal(await panel.$$eval('#paperChoices button', nodes => nodes.length), 1, 'A single URL still requires a choice');
    assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), starts);
    assert.equal(paperRequests.length, requests, 'Do not read an unselected destination');
    await panel.locator('#paperChoices button').click();
    await panel.waitForFunction(() => !document.getElementById('paper').hidden || !document.getElementById('error').hidden, {timeout: 60000});
    assert.equal(await panel.$eval('#error', e => e.hidden ? '' : e.textContent), '');
    const saved = await worker.evaluate(() => Zotero.Research.testStarts.at(-1));
    assert.equal(saved.mode, mode); assert.equal(saved.source.url, url);
    assert.ok(saved.source.pdfURLs.includes(url), 'The selected real PDF reaches the PDF extraction workflow');
  }
  console.log('PASS: single-URL confirmation and real PDFs on arbitrary paths, including without a PDF suffix');

  html = '<!doctype html><title>Twitter</title>' + post('101', 'Our paper:',
    '<div data-testid="card.wrapper"><a href="https://arxiv.org/abs/2605.02105">arxiv.org Paper</a></div>')
    + post('102', `Actually the paper: <a href="${paperURL}">Download</a>`);
  ({panel} = await openPanel());
  const starts = await worker.evaluate(() => Zotero.Research.testStarts.length);
  await panel.locator('#entry').click(); await panel.waitForSelector('#paperChoice:not([hidden])');
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), starts, 'Never auto-select the labelled arXiv card');
  assert.equal(await panel.$$eval('#paperChoices button', nodes => nodes.length), 2);
  await panel.locator('#paperChoices button:nth-child(2)').click(); await panel.waitForSelector('#paper:not([hidden])');
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.at(-1).source.url), paperURL);

  // No external arXiv download is needed to check the single-link exception.
  await worker.evaluate(() => {
    Zotero.Research.testExtractPaper = Zotero.Research.extractPaper;
    Zotero.Research.extractPaper = async function(url, ...args) {
      if (url === 'https://arxiv.org/abs/2605.02105') return {item: {title: 'Single arXiv paper'}, source: {url, pdfURLs: []}};
      return this.testExtractPaper(url, ...args);
    };
  });
  try {
    for (const [mode, url] of [['entry', 'https://export.arxiv.org/pdf/2605.02105.pdf'], ['pdf', 'https://t.co/solearxiv']]) {
      html = '<!doctype html><title>Twitter</title>' + post('101', `Paper: <a href="${url}">Read it</a>`);
      ({panel} = await openPanel());
      const count = await worker.evaluate(() => Zotero.Research.testStarts.length);
      await panel.locator('#' + mode).click(); await panel.waitForSelector('#paper:not([hidden])');
      assert.equal(await panel.$eval('#paperChoice', e => e.hidden), true);
      assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), count + 1);
      const saved = await worker.evaluate(() => Zotero.Research.testStarts.at(-1));
      assert.equal(saved.source.url, 'https://arxiv.org/abs/2605.02105'); assert.equal(saved.mode, mode);
    }
  } finally {
    await worker.evaluate(() => { Zotero.Research.extractPaper = Zotero.Research.testExtractPaper; delete Zotero.Research.testExtractPaper; });
  }
  console.log('PASS: one arXiv paper URL skips the chooser in both Add modes, including expanded short links');

  const links = await worker.evaluate(() => Zotero.Research.paperLinks({posts: [{text: '', links: [
    {url: 'https://t.co/unavailable', label: 'Unavailable redirect'},
    {url: 'https://example.org/download?id=42', label: 'Paper'},
    {url: 'https://example.org/download?id=42', label: 'Duplicate'}]}]}));
  assert.deepEqual(links.map(link => link.url), ['https://t.co/unavailable', 'https://example.org/download?id=42']);
  console.log('PASS: citations never override the selection; unknown destinations and unavailable short URLs remain selectable');

  // Twitter can load a continuation only after scrolling. Recommendations from
  // the same author still do not belong to the thread.
  html = '<!doctype html><title>Twitter</title>' + first + '<div style="height:1500px"></div>'
    + `<script>addEventListener('scroll', () => { if (scrollY < 100 || document.getElementById('loaded')) return;
      const next = document.createElement('div'); next.id = 'loaded';
      next.innerHTML = ${JSON.stringify(second + '<h2>Discover more</h2>' + post('104', 'Unrelated recommended post'))};
      document.body.append(next);
    });</script>`;
  let lazy = await openPanel();
  const captured = await worker.evaluate(tab => browser.tabs.sendMessage(tab.id, {research: 'twitter'}, {frameId: 0}), lazy.tab);
  assert.equal(captured.error, undefined);
  assert.deepEqual(captured.posts.map(p => p.id), ['101', '102']);
  assert.equal(await page.evaluate(() => scrollY), 0, 'Restore the original scroll position');
  console.log('PASS: lazy continuation is captured, same-author recommendations excluded, and scroll position restored');

  html = '<!doctype html><title>Twitter</title>' + post('101', 'A thread without links') + post('201', 'Reply', card, 'someone_else');
  ({panel} = await openPanel());
  const beforeRefusal = await worker.evaluate(() => Zotero.Research.testStarts.length);
  await panel.locator('#entry').click(); await panel.waitForSelector('#error:not([hidden])');
  assert.match(await panel.$eval('#error', n => n.textContent), /No URL was found/);
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), beforeRefusal);
  await panel.locator('#close').click();
  ({panel} = await openPanel()); await panel.locator('#ordinary').click();
  await worker.waitForFunction(() => Zotero.Research.testOrdinary === 1);
  assert.equal(await worker.evaluate(() => Zotero.Research.testOrdinary), 1);
  console.log('PASS: missing paper links show an error; the usual save workflow is unchanged');
} catch (error) {
  for (const page of await browser.pages()) for (const frame of page.frames()) {
    if (frame.url().includes('/research/panel.html')) console.error('Panel at failure:', await frame.evaluate(() => ({text: document.body.innerText, busy, activeAction, job})));
  }
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
