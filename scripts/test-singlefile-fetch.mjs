import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const scope = {URL, document: {baseURI: 'https://example.org/article', location: new URL('https://example.org/article')},
  Zotero: {Utilities: {Connector: {throttleAsync: fn => fn}}, COHTTP: {request: () => {}}}};
vm.createContext(scope);
vm.runInContext(await readFile(new URL('../src/common/singlefile.js', import.meta.url), 'utf8'), scope);
const singleFile = scope.Zotero.SingleFile;
const calls = [], options = {headers: {accept: '*/*'}, referrer: 'https://example.org/style.css'};
let failPage = false, failBackground = false;
singleFile.hostFetch = async (url, options) => {
  calls.push({route: 'page', url, options});
  if (failPage) throw new Error('Page fetch failed');
  return {status: 200, arrayBuffer: async () => 'page bytes'};
};
singleFile._throttledRequest = async (method, url, options) => {
  calls.push({route: 'background', method, url, options});
  if (failBackground) throw new Error('Extension fetch failed');
  return {status: 200, response: 'extension bytes', getResponseHeader: () => 'font/woff2'};
};
for (const url of ['https://fonts.example.net/font.woff2', 'http://images.example.net/image.png']) {
  calls.length = 0;
  const response = await singleFile.singleFileFetch(url, options);
  assert.deepEqual(calls.map(c => c.route), ['background']);
  assert.equal(await response.arrayBuffer(), 'extension bytes');
  assert.equal(response.headers.get('Content-Type'), 'font/woff2');
  assert.equal(calls[0].options.referrer, scope.document.location.href);
  assert.equal(calls[0].options.referrerPolicy, undefined);
}
for (const url of ['/session-image.png', 'data:image/png;base64,AA==', 'blob:https://example.org/image']) {
  calls.length = 0;
  await singleFile.singleFileFetch(url, options);
  assert.deepEqual(calls.map(c => c.route), ['page'], 'Keep page-context access to same-origin and in-memory resources');
  assert.equal(calls[0].options.referrerPolicy, 'strict-origin-when-cross-origin');
}
failBackground = true; calls.length = 0;
await singleFile.singleFileFetch('https://assets.example.net/private-image.png', options);
assert.deepEqual(calls.map(c => c.route), ['background', 'page'], 'Preserve page-context fallback when extension retrieval fails');
failBackground = false; failPage = true; calls.length = 0;
await singleFile.singleFileFetch('/image.png', options);
assert.deepEqual(calls.map(c => c.route), ['page', 'background'], 'Keep the existing background fallback');
failBackground = true;
await assert.rejects(singleFile.singleFileFetch('https://assets.example.net/missing', options), /Page fetch failed/);
assert.deepEqual(options, {headers: {accept: '*/*'}, referrer: 'https://example.org/style.css'}, 'Do not mutate shared request options across fallbacks');
console.log('PASS: snapshot fetch routing, same-origin and in-memory resources, both fallback paths, response bytes, and genuine errors');
