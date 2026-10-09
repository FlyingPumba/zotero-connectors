import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const read = path => readFile(new URL('../src/' + path, import.meta.url), 'utf8');

async function offscreen() {
  const listeners = new Map();
  const scope = {Zotero: {Translate: {Web: class {}, ItemSaver: class {}}, debug() {},
    OffscreenSandbox: {addMessageListener: (name, handler) => listeners.set(name, handler)}}};
  vm.createContext(scope);
  vm.runInContext(await read('browserExt/offscreen/offscreenTranslate.js'), scope);
  scope.Zotero.OffscreenTranslate.init();
  return {translate: scope.Zotero.OffscreenTranslate, listeners};
}

test('cleanup preserves live tab/frame translators and reports only removed instances', async () => {
  const {translate, listeners} = await offscreen();
  const live = translate._getTranslateInstance(1042115632, 0, true);
  const frame = translate._getTranslateInstance(1042115632, 7, true);
  translate._getTranslateInstance(1042115725, 0, true);
  const removed = listeners.get('translateCleanup')(1042115632);
  assert.equal(translate._getTranslateInstance(1042115632, 0, false), live);
  assert.equal(translate._getTranslateInstance(1042115632, 7, false), frame);
  assert.deepEqual(Array.from(removed), ['1042115725']);
  assert.equal(translate.translateInstances[1042115725], undefined);
  assert.deepEqual(Array.from(listeners.get('translateCleanup')(1042115632)), []);
  listeners.get('tabClosed')(1042115632);
  assert.equal(translate.translateInstances[1042115632], undefined);
});

test('background cleanup retains loading tabs and popup windows and logs removed instances', async () => {
  const errors = [], queries = [], messages = [];
  const tabs = [{id: 1, status: 'complete', windowType: 'normal'}, {id: 2, status: 'loading', windowType: 'normal'},
    {id: 3, status: 'complete', windowType: 'popup'}];
  const scope = {self: {}, browser: {tabs: {query: async query => {
    queries.push(query); return tabs.filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value));
  }}}, Zotero: {Promise: {defer: () => ({})}, logError: error => errors.push(error.message)}};
  vm.createContext(scope);
  vm.runInContext(await read('browserExt/background/offscreenManager.js'), scope);
  const manager = scope.Zotero.OffscreenManager;
  manager.getOffscreenPage = async () => ({});
  manager.sendMessage = async (name, ids) => { messages.push({name, ids: Array.from(ids)}); return ['4']; };
  await manager.cleanup();
  assert.deepEqual(messages, [{name: 'translateCleanup', ids: [1, 2, 3]}]);
  assert.match(errors[0], /\["4"\]/);
  assert.equal(queries.length, 1);
});

test('late messages to a closed tab are harmless while live replies and receiver errors are preserved', async () => {
  const sent = [];
  let reply = 'reply';
  const scope = {Zotero: {}, browser: {tabs: {
    query: async () => [{id: 1}],
    get: async id => { if (id === 2) throw new Error('No tab with id: 2.'); return {id}; },
    sendMessage: async (id, data, options) => {
      if (id === 2) throw new Error('Could not establish connection. Receiving end does not exist.');
      sent.push({id, data, options}); return reply;
    }
  }}};
  vm.createContext(scope);
  vm.runInContext(await read('common/messaging.js'), scope);
  for (const name of ['sendMessage', 'sendToZoteroFrames']) for (const isSafari of [false, true]) {
    scope.Zotero.isSafari = isSafari;
    const send = scope.Zotero.Messaging[name].bind(scope.Zotero.Messaging);
    assert.equal(await send('Translate.onHandler.done', [], 2, 0), undefined);
    assert.equal(await send('Translate.onHandler.done', [], 1, 0), 'reply');
    assert.equal(sent.at(-1).id, 1);
    reply = ['error', JSON.stringify({message: 'Receiver failed'})];
    await assert.rejects(send('test', [], 1), /Receiver failed/);
    reply = 'reply';
  }
});
