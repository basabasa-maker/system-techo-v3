// PWA code updates only. This module never clears caches or stored records.
const BUILD_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const MAX_ASSETS = 128;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const REQUIRED_ASSETS = ['index.html', 'sw.js', 'js/app.js'];

export class AppUpdateError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AppUpdateError';
    this.code = code;
  }
}

function validBuild(build) {
  if (typeof build !== 'string') return false;
  const match = BUILD_PATTERN.exec(build);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return year >= 2000 && value.getUTCFullYear() === year
    && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
    && value.getUTCHours() === hour && value.getUTCMinutes() === minute
    && value.getUTCSeconds() === second;
}

function invalidRelease() {
  return new AppUpdateError('INVALID_RELEASE', '最新版の配信情報が正しくありません。更新せずに停止しました。');
}

function releaseDescriptor(value) {
  if (!value || typeof value !== 'object' || !validBuild(value.build)
      || !Array.isArray(value.assets) || value.assets.length < REQUIRED_ASSETS.length
      || value.assets.length > MAX_ASSETS) throw invalidRelease();
  const seen = new Set();
  const assets = value.assets.map(item => {
    if (!item || typeof item.path !== 'string' || item.path.length > 240
        || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(item.path)
        || item.path.split('/').some(segment => segment === '.' || segment === '..')
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)
        || seen.has(item.path)) throw invalidRelease();
    seen.add(item.path);
    return Object.freeze({ path: item.path, sha256: item.sha256.toLowerCase() });
  });
  if (REQUIRED_ASSETS.some(path => !seen.has(path))) throw invalidRelease();
  return { build: value.build, assets: Object.freeze(assets) };
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

function bounded(promise, milliseconds, error, abort) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { abort?.(); reject(error); }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function workerBuild(worker, milliseconds) {
  return new Promise(resolve => {
    if (!worker?.postMessage || typeof MessageChannel === 'undefined') return resolve(null);
    const channel = new MessageChannel();
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), milliseconds);
    channel.port1.onmessage = event => finish(validBuild(event.data?.build) ? event.data.build : null);
    channel.port1.onmessageerror = () => finish(null);
    try { worker.postMessage({ type: 'GET_BUILD_VERSION' }, [channel.port2]); }
    catch (_) { finish(null); }
  });
}

