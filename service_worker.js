const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const SESSION_ENDPOINT_PATH = '/api/extension/session';
const EXTENSION_UPGRADE_ENDPOINT_PATH = '/api/extension/account/upgrade';
const MAGIC_LINK_ENDPOINT_PATH = '/api/auth/magic-link';
const GENERATE_ENDPOINT_PATH = '/gemini/generate';
const LOG_ENDPOINT_PATH = '/api/extension/log';
const TOKEN_EXPIRY_GUARD_MS = 10 * 1000; // keep 10s safety window
const GENERATE_REQUEST_TIMEOUT_MS = 18 * 1000;
const GENERATE_TIMEOUT_MESSAGE = 'Usluga generowania odpowiada zbyt wolno. Sprobuj ponownie.';
const MAX_REVIEW_TEXT_CHARS = 1500;
const MAX_PLACE_TYPE_CHARS = 80;
const MAX_PLACE_NAME_CHARS = 120;
const DEFAULT_GENERATION_CONFIG = {
  candidateCount: 1,
  temperature: 0.5,
  maxOutputTokens: 320
};
const INSTALL_ID_KEY = 'rcInstallId';
const DEVICE_TOKEN_KEY = 'rcDeviceToken';
const ACCOUNT_PROFILE_KEY = 'rcAccountProfile';
const CONFIG_FILE = 'config.json';
const MAPS_TAB_URLS = ['https://*.google.com/maps/*', 'https://*.google.pl/maps/*'];

const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';
const AUTH_REQUIRED_MESSAGE = 'Wymagane logowanie. Otworz opcje rozszerzenia i zaloguj sie przez Google.';
const GOOGLE_LOGIN_REQUIRED_CODE = 'GOOGLE_LOGIN_REQUIRED';
const LOGIN_CANCELLED_CODE = 'LOGIN_CANCELLED';
const AUTH_STATUS_CHANGED_MESSAGE = 'AUTH_STATUS_CHANGED';
const FRIENDLY_RETRY_MESSAGE = 'Sprobuj ponownie pozniej.';
const FRIENDLY_UPGRADE_MESSAGE = 'Nie udalo sie otworzyc platnosci. Sprobuj ponownie pozniej.';
const FRIENDLY_OVERLOAD_MESSAGE = 'Serwer jest obecnie obciazony. Sprobuj ponownie za chwile.';
const OVERLOAD_RETRY_DELAY_MS = 1200;
const EXPECTED_USER_STATE_CODES = new Set([
  AUTH_REQUIRED_CODE,
  GOOGLE_LOGIN_REQUIRED_CODE,
  LOGIN_CANCELLED_CODE,
  'FREE_LIMIT_REACHED',
  'SUBSCRIPTION_REQUIRED'
]);

let staticConfigPromise = null;
let quotaState = null;

function truncateReviewText(value, maxLen = MAX_REVIEW_TEXT_CHARS) {
  const str = (value || '').toString().trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).trimEnd() + '...';
}

function truncateContextField(value, maxLen) {
  const str = (value || '').toString().replace(/\s+/g, ' ').trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).trimEnd();
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
      try {
        const cfg = await loadConfigFile(CONFIG_FILE);
        console.info('[RC] Loaded proxy config from', CONFIG_FILE);
        return cfg;
      } catch (err) {
        console.warn('[RC] Config file skipped', { file: CONFIG_FILE, error: String(err) });
        return null;
      }
    })();
  }
  return staticConfigPromise;
}

async function getProxySettings() {
  const cfg = await loadStaticConfig();
  if (cfg && cfg.proxyBase) {
    return cfg;
  }
  throw new Error('Brak config.json. Zbuduj rozszerzenie przed uruchomieniem.');
}

function buildProxyUrl(base, path) {
  if (!base) return '';
  const suffix = path || '';
  return base + suffix;
}

