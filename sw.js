// A release becomes active only after every published asset is verified and saved.
// Record storage and the separate attachment cache are never changed here.
const BUILD_VERSION = "20261127-235638";
const CACHE_NAME = `system-techo-v3-${BUILD_VERSION}`;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ASSETS = 128;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const APP_BASE = new URL(self.registration.scope);
const VERSION_URL = new URL('version.json', APP_BASE);

function releaseDescriptor(value) {
  if (!value || value.build !== BUILD_VERSION || !Array.isArray(value.assets)
      || value.assets.length < 4 || value.assets.length > MAX_ASSETS) throw new Error('Invalid app release');
  const seen = new Set();
  const assets = value.assets.map(item => {
    if (!item || typeof item.path !== 'string' || item.path.length > 240
        || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(item.path)
        || item.path.split('/').some(segment => segment === '.' || segment === '..')
        || item.path === 'version.json' || seen.has(item.path)
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
      throw new Error('Invalid release asset');
    }
    seen.add(item.path);
    return { path: item.path, sha256: item.sha256.toLowerCase() };
  });
  if (['index.html', 'sw.js', 'manifest.json', 'js/app.js'].some(name => !seen.has(name))) {
    throw new Error('Incomplete app release');
  }
  return assets;
}

function indexBuild(html) {
  const builds = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = {};
    for (const match of tag.matchAll(/\s(name|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    if (attributes.name === 'app-build') builds.push(attributes.content);
  }
  return builds.length === 1 ? builds[0] : null;
}

async function sha256(bytes) {
  if (!crypto?.subtle?.digest) throw new Error('Release verification unavailable');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function freshResource(url, read) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Release download timed out')); }, REQUEST_TIMEOUT_MS);
  });
  const download = Promise.resolve().then(async () => {
    const response = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!response?.ok || response.url && new URL(response.url).origin !== APP_BASE.origin) throw new Error('Release download failed');
    if (Number(response.headers?.get('content-length')) > MAX_ASSET_BYTES) throw new Error('Release file too large');
    return read(response);
  });
  try { return await Promise.race([download, timeout]); }
  finally { clearTimeout(timer); }
}

async function readRelease() {
  const url = new URL(VERSION_URL);
  url.searchParams.set('_app_install', `${BUILD_VERSION}-${Date.now()}`);
  return freshResource(url, async response => {
    const text = await response.text();
    if (text.length > 262144) throw new Error('Release metadata too large');
    return releaseDescriptor(JSON.parse(text));
  });
}

async function verifyAsset(asset) {
  const url = new URL(asset.path, APP_BASE);
  url.searchParams.set('_app_install', `${BUILD_VERSION}-${Date.now()}`);
  return freshResource(url, async response => {
    const bytes = await response.clone().arrayBuffer();
    if (bytes.byteLength > MAX_ASSET_BYTES || await sha256(bytes) !== asset.sha256) {
      throw new Error('Release asset does not match its published hash');
    }
    if (asset.path === 'index.html' && indexBuild(new TextDecoder().decode(bytes)) !== BUILD_VERSION) {
      throw new Error('Index and worker builds do not match');
    }
    return { asset, response };
  });
}

function aliasesFor(asset) {
  const canonical = new URL(asset.path, APP_BASE);
  const aliases = [canonical.href];
  if (/\.(js|css)$/.test(asset.path)) {
    const versioned = new URL(canonical);
    versioned.searchParams.set('v', BUILD_VERSION);
    aliases.push(versioned.href);
  }
  if (asset.path === 'index.html') aliases.push(APP_BASE.href);
  return aliases;
}

async function verifyReleaseAssets(assets) {
  const verified = new Array(assets.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async () => {
    while (next < assets.length) {
      const index = next++;
      verified[index] = await verifyAsset(assets[index]);
    }
  }));
  return verified;
}

async function saveVerifiedRelease(verified) {
  const existed = (await caches.keys()).includes(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  // A same-build active cache may already exist. Never overwrite or delete it
  // while installing another worker; only reuse it if it is already complete.
  if (existed) {
    for (const { asset } of verified) {
      for (const alias of aliasesFor(asset)) {
        const saved = await cache.match(alias);
        if (!saved || await sha256(await saved.arrayBuffer()) !== asset.sha256) {
          throw new Error('An existing app cache is not the verified release');
        }
      }
    }
    return;
  }
  try {
    for (const { asset, response } of verified) {
      for (const alias of aliasesFor(asset)) await cache.put(alias, response.clone());
    }
  } catch (error) {
    // Only the new, incomplete static cache belongs to this failed install.
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function installRelease() {
  const assets = await readRelease();
  const verified = await verifyReleaseAssets(assets);
  await saveVerifiedRelease(verified);
  await self.skipWaiting();
}

self.addEventListener('install', event => {
  event.waitUntil(installRelease());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('system-techo-v3-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'GET_BUILD_VERSION') event.ports?.[0]?.postMessage({ build: BUILD_VERSION });
});

function canonicalRequest(url) {
  const canonical = new URL(url);
  canonical.search = '';
  canonical.hash = '';
  return canonical.href;
}

async function runtimeResponse(request, url) {
  const cache = await caches.open(CACHE_NAME);
  // Keep one complete release together. A partially deployed future release
  // must not replace individual files in the currently active release cache.
  const saved = await cache.match(request) || await cache.match(canonicalRequest(url));
  if (saved) return saved;
  const isHTML = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (!response?.ok && isHTML) {
      const home = await cache.match(APP_BASE.href);
      if (home) return home;
    }
    return response;
  } catch (error) {
    if (isHTML) {
      const home = await cache.match(APP_BASE.href);
      if (home) return home;
    }
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Google APIs and any other origin remain completely outside this cache.
  if (url.origin !== APP_BASE.origin || !url.pathname.startsWith(APP_BASE.pathname)) return;
  if (url.pathname === VERSION_URL.pathname || url.searchParams.has('_app_update') || url.searchParams.has('_app_install')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  event.respondWith(runtimeResponse(request, url));
});
