const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

function createStorageArea() {
  const data = {};
  return {
    async get(keys) {
      if (!keys) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      list.forEach(key => {
        out[key] = data[key];
      });
      return out;
    },
    async set(pairs) {
      Object.assign(data, pairs);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(key => {
        delete data[key];
      });
    }
  };
}

global.crypto = webcrypto;
const sessionArea = createStorageArea();
const localArea = createStorageArea();

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getURL: fileName => fileName,
    getManifest: () => ({ version: '1.0.0' }),
    onMessage: { addListener: () => {} }
  },
  storage: {
    session: sessionArea,
    local: localArea
  },
  identity: {
    getAuthToken: (_options, cb) => cb('token-123'),
    removeCachedAuthToken: (_options, cb) => cb()
  }
};

global.fetch = async () => { throw new Error('fetch not mocked'); };

const worker = require('../service_worker.js');
const { normalizeBase, loadConfigFile, ensureGoogleIdentity } = worker;

async function runTest(name, fn) {
  try {
    await fn();
    console.log('[ok]', name);
  } catch (err) {
    console.error('[fail]', name);
    console.error(err);
    process.exit(1);
  }
}

(async () => {
  await runTest('normalizeBase trims trailing slashes', async () => {
    assert.equal(normalizeBase('https://example.com///'), 'https://example.com');
    assert.equal(normalizeBase('https://api.test/path/'), 'https://api.test/path');
  });

  await runTest('loadConfigFile reads proxy base and dev email', async () => {
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({
        proxyBase: 'https://proxy.local/ ',
        dev: { googleMockEmail: 'dev@test.local' }
      })
    });
    const cfg = await loadConfigFile('config.json');
    assert.equal(cfg.proxyBase, 'https://proxy.local');
    assert.equal(cfg.devMockGoogleEmail, 'dev@test.local');
    assert.equal(cfg.source, 'config.json');
  });

  await runTest('ensureGoogleIdentity returns mocked profile when email provided', async () => {
    const result = await ensureGoogleIdentity(false, 'mock-user@test.local');
    assert.equal(result.accessToken, 'mock-user@test.local');
    assert.equal(result.profile.email, 'mock-user@test.local');
    const stored = await localArea.get('rcGoogleProfile');
    assert.ok(stored.rcGoogleProfile);
    assert.equal(stored.rcGoogleProfile.email, 'mock-user@test.local');
  });

  console.log('service-worker.test.js passed');
})();
