// Actual extension messaging and paper navigation in a temporary Chrome profile.
// Synthetic Twitter DOM follows the observed post/card/photo structure; no real library writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
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
  if (req.url === '/short-link') {
    res.writeHead(302, {Location: '/title-citation'}); res.end(); return;
  }
  const titlePages = {
    '/title-citation': '<title>Generic site title</title><meta name="citation_title" content="A paper &amp; its findings"><meta property="og:title" content="Social title"><script>window.titleScriptRan=true</script><img src="/unrequested-image">',
    '/title-social': '<title>Generic site title</title><meta property="og:title" content="Weightpedia: &lt;Understanding&gt; models">',
    '/title-page': '<title>  Research\n  resources </title>',
    '/title-refresh': '<meta http-equiv="refresh" content="0; url=\'/title-page\'">',
    '/title-loop': '<meta http-equiv="refresh" content="0; url=/title-loop">',
    '/title-missing': '<p>No title here</p>'
  };
  if (req.url in titlePages) {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html>' + titlePages[req.url]); return;
  }
  if (req.url === '/title-failure') { res.writeHead(503); res.end(); return; }
  if (req.url === '/') {
    res.writeHead(302, {Location: '/downloads/identifying-intro-preprint.pdf'}); res.end(); return;
  }
  if (req.url.startsWith('/downloads/') || req.url.startsWith('/download?')) {
    res.setHeader('Content-Type', 'application/pdf'); res.end(pdf); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Linked research paper</title><meta name="citation_title" content="Linked research paper"><meta name="citation_author" content="Researcher, A"><h1>Linked research paper</h1><p>The paper, not the Twitter post.</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// A non-loopback HTTP origin is necessary to exercise mixed-content rules in
// the research panel embedded inside the HTTPS Twitter page.
const paperURL = `http://research-paper.test:${server.address().port}/paper.pdf`;
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome',
  args: ['--host-resolver-rules=MAP research-paper.test 127.0.0.1'], enableExtensions: [root + '/build/manifestv3']});
