const DEFAULT_MODEL = 'gemini-2.0-flash';
const SESSION_ENDPOINT_PATH = '/api/extension/session';
const GENERATE_ENDPOINT_PATH = '/gemini/generate';
const LOG_ENDPOINT_PATH = '/api/extension/log';
const TOKEN_EXPIRY_GUARD_MS = 10 * 1000; // keep 10s safety window
const LOG_PROMPT_PREVIEW_LIMIT = 200;
const LOG_PROMPT_ELLIPSIS = '...';
const INSTALL_ID_KEY = 'rcInstallId';
const CONFIG_PRIMARY_FILE = 'config.json';
const CONFIG_FALLBACK_FILE = 'config.default.json';

let staticConfigPromise = null;
let quotaState = null;

function truncateForLog(value, maxLen = LOG_PROMPT_PREVIEW_LIMIT){
  const str = (value || '').toString();
  if (str.length <= maxLen) return str;
  const sliceLen = Math.max(0, maxLen - LOG_PROMPT_ELLIPSIS.length);
  return str.slice(0, sliceLen) + LOG_PROMPT_ELLIPSIS;
}

function getProxySessionStorage(){
  return (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
}

function normalizeBase(url){
  if (!url) return '';
  return url.trim().replace(/\/+$/, '');
}

async function loadConfigFile(fileName){
  const url = chrome.runtime.getURL(fileName);
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok){ throw new Error(`HTTP ${resp.status}`); }
  const raw = await resp.text();
  if (!raw){ throw new Error('Empty config file'); }
  let parsed;
  try{
    parsed = JSON.parse(raw);
  }catch(err){
    throw new Error('Invalid JSON');
  }
  const proxyBase = normalizeBase(parsed.proxyBase || parsed.apiBase);
  const accessKey = (parsed.licenseKey || parsed.accessKey || '').trim();
  const upgradeUrl = (parsed.upgradeUrl || parsed.billingUrl || '').trim();
  if (!proxyBase || !accessKey){
    throw new Error('Missing proxyBase/licenseKey');
  }
  return { proxyBase, accessKey, upgradeUrl, source: fileName };
}

async function loadStaticConfig(){
  if (!staticConfigPromise){
    staticConfigPromise = (async ()=>{
      for (const file of [CONFIG_PRIMARY_FILE, CONFIG_FALLBACK_FILE]){
        try{
          const cfg = await loadConfigFile(file);
          console.info('[RC] Loaded proxy config from', file);
          return cfg;
        }catch(err){
          console.warn('[RC] Config file skipped', { file, error: String(err) });
        }
      }
      return null;
    })();
  }
  return staticConfigPromise;
}

async function getProxySettings(){
  const cfg = await loadStaticConfig();
  if (cfg && cfg.proxyBase && cfg.accessKey){
    return cfg;
  }
  throw new Error('Brak config.json: ustaw proxyBase i licenseKey w pliku konfiguracji.');
}

function buildProxyUrl(base, path){
  if (!base) return '';
  const suffix = path || '';
  return base + suffix;
}

async function getCachedSession(){
  if (chrome.storage && chrome.storage.session){
    const { proxySession = {} } = await chrome.storage.session.get(['proxySession']);
    if (proxySession && proxySession.token){
      return proxySession;
    }
  }
  const { proxySession: legacySession = {} } = await chrome.storage.local.get(['proxySession']);
  return legacySession;
}

