import assert from 'node:assert/strict';

export async function checkPanelDocking(page, panel, screenshotPrefix) {
  const iframe = await panel.frameElement(), viewport = page.viewport();
  // Resizing crosses the content-script/background/iframe boundary. Wait for
  // both the iframe viewport and its position to settle before pointer input.
  async function clickControl(selector) {
    await panel.waitForFunction(({width, height}) => {
      const mode = document.body.dataset.mode, docked = mode !== 'floating';
      const requestedWidth = mode === 'minimized' ? 320 : docked ? 440 : document.body.classList.contains('results') ? 760 : 360;
      const requestedHeight = Math.ceil(document.body.getBoundingClientRect().height);
      return innerWidth === Math.min(requestedWidth, width - 32)
        && innerHeight === Math.min(requestedHeight, docked ? 640 : 760, height - (docked ? 16 : 32));
    }, {}, page.viewport());
    await page.waitForFunction(async n => {
      const before = JSON.stringify(n.getBoundingClientRect());
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return before === JSON.stringify(n.getBoundingClientRect());
    }, {}, iframe);
    await panel.locator(selector).click();
  }
  const originalDraft = await panel.$eval('#question', n => n.value);
  const originalJob = await panel.evaluate(() => ({id: job?.id, messages: job?.messages}));
  await panel.evaluate(() => { window.dockingMarker = crypto.randomUUID(); });
  const marker = await panel.evaluate(() => window.dockingMarker);
  await panel.$eval('#question', n => { n.value = 'Keep this unsent question.'; });
  assert.equal(await panel.evaluate(() => document.body.dataset.mode), 'floating');
  assert.equal(await panel.$eval('#minimize', n => n.hidden), true);
  if (screenshotPrefix) await page.screenshot({path: screenshotPrefix + '-before-dock.png'});
  await clickControl('#dock');
  await page.waitForFunction(n => n.style.bottom === '0px' && n.getBoundingClientRect().width === 440, {}, iframe).catch(async error => {
    console.log('Dock diagnostics:', await iframe.evaluate(n => ({style: n.getAttribute('style'), rect: n.getBoundingClientRect().toJSON()})),
      await panel.evaluate(() => ({mode: panelMode, lastSize, error: document.getElementById('error').textContent})));
    throw error;
  });
  assert.equal(await iframe.evaluate(n => n.style.boxShadow.includes('100vmax')), false, 'Docked panels do not dim the document');
  assert.equal(await panel.$eval('#dock', n => n.getAttribute('aria-label')), 'Return to centered view');
  assert.equal(await panel.$eval('#minimize', n => n.hidden), false);
  const rect = await iframe.boundingBox();
  assert.equal(rect.x + rect.width, viewport.width - 16);
  assert.equal(rect.y + rect.height, viewport.height);
  assert.ok(rect.height <= 640);
  if (await page.$('h1')) {
    await page.$eval('h1', n => n.addEventListener('click', () => { window.paperClickedWhileDocked = true; }, {once: true}));
    await page.click('h1');
    assert.equal(await page.evaluate(() => window.paperClickedWhileDocked), true, 'The underlying document remains interactive');
  }
  if (screenshotPrefix) await page.screenshot({path: screenshotPrefix + '-docked.png'});

  await panel.evaluate(() => window.scrollTo(0, 140));
  const scroll = await panel.evaluate(() => window.scrollY);
  await clickControl('#minimize');
  await page.waitForFunction(n => n.getBoundingClientRect().height === 56 && n.getBoundingClientRect().width === 320, {}, iframe);
  assert.equal(await panel.$eval('main', n => n.getClientRects().length), 0);
  assert.equal(await panel.$eval('#restoreTitle', n => n.textContent), 'Zotero Research');
  assert.equal(await iframe.evaluate(n => n.style.boxShadow.includes('100vmax')), false, 'Minimized panels do not dim the document');
  const minimizedRect = await iframe.boundingBox();
  assert.equal(minimizedRect.x + minimizedRect.width, viewport.width - 16);
  assert.equal(minimizedRect.y + minimizedRect.height, viewport.height);
  assert.equal(await panel.$eval('#close', n => n.getClientRects().length > 0), true);
  if (screenshotPrefix) await page.screenshot({path: screenshotPrefix + '-minimized.png'});
  // The restore button also works from the keyboard.
  await panel.focus('#restore');
  await page.keyboard.press('Enter');
  await panel.waitForFunction(() => document.body.dataset.mode === 'docked' && innerHeight > 56);
  await panel.waitForFunction(y => Math.abs(window.scrollY - y) <= 1, {}, scroll);
  assert.equal(await panel.$eval('#question', n => n.value), 'Keep this unsent question.');
  assert.equal(await panel.evaluate(() => window.dockingMarker), marker, 'The same panel remains alive');
  assert.deepEqual(await panel.evaluate(() => ({id: job?.id, messages: job?.messages})), originalJob);

  await page.setViewport({width: 360, height: 620});
  await page.waitForFunction(n => n.getBoundingClientRect().width === 328, {}, iframe);
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Docked content fits a narrow viewport');
  const narrow = await iframe.boundingBox();
  assert.equal(narrow.x, 16);
  assert.equal(narrow.y + narrow.height, 620);
  assert.ok(narrow.y >= 16);
  if (screenshotPrefix) await page.screenshot({path: screenshotPrefix + '-docked-narrow.png'});
  await clickControl('#minimize');
  await page.waitForFunction(n => n.getBoundingClientRect().height === 56, {}, iframe);
  await clickControl('#restore');
  await panel.waitForFunction(() => document.body.dataset.mode === 'docked' && innerHeight > 56);
  await page.setViewport(viewport);
  await clickControl('#dock');
  await page.waitForFunction(n => n.style.bottom === 'auto' && n.getBoundingClientRect().width === 760, {}, iframe);
  const centered = await iframe.boundingBox();
  assert.equal(centered.x + centered.width / 2, viewport.width / 2);
  assert.equal(centered.y + centered.height / 2, viewport.height / 2);
  assert.equal(await panel.$eval('#minimize', n => n.hidden), true);
  assert.equal(await panel.$eval('#question', n => n.value), 'Keep this unsent question.');
  await panel.$eval('#question', (n, draft) => { n.value = draft; }, originalDraft);
  console.log('PASS: dock, minimize, keyboard reopen, center, narrow layout, draft, conversation and scroll preservation');
}
