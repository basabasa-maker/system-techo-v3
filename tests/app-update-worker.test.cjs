const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
const build = source.match(/const BUILD_VERSION = "([^"]+)"/)[1];
const scope = 'https://planner.example/system-techo-v3/';
const currentCache = `system-techo-v3-${build}`;
const encode = text => new TextEncoder().encode(text);
const hash = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
const keyOf = request => typeof request === 'string' ? new URL(request, scope).href : request.url;

async function release() {
  const files = new Map([
    ['index.html', `<html><head><meta name="app-build" content="${build}"></head><body>new app</body></html>`],
    ['sw.js', source], ['manifest.json', '{"name":"synthetic app"}'],
    ['js/app.js', 'import "./child.js";'], ['js/child.js', 'export const result = 42;'],
    ['css/style.css', 'body { color: #123; }'], ['privacy.html', '<p>Privacy</p>'],
    ['support.html', '<p>Support</p>'], ['icons/icon.png', new Uint8Array([137, 80, 78, 71])],
    ['shortcuts/health-bridge/system-techo-health.zip', new Uint8Array([80, 75, 3, 4])],
  ]);
  const descriptor = { build, assets: await Promise.all([...files].map(async ([name, body]) => ({ path: name, sha256: await hash(typeof body === 'string' ? encode(body) : body) }))) };
  return { files, descriptor };
}

function worker({ files = new Map(), descriptor, offline = false, offlinePath, quotaFailure = false, existingNew = false, slowFetch = false } = {}) {
  const handlers = {};
  const data = new Map([
    ['system-techo-v3-old', new Map([[scope, new Response('old app')]])],
    ['sth-att', new Map([[scope + 'attachment', new Response('attachment bytes')]])],
    ['user-records', new Map([[scope + 'record', new Response('private record')]])],
  ]);
  if (existingNew) data.set(currentCache, new Map([[scope, new Response('existing same-build cache')]]));
  const state = { matched: 0, deleted: [], replies: [], opened: [], fetches: [], skipWaiting: 0, claimed: 0, puts: 0 };
  const caches = {
    async keys() { return [...data.keys()]; },
    async delete(name) { state.deleted.push(name); return data.delete(name); },
    async open(name) {
      state.opened.push(name);
      if (!data.has(name)) data.set(name, new Map());
      const values = data.get(name);
      return {
        async match(request) { state.matched++; return values.get(keyOf(request))?.clone(); },
        async put(request, response) {
          if (quotaFailure && name === currentCache && ++state.puts === 3) throw new Error('synthetic cache quota exceeded');
          values.set(keyOf(request), response.clone());
        },
      };
    },
    async match(request) {
      state.matched++;
      for (const values of data.values()) if (values.has(keyOf(request))) return values.get(keyOf(request)).clone();
    },
  };
  const fetch = async (request, options) => {
    const url = new URL(keyOf(request));
    state.fetches.push({ url, options });
    assert.equal(url.origin, new URL(scope).origin, 'worker never downloads third-party URLs');
    const relative = url.pathname.slice(new URL(scope).pathname.length);
    if (offline || relative === offlinePath) throw new Error('synthetic offline');
    if (slowFetch) return new Promise(() => {});
    if (relative === 'version.json') return new Response(JSON.stringify(descriptor));
    return files.has(relative) ? new Response(files.get(relative)) : new Response('', { status: 404 });
  };
  const self = {
    location: { origin: new URL(scope).origin }, registration: { scope },
    addEventListener(name, handler) { handlers[name] = handler; },
    skipWaiting() { state.skipWaiting++; state.entriesAtSkipWaiting = data.get(currentCache)?.size || 0; },
    clients: { claim() { state.claimed++; } },
  };
  vm.runInNewContext(source, { self, URL, Request, Response, TextDecoder, TextEncoder, AbortController,
    crypto: webcrypto, fetch, caches, setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 40)), clearTimeout, Date });
  return { handlers, state, data };
}

function install(w) {
  let pending;
  w.handlers.install({ waitUntil: promise => { pending = promise; } });
  return pending;
}
function activate(w) {
  let pending;
  w.handlers.activate({ waitUntil: promise => { pending = promise; } });
  return pending;
}
function fetchEvent(w, relative, { method = 'GET', mode = 'cors', accept = '' } = {}) {
  let pending;
  w.handlers.fetch({ request: { method, url: new URL(relative, scope).href, mode, headers: { get: name => name === 'accept' ? accept : null } },
    respondWith: promise => { pending = promise; } });
  return pending;
}


test('version metadata never falls back to cached bytes while offline', async () => {
  const w = worker({ offline: true });
  await assert.rejects(fetchEvent(w, 'version.json?check=unique'), /offline/);
  assert.equal(w.state.matched, 0);
  assert.equal(w.state.opened.length, 0);
});

test('worker answers only the build query through the supplied port', () => {
  const w = worker();
  assert.equal(typeof w.handlers.message, 'function');
  w.handlers.message({ data: { type: 'GET_BUILD_VERSION' }, ports: [{ postMessage: value => w.state.replies.push(value) }] });
  assert.equal(w.state.replies[0].build, build);
  w.handlers.message({ data: { type: 'DELETE_RECORDS' }, ports: [{ postMessage: value => w.state.replies.push(value) }] });
  assert.equal(w.state.replies.length, 1);
});