function isSessionValid(session, proxyBase){
  if (!session || session.proxyBase !== proxyBase || !session.token) return false;
  if (!session.expiresAt) return true;
  const expiresAt = new Date(session.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > Date.now();
}

async function storeSession(session){
  const storageArea = getProxySessionStorage();
  await storageArea.set({ proxySession: session });
  if (storageArea !== chrome.storage.local){
    await chrome.storage.local.remove(['proxySession']);
  }
}

function normalizeQuota(raw, fallbackUrl=''){
  if (!raw || typeof raw !== 'object') return null;
  const limit = Number(raw.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remainingNum = Number(raw.remaining);
  const remaining = Number.isFinite(remainingNum) ? Math.max(0, remainingNum) : null;
  const upgradeUrl = (raw.upgradeUrl || fallbackUrl || '').trim();
  return { limit, remaining, upgradeUrl };
}

function updateQuotaState(quota){
  quotaState = quota || null;
}

function getQuotaState(){
  return quotaState;
}

function quotaFromHeaders(resp, fallbackUrl=''){
  if (!resp || typeof resp.headers?.get !== 'function') return null;
  const limit = Number(resp.headers.get('x-free-limit'));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remainingNum = Number(resp.headers.get('x-free-remaining'));
  const remaining = Number.isFinite(remainingNum) ? Math.max(0, remainingNum) : null;
  const upgradeUrl = (fallbackUrl || '').trim();
  return { limit, remaining, upgradeUrl };
}

function resolveSessionExpiry(parsed){
  if (typeof parsed.expiresIn === 'number' && Number.isFinite(parsed.expiresIn)){
    const ttlMs = Math.max(0, (parsed.expiresIn * 1000) - TOKEN_EXPIRY_GUARD_MS);
    return new Date(Date.now() + ttlMs).toISOString();
  }
  if (parsed.expiresAt){
    const expTs = new Date(parsed.expiresAt).getTime();
    if (!Number.isNaN(expTs)){
      const guardedTs = Math.max(Date.now(), expTs - TOKEN_EXPIRY_GUARD_MS);
      return new Date(guardedTs).toISOString();
    }
  }
  return null;
}

async function ensureInstallId(){
  const stored = await chrome.storage.local.get([INSTALL_ID_KEY]);
  const current = stored?.[INSTALL_ID_KEY];
  if (current && typeof current === 'string'){ return current; }
  const generated = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `rc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = {}; payload[INSTALL_ID_KEY] = generated;
  await chrome.storage.local.set(payload);
  return generated;
}

async function fetchSessionToken(settings){
  const proxyBase = settings?.proxyBase;
  const accessKey = settings?.accessKey;
  if (!proxyBase){ throw new Error('Brak Proxy URL w konfiguracji.'); }
  if (!accessKey){ throw new Error('Brak klucza licencyjnego w konfiguracji.'); }
  const installId = await ensureInstallId();
  const tokenUrl = buildProxyUrl(proxyBase, SESSION_ENDPOINT_PATH);
  const body = {
    licenseKey: accessKey,
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    installId
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-Extension-Id': chrome.runtime.id
  };
  const resp = await fetch(tokenUrl, {
    method:'POST',
    headers,
    body: JSON.stringify(body),
    mode:'cors',
    cache:'no-store',
    credentials:'omit'
  });
  const raw = await resp.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (err){
    throw new Error(resp.ok ? 'Proxy zwrocilo niepoprawny JSON podczas autoryzacji.' : `Proxy auth HTTP ${resp.status}`);
  }
  if (!resp.ok){
    const errorText = parsed && (parsed.error || parsed.message) ? (parsed.error || parsed.message) : resp.statusText;
    throw new Error(errorText || 'Nie udalo sie pobrac sesji z proxy.');
  }
  const token = (parsed.token || parsed.jwt || '').trim();
  if (!token) throw new Error('Proxy nie zwrocilo tokenu JWT.');
  const expiresAt = resolveSessionExpiry(parsed);
  const normalizedQuota = normalizeQuota(parsed.quota, settings?.upgradeUrl);
  if (normalizedQuota) updateQuotaState(normalizedQuota);
  const session = { token, proxyBase, expiresAt, quota: normalizedQuota };
  await storeSession(session);
  return session;
}

async function ensureSessionToken(settings){
  const cached = await getCachedSession();
  if (isSessionValid(cached, settings.proxyBase)){
    if (cached.quota) updateQuotaState(cached.quota);
    return cached.token;
  }
  if (!settings.accessKey){
    throw new Error('Brak klucza licencyjnego. Uzupelnij config.json.');
  }
  const session = await fetchSessionToken(settings);
  return session.token;
}
function proxyErrorText(j){
  if (j && j.error && (j.error.message || j.error.status)) return (j.error.message || j.error.status);
  return null;
}

function sendLogEvent(proxySettings, token, level, message, context){
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
    }).catch(()=>{});
  } catch (_){ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  (async ()=>{
    if (msg.type === 'GET_QUOTA_STATUS'){
      sendResponse({ quota: getQuotaState() });
      return;
    }
    if (msg.type === 'GENERATE_ALL'){
      const proxySettings = await getProxySettings();
      if (!proxySettings.proxyBase){ sendResponse({ error:'Brak Proxy URL. Uzupelnij plik config.json.' }); return; }
      let sessionToken = '';
      try{
        sessionToken = await ensureSessionToken(proxySettings);
      }catch(err){
        console.error('[RC] Nie udalo sie pobrac tokenu proxy', err);
        sendResponse({ error: err && err.message ? err.message : 'Nie udalo sie pobrac tokenu proxy.' });
        return;
      }
      const rating = msg.payload.rating || '?';
      const reviewText = (msg.payload.text || '').trim();
      console.log('[RC] Worker payload:', { rating, textLength: reviewText.length, sample: reviewText.slice(0, 140) });
      const ratingNumber = parseFloat(rating);
      let toneHint = 'neutralny i uprzejmy';
      let sentimentGuideline = 'Brak oceny: zachowaj neutralnosc i zaproponuj pomoc, jesli klient opisuje problem.';
      if (!Number.isNaN(ratingNumber)){
        if (ratingNumber <= 2){
          toneHint = 'empatyczny i spokojny, zachecajacy do kontaktu przez profil';
          sentimentGuideline = 'Klient jest niezadowolony: przepros, uznaj problem i zaproponuj dalszy kontakt przez profil firmy.';
        }else if (ratingNumber <= 3.5){
          toneHint = 'rzeczowy i uprzejmy';
          sentimentGuideline = 'Klient ma mieszane odczucia: podziekuj, odnie sie do uwag i zapewnij o wsparciu.';
        }else{
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
        contents: [{ role: 'user', parts: [{ text: promptPayload }]}]
      };
      const baseHeaders = {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id
      };
      const requestBody = JSON.stringify(body);
      const requestInitBase = {
        method:'POST',
        body: requestBody,
        mode:'cors',
        cache:'no-store',
        credentials:'omit'
      };
      sendLogEvent(proxySettings, sessionToken, 'info', 'generate_start', { rating, textLength: reviewText.length });
      let attempt = 0;
      try{
        while (attempt < 2){
          const headers = {
            ...baseHeaders,
            'Authorization': `Bearer ${sessionToken}`
          };
          const resp = await fetch(url, { ...requestInitBase, headers });
          if (resp.status === 401 && attempt === 0){
            attempt++;
            console.warn('[RC] JWT rejected by proxy, refreshing session.');
            const refreshedSession = await fetchSessionToken(proxySettings);
            sessionToken = refreshedSession.token;
            continue;
          }
          const quotaFromResp = quotaFromHeaders(resp, proxySettings.upgradeUrl);
          const raw = await resp.text();
          let j = null;
          try {
            j = raw ? JSON.parse(raw) : {};
          } catch (_){
            if (!resp.ok){
              sendResponse({ error: `Blad proxy (${resp.status})`, quota: quotaFromResp });
              if (quotaFromResp) updateQuotaState(quotaFromResp);
              return;
            }
            sendResponse({ error: 'Niepoprawna odpowiedz proxy.', quota: quotaFromResp });
            if (quotaFromResp) updateQuotaState(quotaFromResp);
            return;
          }
          if (!resp.ok){
            const proxyErr = proxyErrorText(j) || j.error || resp.statusText || 'Blad proxy.';
            const enriched = quotaFromResp || normalizeQuota(j?.quota, proxySettings.upgradeUrl);
            if (enriched) updateQuotaState(enriched);
            sendResponse({ error: proxyErr, errorCode: j?.code, freeLimit: j?.limit, upgradeUrl: j?.upgradeUrl || proxySettings.upgradeUrl, quota: enriched });
            sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_rejected', { error: proxyErr, code: j?.code, remaining: enriched?.remaining });
            return;
          }
          const err = proxyErrorText(j);
          if (err) {
            if (quotaFromResp) updateQuotaState(quotaFromResp);
            sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_error', { error: err, remaining: quotaFromResp?.remaining });
            sendResponse({ error: err, quota: quotaFromResp });
            return;
          }
          const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts)
            ? j.candidates[0].content.parts.map(p=>p.text||'').join('\n')
            : '';
          let soft = '', brief = '', proactive = '';
          try{
            const m = text.match(/\{[\s\S]*\}/);
            const jsonText = m ? m[0] : text;
            const obj = JSON.parse(jsonText);
            soft = (obj.soft || '').trim();
            brief = (obj.brief || '').trim();
            proactive = (obj.proactive || '').trim();
          }catch(_){
            const parts = text.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
            soft = parts[0] || '';
            brief = parts[1] || '';
            proactive = parts[2] || '';
          }
          if (quotaFromResp) updateQuotaState(quotaFromResp);
          sendLogEvent(proxySettings, sessionToken, 'info', 'generate_success', { rating, remaining: quotaFromResp?.remaining, limit: quotaFromResp?.limit });
          sendResponse({ soft, brief, proactive, _prompt: promptPayload, quota: quotaFromResp });
          return;
        }
      }catch(e){
        sendLogEvent(proxySettings, sessionToken, 'error', 'generate_exception', { error: String(e), rating });
        sendResponse({ error: String(e) });
      }
      return;
    }
  })();
  return true;
});
