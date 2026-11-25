import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createAppUpdater } from '../js/settings/updater.js';

const CURRENT = '20261125-101928';
const LATEST = '20261125-120000';
const BASE = 'https://planner.example/app/';
const encode = text => new TextEncoder().encode(text);
const digest = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');

async function fixture({ build = LATEST, indexBuild = build, worker = null, timeoutMs = 100, guard } = {}) {
  const files = new Map([
    ['index.html', `<html><head><meta name="app-build" content="${indexBuild}"></head></html>`],
    ['sw.js', `const BUILD_VERSION = "${build}";`],
    ['js/app.js', 'console.log("synthetic app");'],
    ['css/style.css', 'body { color: #123; }'],
  ]);
  const descriptor = { build, assets: await Promise.all([...files].map(async ([path, body]) => ({ path, sha256: await digest(encode(body)) }))) };
  const calls = [], progress = [], reloads = [], phases = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, new URL(BASE).origin);
    calls.push({ url: parsed, options });
    if (parsed.pathname === '/app/version.json') return new Response(JSON.stringify(descriptor));
    const path = parsed.pathname.slice('/app/'.length);
    return files.has(path) ? new Response(files.get(path)) : new Response('', { status: 404 });
  };
  const updater = createAppUpdater({
    currentBuild: CURRENT, baseUrl: BASE, cryptoImpl: webcrypto, fetchImpl,
    serviceWorker: worker, timeoutMs,
    beforeApply: async context => { phases.push(context.phase); return guard?.(context); },
    onProgress: item => progress.push(item),
    reload: () => reloads.push('same-window'),
  });
  return { updater, descriptor, files, calls, progress, reloads, phases };
}

function activeWorker(build) {
  return { state: 'activated', postMessage(message, ports) {
    assert.deepEqual(message, { type: 'GET_BUILD_VERSION' });
    ports[0].postMessage({ build });
  } };
}

test('current build checks only fresh metadata and never reloads or changes data', async () => {
  const f = await fixture({ build: CURRENT });
  assert.equal((await f.updater.apply()).status, 'current');
  await f.updater.check();
  assert.equal(f.reloads.length, 0);
  assert.equal(f.phases.length, 0);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].url.search, f.calls[1].url.search);
  for (const call of f.calls) assert.equal(call.options.cache, 'no-store');
});

test('old remote build cannot downgrade the running app', async () => {
  const f = await fixture({ build: '20261124-120000' });
  await assert.rejects(f.updater.apply(), error => error.code === 'OLDER_BUILD');
  assert.equal(f.reloads.length, 0);
});

test('unsafe paths and malformed or incomplete release descriptors are rejected', async t => {
  for (const path of ['https://evil.example/app.js', '//evil.example/app.js', '../app.js', './app.js', 'js/../app.js', 'js/%2e%2e/app.js', 'js\\app.js', 'js/app.js?x=1', 'js/app.js#x']) {
    await t.test(path, async () => {
      const f = await fixture();
      f.descriptor.assets.push({ path, sha256: 'a'.repeat(64) });
      await assert.rejects(f.updater.apply(), error => error.code === 'INVALID_RELEASE');
      assert.equal(f.calls.length, 1);
      assert.equal(f.reloads.length, 0);
    });
  }
  for (const mutate of [
    d => { d.build = '20260230-120000'; },
    d => { d.assets[0].sha256 = 'invalid'; },
    d => { d.assets.pop(); d.assets.pop(); },
    d => { d.assets.push({ ...d.assets[0] }); },
    d => { d.assets = Array.from({ length: 129 }, (_, i) => ({ path: `js/${i}.js`, sha256: 'a'.repeat(64) })); },
  ]) {
    const f = await fixture(); mutate(f.descriptor);
    await assert.rejects(f.updater.apply(), error => error.code === 'INVALID_RELEASE');
    assert.equal(f.reloads.length, 0);
  }
});

test('offline or failed metadata fetch never applies a release', async () => {
  let reloads = 0;
  const updater = createAppUpdater({ currentBuild: CURRENT, baseUrl: BASE, serviceWorker: null,
    fetchImpl: async () => { throw new TypeError('synthetic offline'); }, reload: () => reloads++ });
  await assert.rejects(updater.apply());
  assert.equal(reloads, 0);
});

