// Exercise the actual content script in isolated Chrome; no Zotero writes or model calls.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome', enableExtensions: [root + '/build/manifestv3']});
try {
  const worker = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'))).worker();
  await worker.evaluate(async () => {
    await Zotero.initDeferred.promise; await Zotero.Prefs.set('firstUse', false);
    await Zotero.Prefs.set('connector.url', 'http://127.0.0.1:1/');
  });
  const page = await browser.newPage();
  let html;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest()) request.respond({status: 200, contentType: 'text/html', body: html});
    else request.abort();
  });
  const url = 'https://www.lesswrong.com/posts/research-fixture/hidden-post';
  async function extract(sourceURL = url, translatedItem) {
    await page.goto(sourceURL);
    return worker.evaluate(async ({sourceURL, translatedItem}) => {
      const tab = (await browser.tabs.query({url: sourceURL}))[0];
      await Zotero.Connector_Browser.injectTranslationScripts(tab);
      if (translatedItem) await browser.scripting.executeScript({target: {tabId: tab.id}, args: [translatedItem], func: item => {
        Zotero.PageSaving = {translators: [{itemType: item.itemType}], _initTranslate: async () => ({})};
        Zotero.TranslateWeb.translate = async () => ({items: [item]});
      }});
      return browser.tabs.sendMessage(tab.id, {research: 'extract', metadata: !!translatedItem}, {frameId: 0});
    }, {sourceURL, translatedItem});
  }
  const article = '<div id="postContent"><h1>TL;DR</h1><p>First paragraph with <em>emphasis</em>.</p>'
    + '<h2>Methods</h2><ul><li>First method</li><li>Second method</li></ul>'
    + '<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Accuracy</td><td>0.8</td></tr></table>'
    + '<p>One line<br>Another line</p><h2>Appendix</h2><p>Final source detail.</p>'
    + '<script type="application/json">{"notArticleText":true}</script><style>.notArticleText {color: red}</style><noscript>notArticleText</noscript></div>';
  html = '<!doctype html><title>Research fixture</title><body>x<div hidden id="S:2">'
    + article + '</div><nav>Navigation clutter</nav><div id="comments">Unrelated discussion</div>';
  const hidden = await extract();
  assert.equal(hidden.error, undefined);
  assert.equal(hidden.source.url, url);
  assert.match(await page.evaluate(() => document.body.innerText), /^x/);
  assert.ok(!await page.evaluate(() => document.body.innerText.includes('Final source detail.')));
  assert.equal(hidden.source.pageText, 'TL;DR\n\nFirst paragraph with emphasis.\n\nMethods\n\nFirst method\n\nSecond method\n\nMetric\tValue\n\nAccuracy\t0.8\n\nOne line\nAnother line\n\nAppendix\n\nFinal source detail.');
  assert.ok(await page.$eval('#S\\:2', node => node.hidden), 'Extraction must not unhide or modify the page');
  html = html.replace('hidden id="S:2"', 'id="S:2"');
  assert.equal((await extract()).source.pageText, hidden.source.pageText, 'Visible and hidden versions have identical source text');
  html = '<!doctype html><title>Loading post</title><body>x';
  assert.match((await extract()).error, /Could not read the LessWrong post text/, 'Do not pass the loading shell to the summarizer');
  html = '<!doctype html><title>Empty post</title><body>x<div id="postContent"><script>void 0</script></div>';
  assert.match((await extract()).error, /Could not read the LessWrong post text/);
  html = '<!doctype html><title>Other page</title><body><p>Other page text.</p>';
  assert.equal((await extract('https://example.org/paper')).source.pageText, 'Other page text.', 'Preserve extraction on other sites');
  assert.equal((await extract('https://www.lesswrong.com/')).source.pageText, 'Other page text.', 'Preserve non-post pages');
  console.log('PASS: LessWrong extraction reads hidden article text, preserves structure, excludes page clutter, and rejects missing post content');

  const names = ['camilablank', 'agam_bhatia', 'Euan Ong', 'Neel Nanda'];
  const authors = names.map(lastName => ({lastName, creatorType: 'author', fieldMode: 1}));
  // Preserve a translator's structured name and non-author creators too.
  authors[2] = {firstName: 'Euan', lastName: 'Ong', creatorType: 'author'};
  const editor = {lastName: 'Fixture editor', creatorType: 'editor', fieldMode: 1};
  const translated = {itemType: 'forumPost', title: 'Research fixture', date: '2026-09-23', forumTitle: 'LessWrong', url,
    creators: [...authors.slice(1), editor], tags: ['Interpretability'], attachments: []};
  const metas = names.map(name => `<meta name="citation_author" content="${name}">`).join('');
  html = '<!doctype html><title>Research fixture</title>' + metas + '<body><div hidden>' + article + '</div>';
  const repaired = (await extract(url, translated)).item;
  assert.deepEqual(repaired, {...translated, creators: [...authors, editor]}, 'Restore the primary author in byline order and preserve other metadata');
  assert.deepEqual((await extract(url, repaired)).item, repaired, 'Do not duplicate authors when the translator already supplies the complete list');
  assert.deepEqual((await extract(url + '?commentId=comment', translated)).item, translated, 'Do not apply post authors to a comment');
  assert.deepEqual((await extract('https://example.org/paper', translated)).item, translated, 'Do not change authors for other sites');
  html = '<!doctype html><title>Research fixture</title><body>' + article;
  assert.deepEqual((await extract(url, translated)).item, translated, 'Preserve translated authors when citation metadata is absent');
  html = '<!doctype html><title>Research fixture</title><meta name="citation_author" content="camilablank"><body>' + article;
  assert.deepEqual((await extract(url, {...translated, creators: []})).item.creators, [authors[0]], 'Handle single-author posts too');
  console.log('PASS: LessWrong imports include the primary author and coauthors in order, without dropping or duplicating existing creators');

  if (process.argv.includes('--live-lesswrong')) {
    const sourceURL = 'https://www.lesswrong.com/posts/Zeg2JztbdhguL48uH/workspacebench-evaluating-interpretability-methods-for-the';
    const result = await worker.evaluate(url => Zotero.Research.extractPaper(url), sourceURL);
    assert.equal(result.item.title, 'WorkspaceBench: Evaluating Interpretability Methods for the Global Workspace');
    assert.equal(result.source.url, sourceURL);
    assert.ok(result.source.pageText.startsWith('TL;DR'));
    assert.ok(result.source.pageText.length > 25000);
    for (const section of ['3,356', 'Introduction', 'Grading', 'Appendix']) assert.ok(result.source.pageText.includes(section), section);
    assert.deepEqual(result.item.creators.map(creator => [creator.firstName, creator.lastName].filter(Boolean).join(' ')), names, 'Import the complete live byline in order');
    console.log(`PASS: real inactive-tab import captures ${result.source.pageText.length} characters and ${result.item.creators.length} authors from WorkspaceBench`);
  }
} finally { await browser.close(); }