export function createAppUpdater(options = {}) {
  const currentBuild = options.currentBuild;
  if (!validBuild(currentBuild)) {
    throw new AppUpdateError('INVALID_CURRENT_BUILD', '現在のアプリの版を確認できません。更新せずに停止しました。');
  }
  const base = new URL('.', options.baseUrl || globalThis.document?.baseURI || globalThis.location?.href);
  if (!['https:', 'http:'].includes(base.protocol)) throw invalidRelease();
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const cryptoImpl = options.cryptoImpl || globalThis.crypto;
  const serviceWorker = Object.hasOwn(options, 'serviceWorker') ? options.serviceWorker : globalThis.navigator?.serviceWorker;
  const beforeApply = options.beforeApply || (() => {});
  const onProgress = options.onProgress || (() => {});
  const reload = options.reload || (() => globalThis.location.reload());
  const now = options.now || Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20000;
  let sequence = 0;
  let applying = null;

  async function responseAt(path) {
    const url = new URL(path, base);
    url.searchParams.set('_app_update', `${now()}-${++sequence}`);
    const controller = new AbortController();
    const failure = new AppUpdateError('FETCH_FAILED', '更新ファイルを取得できませんでした。通信を確認して再試行してください。');
    try {
      const response = await bounded(Promise.resolve().then(() => fetchImpl(url.toString(), {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      })), timeoutMs, failure, () => controller.abort());
      if (!response?.ok || response.url && new URL(response.url).origin !== base.origin) throw failure;
      return { response, controller, failure };
    } catch (error) {
      if (error instanceof AppUpdateError) throw error;
      throw new AppUpdateError('FETCH_FAILED', failure.message, error);
    }
  }

  async function check() {
    onProgress({ stage: 'checking' });
    const { response, controller, failure } = await responseAt('version.json');
    let descriptor;
    try {
      const text = await bounded(response.text(), timeoutMs, failure, () => controller.abort());
      if (text.length > 262144) throw invalidRelease();
      descriptor = releaseDescriptor(JSON.parse(text));
    } catch (error) {
      if (error instanceof AppUpdateError) throw error;
      throw invalidRelease();
    }
    if (descriptor.build < currentBuild) {
      throw new AppUpdateError('OLDER_BUILD', '配信先の版が現在のアプリより古いため、更新せずに停止しました。');
    }
    return Object.freeze({ status: descriptor.build === currentBuild ? 'current' : 'available', currentBuild, ...descriptor });
  }

  async function guard(phase, build) {
    if (await beforeApply({ phase, build }) === false) {
      throw new AppUpdateError('UPDATE_BUSY', '入力や保存が完了してから、もう一度更新してください。');
    }
  }

  async function verifyAssets(release) {
    if (!cryptoImpl?.subtle?.digest) {
      throw new AppUpdateError('HASH_UNAVAILABLE', '更新ファイルを確認できない環境のため、更新を停止しました。');
    }
    let completed = 0;
    onProgress({ stage: 'verifying', build: release.build, completed, total: release.assets.length });
    for (const asset of release.assets) {
      const { response, controller, failure } = await responseAt(asset.path);
      if (Number(response.headers?.get('content-length')) > MAX_ASSET_BYTES) throw invalidRelease();
      const bytes = await bounded(response.arrayBuffer(), timeoutMs, failure, () => controller.abort());
      if (bytes.byteLength > MAX_ASSET_BYTES) throw invalidRelease();
      const hash = Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.sha256) {
        throw new AppUpdateError('ASSET_MISMATCH', '更新ファイルがまだ揃っていません。少し待ってから再試行してください。');
      }
      if (asset.path === 'index.html' && indexBuild(new TextDecoder().decode(bytes)) !== release.build) {
        throw new AppUpdateError('INDEX_BUILD_MISMATCH', '画面と配信情報の版が一致しないため、更新を停止しました。');
      }
      onProgress({ stage: 'verifying', build: release.build, completed: ++completed, total: release.assets.length });
    }
  }

  async function verifyWorker(build) {
    if (!serviceWorker) return false;
    onProgress({ stage: 'worker', build });
    const failure = new AppUpdateError('WORKER_TIMEOUT', 'アプリの更新準備が完了しませんでした。今の画面を保ったまま停止しました。もう一度お試しください。');
    const deadline = Date.now() + timeoutMs;
    const registration = await bounded(Promise.resolve().then(() => serviceWorker.getRegistration(base.href)), timeoutMs, failure);
    if (!registration?.update) throw failure;
    await bounded(Promise.resolve().then(() => registration.update()), Math.max(1, deadline - Date.now()), failure);
    while (Date.now() < deadline) {
      const latest = await bounded(Promise.resolve().then(() => serviceWorker.getRegistration(base.href)), Math.max(1, deadline - Date.now()), failure);
      const found = await workerBuild(latest?.active, Math.min(500, Math.max(1, deadline - Date.now())));
      if (found === build) return true;
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    throw failure;
  }

  async function performApply() {
    const release = await check();
    if (release.status === 'current') return release;
    await guard('before-download', release.build);
    await verifyAssets(release);
    await guard('after-download', release.build);
    const serviceWorkerVerified = await verifyWorker(release.build);
    await guard('before-reload', release.build);
    onProgress({ stage: 'reloading', build: release.build });
    await reload();
    return { status: 'reloading', currentBuild, build: release.build, serviceWorkerVerified };
  }

  function apply() {
    if (!applying) applying = performApply().finally(() => { applying = null; });
    return applying;
  }
  return { check, apply };
}
