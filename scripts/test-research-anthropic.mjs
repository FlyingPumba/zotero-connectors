// Exercise the built content script in isolated Chrome, without Zotero writes or model calls.
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
  const url = 'https://alignment.anthropic.com/2025/modifying-beliefs-via-sdf/';
  async function extract(sourceURL = url, translatedItem) {
    await page.goto(sourceURL);
    return worker.evaluate(async ({sourceURL, translatedItem}) => {
      const tab = (await browser.tabs.query({url: sourceURL}))[0];
      await Zotero.Connector_Browser.injectTranslationScripts(tab);
      if (translatedItem !== undefined) await browser.scripting.executeScript({target: {tabId: tab.id}, args: [translatedItem], func: item => {
        Zotero.PageSaving = {translators: item ? [{itemType: item.itemType}] : [], _initTranslate: async () => ({})};
        Zotero.TranslateWeb.translate = async () => ({items: [item]});
      }});
      return browser.tabs.sendMessage(tab.id, {research: 'extract', metadata: translatedItem !== undefined}, {frameId: 0});
    }, {sourceURL, translatedItem});
  }
  const title = 'Modifying LLM Beliefs with Synthetic Document Finetuning';
  const description = 'We study how to modify the beliefs of LLMs.';
  const names = ['Rowan Wang', 'Avery Griffin', 'Johannes Treutlein', 'Ethan Perez', 'Julian Michael', 'Fabien Roger', 'Sam Marks'];
  const authorNames = item => item.creators.filter(creator => creator.creatorType === 'author')
    .map(creator => [creator.firstName, creator.lastName].filter(Boolean).join(' '));
  const authorRows = '<div class="section-authors" data-author="" data-published="">'
    + '<!-- Byline --><div>Rowan Wang<div style="float: right;">April 24, 2025</div></div>'
    + '<p>Avery Griffin<sup>‡</sup>, Johannes Treutlein</p>'
    + '<p>Ethan Perez, Julian Michael<sup>§</sup>, Fabien Roger, Sam Marks</p>'
    + '<div><p>Anthropic; <sup>‡</sup>MATS; <sup>§</sup>Scale AI</p></div></div>';
  const body = '<p>Introduction with <em>emphasis</em>.</p><h2>Methods</h2>'
    + '<p>A finding<d-footnote>Supporting detail.</d-footnote> with evidence.</p>'
    + '<figure><img src="figure.png"><figcaption>Figure explanation.</figcaption></figure>'
    + '<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Accuracy</td><td>0.8</td></tr></table>'
    + '<details><summary>Appendix</summary><p>Final source detail.</p></details>'
    + '<script type="application/json">{"notArticleText":true}</script><style>.notArticleText {color:red}</style>'
    + '<noscript>notArticleText</noscript>';
  const fixture = (byline = authorRows, frontMatter = {title, description, authors: [null]}) => '<!doctype html><meta charset="utf-8">'
    + '<title>' + title + '</title><d-front-matter><script type="text/json">' + JSON.stringify(frontMatter) + '</script></d-front-matter>'
    + '<body><nav>Navigation clutter</nav><d-title><h1>' + title + '</h1></d-title>'
    + '<d-article>' + byline + body + '</d-article><footer>Footer clutter</footer>';
  html = fixture();
  const fallback = await extract(url, null);
  assert.equal(fallback.error, undefined);
  assert.equal(fallback.item.title, title);
  assert.equal(fallback.item.itemType, 'blogPost');
  assert.equal(fallback.item.blogTitle, 'Alignment Science Blog');
  assert.equal(fallback.item.date, '2025-04-24');
  assert.equal(fallback.item.abstractNote, description);
  assert.deepEqual(authorNames(fallback.item), names);
  assert.equal(fallback.source.url, url);
  assert.deepEqual(fallback.source.pdfURLs, [], 'Do not follow unrelated article links');
  assert.match(fallback.source.pageText, /^Introduction with emphasis\./);
  assert.match(fallback.source.pageText, /Methods\n\nA finding \(Supporting detail\.\)  with evidence\./);
  for (const text of ['Figure explanation.', 'Metric\tValue', 'Accuracy\t0.8', 'Appendix', 'Final source detail.']) {
    assert.ok(fallback.source.pageText.includes(text), text);
  }
  assert.doesNotMatch(fallback.source.pageText, /notArticleText|Navigation clutter|Footer clutter|MATS/);
  assert.equal(await page.$eval('.section-authors sup', node => node.textContent), '‡', 'Extraction must not alter the original page');
  assert.equal((await extract()).source.pageText, fallback.source.pageText, 'Text-only extraction uses the same article body');
  const editor = {lastName: 'Existing editor', creatorType: 'editor', fieldMode: 1};
  const translated = {itemType: 'webpage', title, url, date: '2025', creators: [...fallback.item.creators.slice(1), editor],
    abstractNote: 'Translated abstract', tags: ['Alignment'], attachments: []};
  const repaired = (await extract(url, translated)).item;
  assert.deepEqual(repaired, {...translated, itemType: 'blogPost', blogTitle: 'Alignment Science Blog',
    date: '2025-04-24', creators: [...fallback.item.creators, editor]});
  assert.deepEqual((await extract(url, repaired)).item, repaired, 'Preserve complete metadata without duplicating authors');
  console.log('PASS: multi-row bylines import all seven authors, date, blog metadata, and full article text without affiliations or page clutter');

  const petriNames = ['Kai Fronsdal', 'Isha Gupta', 'Abhay Sheshadri', 'Jonathan Michala', 'Stephen McAleer', 'Rowan Wang', 'Sara Price', 'Samuel R. Bowman'];
  html = fixture('<div class="section-authors" data-author="' + petriNames.slice(0, -1).join(', ') + ', and Samuel R. Bowman" data-published="">'
    + '<div style="float: right;">October 6,\n2025</div></div>');
  const petri = (await extract(url, null)).item;
  assert.deepEqual(authorNames(petri), petriNames);
  assert.equal(petri.date, '2025-10-06');
  html = fixture('<div class="section-authors" data-author="Samuel R. Bowman" data-published="April 23, 2025"></div>');
  const single = (await extract(url, null)).item;
  assert.deepEqual(authorNames(single), ['Samuel R. Bowman']);
  assert.equal(single.date, '2025-04-23');
  html = fixture('', {});
  const incomplete = (await extract(url, translated)).item;
  assert.deepEqual(incomplete.creators, translated.creators, 'Missing bylines must preserve translator metadata');
  assert.equal(incomplete.date, translated.date);
  assert.equal(incomplete.abstractNote, translated.abstractNote);
  html = fixture();
  assert.deepEqual((await extract('https://example.org/article', translated)).item, translated, 'Do not alter unrelated sites');
  html = '<!doctype html><title>Alignment Science Blog</title><body><p>Blog index</p>';
  const index = await extract('https://alignment.anthropic.com/', translated);
  assert.deepEqual(index.item, translated, 'Do not change non-article pages');
  assert.equal(index.source.pageText, 'Blog index');
  console.log('PASS: attribute bylines, single authors, missing metadata, and non-article pages');

  if (process.argv.includes('--live')) {
    for (const post of [
      {url, title, names, date: '2025-04-24', sections: ['Introduction', 'Methods', 'Additional Discussion on Finetuning', 'Pareto improvement over LoRA']},
      {url: 'https://alignment.anthropic.com/2025/petri/', title: 'Petri: An open-source auditing tool to accelerate AI safety research',
        names: petriNames, date: '2025-10-06', sections: ['Petri']},
      {url: 'https://alignment.anthropic.com/2025/bumpers/', title: 'Putting up Bumpers',
        names: ['Samuel R. Bowman'], date: '2025-04-23', sections: ['misalignment']}
    ]) {
      const result = await worker.evaluate(url => Zotero.Research.extractPaper(url), post.url);
      assert.equal(result.item.title, post.title);
      assert.equal(result.item.itemType, 'blogPost');
      assert.equal(result.item.blogTitle, 'Alignment Science Blog');
      assert.equal(result.item.date, post.date);
      assert.deepEqual(authorNames(result.item), post.names);
      assert.ok(result.source.pageText.length > 1000);
      for (const section of post.sections) assert.ok(result.source.pageText.includes(section), section);
      assert.doesNotMatch(result.source.pageText, /function numberFigures|\.section-authors\s*\{/);
      console.log(`PASS: real inactive-tab import of ${post.title}: ${result.source.pageText.length} characters, ${post.names.length} authors, ${result.item.date}`);
    }
  }
} finally { await browser.close(); }
