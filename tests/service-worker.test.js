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

let onMessageHandler = null;

// global.crypto = webcrypto;
const sessionArea = createStorageArea();
const localArea = createStorageArea();

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getURL: fileName => fileName,
    getManifest: () => ({ version: '1.0.0' }),
    onMessage: { addListener: (fn) => { onMessageHandler = fn; } }
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
const { normalizeBase, loadConfigFile } = worker;

describe('Service Worker Logic', () => {
  test('normalizeBase trims trailing slashes', () => {
    expect(normalizeBase('https://example.com///')).toBe('https://example.com');
    expect(normalizeBase('https://api.test/path/')).toBe('https://api.test/path');
  });

  test('loadConfigFile reads proxy base and license key', async () => {
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({
        proxyBase: 'https://proxy.local/ ',
        licenseKey: 'TEST-LICENSE'
      })
    });
    const cfg = await loadConfigFile('config.json');
    expect(cfg.proxyBase).toBe('https://proxy.local');
    expect(cfg.licenseKey).toBe('TEST-LICENSE');
    expect(cfg.source).toBe('config.json');
  });

  test('GENERATE_ALL without payload responds with error', async () => {
    expect(typeof onMessageHandler).toBe('function');
    let response = null;
    const listenerResult = onMessageHandler({ type: 'GENERATE_ALL' }, {}, (payload)=>{
      response = payload;
    });
    expect(listenerResult).toBe(true);
    await Promise.resolve();
    expect(response).toEqual({ error: 'Brak danych opinii do wygenerowania.' });
  });
});
