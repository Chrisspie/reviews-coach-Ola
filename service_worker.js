const DEFAULT_MODEL = 'gemini-2.5-flash';
const SESSION_ENDPOINT_PATH = '/api/extension/session';
const MAGIC_LINK_ENDPOINT_PATH = '/api/auth/magic-link';
const GENERATE_ENDPOINT_PATH = '/gemini/generate';
const LOG_ENDPOINT_PATH = '/api/extension/log';
const TOKEN_EXPIRY_GUARD_MS = 10 * 1000; // keep 10s safety window
const LOG_PROMPT_PREVIEW_LIMIT = 200;
const LOG_PROMPT_ELLIPSIS = '...';
const INSTALL_ID_KEY = 'rcInstallId';
const DEVICE_TOKEN_KEY = 'rcDeviceToken';
const ACCOUNT_PROFILE_KEY = 'rcAccountProfile';
const CONFIG_PRIMARY_FILE = 'config.json';
const CONFIG_FALLBACK_FILE = 'config.default.json';

const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';

let staticConfigPromise = null;
let quotaState = null;

function truncateForLog(value, maxLen = LOG_PROMPT_PREVIEW_LIMIT) {
  const str = (value || '').toString();
  if (str.length <= maxLen) return str;
  const sliceLen = Math.max(0, maxLen - LOG_PROMPT_ELLIPSIS.length);
  return str.slice(0, sliceLen) + LOG_PROMPT_ELLIPSIS;
}

function getProxySessionStorage() {
  return (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
}

function normalizeBase(url) {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '');
}

async function loadConfigFile(fileName) {
  const url = chrome.runtime.getURL(fileName);
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) { throw new Error(`HTTP ${resp.status}`); }
  const raw = await resp.text();
  if (!raw) { throw new Error('Empty config file'); }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Invalid JSON');
  }
  const proxyBase = normalizeBase(parsed.proxyBase || parsed.apiBase);
  const upgradeUrl = (parsed.upgradeUrl || parsed.billingUrl || '').trim();
  const licenseKey = (parsed.licenseKey || '').toString().trim();
  const googleClientId = (parsed.googleClientId || '').toString().trim();
  if (!proxyBase) {
    throw new Error('Missing proxyBase in config file');
  }
  return { proxyBase, upgradeUrl, source: fileName, licenseKey, googleClientId };
}

async function loadStaticConfig() {
  if (!staticConfigPromise) {
    staticConfigPromise = (async () => {
      for (const file of [CONFIG_PRIMARY_FILE, CONFIG_FALLBACK_FILE]) {
        try {
          const cfg = await loadConfigFile(file);
          console.info('[RC] Loaded proxy config from', file);
          return cfg;
        } catch (err) {
          console.warn('[RC] Config file skipped', { file, error: String(err) });
        }
      }
      return null;
    })();
  }
  return staticConfigPromise;
}

async function getProxySettings() {
  const cfg = await loadStaticConfig();
  if (cfg && cfg.proxyBase) {
    return cfg;
  }
  throw new Error('Brak config.json: ustaw proxyBase w pliku konfiguracji.');
}

function buildProxyUrl(base, path) {
  if (!base) return '';
  const suffix = path || '';
  return base + suffix;
}

async function getCachedSession() {
  if (chrome.storage && chrome.storage.session) {
    const { proxySession = {} } = await chrome.storage.session.get(['proxySession']);
    if (proxySession && proxySession.token) {
      return proxySession;
    }
  }
  const { proxySession: legacySession = {} } = await chrome.storage.local.get(['proxySession']);
  return legacySession;
}

