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
    let currentJob = null, statusError = 'Zotero is unavailable';
    Zotero.Research.setStatusError = message => { statusError = message; };
    Zotero.Research.setTestJob = job => { currentJob = job; };
    Zotero.Research.call = async (method, data) => {
      if (method === 'status') {
        if (statusError) throw new Error(statusError);
        return {job: currentJob};
      }
      if (method === 'command') return {command: 'codex resume ' + currentJob.threadId};
      if (method === 'start') {
        currentJob = {id: 'ui-test', status: 'ingesting', stage: 'Reading paper and writing summary',
          mode: data.mode, title: 'Paper preview', model: 'gpt-6-astra', messages: [],
          createdAt: new Date(Date.now() - 125000).toISOString(),
          operationStartedAt: new Date(Date.now() - 65000).toISOString()};
      }
      if (method === 'summarize') {
        if (data.source) throw new Error('Summary in an existing session must not fetch the page again');
        currentJob.status = 'summarizing'; currentJob.error = null;
        currentJob.stage = 'Reading paper and writing summary';
        currentJob.operationStartedAt = new Date().toISOString();
      }
      if (method === 'chat') {
        if (data.source) throw new Error('Resumed chat must not extract the page again');
        Zotero.Research.chatVerified = true;
        currentJob.status = 'chatting'; currentJob.partial = '';
        currentJob.stage = 'Answering in the paper’s Codex session';
        currentJob.operationStartedAt = new Date().toISOString();
        currentJob.messages.push({role: 'user', text: data.question});
      }
      if (method === 'category') {
        if (data.key === 'fail') throw new Error('Category save failed');
        currentJob.existingCollections = currentJob.existingCollections.filter(c => c.key !== data.key);
        if (data.selected) currentJob.existingCollections.push(currentJob.availableCollections.find(c => c.key === data.key));
      }
      if (method === 'approve') currentJob = {...currentJob, approved: data.selected};
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
  let panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
  await panel.waitForFunction(() => !document.getElementById('error').hidden);
  assert.equal(await panel.$eval('#error', n => n.textContent), 'Zotero is unavailable');
  assert.equal(await panel.$eval('#progress', n => n.hidden), true, 'A failed initial status check must stop connecting');
  const buttons = await panel.evaluate(() => ['entry', 'pdf', 'ordinary'].map(id => {
    const node = document.getElementById(id), rect = node.getBoundingClientRect();
    return {parent: node.parentElement.id, top: rect.top, bottom: rect.bottom};
  }));
  assert.deepEqual(buttons.map(b => b.parent), ['actions', 'actions', 'actions']);
  assert.equal(buttons[2].top - buttons[1].bottom, buttons[1].top - buttons[0].bottom);
  await worker.evaluate(() => Zotero.Research.setStatusError(null));
  await panel.evaluate(() => refresh());
  assert.equal(await panel.$eval('#error', n => n.hidden), true);

  await panel.waitForFunction(() => document.getElementById('progress').hidden && innerHeight === Math.ceil(document.body.getBoundingClientRect().height));
  const ready = await panel.evaluate(() => ({width: innerWidth, height: innerHeight, text: document.body.innerText,
    scrollHeight: document.documentElement.scrollHeight, bottomGap: innerHeight - document.getElementById('ordinary').getBoundingClientRect().bottom,
    buttons: [...document.querySelectorAll('main button, footer button')].filter(b => b.offsetHeight).map(b => b.textContent)}));
  assert.deepEqual(ready.buttons, ['Add entry & Summarize', 'Add PDF & Summarize', 'Save with usual workflow']);
  assert.ok(!ready.text.includes('A concise research') && !ready.text.includes('Ready'));
  assert.equal(ready.width, 360);
  assert.ok(ready.height >= 260 && ready.height < 300, JSON.stringify(ready));
  assert.ok(ready.bottomGap >= 24, JSON.stringify(ready));
  assert.ok(ready.scrollHeight <= ready.height, 'All three actions must fit without a scrollbar');
  await (await panel.frameElement()).screenshot({path: output + '/zotero-panel-ready.png'});
  // Ordinary saving is an initial choice, not an action on an ingested paper.
  const ordinaryClosed = new Promise(resolve => page.on('framedetached', frame => { if (frame === panel) resolve(); }));
  await panel.focus('#ordinary');
  await page.keyboard.press('Enter');
  await worker.waitForFunction(() => Zotero.Research.ordinarySaves === 1, {timeout: 5000});
  await ordinaryClosed;
  assert.equal(await worker.evaluate(() => Zotero.Research.ordinarySaves), 1);
  await worker.evaluate(async id => Zotero.Connector_Browser.onZoteroButtonElementClick(await browser.tabs.get(id)), tabID);
  panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
  await panel.waitForFunction(() => document.getElementById('progress').hidden);
  assert.equal(await panel.$eval('#entry', button => {
    button.click();
    return document.getElementById('ordinary').getClientRects().length;
  }), 0, 'Ordinary saving must disappear as soon as entry summarization is selected');
  await panel.waitForFunction(() => document.getElementById('elapsed').textContent.includes('1m') && innerHeight === Math.ceil(document.body.getBoundingClientRect().height), {timeout: 5000}).catch(async error => {
    console.log(await panel.evaluate(() => ({height: innerHeight, bodyHeight: document.body.getBoundingClientRect().height, text: document.body.innerText, job, busy})));
    throw error;
  });
  const progress = await panel.evaluate(() => ({height: innerHeight, elapsed: document.getElementById('elapsed').textContent,
    stage: document.getElementById('status').textContent, active: !document.getElementById('activity').hidden}));
  assert.ok(progress.active && progress.stage.startsWith('Codex:'));
  assert.equal(await panel.$eval('#progress', n => n.nextElementSibling.id), 'error', 'Ingestion progress stays above the paper');
  assert.equal(await panel.$eval('#ordinary', n => n.getClientRects().length), 0);
  assert.ok(progress.elapsed.includes('gpt-6-astra'));
  assert.ok(progress.height < 240, JSON.stringify(progress));
  await (await panel.frameElement()).screenshot({path: output + '/zotero-panel-progress.png'});
  await panel.waitForFunction(previous => document.getElementById('elapsed').textContent !== previous, {}, progress.elapsed);
  const job = {id: 'ui-test', status: 'ready', stage: 'Ready to discuss', title: 'Paper preview',
    summary: 'A saved result. '.repeat(150), messages: [], existingCollections: [{key: 'a', path: 'Machine learning / Attention'}],
    availableCollections: [{key: 'a', path: 'Machine learning / Attention'}, {key: 'b', path: 'Safety / Oversight'}, {key: 'fail', path: 'Broken category'}],
    threadId: '019-test-persistent-session', model: 'gpt-6-astra', sourceInfo: {kind: 'PDF text'},
    proposedCollections: [{name: 'A proposed category', reason: 'Relevant topic'}], coverage: 'full_text'};
  await worker.evaluate(job => Zotero.Research.setTestJob(job), job);
  await panel.evaluate(() => refresh());
  await panel.waitForFunction(() => innerHeight === 760);
  assert.equal(await panel.$eval('#chat', n => n.hidden), false, 'Chat is available before category review');
  assert.equal(await panel.$eval('#coverage', n => n.hidden), true);
  assert.equal(await panel.$eval('#ordinary', n => n.getClientRects().length), 0);
  assert.equal(await panel.$eval('#activity', n => n.hidden), true);
  job.summary = 'A saved result.';
  await worker.evaluate(job => Zotero.Research.setTestJob(job), job);
  await panel.evaluate(() => refresh());
  await panel.waitForFunction(() => innerHeight === Math.min(760, Math.ceil(document.body.getBoundingClientRect().height)));

  assert.deepEqual(await panel.$$eval('#categories, #approval, #paper, #chat', nodes => nodes.map(n => n.id)),
    ['categories', 'approval', 'paper', 'chat'], 'Category suggestions belong above the summary and discussion');
  assert.equal(await panel.$eval('#approval', n => n.hidden), false);
  const approvalButtons = await panel.$$eval('.approval-actions button', nodes => nodes.map(n => ({text: n.textContent,
    top: n.getBoundingClientRect().top, left: n.getBoundingClientRect().left, right: n.getBoundingClientRect().right})));
  assert.deepEqual(approvalButtons.map(b => b.text), ['Save choices', 'Skip new categories']);
  assert.equal(approvalButtons[0].top, approvalButtons[1].top, 'Review buttons share a row');
  assert.ok(approvalButtons[0].right < approvalButtons[1].left);
  await page.screenshot({path: output + '/zotero-category-proposals.png'});

  await panel.click('#proposals input');
  await panel.type('#question', 'Discuss before category review.');
  await panel.focus('#send');
  await page.keyboard.press('Enter');
  await panel.waitForFunction(() => !busy && job.status === 'chatting');
  assert.equal(await panel.$eval('#approval', n => n.hidden), false, 'Suggestions stay visible during a reply');
  assert.equal(await panel.$eval('#proposals input', n => n.checked), true, 'Chat does not reset pending selections');
  await panel.click('#skip');
  await panel.waitForFunction(() => !busy && document.getElementById('approval').hidden);
  assert.equal(await panel.$eval('#chat', n => n.hidden), false);
  assert.equal(await panel.$eval('#send', n => n.disabled), true, 'Skipping categories must not finish the active reply');
  const pendingReply = await panel.evaluate(() => job);
  assert.equal(pendingReply.status, 'chatting');
  assert.deepEqual(pendingReply.approved, []);
  await worker.evaluate(job => Zotero.Research.setTestJob({...job, status: 'ready',
    messages: [...job.messages, {role: 'assistant', text: 'A reply independent of category review.'}]}), pendingReply);
  await panel.waitForFunction(() => job.status === 'ready' && !document.getElementById('send').disabled);
  assert.equal(await panel.$eval('#approval', n => n.hidden), true);
  // Restore the short fixture before the independent category-picker checks.
  await worker.evaluate(async () => {
    const {job} = await Zotero.Research.call('status');
    Zotero.Research.setTestJob({...job, messages: []});
  });
  await panel.evaluate(async () => { await refresh(); window.scrollTo(0, 0); });
  await panel.waitForFunction(() => innerWidth === 760 && innerHeight === Math.min(760, Math.ceil(document.body.getBoundingClientRect().height)));
  const rect = await (await panel.frameElement()).boundingBox();
  assert.ok(Math.abs(rect.x + rect.width / 2 - 550) < 2, JSON.stringify(rect));
  assert.ok(Math.abs(rect.y + rect.height / 2 - 450) < 2, JSON.stringify(rect));
  assert.equal(rect.width, 760);
  assert.equal(await panel.$eval('#title', n => n.parentElement.parentElement.tagName), 'HEADER');
  assert.equal(await panel.$('label[for="question"]'), null);
  await panel.click('#categoryPicker > summary');
  await panel.click('#categorySearch');
  assert.equal(await panel.$eval('#categoryPicker', n => n.open), true, 'Clicks inside the picker keep it open');
  await panel.click('#title');
  assert.equal(await panel.$eval('#categoryPicker', n => n.open), false, 'Clicks elsewhere in the panel close the picker');
  await panel.click('#categoryPicker > summary');
  await page.click('h1');
  assert.equal(await panel.$eval('#categoryPicker', n => n.open), false, 'Clicks on the surrounding page close the picker');
  await panel.click('#categoryPicker > summary');
  await panel.type('#categorySearch', 'Oversight');
  assert.equal(await panel.$$eval('#categoryOptions label:not([hidden])', nodes => nodes.length), 1);
  await panel.click('input[data-key="b"]');
  await panel.waitForFunction(() => document.getElementById('categoryStatus').textContent === 'Saved to Zotero');
  assert.equal(await panel.$eval('#categoryChips', n => n.children.length), 2);
  await panel.click('.chip-remove[aria-label="Remove Machine learning / Attention"]');
  await panel.waitForFunction(() => document.getElementById('categoryChips').children.length === 1);
  assert.equal(await panel.$eval('#categoryPicker', n => n.open), false);
  await panel.click('#categoryPicker > summary');
  await panel.$eval('#categorySearch', n => { n.value = ''; n.dispatchEvent(new Event('input')); });
  await panel.click('input[data-key="fail"]');
  await panel.waitForFunction(() => document.getElementById('categoryStatus').textContent === 'Category save failed');
  assert.equal(await panel.$eval('input[data-key="fail"]', n => n.checked), false);
  await panel.click('#categoryPicker > summary');
  const markdownText = '**Key finding**\n\n- A grounded result\n- A limitation\n\n| Metric | Value |\n| --- | --- |\n| Recall | 0.8 |\n\n```python\nprint("hello")\n```\n\n[Paper](https://example.org/paper) <img src=x onerror="window.pwned=1"> <script>window.pwned=1</script> [bad](javascript:alert(1))';
  await panel.evaluate(text => { render({...job, messages: [{role: 'user', text: '**Keep this literal**'}, {role: 'assistant', text}]}); }, markdownText);
  assert.deepEqual(await panel.$$eval('.message-role', nodes => nodes.map(n => n.textContent)), ['User', 'Assistant']);
  assert.equal(await panel.$$eval('.assistant strong', n => n.length), 2);
  assert.equal(await panel.$$eval('.assistant li', n => n.length), 2);
  assert.equal(await panel.$$eval('.assistant table', n => n.length), 1);
  assert.equal(await panel.$$eval('.assistant pre code', n => n.length), 1);
  assert.equal(await panel.$$eval('.assistant script, .assistant img, .assistant [onerror], .assistant [href^="javascript:"]', n => n.length), 0);
  assert.equal(await panel.$$eval('.user > div strong', n => n.length), 0);

  const mathText = String.raw`### How do they measure faithfulness?

- **Behavioral preferences, \(\hat p\):** weights inferred from choices.
- **Reported preferences, \(\tilde p\):** the average reported weights.

Their metric is:

\[
\text{Faithfulness}=\operatorname{corr}(\hat p,\tilde p).
\]

Inline dollars: $x_i^2$. Costs $5 and $10; escaped \$25.

$$\begin{pmatrix}a & b \\ c & d\end{pmatrix}$$

| Quantity | Formula |
| --- | --- |
| Estimate | $p_i$ |
` + '\nLiteral code: `\\(x_i\\)`\n\n```tex\n\\[x_i\\]\n```';
  const summaryMath = String.raw`Plain **summary** with \(p_i\).`;
  await panel.evaluate(({mathText, summaryMath}) => {
    render({...job, discussionHTML: null, summary: summaryMath, messages: [{role: 'assistant', text: mathText}]});
  }, {mathText, summaryMath});
  assert.equal(await panel.$$eval('.assistant .katex', nodes => nodes.length), 6);
  assert.equal(await panel.$$eval('.assistant .katex-display', nodes => nodes.length), 2);
  assert.equal(await panel.$$eval('.assistant .katex-error', nodes => nodes.length), 0);
  assert.equal(await panel.$eval('.assistant .katex-display annotation', n => n.textContent.trim()), String.raw`\text{Faithfulness}=\operatorname{corr}(\hat p,\tilde p).`);
  assert.equal(await panel.$$eval('.assistant code .katex', nodes => nodes.length), 0, 'Code remains literal');
  assert.ok(await panel.$eval('.assistant', n => n.textContent.includes('Costs $5 and $10; escaped $25.')));
  assert.equal(await panel.$$eval('#summary .katex', nodes => nodes.length), 1);
  assert.ok(await panel.$eval('#summary', n => n.textContent.startsWith('Plain **summary** with')), 'Summary prose retains plain-text formatting');
  await panel.evaluate(() => document.fonts.ready);
  assert.equal(await panel.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').some(f => f.family.startsWith('KaTeX_'))), true, 'Bundled math fonts load in the extension');
  await page.screenshot({path: output + '/zotero-research-math.png'});

  // Completed discussions usually come back as saved Zotero HTML, whose old
  // Markdown renderer stripped delimiters. Recover only unchanged answers.
  await panel.evaluate(text => {
    render({...job, discussionHTML: '<h2>Assistant</h2>' + markdownHTML(text, marked), discussionMessageCount: 1});
  }, mathText);
  assert.equal(await panel.$$eval('.assistant .katex', nodes => nodes.length), 6, 'Saved answers also render formulas');
  await panel.evaluate(() => render({...job, discussionHTML: job.discussionHTML.replace('weights inferred from choices.', 'My edited interpretation.')}));
  assert.ok(await panel.$eval('.assistant', n => n.textContent.includes('My edited interpretation.')), 'Never replace an edited Zotero note with the original answer');

  await panel.evaluate(() => render({...job, discussionHTML: null, messages: [], partial: String.raw`Let \(\frac{`}));
  assert.equal(await panel.$eval('#partial', n => n.textContent.trimEnd()), String.raw`Let (\frac{`);
  await panel.evaluate(() => render({...job, partial: String.raw`Let \(\frac{x}{y}\)`}));
  assert.equal(await panel.$$eval('#partial .katex', nodes => nodes.length), 1, 'Math appears once a streamed formula is complete');
  await panel.evaluate(() => render({...job, partial: String.raw`\(\frac{x}\) and \(\unknowncommand{x}\) and \(\href{javascript:alert(1)}{click}\)`}));
  assert.equal(await panel.$$eval('#partial .katex-error', nodes => nodes.length), 1, 'Malformed TeX stays visible without breaking the answer');
  assert.ok(await panel.$eval('#partial', n => n.textContent.includes('\\unknowncommand')), 'Unsupported commands stay visible');
  assert.equal(await panel.$$eval('#partial a, #partial script, #partial iframe', nodes => nodes.length), 0, 'Formula commands cannot add executable links');
  await panel.evaluate(() => render({...job, partial: '\\[' + Array.from({length: 60}, (_, i) => 'x_{' + i + '}').join('+') + '\\]'}));
  const formulaLayout = await panel.$eval('#partial .research-math-display', n => ({width: n.clientWidth, scroll: n.scrollWidth, panel: document.documentElement.clientWidth, body: document.body.scrollWidth}));
  assert.ok(formulaLayout.scroll > formulaLayout.width, 'Long equations scroll horizontally');
  assert.ok(formulaLayout.body <= formulaLayout.panel, 'Long equations do not widen the panel');
  console.log('PASS: inline/display math, saved discussions, streaming, local fonts, literal code/currency, and note-edit preservation');
  await panel.evaluate(text => render({...job, discussionHTML: null, partial: '', messages: [{role: 'user', text: '**Keep this literal**'}, {role: 'assistant', text}]}), markdownText);
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
  await page.setViewport({width: 1100, height: 900});
  await panel.waitForFunction(() => innerWidth === 760);
  await panel.evaluate(() => refresh()); // Restore backend state after the render-only Markdown fixture.
  const messagesBeforeShortcut = await panel.evaluate(() => job.messages.length);
  await panel.focus('#question');
  await page.keyboard.down('Meta');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Meta');
  assert.equal(await panel.evaluate(() => job.messages.length), messagesBeforeShortcut, 'Cmd+Enter must not send an empty message');
  await panel.type('#question', 'Continue the discussion.');
  await page.keyboard.press('Enter');
  await panel.type('#question', 'Explain the details.');
  assert.equal(await panel.$eval('#question', n => n.value), 'Continue the discussion.\nExplain the details.', 'Enter inserts a newline');
  assert.equal(await panel.evaluate(() => job.status), 'ready', 'Enter does not send the message');
  await page.keyboard.down('Meta');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Meta');
  await panel.waitForFunction(() => !busy && job.status === 'chatting');
  assert.equal(await panel.evaluate(() => job.messages.length), messagesBeforeShortcut + 1, 'Cmd+Enter sends exactly one message');
  assert.equal(await panel.evaluate(() => job.messages.at(-1).text), 'Continue the discussion.\nExplain the details.');
  const chatProgress = await panel.evaluate(() => {
    const progress = $('progress'), message = $('messages').lastElementChild;
    return {visible: progress.getClientRects().length > 0, parent: progress.parentElement.id,
      previous: progress.previousElementSibling.id, next: progress.nextElementSibling.id,
      stage: $('status').textContent, elapsed: $('elapsed').textContent,
      belowMessage: progress.getBoundingClientRect().top >= message.getBoundingClientRect().bottom,
      question: message.textContent, fontSize: getComputedStyle(message.lastElementChild).fontSize};
  });
  assert.equal(chatProgress.visible, true);
  assert.equal(chatProgress.parent, 'chat');
  assert.equal(chatProgress.previous, 'messages');
  assert.equal(chatProgress.next, 'partial');
  assert.equal(chatProgress.belowMessage, true);
  assert.ok(chatProgress.question.includes('Continue the discussion.'));
  assert.equal(chatProgress.fontSize, '15px');
  assert.equal(chatProgress.stage, 'Answering in the paper’s Codex session');
  assert.ok(chatProgress.elapsed.includes('gpt-6-astra'));
  await panel.$eval('#progress', n => n.scrollIntoView({block: 'nearest'}));
  await page.screenshot({path: output + '/zotero-chat-waiting.png'});

  const chattingJob = await panel.evaluate(() => job);
  await worker.evaluate(job => Zotero.Research.setTestJob({...job, partial: '**Same session.**', stage: 'Answering'}), chattingJob);
  await panel.waitForFunction(() => !document.getElementById('partial').hidden);
  assert.equal(await panel.$eval('#progress', n => n.hidden), true, 'The first streamed text replaces chat progress');
  assert.equal(await panel.$eval('#partial strong', n => n.textContent), 'Same session.');
  assert.equal(await panel.$eval('#partial', n => getComputedStyle(n).fontSize), '15px');
  await panel.evaluate(() => updateActivity());
  assert.equal(await panel.$eval('#progress', n => n.hidden), true, 'Elapsed-time updates must not bring progress back while streaming');

  const finishedJob = {...chattingJob, status: 'ready', stage: 'Ready to discuss', partial: '',
    messages: [...chattingJob.messages, {role: 'assistant', text: '**Same session.**'}]};
  await worker.evaluate(job => Zotero.Research.setTestJob(job), finishedJob);
  await panel.waitForFunction(() => job.status === 'ready' && !document.getElementById('send').disabled);
  assert.equal(await panel.$eval('#progress', n => n.hidden), true);
  assert.equal(await panel.$eval('.assistant > div', n => getComputedStyle(n).fontSize), '15px');
  assert.equal(await worker.evaluate(() => Zotero.Research.chatVerified), true);
  await page.screenshot({path: output + '/zotero-chat-complete.png'});

  // A follow-up starts a new waiting indicator; a failed answer clears it.
  await panel.type('#question', 'And the main limitation?');
  await panel.focus('#send');
  await page.keyboard.press('Enter');
  await panel.waitForFunction(() => !busy && job.status === 'chatting');
  assert.equal(await panel.$eval('#progress', n => !n.hidden && n.previousElementSibling.id === 'messages'), true);
  assert.ok(await panel.$eval('#messages', n => n.lastElementChild.textContent.includes('And the main limitation?')));
  const failedJob = await panel.evaluate(() => ({...job, status: 'ready', stage: 'Ready to discuss', error: 'Answer failed'}));
  await worker.evaluate(job => Zotero.Research.setTestJob(job), failedJob);
  await panel.waitForFunction(() => job.status === 'ready' && !document.getElementById('error').hidden);
  assert.equal(await panel.$eval('#progress', n => n.hidden), true);
  const noSummary = {...finishedJob, summary: '', error: null};
  await worker.evaluate(job => Zotero.Research.setTestJob(job), noSummary);
  await panel.evaluate(() => refresh());
  assert.equal(await panel.$eval('#paper', n => n.hidden), false);
  assert.equal(await panel.$eval('#produceSummary', n => n.hidden || n.disabled), false);
  await panel.$eval('#produceSummary', n => n.scrollIntoView({block: 'center'}));
  await page.screenshot({path: output + '/zotero-produce-summary.png'});
  await panel.click('#produceSummary');
  await panel.waitForFunction(() => !busy && job.status === 'summarizing');
  assert.equal(await panel.$eval('#progress', n => !n.hidden && n.parentElement.id === 'paper'), true);
  assert.equal(await panel.$eval('#chat', n => n.hidden), false);
  assert.equal(await panel.$eval('#produceSummary', n => n.disabled), true);
  assert.equal(await panel.$eval('#send', n => n.disabled), true);
  await panel.type('#question', 'Wait until the summary finishes.');
  await page.keyboard.down('Meta');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Meta');
  assert.equal(await panel.evaluate(() => job.status), 'summarizing', 'Cmd+Enter respects the disabled Send button');
  assert.equal(await panel.$eval('#question', n => n.value), 'Wait until the summary finishes.');
  await worker.evaluate(job => Zotero.Research.setTestJob({...job, error: 'Summary failed'}), noSummary);
  await panel.waitForFunction(() => job.status === 'ready');
  assert.equal(await panel.$eval('#produceSummary', n => n.disabled), false, 'Summary failures can be retried');
  await panel.click('#produceSummary');
  await panel.waitForFunction(() => !busy && job.status === 'summarizing');
  await worker.evaluate(job => Zotero.Research.setTestJob({...job, summary: 'The newly saved summary.'}), noSummary);
  await panel.waitForFunction(() => job.status === 'ready');
  assert.equal(await panel.$eval('#summary', n => n.textContent), 'The newly saved summary.');
  assert.equal(await panel.$eval('#produceSummary', n => n.hidden), true);
  assert.equal(await panel.$eval('#progress', n => n.hidden), true);
  assert.deepEqual(await panel.evaluate(() => job.messages), noSummary.messages);
  assert.deepEqual(await panel.evaluate(() => job.existingCollections), noSummary.existingCollections);
  const closed = new Promise(resolve => page.on('framedetached', frame => { if (frame === panel) resolve(); }));
  assert.equal(await panel.$eval('#ordinary', n => n.getClientRects().length), 0);
  await panel.click('#close');
  await closed;
  await worker.evaluate(() => Zotero.Research.setTestJob(null));
  await worker.evaluate(async id => Zotero.Connector_Browser.onZoteroButtonElementClick(await browser.tabs.get(id)), tabID);
  panel = await page.waitForFrame(f => f.url().includes('/research/panel.html'));
  await panel.waitForFunction(() => document.getElementById('progress').hidden);
  assert.equal(await panel.$eval('#pdf', button => {
    button.click();
    return document.getElementById('ordinary').getClientRects().length;
  }), 0, 'Ordinary saving must disappear as soon as PDF summarization is selected');
  await panel.waitForFunction(() => job?.mode === 'pdf' && !busy);
  assert.equal(await panel.$eval('#ordinary', n => n.getClientRects().length), 0);
  assert.equal(await worker.evaluate(() => Zotero.Research.ordinarySaves), 1);
  console.log(JSON.stringify({ready, progress, longContentCapsAt760: true, shrinksAfterContentChange: true,
    independentCategoryReviewAndOrdinarySavePreserved: true, chatProgress, streamingReplacesProgress: true, centered: rect, categoryEditingAndMarkdown: true, narrow}, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