test('activation preserves attachment and unrelated caches', async () => {
  const w = worker();
  await activate(w);
  assert.deepEqual(w.state.deleted, ['system-techo-v3-old']);
  assert.equal(w.state.claimed, 1);
  assert.equal(await w.data.get('sth-att').get(scope + 'attachment').text(), 'attachment bytes');
  assert.equal(await w.data.get('user-records').get(scope + 'record').text(), 'private record');
});

test('install verifies every asset and precaches canonical, root, and versioned aliases before activation', async () => {
  const fixture = await release(), w = worker(fixture);
  await install(w);
  assert.equal(w.state.skipWaiting, 1);
  assert(w.state.entriesAtSkipWaiting > fixture.files.size);
  assert.equal(await w.data.get('system-techo-v3-old').get(scope).text(), 'old app', 'install never rewrites old cache');
  const cache = w.data.get(currentCache);
  for (const [name, bytes] of fixture.files) {
    assert.deepEqual(new Uint8Array(await cache.get(scope + name).clone().arrayBuffer()), typeof bytes === 'string' ? encode(bytes) : bytes);
  }
  assert.equal(await cache.get(scope).clone().text(), fixture.files.get('index.html'));
  assert.equal(await cache.get(scope + 'js/app.js?v=' + build).clone().text(), fixture.files.get('js/app.js'));
  assert.equal(await cache.get(scope + 'css/style.css?v=' + build).clone().text(), fixture.files.get('css/style.css'));
  await activate(w);
  const fetchedBefore = w.state.fetches.length;
  assert.equal(await (await fetchEvent(w, 'js/child.js')).text(), fixture.files.get('js/child.js'));
  assert.equal(await (await fetchEvent(w, 'css/style.css?v=' + build)).text(), fixture.files.get('css/style.css'));
  assert.equal(await (await fetchEvent(w, './', { mode: 'navigate' })).text(), fixture.files.get('index.html'));
  assert.equal(w.state.fetches.length, fetchedBefore, 'verified current runtime assets are served from their complete release cache');
});

test('failed download, hash mismatch, and old index prevent activation without touching the old app', async () => {
  const cases = [
    fixture => ({ ...fixture, offlinePath: 'js/child.js' }),
    fixture => { fixture.files.set('js/child.js', 'wrong cached code'); return fixture; },
    fixture => { fixture.descriptor.build = '20261124-120000'; return fixture; },
    async fixture => {
      fixture.files.set('index.html', '<meta name="app-build" content="20261124-120000">');
      fixture.descriptor.assets.find(asset => asset.path === 'index.html').sha256 = await hash(encode(fixture.files.get('index.html')));
      return fixture;
    },
  ];
  for (const make of cases) {
    const w = worker(await make(await release()));
    await assert.rejects(install(w));
    assert.equal(w.state.skipWaiting, 0);
    assert.equal(await w.data.get('system-techo-v3-old').get(scope).text(), 'old app');
    assert(!w.state.deleted.includes('system-techo-v3-old'));
    assert(w.data.has('sth-att') && w.data.has('user-records'));
    assert(!w.data.has(currentCache), 'a failed release is not left as an apparently usable cache');
  }
});

test('unsafe metadata cannot send worker fetches outside its app scope', async () => {
  for (const name of ['https://evil.example/code.js', '../code.js', 'js/%2e%2e/code.js', 'js/app.js?x=1', 'version.json']) {
    const fixture = await release();
    fixture.descriptor.assets.push({ path: name, sha256: 'a'.repeat(64) });
    const w = worker(fixture);
    await assert.rejects(install(w));
    assert.equal(w.state.skipWaiting, 0);
    assert.equal(w.state.fetches.length, 1, 'reject descriptor before downloading any assets');
  }
});

test('a cache write failure removes only the incomplete new static cache', async () => {
  const w = worker({ ...await release(), quotaFailure: true });
  await assert.rejects(install(w), /quota/);
  assert.equal(w.state.skipWaiting, 0);
  assert.deepEqual(w.state.deleted, [currentCache]);
  assert(w.data.has('system-techo-v3-old') && w.data.has('sth-att') && w.data.has('user-records'));
});

test('an existing cache for this build is not overwritten or deleted by a failed install', async () => {
  const w = worker({ ...await release(), existingNew: true });
  await assert.rejects(install(w));
  assert.equal(await w.data.get(currentCache).get(scope).text(), 'existing same-build cache');
  assert.equal(w.state.skipWaiting, 0);
  assert(!w.state.deleted.includes(currentCache));
});

test('updater verification requests are fresh network-only and never cache stale fallback bytes', async () => {
  const w = worker({ offline: true });
  await assert.rejects(fetchEvent(w, 'js/app.js?_app_update=unique'), /offline/);
  assert.equal(w.state.matched, 0);
  assert.equal(w.state.opened.length, 0);
});

test('foreign requests and record POSTs are never intercepted', () => {
  const w = worker();
  assert.equal(fetchEvent(w, 'https://script.google.com/example'), undefined);
  assert.equal(fetchEvent(w, 'api', { method: 'POST' }), undefined);
  assert.equal(w.state.opened.length, 0);
});

test('a stalled release request times out without activating or touching stored records', async () => {
  const fixture = await release(), w = worker({ ...fixture, slowFetch: true });
  await assert.rejects(install(w));
  assert.equal(w.state.skipWaiting, 0);
  assert.equal(w.state.deleted.length, 0);
  assert.equal(w.data.size, 3);
});