const post = (id, text, extra = '', author = 'researcher') => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}">${author}</a><a href="/${author}">@${author}</a><a href="/${author}/status/${id}"><time datetime="2026-10-06T10:00:00Z">Oct 6</time></a></div><div data-testid="tweetText">${text}</div>${extra}</article>`;
const card = `<div data-testid="card.wrapper"><a href="https://t.co/paper">arxiv.org<br>Linked research paper</a></div>`;
const photo = `<div data-testid="tweetPhoto"><img alt="Result chart" src="https://pbs.twimg.com/media/test?format=png&name=medium"></div>`;
const mentions = '<a href="https://x.com/colleague">@colleague</a> <a href="https://mobile.twitter.com/another">@another</a>';
const first = post('101', '1/ New paper. ' + mentions + ' <a href="https://github.com/example/code">Code</a>', photo);
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
      if (['https://github.com/example/code', 'https://arxiv.org/abs/2605.02105'].includes(url)) {
        return new Response('<title>Linked resource</title>', {headers: {'Content-Type': 'text/html'}});
      }
      if (['https://lnkd.in/social', 'https://lnkd.in/paper'].includes(url)) {
        const target = url.endsWith('/social') ? 'https://x.com/researcher/status/101' : paperURL + '?a=1&b=2';
        return {url, headers: new Headers({'Content-Type': 'text/html'}),
          text: async () => `<title>LinkedIn</title><a class="artdeco-button" data-tracking-control-name="external_url_click" href="${target.replaceAll('&', '&amp;')}">${target}</a>`};
      }
      if (String(url).startsWith('https://t.co/')) {
        Zotero.Research.testLinkRequests.push({url, method: options?.method, redirect: options?.redirect});
        if (url === 'https://t.co/unavailable') throw new Error('Redirect unavailable');
        if (url === 'https://t.co/solearxiv') return {url: 'https://arxiv.org/abs/2605.02105', headers: new Headers({'Content-Type': 'text/html'})};
        if (url === 'https://t.co/social') return {url: 'https://www.x.com/colleague/status/123', headers: new Headers({'Content-Type': 'text/html'})};
        if (url === 'https://t.co/linkedin') return {url, headers: new Headers({'Content-Type': 'text/html'}), text: async () => '<script>location.replace("https://lnkd.in/paper")</script>'};
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
        // Match the native plugin's request validation, including the required title.
        if (!['entry', 'pdf'].includes(data.mode) || !data.item?.title || !data.requestID) {
          throw new Error('Incomplete paper request.');
        }
        Zotero.Research.testStarts.push(data);
        return Zotero.Research.testJob = {id: data.requestID, mode: data.mode, title: data.item.title, url: data.source.url,
          status: 'ready', stage: 'Ready to discuss', summary: 'Summary of the paper.', existingCollections: [], availableCollections: [], messages: []};
      }
    };
    Zotero.Connector_Browser.saveWithTranslator = Zotero.Connector_Browser.saveAsWebpage = async () => { Zotero.Research.testOrdinary++; };
  }, paperURL);
  assert.deepEqual(await worker.evaluate(() => Zotero.Research.paperLinks({posts: [{links: [
    {url: 'https://lnkd.in/social'}, {url: 'https://t.co/linkedin'}, {url: 'https://lnkd.in/paper'}
  ]}]})), [{url: paperURL + '?a=1&b=2', label: paperURL + '?a=1&b=2'}],
  'Follow LinkedIn landing pages (including t.co chains), decode URL entities, deduplicate and exclude X destinations');
  await worker.evaluate(() => { Zotero.Research.testLinkRequests = []; });
  const page = await browser.newPage();
  const securityErrors = [], cdp = await page.createCDPSession();
  cdp.on('Log.entryAdded', ({entry}) => { if (entry.source === 'security') securityErrors.push(entry.text); });
  await cdp.send('Log.enable');
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
    await panel.waitForFunction(() => document.querySelector('#paperChoices button:nth-child(2) > span').textContent !== 'Loading title…');
    assert.deepEqual(securityErrors.filter(text => /mixed content/i.test(text)), [], 'HTTP title lookups must not trigger mixed-content errors');
    assert.equal(await panel.$eval('#paperChoices button:nth-child(2) > span', n => n.textContent), 'Linked research paper');
    assert.equal(await panel.$eval('#paperChoices button:nth-child(2) > small', n => n.textContent), paperURL);
    await panel.locator('#paperChoices button:nth-child(2)').click();
    await panel.waitForFunction(() => !document.getElementById('paper').hidden || !document.getElementById('error').hidden, {timeout: 60000});
    assert.equal(await panel.$eval('#error', e => e.hidden ? '' : e.textContent), '');
    const request = await worker.evaluate(() => Zotero.Research.testStarts.at(-1));
    assert.equal(request.mode, mode); assert.equal(request.source.url, paperURL);
    assert.equal(request.item.title, 'Linked research paper');
    assert.equal(request.twitterThread.posts.length, 2, 'Exclude replies, including later author replies');
    assert.ok(request.twitterThread.posts[0].links.some(link => link.url === 'https://x.com/colleague'), 'Keep excluded candidate links in the saved thread');
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

  for (const [mode, path, finalPath] of [
    ['entry', '/downloads/paper.pdf', '/downloads/paper.pdf'],
    ['pdf', '/download?id=123', '/download?id=123'],
    ['entry', '/', '/downloads/identifying-intro-preprint.pdf'],
    ['pdf', '/', '/downloads/identifying-intro-preprint.pdf']
  ]) {
    const url = new URL(path, paperURL).href;
    const finalURL = new URL(finalPath, paperURL);
    html = '<!doctype html><title>Twitter</title>' + post('101', `Our paper: <a href="${url}">Download</a>`);
    ({panel} = await openPanel());
    const starts = await worker.evaluate(() => Zotero.Research.testStarts.length), requests = paperRequests.length;
    await panel.locator('#' + mode).click();
    await panel.waitForSelector('#paperChoice:not([hidden])');
    assert.equal(await panel.$$eval('#paperChoices button', nodes => nodes.length), 1, 'A single URL still requires a choice');
    assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), starts);
    await panel.waitForFunction(() => document.querySelector('#paperChoices button > span').textContent !== 'Loading title…');
    assert.ok(paperRequests.length > requests, 'Look up destination metadata before selection');
    assert.equal(await panel.$eval('#paperChoices button > span', n => n.textContent), finalURL.pathname.split('/').pop(), 'An unselected PDF uses its filename without parsing its body');
    assert.equal(await panel.$eval('#paperChoices button > small', n => n.textContent), finalURL.href, 'Show the resolved URL');
    await panel.locator('#paperChoices button').click();
    await panel.waitForFunction(() => !document.getElementById('paper').hidden || !document.getElementById('error').hidden, {timeout: 60000});
    assert.equal(await panel.$eval('#error', e => e.hidden ? '' : e.textContent), '');
    const saved = await worker.evaluate(() => Zotero.Research.testStarts.at(-1));
    assert.equal(saved.mode, mode); assert.equal(saved.source.url, finalURL.href);
    assert.equal(saved.item.title, finalURL.pathname.split('/').pop(), 'Titleless PDFs use the final URL filename');
    assert.ok(saved.source.pdfURLs.includes(finalURL.href), 'The selected real PDF reaches the PDF extraction workflow');
  }
  console.log('PASS: titleless PDFs reach the backend in both Add modes, including redirects and URLs without a PDF suffix');

  const titleCases = [
    ['/short-link', 'A paper & its findings', '/title-citation'],
    ['/title-social', 'Weightpedia: <Understanding> models', '/title-social'],
    ['/title-page', 'Research resources', '/title-page'],
    ['/title-refresh', 'Research resources', '/title-page'],
    ['/title-loop', 'Title unavailable', '/title-loop'],
    ['/title-failure', 'Title unavailable', '/title-failure'],
    ['/title-missing', 'Title unavailable', '/title-missing']
  ];
  html = '<!doctype html><title>Twitter</title>' + post('101', titleCases.map(([path]) => {
    const url = new URL(path, paperURL).href;
    return `<a href="${url}">${url}</a>`;
  }).join(' '));
  ({panel} = await openPanel());
  const beforeTitleChoices = await worker.evaluate(() => Zotero.Research.testStarts.length);
  await panel.locator('#entry').click();
  await panel.waitForSelector('#paperChoice:not([hidden])');
  await panel.waitForFunction(() => [...document.querySelectorAll('#paperChoices button > span')].every(n => n.textContent !== 'Loading title…'));
  const titles = await panel.$$eval('#paperChoices button', nodes => nodes.map(n => ({title: n.firstElementChild.textContent, url: n.lastElementChild.textContent, disabled: n.disabled})));
  assert.deepEqual(titles, titleCases.map(([, title, path]) => ({title, url: new URL(path, paperURL).href, disabled: false})));
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), beforeTitleChoices, 'Title lookups never save an item');
  assert.equal(await panel.evaluate(() => !!window.titleScriptRan), false, 'Fetched page scripts do not execute');
  assert.ok(!paperRequests.some(r => r.url === '/unrequested-image'), 'Do not fetch pictures or other page resources for titles');
  assert.equal(await panel.$$eval('#paperChoices script, #paperChoices img, #paperChoices understanding', nodes => nodes.length), 0, 'Titles render as plain text');
  await mkdir(root + '/dist/research-ui-test', {recursive: true});
  await page.screenshot({path: root + '/dist/research-ui-test/zotero-paper-choice-titles.png'});
  await panel.locator('#paperChoices button:first-child').click();
  await panel.waitForSelector('#paper:not([hidden])');
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.at(-1).source.url), new URL('/title-citation', paperURL).href, 'A titled redirect still imports the selected paper');
  console.log('PASS: chooser shows citation, social or page titles above resolved URLs; unavailable titles remain selectable');

  if (process.argv.includes('--live-paper-titles')) {
    // Read only title metadata for the reported links; do not select or save anything.
    html = '<!doctype html><title>Twitter</title>' + post('101', [
      'https://lnkd.in/g_q7DVJ8', 'http://weightpedia.org/individual-parameters-in-sparse-transformers/', 'https://lnkd.in/gT5RW4MS'
    ].map(url => `<a href="${url}">${url}</a>`).join(' '));
    ({panel} = await openPanel());
    await panel.locator('#entry').click();
    await panel.waitForSelector('#paperChoice:not([hidden])', {timeout: 60000});
    await panel.waitForFunction(() => [...document.querySelectorAll('#paperChoices button > span')].every(n => n.textContent !== 'Loading title…'));
    const choices = await panel.$$eval('#paperChoices button', nodes => nodes.map(n => ({title: n.firstElementChild.textContent, url: n.lastElementChild.textContent})));
    assert.equal(choices.length, 2, 'Exclude the short link that resolves to X');
    assert.ok(choices.every(c => !['Title unavailable', 'LinkedIn', c.url].includes(c.title)));
    assert.ok(choices.some(c => new URL(c.url).hostname === 'transformer-circuits.pub'));
    assert.deepEqual(securityErrors.filter(text => /mixed content/i.test(text)), [], 'The reported HTTP Weightpedia URL must also avoid mixed-content errors');
    console.log('PASS: live screenshot links show destination titles:', JSON.stringify(choices));
    await page.screenshot({path: root + '/dist/research-ui-test/zotero-paper-choice-live-titles.png'});
  }

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
      html = '<!doctype html><title>Twitter</title>' + post('101', `${mentions} Paper: <a href="${url}">Read it</a>`);
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
    {url: 'https://x.com/colleague'}, {url: 'https://twitter.com/colleague/status/123'},
    {url: 'https://mobile.x.com/colleague'}, {url: 'https://www.twitter.com/colleague'},
    {url: 'https://t.co/social'},
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

  // The reported AuditBench thread has a quote timestamp before its own
  // permalink, a hidden progress bar, and empty space after the final post.
  for (const linkedQuote of [false, true]) {
    const quoteTime = '<time datetime="2026-03-10T19:20:33Z">Mar 10</time>';
    html = '<!doctype html><title>Twitter thread</title><article data-testid="tweet">'
      + '<div data-testid="User-Name"><a href="/researcher">Researcher</a></div>'
      + '<div data-testid="tweetText">Using AuditBench? Here is our update.</div>'
      + '<div role="link"><div data-testid="User-Name">Quoted author</div>'
      + (linkedQuote ? `<a href="/quoted/status/99">${quoteTime}</a>` : quoteTime)
      + '<div data-testid="tweetText">Original AuditBench announcement</div></div>'
      + '<a href="/researcher/status/101"><time datetime="2026-10-02T13:23:19Z">Oct 2</time></a>'
      + '<div role="progressbar" style="visibility:hidden;height:3px"></div></article>'
      + Array.from({length: 9}, (_, i) => post(String(102 + i), i === 6 ? 'Paper:' : `Update ${i + 2}`, i === 6 ? card : '')).join('')
      + '<div style="display:none"><div role="progressbar"></div></div><div style="height:1800px"></div>';
    const {tab} = await openPanel();
    await page.evaluate(() => window.scrollTo(0, 120));
    const thread = await worker.evaluate(tab => browser.tabs.sendMessage(tab.id, {research: 'twitter'}, {frameId: 0}), tab);
    assert.equal(thread.error, undefined);
    assert.deepEqual(thread.posts.map(p => p.id), Array.from({length: 10}, (_, i) => String(101 + i)));
    assert.equal(thread.posts[0].author, 'researcher');
    assert.equal(thread.posts[0].date, '2026-10-02T13:23:19Z');
    assert.equal(thread.posts[0].quotes[0].text, 'Original AuditBench announcement');
    assert.ok(thread.posts[7].links.some(link => link.url === 'https://t.co/paper'));
    assert.equal(await page.evaluate(() => scrollY), 120, 'Restore a nonzero original scroll position');
  }
  console.log('PASS: quote timestamps do not hide the root post; hidden loaders and trailing space do not stall a complete thread');

  html = '<!doctype html><title>Twitter thread</title>' + first + second
    + '<div role="progressbar" style="height:3px">Loading more posts</div><div style="height:1000px"></div>';
  ({panel} = await openPanel());
  await page.evaluate(() => window.scrollTo(0, 120));
  const beforeTimeout = await worker.evaluate(() => Zotero.Research.testStarts.length);
  const timeoutStarted = performance.now();
  await panel.locator('#entry').click();
  await panel.waitForSelector('#error:not([hidden])', {timeout: 18000});
  const timeoutElapsed = performance.now() - timeoutStarted;
  assert.ok(timeoutElapsed >= 15000 && timeoutElapsed < 17000, `Loading must stop at 15 seconds (elapsed ${timeoutElapsed} ms)`);
  assert.match(await panel.$eval('#error', n => n.textContent), /after 15 seconds/);
  assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), beforeTimeout, 'Do not import an incomplete thread on timeout');
  assert.equal(await page.evaluate(() => scrollY), 120, 'Restore scroll position after timeout');
  assert.equal(await panel.$eval('#entry', n => n.disabled), false, 'Allow retry after timeout');
  console.log('PASS: genuinely unfinished threads stop after 15 seconds, restore scroll, and allow retry without importing');

  for (const text of ['A thread without links', mentions]) {
    html = '<!doctype html><title>Twitter</title>' + post('101', text) + post('201', 'Reply', card, 'someone_else');
    ({panel} = await openPanel());
    const beforeRefusal = await worker.evaluate(() => Zotero.Research.testStarts.length);
    await panel.locator('#entry').click(); await panel.waitForSelector('#error:not([hidden])');
    assert.match(await panel.$eval('#error', n => n.textContent), /No paper URL was found/);
    assert.equal(await worker.evaluate(() => Zotero.Research.testStarts.length), beforeRefusal);
    await panel.locator('#close').click();
  }
  ({panel} = await openPanel()); await panel.locator('#ordinary').click();
  await worker.waitForFunction(() => Zotero.Research.testOrdinary === 1);
  assert.equal(await worker.evaluate(() => Zotero.Research.testOrdinary), 1);
  console.log('PASS: missing paper links show an error; the usual save workflow is unchanged');

  // Hold automatic detection after setDocument. A second detection used to
  // replace that offscreen instance before its first getTranslators call.
  await page.goto(paperURL);
  const detectionTab = await worker.evaluate(async url => {
    const tab = (await browser.tabs.query({url}))[0];
    await Zotero.Connector_Browser.injectTranslationScripts(tab);
    await browser.scripting.executeScript({target: {tabId: tab.id}, func: () => Zotero.PageSaving.onPageLoad()});
    return tab;
  }, paperURL);
  for (const force of [false, true]) {
    await worker.evaluate(tab => browser.scripting.executeScript({target: {tabId: tab.id}, func: async () => {
      const saving = Zotero.PageSaving, init = saving._initTranslate, detect = saving.onPageLoad;
      let ready, release, joined;
      const initialized = new Promise(resolve => { ready = resolve; });
      const pause = new Promise(resolve => { release = resolve; });
      const state = Zotero.testDetection = {starts: 0, calls: 0, release,
        joined: new Promise(resolve => { joined = resolve; }),
        restore: () => { saving._initTranslate = init; saving.onPageLoad = detect; }};
      saving._initTranslate = async function(...args) {
        state.starts++;
        const translate = await init.apply(this, args);
        if (state.starts === 1) { ready(); await pause; }
        return translate;
      };
      saving.onPageLoad = function(...args) {
        if (++state.calls === 2) joined();
        return detect.apply(this, args);
      };
      state.initial = saving.onPageLoad(true);
      await initialized;
    }}), detectionTab);
    const overlapping = worker.evaluate(({tab, force}) => force
      ? browser.scripting.executeScript({target: {tabId: tab.id}, func: () => Zotero.PageSaving.onPageLoad(true)})
      : browser.tabs.sendMessage(tab.id, {research: 'extract', metadata: true, detect: true}, {frameId: 0}), {tab: detectionTab, force});
    let beforeRelease, result;
    try {
      const [{result: starts}] = await worker.evaluate(tab => browser.scripting.executeScript({target: {tabId: tab.id}, func: async () => {
        await Zotero.testDetection.joined;
        return Zotero.testDetection.starts;
      }}), detectionTab);
      beforeRelease = starts;
    } finally {
      await worker.evaluate(tab => browser.scripting.executeScript({target: {tabId: tab.id}, func: () => Zotero.testDetection.release()}), detectionTab);
      try { result = await overlapping; }
      finally {
        await worker.evaluate(tab => browser.scripting.executeScript({target: {tabId: tab.id}, func: async () => {
          await Zotero.testDetection.initial;
          Zotero.testDetection.restore();
        }}), detectionTab);
      }
    }
    assert.equal(beforeRelease, 1, 'A second caller must not reset the offscreen translator during detection');
    const [{result: starts}] = await worker.evaluate(tab => browser.scripting.executeScript({target: {tabId: tab.id}, func: () => Zotero.testDetection.starts}), detectionTab);
    assert.equal(starts, 2, force ? 'Run the forced refresh after the pending detection' : 'Initialize translation after the shared detection completes');
    if (!force) {
      assert.equal(result.error, undefined);
      assert.equal(result.item.title, 'Linked research paper');
      assert.ok(result.item.creators.some(author => author.lastName === 'Researcher'));
      assert.equal(result.source.url, paperURL);
    }
  }
  console.log('PASS: research waits for in-flight detection, imports metadata, and still honors forced page refreshes');
  const translatorErrors = (await worker.evaluate(() => Zotero.Errors.getErrors())).filter(error => /Cannot read properties of (?:null|undefined)/.test(error));
  assert.deepEqual(translatorErrors, [], 'No null/undefined translator errors during the chooser and import flows');
} catch (error) {
  console.error(error);
  for (const page of await browser.pages()) for (const frame of page.frames()) {
    if (frame.url().includes('/research/panel.html')) console.error('Panel at failure:', await frame.evaluate(() => ({text: document.body.innerText, busy, activeAction, job})).catch(e => e.message));
  }
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