function isSessionValid(session, proxyBase) {
  if (!session || session.proxyBase !== proxyBase || !session.token) return false;
  if (!session.expiresAt) return true;
  const expiresAt = new Date(session.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > Date.now();
}

async function storeSession(session) {
  const storageArea = getProxySessionStorage();
  await storageArea.set({ proxySession: session });
  if (storageArea !== chrome.storage.local) {
    await chrome.storage.local.remove(['proxySession']);
  }
}

function normalizeQuota(raw, fallbackUrl = '') {
  if (!raw || typeof raw !== 'object') return null;
  const upgradeUrl = (raw.upgradeUrl || fallbackUrl || '').trim();
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : null;
  if (type === 'time') {
    const limitSeconds = Number(raw.limitSeconds ?? raw.limit);
    if (!Number.isFinite(limitSeconds) || limitSeconds <= 0) return null;
    const remainingSecondsRaw = Number(raw.remainingSeconds ?? raw.remaining);
    const remainingSeconds = Number.isFinite(remainingSecondsRaw) ? Math.max(0, Math.floor(remainingSecondsRaw)) : null;
    const expiresAt = raw.expiresAt ? new Date(raw.expiresAt).toISOString() : null;
    return {
      type: 'time',
      limit: null,
      remaining: null,
      limitSeconds: Math.max(0, Math.floor(limitSeconds)),
      remainingSeconds,
      expiresAt,
      upgradeUrl
    };
  }
  const limit = Number(raw.limit ?? raw.limitSeconds);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remainingNum = Number(raw.remaining ?? raw.remainingSeconds);
  const remaining = Number.isFinite(remainingNum) ? Math.max(0, Math.floor(remainingNum)) : null;
  return {
    type: 'usage',
    limit: Math.max(0, Math.floor(limit)),
    remaining,
    limitSeconds: null,
    remainingSeconds: null,
    expiresAt: null,
    upgradeUrl
  };
}

function updateQuotaState(quota) {
  quotaState = quota || null;
}

function getQuotaState() {
  return quotaState;
}

function quotaFromHeaders(resp, fallbackUrl = '') {
  if (!resp || typeof resp.headers?.get !== 'function') return null;
  const mode = (resp.headers.get('x-free-mode') || '').toLowerCase();
  const upgradeUrl = (resp.headers.get('x-free-upgrade-url') || fallbackUrl || '').trim();
  if (mode === 'time') {
    const limitSecondsRaw = Number(resp.headers.get('x-free-limit-seconds') ?? resp.headers.get('x-free-limit'));
    if (!Number.isFinite(limitSecondsRaw) || limitSecondsRaw <= 0) return null;
    const remainingSecondsRaw = Number(resp.headers.get('x-free-remaining-seconds') ?? resp.headers.get('x-free-remaining'));
    const remainingSeconds = Number.isFinite(remainingSecondsRaw) ? Math.max(0, Math.floor(remainingSecondsRaw)) : null;
    const expiresAtHeader = resp.headers.get('x-free-expires-at');
    const expiresAt = expiresAtHeader ? new Date(expiresAtHeader).toISOString() : null;
    return {
      type: 'time',
      limit: null,
      remaining: null,
      limitSeconds: Math.max(0, Math.floor(limitSecondsRaw)),
      remainingSeconds,
      expiresAt,
      upgradeUrl
    };
  }
  const limit = Number(resp.headers.get('x-free-limit'));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remainingNum = Number(resp.headers.get('x-free-remaining'));
  const remaining = Number.isFinite(remainingNum) ? Math.max(0, Math.floor(remainingNum)) : null;
  return {
    type: 'usage',
    limit: Math.max(0, Math.floor(limit)),
    remaining,
    limitSeconds: null,
    remainingSeconds: null,
    expiresAt: null,
    upgradeUrl
  };
}

function quotaLimitValue(quota) {
  if (!quota) return null;
  if (typeof quota.limit === 'number') return quota.limit;
  if (typeof quota.limitSeconds === 'number') return quota.limitSeconds;
  return null;
}

function quotaRemainingValue(quota) {
  if (!quota) return null;
  if (typeof quota.remaining === 'number') return quota.remaining;
  if (typeof quota.remainingSeconds === 'number') return quota.remainingSeconds;
  return null;
}

function resolveSessionExpiry(parsed) {
  if (typeof parsed.expiresIn === 'number' && Number.isFinite(parsed.expiresIn)) {
    const ttlMs = Math.max(0, (parsed.expiresIn * 1000) - TOKEN_EXPIRY_GUARD_MS);
    return new Date(Date.now() + ttlMs).toISOString();
  }
  if (parsed.expiresAt) {
    const expTs = new Date(parsed.expiresAt).getTime();
    if (!Number.isNaN(expTs)) {
      const guardedTs = Math.max(Date.now(), expTs - TOKEN_EXPIRY_GUARD_MS);
      return new Date(guardedTs).toISOString();
    }
  }
  return null;
}

async function ensureInstallId() {
  const stored = await chrome.storage.local.get([INSTALL_ID_KEY]);
  const current = stored?.[INSTALL_ID_KEY];
  if (current && typeof current === 'string') { return current; }
  const generated = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `rc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = {}; payload[INSTALL_ID_KEY] = generated;
  await chrome.storage.local.set(payload);
  return generated;
}

async function getStoredAccountProfile() {
  const stored = await chrome.storage.local.get([ACCOUNT_PROFILE_KEY]);
  return stored?.[ACCOUNT_PROFILE_KEY] || null;
}

async function storeAccountProfile(profile) {
  if (!profile) return;
  const payload = {}; payload[ACCOUNT_PROFILE_KEY] = profile;
  await chrome.storage.local.set(payload);
}

async function clearAccountProfile() {
  await chrome.storage.local.remove([ACCOUNT_PROFILE_KEY]);
}

async function getStoredDeviceToken() {
  const stored = await chrome.storage.local.get([DEVICE_TOKEN_KEY]);
  return stored?.[DEVICE_TOKEN_KEY] || '';
}

async function storeDeviceToken(token) {
  if (!token) return;
  const payload = {}; payload[DEVICE_TOKEN_KEY] = token;
  await chrome.storage.local.set(payload);
}

async function clearStoredDeviceToken() {
  await chrome.storage.local.remove([DEVICE_TOKEN_KEY]);
}

function launchAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, redirectUri => {
      if (chrome.runtime.lastError || !redirectUri) {
        const message = chrome.runtime.lastError?.message || 'Auth flow failed.';
        reject(new Error(message));
        return;
      }
      resolve(redirectUri);
    });
  });
}

async function clearStoredSession() {
  const storageArea = getProxySessionStorage();
  await storageArea.remove(['proxySession']);
}

async function logoutAccount() {
  await clearStoredDeviceToken();
  await clearAccountProfile();
  await clearStoredSession();
}

async function fetchSessionToken(settings, options = {}) {
  const proxyBase = settings?.proxyBase;
  if (!proxyBase) { throw new Error('Brak Proxy URL w konfiguracji.'); }
  const licenseKey = (settings?.licenseKey || '').toString().trim();
  const deviceToken = licenseKey ? '' : (await getStoredDeviceToken());
  const installId = await ensureInstallId();
  const tokenUrl = buildProxyUrl(proxyBase, SESSION_ENDPOINT_PATH);
  const body = {
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    installId
  };
  if (options.idToken) {
    body.idToken = options.idToken;
  } else if (options.code) {
    body.code = options.code;
  } else if (licenseKey) {
    body.licenseKey = licenseKey;
  } else if (deviceToken) {
    body.deviceToken = deviceToken;
  } else {
    // No auth available - try to trigger Google login automatically
    console.log('[RC] No auth method available, attempting auto Google login...');
    const googleClientId = settings?.googleClientId;
    if (googleClientId) {
      const redirectUri = chrome.identity.getRedirectURL('provider_cb');
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', googleClientId);
      authUrl.searchParams.set('response_type', 'id_token');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'email profile openid');
      authUrl.searchParams.set('nonce', Math.random().toString(36).substring(2));
      authUrl.searchParams.set('prompt', 'select_account');

      const responseUrl = await launchAuthFlow(authUrl.toString());
      if (!responseUrl) {
        throw new Error('Logowanie anulowane.');
      }
      const urlObj = new URL(responseUrl);
      const params = new URLSearchParams(urlObj.hash.substring(1));
      const autoIdToken = params.get('id_token');
      if (!autoIdToken) {
        throw new Error('Brak id_token w odpowiedzi Google.');
      }
      body.idToken = autoIdToken;
      console.log('[RC] Auto Google login successful, proceeding with idToken');
    } else {
      const authErr = new Error('Sign-in required. Please configure Google Client ID or license key.');
      authErr.code = AUTH_REQUIRED_CODE;
      throw authErr;
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    'X-Extension-Id': chrome.runtime.id
  };
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    mode: 'cors',
    cache: 'no-store',
    credentials: 'omit'
  });
  const raw = await resp.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(resp.ok ? 'Proxy zwrocilo niepoprawny JSON podczas autoryzacji.' : `Proxy auth HTTP ${resp.status}`);
  }
  if (!resp.ok) {
    const errorText = parsed && (parsed.error || parsed.message) ? (parsed.error || parsed.message) : resp.statusText;
    throw new Error(errorText || 'Nie udalo sie pobrac sesji z proxy.');
  }
  const token = (parsed.token || parsed.jwt || '').trim();
  if (!token) throw new Error('Proxy nie zwrocilo tokenu JWT.');
  const expiresAt = resolveSessionExpiry(parsed);
  const normalizedQuota = normalizeQuota(parsed.quota, settings?.upgradeUrl);
  if (normalizedQuota) updateQuotaState(normalizedQuota);
  if (parsed.deviceToken) {
    await storeDeviceToken(parsed.deviceToken);
  }
  if (parsed.profile) {
    await storeAccountProfile({
      email: (parsed.profile.email || '').toString(),
      sub: (parsed.profile.sub || '').toString(),
      name: (parsed.profile.name || '').toString(),
      updatedAt: new Date().toISOString()
    });
  }
  const session = { token, proxyBase, expiresAt, quota: normalizedQuota };
  await storeSession(session);
  return session;
}

async function ensureSessionToken(settings, options = {}) {
  const cached = await getCachedSession();
  if (isSessionValid(cached, settings.proxyBase)) {
    if (cached.quota) updateQuotaState(cached.quota);
    return cached.token;
  }
  const session = await fetchSessionToken(settings, options);
  return session.token;
}
function proxyErrorText(j) {
  if (j && j.error && (j.error.message || j.error.status)) return (j.error.message || j.error.status);
  return null;
}

function sendLogEvent(proxySettings, token, level, message, context) {
  if (!proxySettings?.proxyBase || !token || !message) return;
  try {
    const payload = {
      level: level || 'info',
      message,
      context: context || {},
      timestamp: new Date().toISOString()
    };
    fetch(buildProxyUrl(proxySettings.proxyBase, LOG_ENDPOINT_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Extension-Id': chrome.runtime.id
      },
      body: JSON.stringify(payload),
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit'
    }).catch(() => { });
  } catch (_) { }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'GET_QUOTA_STATUS') {
      sendResponse({ quota: getQuotaState() });
      return;
    }
    if (msg.type === 'GET_AUTH_STATUS') {
      const profile = await getStoredAccountProfile();
      sendResponse({ profile });
      return;
    }
    if (msg.type === 'START_GOOGLE_LOGIN') {
      try {
        const proxySettings = await getProxySettings();
        const clientId = proxySettings.googleClientId;
        if (!clientId) {
          sendResponse({ error: 'Brak Google Client ID w konfiguracji.' });
          return;
        }
        const redirectUri = chrome.identity.getRedirectURL('provider_cb');
        console.log('[RC] OAuth Redirect URI (add this to Google Cloud Console):', redirectUri);
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('response_type', 'id_token');
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', 'email profile openid');
        authUrl.searchParams.set('nonce', Math.random().toString(36).substring(2));
        authUrl.searchParams.set('prompt', 'select_account');

        const responseUrl = await launchAuthFlow(authUrl.toString());
        if (!responseUrl) {
          sendResponse({ error: 'Logowanie anulowane.' });
          return;
        }
        const urlObj = new URL(responseUrl);
        const params = new URLSearchParams(urlObj.hash.substring(1)); // id_token is in hash
        const idToken = params.get('id_token');
        if (!idToken) {
          // Sometimes it might come in search query if response_type=code, but for id_token it is usually hash
          const queryParams = urlObj.searchParams;
          if (queryParams.get('id_token')) {
            await clearStoredSession();
            await fetchSessionToken(proxySettings, { idToken: queryParams.get('id_token') });
            const profile = await getStoredAccountProfile();
            sendResponse({ ok: true, profile });
            return;
          }
          sendResponse({ error: 'Brak id_token w odpowiedzi Google.' });
          return;
        }
        await clearStoredSession();
        await fetchSessionToken(proxySettings, { idToken });
        const profile = await getStoredAccountProfile();
        sendResponse({ ok: true, profile });
      } catch (err) {
        console.error('[RC] Google login failed', err);
        sendResponse({ error: err.message || 'Blad logowania Google.' });
      }
      return;
    }
    if (msg.type === 'OPEN_UPGRADE_PAGE') {
      (async () => {
        try {
          const proxySettings = await getProxySettings();
          let upgradeUrl = proxySettings.upgradeUrl;
          console.log('[RC] OPEN_UPGRADE_PAGE - upgradeUrl:', upgradeUrl); // DEBUG

          if (!upgradeUrl) {
            sendResponse({ error: 'Brak Upgrade URL w konfiguracji.' });
            return;
          }

          // Check if user is logged in with Google (has account profile)
          const accountProfile = await getStoredAccountProfile();
          console.log('[RC] OPEN_UPGRADE_PAGE - accountProfile:', accountProfile); // DEBUG

          if (!accountProfile || !accountProfile.email) {
            // User not logged in with Google - trigger Google login first
            console.log('[RC] OPEN_UPGRADE_PAGE - No Google account, triggering login first'); // DEBUG

            const clientId = proxySettings.googleClientId;
            if (!clientId) {
              sendResponse({ error: 'Brak Google Client ID w konfiguracji.' });
              return;
            }
            const redirectUri = chrome.identity.getRedirectURL('provider_cb');
            const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            authUrl.searchParams.set('client_id', clientId);
            authUrl.searchParams.set('response_type', 'id_token');
            authUrl.searchParams.set('redirect_uri', redirectUri);
            authUrl.searchParams.set('scope', 'email profile openid');
            authUrl.searchParams.set('nonce', Math.random().toString(36).substring(2));
            authUrl.searchParams.set('prompt', 'select_account');

            try {
              const responseUrl = await launchAuthFlow(authUrl.toString());
              if (!responseUrl) {
                sendResponse({ error: 'Logowanie anulowane.' });
                return;
              }
              const urlObj = new URL(responseUrl);
              const params = new URLSearchParams(urlObj.hash.substring(1));
              const idToken = params.get('id_token');
              if (!idToken) {
                sendResponse({ error: 'Brak id_token w odpowiedzi Google.' });
                return;
              }
              await clearStoredSession();
              await fetchSessionToken(proxySettings, { idToken });
              console.log('[RC] OPEN_UPGRADE_PAGE - Google login successful, now getting session'); // DEBUG
            } catch (loginErr) {
              console.error('[RC] OPEN_UPGRADE_PAGE - Google login failed:', loginErr);
              sendResponse({ error: loginErr.message || 'Blad logowania Google.' });
              return;
            }
          }

          // Now get the session (should be user-based after Google login)
          const session = await getCachedSession();
          console.log('[RC] OPEN_UPGRADE_PAGE - session after login check:', session); // DEBUG

          const sessionValid = isSessionValid(session, proxySettings.proxyBase);
          console.log('[RC] OPEN_UPGRADE_PAGE - isSessionValid:', sessionValid, 'hasToken:', !!session?.token); // DEBUG
          if (sessionValid && session.token) {
            const separator = upgradeUrl.includes('#') ? '&' : '#';
            upgradeUrl += `${separator}accessToken=${encodeURIComponent(session.token)}`;
            console.log('[RC] OPEN_UPGRADE_PAGE - final URL with token:', upgradeUrl); // DEBUG
          } else {
            console.warn('[RC] OPEN_UPGRADE_PAGE - No valid session, opening URL without token'); // DEBUG
          }

          chrome.tabs.create({ url: upgradeUrl });
          sendResponse({ ok: true });
        } catch (err) {
          console.error('[RC] OPEN_UPGRADE_PAGE error:', err); // DEBUG
          sendResponse({ error: err.message || 'Error opening upgrade page' });
        }
      })();
      return true; // async response
    }
    if (msg.type === 'START_MAGIC_LINK') {
      const email = (msg.email || '').toString().trim();
      if (!email) {
        sendResponse({ error: 'Email is required.' });
        return;
      }
      try {
        const proxySettings = await getProxySettings();
        const installId = await ensureInstallId();
        const redirectUri = chrome.identity.getRedirectURL('magic-link');
        const requestBody = {
          email,
          installId,
          extensionId: chrome.runtime.id,
          redirectUri
        };
        const resp = await fetch(buildProxyUrl(proxySettings.proxyBase, MAGIC_LINK_ENDPOINT_PATH), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          mode: 'cors',
          cache: 'no-store',
          credentials: 'omit'
        });
        const raw = await resp.text();
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = {}; }
        if (!resp.ok) {
          const message = parsed.error || parsed.message || resp.statusText || 'Magic link request failed.';
          sendResponse({ error: message });
          return;
        }
        if (parsed.magicLink) {
          const redirectUrl = await launchAuthFlow(parsed.magicLink);
          const urlObj = new URL(redirectUrl);
          const code = urlObj.searchParams.get('code');
          if (!code) {
            sendResponse({ error: 'Missing auth code in redirect.' });
            return;
          }
          await clearStoredSession();
          await fetchSessionToken(proxySettings, { code });
          const profile = await getStoredAccountProfile();
          sendResponse({ ok: true, profile });
          return;
        }
        sendResponse({ ok: true, pending: true, emailSent: parsed.emailSent === true });
      } catch (err) {
        const message = err && err.message ? err.message : 'Magic link failed.';
        sendResponse({ error: message });
      }
      return;
    }
    if (msg.type === 'COMPLETE_MAGIC_LINK') {
      const code = (msg.code || '').toString().trim();
      if (!code) {
        sendResponse({ error: 'Code is required.' });
        return;
      }
      try {
        const proxySettings = await getProxySettings();
        await clearStoredSession();
        await fetchSessionToken(proxySettings, { code });
        const profile = await getStoredAccountProfile();
        sendResponse({ ok: true, profile });
      } catch (err) {
        const message = err && err.message ? err.message : 'Could not complete sign-in.';
        sendResponse({ error: message });
      }
      return;
    }
    if (msg.type === 'LOGOUT') {
      await logoutAccount();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'GENERATE_ALL') {
      const payload = (msg && typeof msg === 'object' && msg.payload && typeof msg.payload === 'object') ? msg.payload : null;
      if (!payload) {
        console.warn('[RC] GENERATE_ALL message missing payload.');
        sendResponse({ error: 'Brak danych opinii do wygenerowania.' });
        return;
      }
      const proxySettings = await getProxySettings();
      if (!proxySettings.proxyBase) { sendResponse({ error: 'Brak Proxy URL. Uzupelnij plik config.json.' }); return; }
      let sessionToken = '';
      try {
        sessionToken = await ensureSessionToken(proxySettings, { interactive: true });
      } catch (err) {
        console.error('[RC] Nie udalo sie pobrac tokenu proxy', err);
        const message = err && err.message ? err.message : 'Nie udalo sie pobrac tokenu proxy.';
        sendResponse({ error: message, errorCode: err && err.code ? err.code : undefined });
        return;
      }
      const ratingRaw = payload.rating == null ? '?' : payload.rating;
      const rating = (typeof ratingRaw === 'string' ? ratingRaw : String(ratingRaw)).trim() || '?';
      const reviewText = (payload.text == null ? '' : String(payload.text)).trim();
      console.log('[RC] Worker payload:', { rating, textLength: reviewText.length, sample: reviewText.slice(0, 140) });
      const ratingNumber = parseFloat(rating);
      let toneHint = 'neutralny i uprzejmy';
      let sentimentGuideline = 'Brak oceny: zachowaj neutralnosc i zaproponuj pomoc, jesli klient opisuje problem.';
      if (!Number.isNaN(ratingNumber)) {
        if (ratingNumber <= 2) {
          toneHint = 'empatyczny i spokojny, zachecajacy do kontaktu przez profil';
          sentimentGuideline = 'Klient jest niezadowolony: przepros, uznaj problem i zaproponuj dalszy kontakt przez profil firmy.';
        } else if (ratingNumber <= 3.5) {
          toneHint = 'rzeczowy i uprzejmy'; 0
          sentimentGuideline = 'Klient ma mieszane odczucia: podziekuj, odnie sie do uwag i zapewnij o wsparciu.';
        } else {
          toneHint = 'serdeczny, wdzieczny i krotki';
          sentimentGuideline = 'Klient jest zadowolony: podziekuj, podkresl docenione elementy i zapros do ponownej wizyty.';
        }
      }
      const ratingInfo = (rating && rating !== '?') ? 'Ocena klienta: ' + rating + '/5.' : 'Ocena klienta: brak danych.';
      const systemPrompt = [
        'Jestes asystentem firmy, ktory odpowiada na opinie klientow w Google. Jezyk: polski.',
        'Nie podawaj adresow e-mail ani numerow telefonow. Gdy trzeba, zapros do kontaktu przez informacje na profilu firmy.',
        'Unikaj frazy "Pan/Pani". Jezeli imie recenzenta jednoznacznie wskazuje plec, uzyj poprawnej formy w wolaczu (np. "Pani Katarzyno", "Panie Piotrze"); w przeciwnym razie zastosuj neutralne powitanie (np. "Dzien dobry").',
        'Kazda odpowiedz musi nawiazywac do konkretnego elementu opinii (cytat lub krotka parafraza) i adekwatnie reagowac na emocje autora.',
        'Dostosuj ogolny ton (wg oceny): ' + toneHint + '.',
        'Dlugosc kazdego wariantu: 2-4 zdania.'
      ].join('\n');
      const userPrompt = [
        ratingInfo,
        'Tresc opinii:',
        reviewText,
        'Wygeneruj poprawny JSON: {"soft":"...","brief":"...","proactive":"..."}. Zwroc tylko JSON bez dodatkowych komentarzy.',
        'soft: bardzo serdeczny, wdzieczny i uspokajajacy; podkresl wdziecznosc i okaz empatie.',
        'brief: rzeczowy i konkretny, maksymalnie dwa zdania, bez marketingowych ozdobnikow.',
        'proactive: proaktywny i konkretny, zaproponuj kolejny krok lub kontakt poprzez profil firmy i podaj powod.',
        'Kazdy wariant ma uzywac innego slowictwa i konstrukcji zdan, zachowujac zgodnosc z typem.',
        sentimentGuideline,
        'Jesli klient sygnalizuje problem, w kazdym wariancie zaproponuj pomoc lub dzialanie naprawcze.',
        'Oddaj tylko JSON.'
      ].join('\n');
      const promptPayload = systemPrompt + '\n\n' + userPrompt;
      console.log('[RC] Proxy request meta:', {
        proxy: proxySettings.proxyBase,
        promptLength: promptPayload.length,
        promptPreview: truncateForLog(promptPayload)
      });
      const url = buildProxyUrl(proxySettings.proxyBase, GENERATE_ENDPOINT_PATH);
      const body = {
        model: DEFAULT_MODEL,
        contents: [{ role: 'user', parts: [{ text: promptPayload }] }]
      };
      const baseHeaders = {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id
      };
      const requestBody = JSON.stringify(body);
      const requestInitBase = {
        method: 'POST',
        body: requestBody,
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit'
      };
      sendLogEvent(proxySettings, sessionToken, 'info', 'generate_start', { rating, textLength: reviewText.length });
      let attempt = 0;
      try {
        while (attempt < 2) {
          const headers = {
            ...baseHeaders,
            'Authorization': `Bearer ${sessionToken}`
          };
          const resp = await fetch(url, { ...requestInitBase, headers });
          if (resp.status === 401 && attempt === 0) {
            attempt++;
            console.warn('[RC] JWT rejected by proxy, refreshing session.');
            const refreshedSession = await fetchSessionToken(proxySettings, { interactive: false });
            sessionToken = refreshedSession.token;
            continue;
          }
          const quotaFromResp = quotaFromHeaders(resp, proxySettings.upgradeUrl);
          const raw = await resp.text();
          let j = null;
          try {
            j = raw ? JSON.parse(raw) : {};
          } catch (_) {
            if (!resp.ok) {
              sendResponse({ error: `Blad proxy (${resp.status})`, quota: quotaFromResp });
              if (quotaFromResp) updateQuotaState(quotaFromResp);
              return;
            }
            sendResponse({ error: 'Niepoprawna odpowiedz proxy.', quota: quotaFromResp });
            if (quotaFromResp) updateQuotaState(quotaFromResp);
            return;
          }
          if (!resp.ok) {
            const proxyErr = proxyErrorText(j) || j.error || resp.statusText || 'Blad proxy.';
            const enriched = quotaFromResp || normalizeQuota(j?.quota, proxySettings.upgradeUrl);
            if (enriched) updateQuotaState(enriched);
            sendResponse({ error: proxyErr, errorCode: j?.code, freeLimit: j?.limit, upgradeUrl: j?.upgradeUrl || proxySettings.upgradeUrl, quota: enriched });
            const remainingForLog = quotaRemainingValue(enriched);
            sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_rejected', { error: proxyErr, code: j?.code, remaining: remainingForLog, quotaType: enriched?.type });
            return;
          }
          const err = proxyErrorText(j);
          if (err) {
            if (quotaFromResp) updateQuotaState(quotaFromResp);
            const logRemaining = quotaRemainingValue(quotaFromResp);
            sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_error', { error: err, remaining: logRemaining, quotaType: quotaFromResp?.type });
            sendResponse({ error: err, quota: quotaFromResp });
            return;
          }
          const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts)
            ? j.candidates[0].content.parts.map(p => p.text || '').join('\n')
            : '';
          let soft = '', brief = '', proactive = '';
          try {
            const m = text.match(/\{[\s\S]*\}/);
            const jsonText = m ? m[0] : text;
            const obj = JSON.parse(jsonText);
            soft = (obj.soft || '').trim();
            brief = (obj.brief || '').trim();
            proactive = (obj.proactive || '').trim();
          } catch (_) {
            const parts = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
            soft = parts[0] || '';
            brief = parts[1] || '';
            proactive = parts[2] || '';
          }
          if (quotaFromResp) updateQuotaState(quotaFromResp);
          const logRemaining = quotaRemainingValue(quotaFromResp);
          const logLimit = quotaLimitValue(quotaFromResp);
          sendLogEvent(proxySettings, sessionToken, 'info', 'generate_success', { rating, remaining: logRemaining, limit: logLimit, quotaType: quotaFromResp?.type });
          sendResponse({ soft, brief, proactive, _prompt: promptPayload, quota: quotaFromResp });
          return;
        }
      } catch (e) {
        sendLogEvent(proxySettings, sessionToken, 'error', 'generate_exception', { error: String(e), rating });
        sendResponse({ error: String(e) });
      }
      return;
    }
  })();
  return true;
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeBase, loadConfigFile };
}