async function fetchWithTimeout(url, init, timeoutMs, timeoutMessage) {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort(new Error(timeoutMessage || 'Request timed out.'));
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...(init || {}),
      signal: controller.signal
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || String(err).includes('AbortError'))) {
      throw new Error(timeoutMessage || 'Request timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timerId);
  }
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
  const expiresAt = raw.expiresAt ? new Date(raw.expiresAt).toISOString() : null;
  return {
    type: 'usage',
    limit: Math.max(0, Math.floor(limit)),
    remaining,
    limitSeconds: null,
    remainingSeconds: null,
    expiresAt,
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
  const expiresAtHeader = resp.headers.get('x-free-expires-at');
  const expiresAt = expiresAtHeader ? new Date(expiresAtHeader).toISOString() : null;
  return {
    type: 'usage',
    limit: Math.max(0, Math.floor(limit)),
    remaining,
    limitSeconds: null,
    remainingSeconds: null,
    expiresAt,
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

function buildStoredProfile(rawProfile, parsed) {
  if (!rawProfile || typeof rawProfile !== 'object') return null;
  const license = parsed && parsed.license && typeof parsed.license === 'object' ? parsed.license : {};
  return {
    email: (rawProfile.email || '').toString(),
    sub: (rawProfile.sub || '').toString(),
    name: (rawProfile.name || '').toString(),
    plan: (rawProfile.plan || parsed?.plan || '').toString(),
    licenseId: (rawProfile.licenseId || license.id || '').toString(),
    updatedAt: new Date().toISOString()
  };
}

async function getAuthStatusPayload(options = {}) {
  const refresh = options.refresh !== false;
  let profile = await getStoredAccountProfile();
  let quota = getQuotaState();
  const cached = await getCachedSession();
  if (!quota && cached?.quota) {
    quota = cached.quota;
    updateQuotaState(quota);
  }

  const deviceToken = refresh ? await getStoredDeviceToken() : '';
  if (refresh && profile && !cached?.token && !deviceToken) {
    await clearAccountProfile();
    updateQuotaState(null);
    profile = null;
    quota = null;
  }

  if (refresh && (cached?.token || deviceToken)) {
    try {
      const proxySettings = await getProxySettings();
      await ensureSessionToken(proxySettings, { interactive: false });
      profile = await getStoredAccountProfile();
      quota = getQuotaState();
      const refreshed = await getCachedSession();
      if (!quota && refreshed?.quota) {
        quota = refreshed.quota;
        updateQuotaState(quota);
      }
    } catch (err) {
      if (isExpectedUserStateError(err)) {
        await logoutAccount();
        profile = null;
        quota = null;
      } else {
        console.warn('[RC] Nie udalo sie odswiezyc statusu konta', err);
      }
    }
  }

  return { profile: profile || null, quota: quota || null };
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
        reject(createErrorWithCode(message, isLoginCancelledMessage(message) ? LOGIN_CANCELLED_CODE : undefined));
        return;
      }
      resolve(redirectUri);
    });
  });
}

function isInvalidDeviceTokenError(err) {
  const message = err && err.message ? String(err.message) : '';
  return message.toLowerCase().includes('invalid device token');
}

async function requestGoogleIdToken(proxySettings) {
  const clientId = (proxySettings?.googleClientId || '').toString().trim();
  if (!clientId) {
    throw new Error('Brak Google Client ID w konfiguracji.');
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
    throw createErrorWithCode('Logowanie anulowane.', LOGIN_CANCELLED_CODE);
  }
  const urlObj = new URL(responseUrl);
  const hashParams = new URLSearchParams(urlObj.hash.substring(1));
  const authError = hashParams.get('error') || urlObj.searchParams.get('error');
  if (authError) {
    throw createErrorWithCode(authError, isLoginCancelledMessage(authError) ? LOGIN_CANCELLED_CODE : undefined);
  }
  const hashToken = hashParams.get('id_token');
  if (hashToken) {
    return hashToken;
  }
  const queryToken = urlObj.searchParams.get('id_token');
  if (queryToken) {
    return queryToken;
  }
  throw new Error('Brak id_token w odpowiedzi Google.');
}

async function clearStoredSession() {
  const storageArea = getProxySessionStorage();
  await storageArea.remove(['proxySession']);
}

