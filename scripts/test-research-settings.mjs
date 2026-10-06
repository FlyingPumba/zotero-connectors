import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
await mkdir(root + '/dist/research-ui-test', {recursive: true});
const browser = await puppeteer.launch({headless: true, pipe: true, channel: 'chrome',
  enableExtensions: [root + '/build/manifestv3'], defaultViewport: {width: 1100, height: 700}});
try {
  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background-worker.js'));
  const worker = await target.worker();
  await worker.evaluate(async () => {
    await Zotero.initDeferred.promise;
    await Zotero.Prefs.set('firstUse', false);
    const original = Zotero.Connector.callMethod.bind(Zotero.Connector);
    globalThis.settingsTest = {reads: 0, writes: 0, fail: false, current: {model: 'gpt-6-astra', effort: 'xhigh'}};
    Zotero.Connector.callMethod = async (options, data, ...args) => {
      if (options.method !== 'research/settings') return original(options, data, ...args);
      const state = globalThis.settingsTest;
      if (state.fail) return {error: 'Settings test: Zotero unavailable'};
      if (data.model !== undefined) { state.current = {...data}; state.writes++; }
      else state.reads++;
      return {...state.current, models: [
        {model: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Astra test description',
          supportedReasoningEfforts: [{reasoningEffort: 'high'}, {reasoningEffort: 'xhigh', description: 'Extra high test description'}]},
        {model: 'other-model', displayName: 'Other model', supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'medium'}]}
      ]};
    };
  });
  const page = await browser.newPage();
  const url = new URL('preferences/preferences.html', target.url()).href;
  const ready = () => page.waitForFunction(() => !document.getElementById('research-model').disabled);
  const values = () => page.evaluate(() => ({model: document.getElementById('research-model').value,
    effort: document.getElementById('research-effort').value}));
  await page.goto(url);
  await page.waitForFunction(() => !!Zotero_Preferences.visiblePaneName);
  assert.equal(await worker.evaluate(() => settingsTest.reads), 0, 'General preferences must not start model discovery');
  await page.click('#pane-research');
  await ready();
  assert.deepEqual(await values(), {model: 'gpt-6-astra', effort: 'xhigh'});
  assert.equal(await page.$eval('#research-save', el => el.disabled), true);
  assert.equal(await worker.evaluate(() => settingsTest.writes), 0);
  await page.screenshot({path: root + '/dist/research-ui-test/settings.png'});
  await page.select('#research-model', 'other-model');
  assert.equal((await values()).effort, '', 'An unsupported previous effort requires an explicit choice');
  assert.equal(await page.$eval('#research-save', el => el.disabled), true);
  assert.deepEqual(await page.$$eval('#research-effort option', els => els.map(el => el.value)), ['', 'low', 'medium']);
  await page.select('#research-effort', 'medium');
  assert.equal(await worker.evaluate(() => settingsTest.writes), 0, 'Dropdown changes are not saved until Save');
  await page.click('#research-save');
  await page.waitForFunction(() => document.getElementById('research-status').textContent.startsWith('Saved.'));
  assert.equal(await worker.evaluate(() => settingsTest.writes), 1);
  await page.goto(url + '#research');
  await ready();
  assert.deepEqual(await values(), {model: 'other-model', effort: 'medium'});
  await page.select('#research-effort', 'low');
  await worker.evaluate(() => { settingsTest.fail = true; });
  await page.click('#research-save');
  await page.waitForSelector('#research-status.error');
  assert.equal(await page.$eval('#research-save', el => el.disabled), false, 'A failed save remains retryable');
  assert.deepEqual(await worker.evaluate(() => settingsTest.current), {model: 'other-model', effort: 'medium'});
  await page.reload();
  await page.waitForSelector('#research-status.error');
  assert.equal(await page.$eval('#research-model', el => el.disabled), true);
  await worker.evaluate(() => { settingsTest.fail = false; settingsTest.current = {model: 'custom-model', effort: 'custom-effort'}; });
  await page.click('#research-retry');
  await ready();
  assert.deepEqual(await values(), {model: 'custom-model', effort: 'custom-effort'});
  assert.equal(await worker.evaluate(() => settingsTest.writes), 1, 'Loading and retrying must never overwrite preferences');
  console.log('Research settings UI: defaults, supported choices, explicit save, reload, custom values, and failures passed');
} finally { await browser.close(); }
