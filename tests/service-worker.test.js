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
let createdTabs = [];
let sentTabMessages = [];
let openedOptionsCount = 0;

// global.crypto = webcrypto;
const sessionArea = createStorageArea();
const localArea = createStorageArea();

global.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getURL: fileName => fileName,
    getManifest: () => ({ version: '1.0.0' }),
    openOptionsPage: async () => {
      openedOptionsCount += 1;
    },
    onMessage: { addListener: (fn) => { onMessageHandler = fn; } }
  },
  tabs: {
    create: ({ url }) => {
      createdTabs.push(url);
    },
    query: async () => [{ id: 101 }, { id: 102 }],
    sendMessage: async (tabId, message) => {
      sentTabMessages.push({ tabId, message });
    }
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
    createdTabs = [];
    sentTabMessages = [];
    openedOptionsCount = 0;
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

  test('GENERATE_ALL while logged out returns auth guidance without console error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      global.fetch = async (url) => {
        if (url === 'config.json') {
          return {
            ok: true,
            text: async () => JSON.stringify({
              proxyBase: 'https://proxy.local',
              googleClientId: 'client-id.apps.googleusercontent.com'
            })
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };

      let response = null;
      const listenerResult = onMessageHandler({
        type: 'GENERATE_ALL',
        payload: { text: 'Super obsluga', rating: '5' }
      }, {}, (payload) => {
        response = payload;
      });

      expect(listenerResult).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(response).toEqual({
        error: 'Sesja wygasla. Zaloguj sie ponownie w rozszerzeniu.',
        errorCode: 'AUTH_REQUIRED'
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('OPEN_LOGIN_PAGE opens the extension options page', async () => {
    let response = null;
    const listenerResult = onMessageHandler({ type: 'OPEN_LOGIN_PAGE' }, {}, (payload) => {
      response = payload;
    });

    expect(listenerResult).toBe(true);
    await Promise.resolve();

    expect(response).toEqual({ ok: true });
    expect(openedOptionsCount).toBe(1);
    expect(createdTabs).toEqual([]);
  });

  test('OPEN_OPTIONS_PAGE opens the extension options page', async () => {
    let response = null;
    const listenerResult = onMessageHandler({ type: 'OPEN_OPTIONS_PAGE' }, {}, (payload) => {
      response = payload;
    });

    expect(listenerResult).toBe(true);
    await Promise.resolve();

    expect(response).toEqual({ ok: true });
    expect(openedOptionsCount).toBe(1);
    expect(createdTabs).toEqual([]);
  });

  test('START_GOOGLE_LOGIN returns account profile and quota for options page', async () => {
    const sessionBodies = [];
    global.fetch = async (url, options = {}) => {
      if (url === 'config.json') {
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
        return {
          ok: true,
          text: async () => JSON.stringify({
            token: 'jwt-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            deviceToken: 'fresh-device-token',
            license: { id: 'license-1' },
            profile: {
              email: 'owner@example.com',
              sub: 'user-1',
              plan: 'pro'
            },
            quota: {
              type: 'usage',
              limit: 100,
              remaining: 42,
              expiresAt: '2099-02-01T00:00:00.000Z'
            }
          })
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    let response = null;
    const listenerResult = onMessageHandler({ type: 'START_GOOGLE_LOGIN' }, {}, (payload) => {
      response = payload;
    });

    expect(listenerResult).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sessionBodies).toHaveLength(1);
    expect(sessionBodies[0].idToken).toBe('test-id-token');
    expect(response).toMatchObject({
      ok: true,
      profile: {
        email: 'owner@example.com',
        sub: 'user-1',
        plan: 'pro',
        licenseId: 'license-1'
      },
      quota: {
        type: 'usage',
        limit: 100,
        remaining: 42,
        expiresAt: '2099-02-01T00:00:00.000Z'
      }
    });

    let status = null;
    onMessageHandler({ type: 'GET_AUTH_STATUS' }, {}, (payload) => {
      status = payload;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(status).toMatchObject({
      profile: { email: 'owner@example.com', plan: 'pro', licenseId: 'license-1' },
      quota: { remaining: 42 }
    });
    expect(sentTabMessages).toHaveLength(2);
    expect(sentTabMessages.map(item => item.tabId)).toEqual([101, 102]);
    for (const item of sentTabMessages) {
      expect(item.message).toMatchObject({
        type: 'AUTH_STATUS_CHANGED',
        reason: 'login',
        profile: {
          email: 'owner@example.com',
          sub: 'user-1',
          plan: 'pro',
          licenseId: 'license-1'
        },
        quota: {
          type: 'usage',
          limit: 100,
          remaining: 42,
          limitSeconds: null,
          remainingSeconds: null,
          expiresAt: '2099-02-01T00:00:00.000Z',
          upgradeUrl: ''
        }
      });
    }
  });

  test('START_GOOGLE_LOGIN cancellation returns guidance without console error', async () => {
    const originalLaunchWebAuthFlow = chrome.identity.launchWebAuthFlow;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      chrome.identity.launchWebAuthFlow = (_options, cb) => {
        chrome.runtime.lastError = { message: 'The user did not approve access.' };
        cb(null);
        chrome.runtime.lastError = null;
      };
      global.fetch = async (url) => {
        if (url === 'config.json') {
          return {
            ok: true,
            text: async () => JSON.stringify({
              proxyBase: 'https://proxy.local',
              googleClientId: 'client-id.apps.googleusercontent.com'
            })
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };

      let response = null;
      const result = onMessageHandler({ type: 'START_GOOGLE_LOGIN' }, {}, (payload) => {
        response = payload;
      });

      expect(result).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(response).toEqual({ error: 'Logowanie anulowane.' });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      chrome.identity.launchWebAuthFlow = originalLaunchWebAuthFlow;
      chrome.runtime.lastError = null;
      errorSpy.mockRestore();
    }
  });

  test('GET_AUTH_STATUS clears stale stored profile when device token is invalid', async () => {
    await localArea.set({
      rcAccountProfile: {
        email: 'stale@example.com',
        sub: 'stale-user',
        plan: 'trial',
        updatedAt: '2026-05-04T00:00:00.000Z'
      },
      rcDeviceToken: 'stale-device-token'
    });

    global.fetch = async (url, options = {}) => {
      if (url === 'config.json') {
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
        expect(body.deviceToken).toBe('stale-device-token');
        return {
          ok: false,
          text: async () => JSON.stringify({
            error: 'Invalid device token'
          })
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    let status = null;
    onMessageHandler({ type: 'GET_AUTH_STATUS' }, {}, (payload) => {
      status = payload;
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(status).toEqual({ profile: null, quota: null });

    const stored = await localArea.get(['rcAccountProfile', 'rcDeviceToken']);
    expect(stored.rcAccountProfile).toBeUndefined();
    expect(stored.rcDeviceToken).toBeUndefined();
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
      if (url === 'config.json') {
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
      if (url === 'config.json') {
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
    expect(prompt).toContain('Pisz naturalnie, uprzejmie i po ludzku, jak odpowiedź publikowana w imieniu firmy lub miejsca.');
    expect(prompt).toContain('Używaj poprawnej polszczyzny i zawsze stosuj polskie znaki diakrytyczne (ą, ć, ę, ł, ń, ó, ś, ź, ż) w odpowiedziach.');
    expect(prompt).toContain('Zwróć tylko poprawny JSON bez dodatkowych komentarzy.');
    expect(prompt).toContain('Dziękujemy za opinię,');
    expect(prompt).toContain('Ocena klienta: 5/5.');
    expect(prompt).toContain('Klient jest zadowolony: podziękuj, podkreśl docenione elementy i zaproś do ponownej wizyty.');
    expect(prompt).toContain('Dostosuj ogólny ton: serdeczny, wdzięczny i krótki');
    expect(prompt).toContain('Treść opinii:\nŚwietna obsługa i pyszne pierogi.');
    expect(prompt).not.toContain('Dzień dobry');
    expect(prompt).not.toContain('Dzien dobry');
    expect(prompt).toContain('Nie zakladaj struktury firmy, roli autora odpowiedzi ani tego, ze chodzi o restauracje, chyba ze wynika to z kontekstu miejsca albo z samej opinii.');
    expect(prompt).toContain('Jesli uzywasz imienia recenzenta albo formy typu Panie Pawle / Pani Katarzyno, umiesc je wylacznie na samym poczatku odpowiedzi albo na poczatku pierwszego zdania.');
    expect(prompt).toContain('Wariant brief ma miec maksymalnie 2 zdania i maksymalnie 220 znakow.');
    expect(prompt).toContain('Zwroc tylko poprawny JSON bez markdown, backtickow, blokow kodu, komentarzy i bez zadnego tekstu przed albo po JSON.');
    expect(response.soft).toBe('soft reply');
    expect(response.brief).toBe('brief reply');
    expect(response.proactive).toBe('proactive reply');
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
      if (url === 'config.json') {
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
    expect(prompt).toContain('Klient jest niezadowolony: okaż zrozumienie, odnieś się do problemu i dobierz strategię odpowiedzi bez zakładania winy firmy.');
    expect(prompt).toContain('Dostosuj ogólny ton: empatyczny, spokojny i profesjonalny');
    expect(prompt).toContain('Warianty nie mogą różnić się tylko pojedynczymi słowami ani samym tonem; mają różnić się także strategią odpowiedzi.');
    expect(prompt).toContain('soft ma przede wszystkim okazać zrozumienie i złagodzić napięcie,');
    expect(prompt).toContain('brief ma przede wszystkim odpowiedzieć krótko i rzeczowo,');
    expect(prompt).toContain('proactive ma przede wszystkim pokazać gotowość do dalszej rozmowy albo doprecyzowania.');
    expect(prompt).toContain('Każdy wariant może zakończyć się neutralnym zaproszeniem do kontaktu w razie pytań, ale zaproszenie do kontaktu nie może być jedyną treścią odpowiedzi.');
    expect(prompt).toContain('Jesli opinia jest negatywna albo mieszana, trzy warianty maja roznic sie nie tylko stylem, ale tez glownym ruchem odpowiedzi: soft lagodzi napiecie, brief odpowiada rzeczowo, proactive najmocniej otwiera rozmowe.');
    expect(prompt).toContain('Jedzenie było zimne i długo czekaliśmy.');
    expect(prompt).toContain('Zapraszamy do kontaktu przez dane dostępne na profilu firmy.');
  });

  test('GENERATE_ALL keeps rating and review text while adding place context to the prompt', async () => {
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
      if (url === 'config.json') {
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
      payload: {
        rating: '5',
        text: 'Makaron byl swietny i obsluga bardzo mila.',
        placeType: 'restauracja wloska',
        placeName: 'Trattoria Verde'
      }
    }, {}, () => {});

    expect(listenerResult).toBe(true);
    await generateRequestSeen;

    const prompt = generateBody.contents[0].parts[0].text;

    expect(prompt).toContain('Ocena klienta: 5/5.');
    expect(prompt).toContain('Makaron byl swietny i obsluga bardzo mila.');
    expect(prompt).toContain('Typ dzialalnosci miejsca: restauracja wloska.');
    expect(prompt).toContain('Nazwa firmy: "Trattoria Verde". To nazwa wlasna firmy lub miejsca.');
    expect(prompt).toContain('Instrukcje dotyczace kontekstu miejsca:');
    expect(prompt).toContain('Priorytetowe doprecyzowania:');
  });

  test('OPEN_UPGRADE_PAGE opens Stripe checkout directly for logged-in users', async () => {
    await sessionArea.set({
      proxySession: {
        token: 'cached-jwt',
        proxyBase: 'https://proxy.local',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    global.fetch = async (url, options = {}) => {
      if (url === 'config.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            proxyBase: 'https://proxy.local',
            upgradeUrl: 'http://localhost:5173/#plany'
          })
        };
      }

      if (url === 'https://proxy.local/api/extension/account/upgrade') {
        expect(options.headers.Authorization).toBe('Bearer cached-jwt');
        return {
          ok: true,
          text: async () => JSON.stringify({ checkout_url: 'https://checkout.stripe.com/test-session' })
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    let response = null;
    const result = onMessageHandler({ type: 'OPEN_UPGRADE_PAGE' }, {}, (payload) => {
      response = payload;
    });

    expect(result).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(response).toEqual({ ok: true, checkoutUrl: 'https://checkout.stripe.com/test-session' });
    expect(createdTabs).toEqual(['https://checkout.stripe.com/test-session']);
  });

  test('OPEN_UPGRADE_PAGE returns Google login guidance for license-only sessions', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await sessionArea.set({
      proxySession: {
        token: 'cached-license-jwt',
        proxyBase: 'https://proxy.local',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    global.fetch = async (url) => {
      if (url === 'https://proxy.local/api/extension/account/upgrade') {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({
            error: 'Aby kupić abonament, zaloguj się kontem Google w rozszerzeniu.',
            code: 'GOOGLE_LOGIN_REQUIRED'
          })
        };
      }
      if (url === 'config.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({ proxyBase: 'https://proxy.local' })
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    let response = null;
    const result = onMessageHandler({ type: 'OPEN_UPGRADE_PAGE' }, {}, (payload) => {
      response = payload;
    });

    expect(result).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(response).toEqual({
      error: 'Aby kupić abonament, zaloguj się kontem Google w rozszerzeniu.',
      code: 'GOOGLE_LOGIN_REQUIRED'
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(createdTabs).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('GENERATE_ALL masks raw fetch failures with a friendly retry message', async () => {
    await sessionArea.set({
      proxySession: {
        token: 'jwt-token',
        proxyBase: 'https://proxy.local',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    global.fetch = async (url) => {
      if (url === 'config.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            proxyBase: 'https://proxy.local',
            googleClientId: 'client-id.apps.googleusercontent.com'
          })
        };
      }

      if (url === 'https://proxy.local/gemini/generate') {
        throw new Error('Failed to fetch');
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

    expect(response).toEqual({ error: 'Sprobuj ponownie pozniej.' });
  });

  test('GENERATE_ALL masks upstream high demand errors with a friendly overload message', async () => {
    await sessionArea.set({
      proxySession: {
        token: 'jwt-token',
        proxyBase: 'https://proxy.local',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    global.fetch = async (url) => {
      if (url === 'config.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            proxyBase: 'https://proxy.local',
            googleClientId: 'client-id.apps.googleusercontent.com'
          })
        };
      }

      if (url === 'https://proxy.local/gemini/generate') {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          headers: {
            get: () => null
          },
          text: async () => JSON.stringify({
            error: {
              message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
            }
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
    await new Promise(resolve => setTimeout(resolve, 1300));

    expect(response).toEqual({
      error: 'Serwer jest obecnie obciazony. Sprobuj ponownie za chwile.',
      errorCode: undefined,
      freeLimit: undefined,
      quota: null,
      upgradeUrl: ''
    });
  });

  test('GENERATE_ALL retries once after upstream high demand and succeeds when the retry works', async () => {
    await sessionArea.set({
      proxySession: {
        token: 'jwt-token',
        proxyBase: 'https://proxy.local',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    let generateCalls = 0;
    global.fetch = async (url) => {
      if (url === 'config.json') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            proxyBase: 'https://proxy.local',
            googleClientId: 'client-id.apps.googleusercontent.com'
          })
        };
      }

      if (url === 'https://proxy.local/gemini/generate') {
        generateCalls++;
        if (generateCalls === 1) {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            headers: {
              get: () => null
            },
            text: async () => JSON.stringify({
              error: {
                message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
              }
            })
          };
        }
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
                      text: '{"soft":"soft retry","brief":"brief retry","proactive":"proactive retry"}'
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
    await new Promise(resolve => setTimeout(resolve, 1300));

    expect(generateCalls).toBe(2);
    expect(response).toEqual({
      soft: 'soft retry',
      brief: 'brief retry',
      proactive: 'proactive retry',
      quota: null
    });
  });
});