async function logoutAccount() {
  await clearStoredDeviceToken();
  await clearAccountProfile();
  await clearStoredSession();
  updateQuotaState(null);
}

async function broadcastAuthStatusChanged(reason) {
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function' || typeof chrome.tabs.sendMessage !== 'function') {
    return;
  }
  let status = { profile: null, quota: null };
  try {
    status = await getAuthStatusPayload();
  } catch (err) {
    console.warn('[RC] Nie udalo sie pobrac statusu auth do powiadomienia kart.', err);
  }
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: MAPS_TAB_URLS });
  } catch (err) {
    console.warn('[RC] Nie udalo sie znalezc kart do powiadomienia o auth.', err);
    return;
  }
  const message = {
    type: AUTH_STATUS_CHANGED_MESSAGE,
    reason: reason || '',
    profile: status.profile || null,
    quota: status.quota || null
  };
  await Promise.allSettled((tabs || [])
    .filter(tab => tab && Number.isFinite(tab.id))
    .map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
}

function createAuthRequiredError(message = AUTH_REQUIRED_MESSAGE) {
  const err = new Error(message);
  err.code = AUTH_REQUIRED_CODE;
  return err;
}

function createErrorWithCode(message, code) {
  const err = new Error(message || FRIENDLY_RETRY_MESSAGE);
  if (code) err.code = code;
  return err;
}

function errorCodeFrom(err) {
  return (err && err.code ? String(err.code) : '').toUpperCase();
}

function isLoginCancelledMessage(message) {
  const normalized = (message || '').toString().trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('logowanie anulowane')
    || normalized.includes('user did not approve')
    || normalized.includes('access_denied')
    || normalized.includes('cancelled')
    || normalized.includes('canceled')
    || normalized.includes('cancel');
}

function isExpectedUserStateError(err) {
  const code = errorCodeFrom(err);
  if (code && EXPECTED_USER_STATE_CODES.has(code)) return true;

  const message = (err && err.message ? err.message : err || '').toString().toLowerCase();
  return isLoginCancelledMessage(message)
    || message.includes('auth_required')
    || message.includes('google_login_required')
    || message.includes('wymagane logowanie')
    || message.includes('zaloguj sie kontem google')
    || message.includes('zaloguj się kontem google')
    || message.includes('sesja wygasla')
    || message.includes('sesja wygasła');
}

function logUnexpectedError(label, err) {
  if (!isExpectedUserStateError(err)) {
    console.error(label, err);
  }
}

function sanitizeUserFacingError(message, fallback = FRIENDLY_RETRY_MESSAGE) {
  const text = (message || '').toString().trim();
  if (!text) return fallback;

  const normalized = text.toLowerCase();
  if (isLoginCancelledMessage(text)) {
    return 'Logowanie anulowane.';
  }
  if (normalized.includes('failed to fetch') || normalized.includes('networkerror') || normalized.includes('load failed')) {
    return fallback;
  }
  if (isOverloadMessage(text)) {
    return FRIENDLY_OVERLOAD_MESSAGE;
  }
  if (normalized.includes('auth_required') || normalized.includes('wymagane logowanie') || normalized.includes('sesja wygasla')) {
    return 'Sesja wygasla. Zaloguj sie ponownie w rozszerzeniu.';
  }
  if (normalized.includes('google_login_required') || normalized.includes('zaloguj sie kontem google')) {
    return 'Aby kupic abonament, zaloguj sie kontem Google w rozszerzeniu.';
  }
  return text;
}

function isOverloadMessage(message) {
  const normalized = (message || '').toString().trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('currently experiencing high demand')
    || normalized.includes('spikes in demand are usually temporary')
    || normalized.includes('resource_exhausted')
    || normalized.includes('resource exhausted')
    || normalized.includes('too many requests');
}