test('mismatched assets or an old index prevent reload', async () => {
  const f = await fixture();
  f.files.set('js/app.js', 'old cached code');
  await assert.rejects(f.updater.apply(), error => error.code === 'ASSET_MISMATCH');
  assert.equal(f.reloads.length, 0);
  const oldIndex = await fixture({ indexBuild: CURRENT });
  await assert.rejects(oldIndex.updater.apply(), error => error.code === 'INDEX_BUILD_MISMATCH');
  assert.equal(oldIndex.reloads.length, 0);
});

test('first safety check stops before downloading assets', async () => {
  const f = await fixture({ guard: () => { throw new Error('synthetic unsaved data'); } });
  await assert.rejects(f.updater.apply(), /unsaved data/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reloads.length, 0);
});

test('second and final safety checks stop late writes from being lost', async () => {
  for (const phase of ['after-download', 'before-reload']) {
    const f = await fixture({ guard: context => { if (context.phase === phase) return false; } });
    await assert.rejects(f.updater.apply(), error => error.code === 'UPDATE_BUSY');
    assert.equal(f.reloads.length, 0);
    assert.equal(f.phases.at(-1), phase);
  }
});

test('without service workers the verified update reloads once in the same window', async () => {
  const f = await fixture();
  const result = await f.updater.apply();
  assert.equal(result.status, 'reloading');
  assert.equal(result.serviceWorkerVerified, false);
  assert.deepEqual(f.reloads, ['same-window']);
  assert.deepEqual(f.phases, ['before-download', 'after-download', 'before-reload']);
  assert.equal(f.calls.length, 5);
  assert.equal(f.progress.at(-1).stage, 'reloading');
});

test('an old or unresponsive active service worker times out without reloading', async () => {
  for (const worker of [activeWorker(CURRENT), { state: 'activated', postMessage() {} }]) {
    let updates = 0;
    const f = await fixture({ timeoutMs: 60, worker: { getRegistration: async () => ({ active: worker, update: async () => { updates++; } }) } });
    await assert.rejects(f.updater.apply(), error => error.code === 'WORKER_TIMEOUT');
    assert.equal(updates, 1);
    assert.equal(f.reloads.length, 0);
  }
});

test('service worker activation is verified by build before one reload', async () => {
  const registration = { active: activeWorker(CURRENT), async update() { this.active = activeWorker(LATEST); } };
  const f = await fixture({ worker: { getRegistration: async () => registration } });
  const result = await f.updater.apply();
  assert.equal(result.serviceWorkerVerified, true);
  assert.equal(f.reloads.length, 1);
});

test('a failed or missing registration never pretends to apply an update', async () => {
  for (const serviceWorker of [
    { getRegistration: async () => undefined },
    { getRegistration: async () => ({ active: activeWorker(LATEST), update: async () => { throw new Error('synthetic SW fetch failed'); } }) },
  ]) {
    const f = await fixture({ worker: serviceWorker });
    await assert.rejects(f.updater.apply());
    assert.equal(f.reloads.length, 0);
  }
});

test('concurrent apply clicks share one verification and one reload', async () => {
  const f = await fixture();
  await Promise.all([f.updater.apply(), f.updater.apply()]);
  assert.equal(f.reloads.length, 1);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('version.json')).length, 1);
});

test('stalled fetch or worker APIs have a finite timeout and cannot reload later', async () => {
  let reloads = 0, aborted = false;
  const stalled = createAppUpdater({ currentBuild: CURRENT, baseUrl: BASE, serviceWorker: null, timeoutMs: 20,
    fetchImpl: async (_url, options) => { options.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
    reload: () => reloads++,
  });
  await assert.rejects(stalled.apply(), error => error.code === 'FETCH_FAILED');
  assert.equal(aborted, true);
  assert.equal(reloads, 0);
  for (const worker of [
    { getRegistration: () => new Promise(() => {}) },
    { getRegistration: async () => ({ active: activeWorker(LATEST), update: () => new Promise(() => {}) }) },
  ]) {
    const f = await fixture({ worker, timeoutMs: 20 });
    await assert.rejects(f.updater.apply(), error => error.code === 'WORKER_TIMEOUT');
    assert.equal(f.reloads.length, 0);
  }
});
