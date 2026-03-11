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
    },
    async clear() {
      Object.keys(data).forEach(key => {
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
    getRedirectURL: (path = '') => `https://test.chromiumapp.org/${path}`,
    launchWebAuthFlow: (_options, cb) => cb('https://test.chromiumapp.org/provider_cb#id_token=test-id-token'),
    getAuthToken: (_options, cb) => cb('token-123'),
    removeCachedAuthToken: (_options, cb) => cb()
  }
};

global.fetch = async () => { throw new Error('fetch not mocked'); };

const worker = require('../service_worker.js');
const { normalizeBase, loadConfigFile, fetchWithTimeout, truncateReviewText } = worker;

describe('Service Worker Logic', () => {
  beforeEach(async () => {
    await sessionArea.clear();
    await localArea.clear();
    global.fetch = async () => { throw new Error('fetch not mocked'); };
  });

  test('normalizeBase trims trailing slashes', () => {
    expect(normalizeBase('https://example.com///')).toBe('https://example.com');
    expect(normalizeBase('https://api.test/path/')).toBe('https://api.test/path');
  });

  test('truncateReviewText caps long reviews', () => {
    const longText = 'a'.repeat(1700);
    const truncated = truncateReviewText(longText);
    expect(truncated.length).toBeLessThanOrEqual(1503);
    expect(truncated.endsWith('...')).toBe(true);
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

  test('fetchWithTimeout rejects with a controlled timeout message', async () => {
    global.fetch = async (_url, init = {}) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('AbortError');
        error.name = 'AbortError';
        reject(error);
      });
    });
    await expect(fetchWithTimeout(
      'https://proxy.local/gemini/generate',
      { method: 'POST' },
      20,
      'Usluga generowania odpowiada zbyt wolno. Sprobuj ponownie.'
    )).rejects.toThrow('Usluga generowania odpowiada zbyt wolno. Sprobuj ponownie.');
  });

  test('GENERATE_ALL retries with Google login when stored device token is invalid', async () => {
    await localArea.set({ rcDeviceToken: 'stale-device-token' });
    const sessionBodies = [];
    let generateBody = null;

    global.fetch = async (url, options = {}) => {
      if (url === 'config.json' || url === 'config.default.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            proxyBase: 'https://proxy.local',
            googleClientId: 'client-id.apps.googleusercontent.com'
          })
        };
      }

      if (url === 'https://proxy.local/api/extension/session') {
        const body = JSON.parse(options.body || '{}');
        sessionBodies.push(body);
        if (body.deviceToken) {
          return {
            ok: false,
            text: async () => JSON.stringify({ error: 'Invalid device token' })
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({
            token: 'jwt-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            deviceToken: 'fresh-device-token',
            profile: {
              email: 'owner@example.com',
              sub: 'google-sub'
            }
          })
        };
      }

      if (url === 'https://proxy.local/gemini/generate') {
        generateBody = JSON.parse(options.body || '{}');
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null
          },
          text: async () => JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"soft":"soft reply","brief":"brief reply","proactive":"proactive reply"}'
                    }
                  ]
                }
              }
            ]
          })
        };
      }

      if (url === 'https://proxy.local/api/extension/log') {
        return {
          ok: true,
          text: async () => ''
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    let response = null;
    const listenerResult = onMessageHandler({
      type: 'GENERATE_ALL',
      payload: { rating: '5', text: 'Super obsluga' }
    }, {}, (payload) => {
      response = payload;
    });

    expect(listenerResult).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sessionBodies).toHaveLength(2);
    expect(sessionBodies[0].deviceToken).toBe('stale-device-token');
    expect(sessionBodies[1].idToken).toBe('test-id-token');
    expect(response).toMatchObject({
      soft: 'soft reply',
      brief: 'brief reply',
      proactive: 'proactive reply'
    });
    expect(generateBody.model).toBe('gemini-2.5-flash-lite');
    expect(generateBody.generationConfig).toMatchObject({
      candidateCount: 1,
      maxOutputTokens: 320
    });
    const stored = await localArea.get(['rcDeviceToken']);
    expect(stored.rcDeviceToken).toBe('fresh-device-token');
  });

  test('GENERATE_ALL builds the updated Polish prompt for a positive review', async () => {
    let generateBody = null;
    let response = null;
    let resolveGenerateRequest;
    let resolveResponse;
    const generateRequestSeen = new Promise(resolve => { resolveGenerateRequest = resolve; });
    const responseSeen = new Promise(resolve => { resolveResponse = resolve; });

    await sessionArea.set({
      proxySession: {
        token: 'jwt-token',
        proxyBase: 'https://proxy.local',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    global.fetch = async (url, options = {}) => {
      if (url === 'config.json' || url === 'config.default.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            proxyBase: 'https://proxy.local'
          })
        };
      }

      if (url === 'https://proxy.local/gemini/generate') {
        generateBody = JSON.parse(options.body || '{}');
        resolveGenerateRequest();
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null
          },
          text: async () => JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"soft":"soft reply","brief":"brief reply","proactive":"proactive reply"}'
                    }
                  ]
                }
              }
            ]
          })
        };
      }

      if (url === 'https://proxy.local/api/extension/log') {
        return {
          ok: true,
          text: async () => ''
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const listenerResult = onMessageHandler({
      type: 'GENERATE_ALL',
      payload: { rating: '5', text: 'Świetna obsługa i pyszne pierogi.' }
    }, {}, (payload) => {
      response = payload;
      resolveResponse();
    });

    expect(listenerResult).toBe(true);
    await generateRequestSeen;
    await responseSeen;

    const prompt = generateBody.contents[0].parts[0].text;

    expect(prompt).toContain('Jesteś asystentem firmy, który tworzy odpowiedzi na opinie klientów w Google. Język odpowiedzi: polski.');
    expect(prompt).toContain('Używaj poprawnej polszczyzny i zawsze stosuj polskie znaki diakrytyczne (ą, ć, ę, ł, ń, ó, ś, ź, ż) w odpowiedziach.');
    expect(prompt).toContain('Zwróć tylko poprawny JSON bez dodatkowych komentarzy.');
    expect(prompt).toContain('Dziękujemy za opinię,');
    expect(prompt).toContain('Ocena klienta: 5/5.');
    expect(prompt).toContain('Klient jest zadowolony: podziękuj, podkreśl docenione elementy i zaproś do ponownej wizyty.');
    expect(prompt).toContain('Dostosuj ogólny ton: serdeczny, wdzięczny i krótki');
    expect(prompt).toContain('Treść opinii:\nŚwietna obsługa i pyszne pierogi.');
    expect(prompt).not.toContain('Dzień dobry');
    expect(prompt).not.toContain('Dzien dobry');
    expect(response._prompt).toBe(prompt);
  });

  test('GENERATE_ALL builds the updated Polish prompt for a negative review', async () => {
    let generateBody = null;
    let resolveGenerateRequest;
    const generateRequestSeen = new Promise(resolve => { resolveGenerateRequest = resolve; });

    await sessionArea.set({
      proxySession: {
        token: 'jwt-token',
        proxyBase: 'https://proxy.local',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    global.fetch = async (url, options = {}) => {
      if (url === 'config.json' || url === 'config.default.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            proxyBase: 'https://proxy.local'
          })
        };
      }

      if (url === 'https://proxy.local/gemini/generate') {
        generateBody = JSON.parse(options.body || '{}');
        resolveGenerateRequest();
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => null
          },
          text: async () => JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"soft":"soft reply","brief":"brief reply","proactive":"proactive reply"}'
                    }
                  ]
                }
              }
            ]
          })
        };
      }

      if (url === 'https://proxy.local/api/extension/log') {
        return {
          ok: true,
          text: async () => ''
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const listenerResult = onMessageHandler({
      type: 'GENERATE_ALL',
      payload: { rating: '1', text: 'Jedzenie było zimne i długo czekaliśmy.' }
    }, {}, () => {});

    expect(listenerResult).toBe(true);
    await generateRequestSeen;

    const prompt = generateBody.contents[0].parts[0].text;

    expect(prompt).toContain('Ocena klienta: 1/5.');
    expect(prompt).toContain('Klient jest niezadowolony: przeproś, uznaj problem i zaproponuj dalszy kontakt przez profil firmy.');
    expect(prompt).toContain('Dostosuj ogólny ton: empatyczny i spokojny, zachęcający do kontaktu przez profil');
    expect(prompt).toContain('Jeśli opinia zawiera problem, w każdym wariancie okaż zrozumienie i odnieś się do problemu.');
    expect(prompt).toContain('Jedzenie było zimne i długo czekaliśmy.');
    expect(prompt).toContain('Zapraszamy do kontaktu przez dane dostępne na profilu firmy.');
  });
});