async function waitMs(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
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
    throw createAuthRequiredError();
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
    const err = new Error(errorText || 'Nie udalo sie pobrac sesji z proxy.');
    if (parsed && parsed.code) {
      err.code = parsed.code;
    }
    throw err;
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
    await storeAccountProfile(buildStoredProfile(parsed.profile, parsed));
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
  let session;
  try {
    session = await fetchSessionToken(settings, options);
  } catch (err) {
    if (!isInvalidDeviceTokenError(err)) {
      throw err;
    }

    await clearStoredDeviceToken();
    await clearStoredSession();

    const canRetryWithGoogle = options.interactive === true
      && !options.idToken
      && !options.code
      && !(settings?.licenseKey || '').toString().trim();

    if (!canRetryWithGoogle) {
      throw createAuthRequiredError('Sesja wygasla. Zaloguj sie ponownie.');
    }

    const idToken = await requestGoogleIdToken(settings);
    session = await fetchSessionToken(settings, { idToken });
  }
  return session.token;
}
function proxyErrorText(j) {
  if (j && j.error && (j.error.message || j.error.status)) return (j.error.message || j.error.status);
  return null;
}

async function openUpgradeCheckout(proxySettings) {
  let sessionToken = await ensureSessionToken(proxySettings, { interactive: false });
  let attempt = 0;

  while (attempt < 2) {
    const resp = await fetch(buildProxyUrl(proxySettings.proxyBase, EXTENSION_UPGRADE_ENDPOINT_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'X-Extension-Id': chrome.runtime.id
      },
      body: JSON.stringify({ plan_id: 'pro_monthly' }),
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit'
    });

    const raw = await resp.text();
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (_) {
      parsed = {};
    }

    if (resp.status === 401 && attempt === 0) {
      attempt += 1;
      const refreshed = await fetchSessionToken(proxySettings, { interactive: false });
      sessionToken = refreshed.token;
      continue;
    }

    if (!resp.ok) {
      const message = parsed.message || parsed.error || resp.statusText || FRIENDLY_UPGRADE_MESSAGE;
      throw createErrorWithCode(message, parsed.code);
    }

    const checkoutUrl = (parsed.checkout_url || '').toString().trim();
    if (!checkoutUrl) {
      throw createErrorWithCode(FRIENDLY_UPGRADE_MESSAGE);
    }
    return checkoutUrl;
  }

  throw createErrorWithCode('Sesja wygasla. Zaloguj sie ponownie w rozszerzeniu.', AUTH_REQUIRED_CODE);
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

