import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const output = root + '/dist/research-ui-test';
await mkdir(output, {recursive: true});
const require = createRequire(root + '/package.json');
const {default: puppeteer} = await import(require.resolve('puppeteer'));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Paper preview</title><main><h1>Paper preview</h1></main>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/paper`;
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome',
  enableExtensions: [root + '/build/manifestv3'], defaultViewport: {width: 1100, height: 900}});
try {
  const workerTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'));
  const worker = await workerTarget.worker();
  await worker.evaluate(async () => {
    await Zotero.initDeferred.promise;
    await Zotero.Prefs.set('firstUse', false);
    let currentJob = null;
    Zotero.Research.setTestJob = job => { currentJob = job; };
    Zotero.Research.call = async (method, data) => {
      if (method === 'status') return {job: currentJob};
      if (method === 'start') {
        currentJob = {id: 'ui-test', status: 'ingesting', stage: 'Reading paper and writing summary',
          mode: data.mode, title: 'Paper preview', model: 'gpt-6-astra', messages: [],
          createdAt: new Date(Date.now() - 125000).toISOString(),
          operationStartedAt: new Date(Date.now() - 65000).toISOString()};
      }
      if (method === 'chat') {
        if (data.source) throw new Error('Resumed chat must not extract the page again');
        Zotero.Research.chatVerified = true;
        currentJob.messages.push({role: 'user', text: data.question}, {role: 'assistant', text: '**Same session.**'});
      }
      if (method === 'category') {
        if (data.key === 'fail') throw new Error('Category save failed');
        currentJob.existingCollections = currentJob.existingCollections.filter(c => c.key !== data.key);
        if (data.selected) currentJob.existingCollections.push(currentJob.availableCollections.find(c => c.key === data.key));
      }
      if (method === 'approve') currentJob = {...currentJob, status: 'ready', stage: 'Ready to discuss'};
      return currentJob;
    };
    Zotero.Research.ordinarySaves = 0;
    Zotero.Connector_Browser.saveAsWebpage = async () => { Zotero.Research.ordinarySaves++; };
    Zotero.Connector_Browser.saveWithTranslator = async () => { Zotero.Research.ordinarySaves++; };
  });
  const page = await browser.newPage();
  await page.goto(url);
  const tabID = await worker.evaluate(async url => (await browser.tabs.query({url}))[0].id, url);
  await worker.evaluate(async id => Zotero.Connector_Browser.onZoteroButtonElementClick(await browser.tabs.get(id)), tabID);
  const panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
  await panel.waitForFunction(() => document.getElementById('progress').hidden && innerHeight === Math.ceil(document.body.getBoundingClientRect().height));
  const ready = await panel.evaluate(() => ({height: innerHeight, text: document.body.innerText,
    buttons: [...document.querySelectorAll('main button, footer button')].filter(b => b.offsetHeight).map(b => b.textContent)}));
  assert.deepEqual(ready.buttons, ['Add entry & Summarize', 'Add PDF & Summarize', 'Save with usual workflow']);
  assert.ok(!ready.text.includes('A concise research') && !ready.text.includes('Ready'));
  assert.ok(ready.height < 300, JSON.stringify(ready));
  await (await panel.frameElement()).screenshot({path: output + '/zotero-panel-ready.png'});
  await panel.$eval('#entry', button => button.click());
  await panel.waitForFunction(() => document.getElementById('elapsed').textContent.includes('1m') && innerHeight === Math.ceil(document.body.getBoundingClientRect().height), {timeout: 5000}).catch(async error => {
    console.log(await panel.evaluate(() => ({height: innerHeight, bodyHeight: document.body.getBoundingClientRect().height, text: document.body.innerText, job, busy})));
    throw error;
  });
  const progress = await panel.evaluate(() => ({height: innerHeight, elapsed: document.getElementById('elapsed').textContent,
    stage: document.getElementById('status').textContent, active: !document.getElementById('activity').hidden}));
  assert.ok(progress.active && progress.stage.startsWith('Codex:'));
  assert.ok(progress.elapsed.includes('gpt-6-astra'));
  assert.ok(progress.height < 240, JSON.stringify(progress));
  await (await panel.frameElement()).screenshot({path: output + '/zotero-panel-progress.png'});
  await panel.waitForFunction(previous => document.getElementById('elapsed').textContent !== previous, {}, progress.elapsed);
  const job = {id: 'ui-test', status: 'awaiting_approval', stage: 'Review proposed categories', title: 'Paper preview',
    summary: 'A saved result. '.repeat(150), messages: [], existingCollections: [{key: 'a', path: 'Machine learning / Attention'}],
    availableCollections: [{key: 'a', path: 'Machine learning / Attention'}, {key: 'b', path: 'Safety / Oversight'}, {key: 'fail', path: 'Broken category'}],
    threadId: '019-test-persistent-session',
    proposedCollections: [{name: 'A proposed category', reason: 'Relevant topic'}], coverage: 'full_text'};
  await worker.evaluate(job => Zotero.Research.setTestJob(job), job);
  await panel.evaluate(() => refresh());
  await panel.waitForFunction(() => innerHeight === 760);
  assert.equal(await panel.$eval('#chat', n => n.hidden), true);
  assert.equal(await panel.$eval('#activity', n => n.hidden), true);
  job.summary = 'A saved result.';
  await worker.evaluate(job => Zotero.Research.setTestJob(job), job);
  await panel.evaluate(() => refresh());
  await panel.waitForFunction(() => innerHeight === Math.min(760, Math.ceil(document.body.getBoundingClientRect().height)));

  await panel.click('#skip');
  await panel.waitForFunction(() => !document.getElementById('chat').hidden);
  await panel.waitForFunction(() => innerWidth === 760 && innerHeight === Math.min(760, Math.ceil(document.body.getBoundingClientRect().height)));
  const rect = await (await panel.frameElement()).boundingBox();
  assert.ok(Math.abs(rect.x + rect.width / 2 - 550) < 2, JSON.stringify(rect));
  assert.ok(Math.abs(rect.y + rect.height / 2 - 450) < 2, JSON.stringify(rect));
  assert.equal(rect.width, 760);
  assert.equal(await panel.$eval('#title', n => n.parentElement.parentElement.tagName), 'HEADER');
  assert.equal(await panel.$('label[for="question"]'), null);
  await panel.click('#categoryPicker > summary');
  await panel.type('#categorySearch', 'Oversight');
  assert.equal(await panel.$$eval('#categoryOptions label:not([hidden])', nodes => nodes.length), 1);
  await panel.click('input[data-key="b"]');
  await panel.waitForFunction(() => document.getElementById('categoryStatus').textContent === 'Saved to Zotero');
  assert.equal(await panel.$eval('#categoryChips', n => n.children.length), 2);
  await panel.click('.chip-remove[aria-label="Remove Machine learning / Attention"]');
  await panel.waitForFunction(() => document.getElementById('categoryChips').children.length === 1);
  await panel.$eval('#categorySearch', n => { n.value = ''; n.dispatchEvent(new Event('input')); });
  await panel.click('input[data-key="fail"]');
  await panel.waitForFunction(() => document.getElementById('categoryStatus').textContent === 'Category save failed');
  assert.equal(await panel.$eval('input[data-key="fail"]', n => n.checked), false);
  await panel.click('#categoryPicker > summary');
  const markdownText = '**Key finding**\n\n- A grounded result\n- A limitation\n\n| Metric | Value |\n| --- | --- |\n| Recall | 0.8 |\n\n```python\nprint("hello")\n```\n\n[Paper](https://example.org/paper) <img src=x onerror="window.pwned=1"> <script>window.pwned=1</script> [bad](javascript:alert(1))';
  await panel.evaluate(text => { render({...job, messages: [{role: 'user', text: '**Keep this literal**'}, {role: 'assistant', text}]}); }, markdownText);
  assert.equal(await panel.$$eval('.assistant strong', n => n.length), 2);
  assert.equal(await panel.$$eval('.assistant li', n => n.length), 2);
  assert.equal(await panel.$$eval('.assistant table', n => n.length), 1);
  assert.equal(await panel.$$eval('.assistant pre code', n => n.length), 1);
  assert.equal(await panel.$$eval('.assistant script, .assistant img, .assistant [onerror], .assistant [href^="javascript:"]', n => n.length), 0);
  assert.equal(await panel.$$eval('.user > div strong', n => n.length), 0);
  await panel.focus('#session > summary');
  await page.keyboard.press('Enter');
  await panel.waitForFunction(() => $('session').open);
  await panel.focus('#copySession');
  await page.keyboard.press('Enter');
  await panel.waitForFunction(() => !!document.getElementById('copyStatus').textContent, {timeout: 2000}).catch(async e => { console.log(await panel.evaluate(() => ({copy: $('copyStatus').textContent, focus: document.activeElement?.tagName, hasFocus: document.hasFocus()}))); throw e; });
  console.log('clipboard:', await panel.$eval('#copyStatus', n => n.textContent));
  assert.equal(await panel.$eval('#copyStatus', n => n.textContent), 'Copied');
  assert.equal(await panel.$eval('#sessionCommand', n => n.textContent), 'codex resume 019-test-persistent-session');
  await panel.evaluate(() => window.scrollTo(0, 0));
  await panel.evaluate(() => { $('categoryStatus').textContent = ''; $('categoryStatus').classList.remove('failed'); });
  await page.screenshot({path: output + '/zotero-research-centered.png'});
  await page.setViewport({width: 420, height: 700});
  await panel.waitForFunction(() => innerWidth <= 388);
  const narrow = await (await panel.frameElement()).boundingBox();
  assert.ok(narrow.x >= 15 && narrow.y >= 15 && narrow.height <= 668, JSON.stringify(narrow));
  await panel.type('#question', 'Continue the discussion.');
  await panel.focus('#send');
  await page.keyboard.press('Enter');
  await panel.waitForFunction(() => !busy && job.messages.some(m => m.text === '**Same session.**'));
  assert.equal(await worker.evaluate(() => Zotero.Research.chatVerified), true);
  const closed = new Promise(resolve => page.on('framedetached', frame => { if (frame === panel) resolve(); }));
  await panel.click('#ordinary');
  await closed;
  assert.equal(await worker.evaluate(() => Zotero.Research.ordinarySaves), 1);
  console.log(JSON.stringify({ready, progress, longContentCapsAt760: true, shrinksAfterContentChange: true,
    categoryGateAndOrdinarySavePreserved: true, centered: rect, categoryEditingAndMarkdown: true, narrow}, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