function openExtensionOptionsPage() {
  if (typeof chrome.runtime.openOptionsPage === 'function') {
    return chrome.runtime.openOptionsPage();
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  return Promise.resolve();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'GET_QUOTA_STATUS') {
      sendResponse({ quota: getQuotaState() });
      return;
    }
    if (msg.type === 'GET_AUTH_STATUS') {
      const status = await getAuthStatusPayload();
      sendResponse(status);
      return;
    }
    if (msg.type === 'OPEN_LOGIN_PAGE' || msg.type === 'OPEN_OPTIONS_PAGE') {
      try {
        await openExtensionOptionsPage();
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[RC] Open options page error:', err);
        sendResponse({ error: 'Nie udalo sie otworzyc opcji. Otworz opcje rozszerzenia recznie.' });
      }
      return;
    }
    if (msg.type === 'START_GOOGLE_LOGIN') {
      try {
        const proxySettings = await getProxySettings();
        const idToken = await requestGoogleIdToken(proxySettings);
        await clearStoredDeviceToken();
        await clearStoredSession();
        const session = await fetchSessionToken(proxySettings, { idToken });
        const profile = await getStoredAccountProfile();
        await broadcastAuthStatusChanged('login');
        sendResponse({ ok: true, profile, quota: session.quota || getQuotaState() });
      } catch (err) {
        logUnexpectedError('[RC] Google login failed', err);
        sendResponse({ error: sanitizeUserFacingError(err && err.message, 'Blad logowania Google.') });
      }
      return;
    }
    if (msg.type === 'OPEN_UPGRADE_PAGE') {
      (async () => {
        try {
          const proxySettings = await getProxySettings();
          const checkoutUrl = await openUpgradeCheckout(proxySettings);
          chrome.tabs.create({ url: checkoutUrl });
          sendResponse({ ok: true, checkoutUrl });
        } catch (err) {
          logUnexpectedError('[RC] OPEN_UPGRADE_PAGE error:', err);
          sendResponse({
            error: sanitizeUserFacingError(err && err.message, FRIENDLY_UPGRADE_MESSAGE),
            code: err && err.code ? err.code : undefined
          });
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
          const session = await fetchSessionToken(proxySettings, { code });
          const profile = await getStoredAccountProfile();
          await broadcastAuthStatusChanged('login');
          sendResponse({ ok: true, profile, quota: session.quota || getQuotaState() });
          return;
        }
        sendResponse({ ok: true, pending: true, emailSent: parsed.emailSent === true });
      } catch (err) {
        const message = sanitizeUserFacingError(err && err.message, FRIENDLY_RETRY_MESSAGE);
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
        const session = await fetchSessionToken(proxySettings, { code });
        const profile = await getStoredAccountProfile();
        await broadcastAuthStatusChanged('login');
        sendResponse({ ok: true, profile, quota: session.quota || getQuotaState() });
      } catch (err) {
        const message = sanitizeUserFacingError(err && err.message, FRIENDLY_RETRY_MESSAGE);
        sendResponse({ error: message });
      }
      return;
    }
    if (msg.type === 'LOGOUT') {
      await logoutAccount();
      await broadcastAuthStatusChanged('logout');
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
      if (!proxySettings.proxyBase) { sendResponse({ error: 'Brak Proxy URL. Zbuduj rozszerzenie ponownie.' }); return; }
      let sessionToken = '';
      try {
        sessionToken = await ensureSessionToken(proxySettings, { interactive: true });
      } catch (err) {
        logUnexpectedError('[RC] Nie udalo sie pobrac tokenu proxy', err);
        const message = sanitizeUserFacingError(err && err.message, FRIENDLY_RETRY_MESSAGE);
        sendResponse({ error: message, errorCode: err && err.code ? err.code : undefined });
        return;
      }
      const ratingRaw = payload.rating == null ? '?' : payload.rating;
      const rating = (typeof ratingRaw === 'string' ? ratingRaw : String(ratingRaw)).trim() || '?';
      const reviewText = truncateReviewText(payload.text == null ? '' : String(payload.text));
      const placeType = truncateContextField(payload.placeType, MAX_PLACE_TYPE_CHARS);
      const placeName = truncateContextField(payload.placeName, MAX_PLACE_NAME_CHARS);
      console.log('[RC] Worker payload meta:', {
        rating,
        textLength: reviewText.length,
        placeType,
        hasPlaceName: !!placeName
      });
      const ratingNumber = parseFloat(rating);
      let toneHint = 'neutralny i uprzejmy';
      let sentimentGuideline = 'Brak oceny: zachowaj neutralność i zaproponuj pomoc, jeśli klient opisuje problem.';
      if (!Number.isNaN(ratingNumber)) {
        if (ratingNumber <= 2) {
          toneHint = 'empatyczny, spokojny i profesjonalny';
          sentimentGuideline = 'Klient jest niezadowolony: okaż zrozumienie, odnieś się do problemu i dobierz strategię odpowiedzi bez zakładania winy firmy.';
        } else if (ratingNumber <= 3.5) {
          toneHint = 'rzeczowy i uprzejmy';
          sentimentGuideline = 'Klient ma mieszane odczucia: podziękuj, odnieś się do uwag i zapewnij o wsparciu.';
        } else {
          toneHint = 'serdeczny, wdzięczny i krótki';
          sentimentGuideline = 'Klient jest zadowolony: podziękuj, podkreśl docenione elementy i zaproś do ponownej wizyty.';
        }
      }
      const ratingInfo = (rating && rating !== '?') ? 'Ocena klienta: ' + rating + '/5.' : 'Ocena klienta: brak danych.';
      const placeContextLines = [];
      if (placeType) placeContextLines.push('- Typ dzialalnosci miejsca: ' + placeType + '.');
      if (placeName) placeContextLines.push('- Nazwa firmy: "' + placeName + '". To nazwa wlasna firmy lub miejsca.');
      const placeContextBlock = placeContextLines.length
        ? 'Kontekst miejsca:\n' + placeContextLines.join('\n')
        : 'Kontekst miejsca:\n- Brak dodatkowych danych o miejscu.';
      const systemPrompt = `Jesteś asystentem firmy, który tworzy odpowiedzi na opinie klientów w Google. Język odpowiedzi: polski.

Zadanie:
Na podstawie opinii klienta wygeneruj 3 różne odpowiedzi w formacie JSON:
{"soft":"...","brief":"...","proactive":"..."}

Zasady ogólne:
- Pisz naturalnie, uprzejmie i po ludzku, jak odpowiedź publikowana w imieniu firmy lub miejsca.
- Używaj poprawnej polszczyzny i zawsze stosuj polskie znaki diakrytyczne (ą, ć, ę, ł, ń, ó, ś, ź, ż) w odpowiedziach.
- Każda odpowiedź musi być spersonalizowana i nawiązywać do konkretnego elementu opinii, najlepiej przez krótką parafrazę.
- Adekwatnie reaguj na emocje autora opinii.
- Nie pisz ogólników typu samo Dziękujemy za opinię, jeśli opinia zawiera konkretne treści.
- Nie wymyślaj faktów, działań ani ustaleń, których nie ma w danych wejściowych.
- Nie obiecuj rekompensaty, zwrotu pieniędzy, oddzwonienia ani konkretnych działań naprawczych, jeśli nie wynika to z danych.
- Nie podawaj adresów e-mail, numerów telefonów ani innych danych kontaktowych.
- Gdy trzeba zaprosić do dalszego kontaktu, użyj neutralnej formy, np.:
  Zapraszamy do kontaktu przez dane dostępne na profilu firmy.
- Nie używaj emoji.
- Unikaj przesadnej formalności, urzędowego stylu i marketingowych ozdobników.
- Jeśli płeć autora nie jest pewna, nigdy nie używaj żadnych form zastępczych typu Pani/Pan, Pan/Pani, Panią/Pana ani podobnych. W takiej sytuacji odpowiedź ma pozostać całkowicie neutralna i bezosobowa.

Zwracanie się do autora:
- Nie używaj samodzielnych form Pan/Pani.
- Nie używaj także form łączonych ani alternatywnych typu:
  Pani/Pan, Pan/Pani, Panią/Pana, Pana/Panią, Pani/Panu, Panu/Pani, Szanowny Kliencie ani żadnych podobnych konstrukcji zastępczych.
- Jeśli imię recenzenta jednoznacznie wskazuje płeć i brzmi naturalnie, możesz użyć formy, np.:
  Pani Katarzyno / Panie Piotrze.
- Jeśli płeć nie jest pewna, imię jest nickiem, inicjałem albo brzmi nienaturalnie, nie używaj imienia ani żadnego zwrotu odnoszącego się bezpośrednio do osoby.
- W takich przypadkach nie używaj też bezpośrednich form w stylu Ty, Tobie, Ci ani sformułowań wymagających określenia rodzaju.
- Zamiast tego stosuj wyłącznie naturalne, neutralne konstrukcje bezosobowe, np.:
  Dziękujemy za opinię,
  Dziękujemy za wizytę,
  Dziękujemy za podzielenie się uwagą,
  Cieszymy się, że wizyta była udana,
  Przykro nam, że wizyta nie spełniła oczekiwań,
  Będzie nam miło gościć ponownie,
  Zapraszamy ponownie.

Znaczenie wariantów:
- soft:
  najbardziej serdeczny, empatyczny i spokojny wariant; ma budować dobrą atmosferę, okazać wdzięczność albo zrozumienie i brzmieć ciepło, ale nadal naturalnie; przy problemie jego głównym zadaniem jest deeskalacja i okazanie zrozumienia.
- brief:
  najkrótszy i najbardziej konkretny wariant; maksymalnie 2 zdania; bez lania wody i bez marketingowego stylu; przy problemie ma krótko i rzeczowo odnieść się do sedna uwagi bez wchodzenia w spór, bez bronienia firmy i bez przyznawania winy.
- proactive:
  najbardziej zaangażowany i uważny wariant; ma pokazywać gotowość do dalszej rozmowy, doprecyzowania albo sprawdzenia tematu; przy problemie może zaprosić do kontaktu przez profil firmy, ale neutralnie i bez sugerowania, że firma na pewno popełniła błąd; przy pozytywnej opinii ma pozostać naturalny i nie może być nachalny.

Długość:
- soft: 2-4 zdania
- brief: maksymalnie 2 zdania
- proactive: 2-4 zdania`;
      const userPrompt = `Dopasowanie do oceny i wydźwięku opinii:
${ratingInfo}
${sentimentGuideline}
Dostosuj ogólny ton: ${toneHint}

Treść opinii:
${reviewText}

Wymagania dodatkowe:
- Każdy wariant ma używać innego słownictwa i innych konstrukcji zdań.
- Warianty nie mogą różnić się tylko pojedynczymi słowami ani samym tonem; mają różnić się także strategią odpowiedzi.
- Jeśli opinia zawiera problem, każdy wariant ma odnieść się do problemu, ale innym ruchem komunikacyjnym:
  soft ma przede wszystkim okazać zrozumienie i złagodzić napięcie,
  brief ma przede wszystkim odpowiedzieć krótko i rzeczowo,
  proactive ma przede wszystkim pokazać gotowość do dalszej rozmowy albo doprecyzowania.
- Każdy wariant może zakończyć się neutralnym zaproszeniem do kontaktu w razie pytań, ale zaproszenie do kontaktu nie może być jedyną treścią odpowiedzi.
- Jeśli opinia dotyczy ceny, wyceny, kosztu, warunków albo subiektywnej oceny typu za drogo, nie broń szczegółowej polityki firmy i nie wymyślaj jej; zachowaj neutralność.
- O ostrożnym, ogólnym sposobie wyceny lub zakresie usługi wspominaj tylko wtedy, gdy jasno wynika z opinii albo z kontekstu miejsca, że chodzi o usługę wycenianą indywidualnie.
- Jeśli opinia dotyczy jakości, obsługi, opóźnienia albo innego problemu w przebiegu usługi, uznaj uwagę i zachowaj empatię, ale nie stwierdzaj ani nie sugeruj, że wina na pewno leży po stronie firmy.
- Jeśli opinia jest pozytywna, podkreśl to, co klient docenił, i naturalnie zaproś ponownie.
- Jeśli opinia jest mieszana, odnotuj plusy i uwagi.
- Jeśli opinia nie zawiera konkretów, nie dopowiadaj szczegółów.
- Jeśli płeć autora nie jest pewna, odpowiedź musi pozostać neutralna i bezosobowa; nie używaj żadnych form typu Pan/Pani, Panią/Pana, Ty, Tobie, Ci ani żadnych sformułowań sugerujących płeć.

Zwróć tylko poprawny JSON bez dodatkowych komentarzy.`;
      const contextInstructionBlock = `Instrukcje dotyczace kontekstu miejsca:
- Jesli znasz typ dzialalnosci miejsca, wykorzystaj go do lepszego dopasowania slownictwa i kontekstu odpowiedzi.
- Jesli znasz nazwe firmy, traktuj ja wylacznie jako nazwe wlasna miejsca lub firmy. Uzywaj jej tylko wtedy, gdy brzmi to naturalnie i nie w kazdym wariancie.
- Nie zakladaj menu, oferty, procesu obslugi ani zakresu uslug wylacznie na podstawie typu dzialalnosci lub nazwy firmy.`;
      const promptRefinementBlock = `Priorytetowe doprecyzowania:
- Traktuj odpowiedz jako przygotowywana w imieniu firmy lub miejsca. Nie zakladaj struktury firmy, roli autora odpowiedzi ani tego, ze chodzi o restauracje, chyba ze wynika to z kontekstu miejsca albo z samej opinii.
- Jesli opinia jest krotka, ogolna albo malo konkretna, odpowiedz tez ma byc zwiezla i nie moze dopowiadac szczegolow branzy ani oferty.
- Jesli opinia jest negatywna albo mieszana, trzy warianty maja roznic sie nie tylko stylem, ale tez glownym ruchem odpowiedzi: soft lagodzi napiecie, brief odpowiada rzeczowo, proactive najmocniej otwiera rozmowe.
- Jesli uzywasz imienia recenzenta albo formy typu Panie Pawle / Pani Katarzyno, umiesc je wylacznie na samym poczatku odpowiedzi albo na poczatku pierwszego zdania. Nigdy w srodku ani na koncu odpowiedzi.
- Jesli nie da sie uzyc imienia naturalnie na poczatku, nie uzywaj imienia wcale.
- Wariant brief ma miec maksymalnie 2 zdania i maksymalnie 220 znakow.
- Zwroc tylko poprawny JSON bez markdown, backtickow, blokow kodu, komentarzy i bez zadnego tekstu przed albo po JSON.`;
      const promptPayload = `${systemPrompt}\n\n${contextInstructionBlock}\n\n${promptRefinementBlock}\n\n${placeContextBlock}\n\n${userPrompt}`;
      console.log('[RC] Proxy request meta:', {
        proxy: proxySettings.proxyBase,
        promptLength: promptPayload.length
      });
      const url = buildProxyUrl(proxySettings.proxyBase, GENERATE_ENDPOINT_PATH);
      const body = {
        model: DEFAULT_MODEL,
        contents: [{ role: 'user', parts: [{ text: promptPayload }] }],
        generationConfig: DEFAULT_GENERATION_CONFIG
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
      sendLogEvent(proxySettings, sessionToken, 'info', 'generate_start', {
        rating,
        textLength: reviewText.length,
        placeType,
        hasPlaceName: !!placeName
      });
      let attempt = 0;
      try {
        while (attempt < 2) {
          const headers = {
            ...baseHeaders,
            'Authorization': `Bearer ${sessionToken}`
          };
          const resp = await fetchWithTimeout(
            url,
            { ...requestInitBase, headers },
            GENERATE_REQUEST_TIMEOUT_MS,
            GENERATE_TIMEOUT_MESSAGE
          );
          if (resp.status === 401 && attempt === 0) {
            attempt++;
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
            const rawErrorText = proxyErrorText(j) || j.error || resp.statusText;
            const retryableOverload = (resp.status === 429 || isOverloadMessage(rawErrorText)) && attempt === 0;
            if (retryableOverload) {
              attempt++;
              sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_retry_overload', { status: resp.status });
              await waitMs(OVERLOAD_RETRY_DELAY_MS);
              continue;
            }
            const proxyErr = sanitizeUserFacingError(rawErrorText, FRIENDLY_RETRY_MESSAGE);
            const enriched = quotaFromResp || normalizeQuota(j?.quota, proxySettings.upgradeUrl);
            if (enriched) updateQuotaState(enriched);
            sendResponse({ error: proxyErr, errorCode: j?.code, freeLimit: j?.limit, upgradeUrl: j?.upgradeUrl || proxySettings.upgradeUrl, quota: enriched });
            const remainingForLog = quotaRemainingValue(enriched);
            sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_rejected', { error: proxyErr, code: j?.code, remaining: remainingForLog, quotaType: enriched?.type });
            return;
          }
          const rawProxyErr = proxyErrorText(j);
          const err = rawProxyErr ? sanitizeUserFacingError(rawProxyErr, FRIENDLY_RETRY_MESSAGE) : null;
          if (err) {
            if (attempt === 0 && isOverloadMessage(rawProxyErr)) {
              attempt++;
              sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_retry_overload', { status: resp.status });
              await waitMs(OVERLOAD_RETRY_DELAY_MS);
              continue;
            }
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
          sendResponse({ soft, brief, proactive, quota: quotaFromResp });
          return;
        }
      } catch (e) {
        const errorMessage = sanitizeUserFacingError(e && e.message ? e.message : String(e), FRIENDLY_RETRY_MESSAGE);
        sendLogEvent(proxySettings, sessionToken, 'error', 'generate_exception', { error: String(e), rating });
        sendResponse({ error: errorMessage });
      }
      return;
    }
  })();
  return true;
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeBase, loadConfigFile, fetchWithTimeout, truncateReviewText };
}
