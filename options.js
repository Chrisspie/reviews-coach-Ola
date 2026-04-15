(function(){
  const authStatusEl = document.getElementById('auth-status');
  const accountEmailEl = document.getElementById('account-email');
  const licenseTypeEl = document.getElementById('license-type');
  const quotaLeftEl = document.getElementById('quota-left');
  const nextPaymentEl = document.getElementById('next-payment');
  const googleLoginBtn = document.getElementById('google_login_btn');
  const upgradeBtn = document.getElementById('upgrade_btn');
  const logoutBtn = document.getElementById('logout_btn');
  const placeTypeInput = document.getElementById('business_place_type');
  const placeNameInput = document.getElementById('business_place_name');
  const saveContextBtn = document.getElementById('save_context_btn');
  const contextSaveStatusEl = document.getElementById('context-save-status');
  const upgradeStatusEl = document.getElementById('upgrade-status');
  const authOnlyEls = Array.from(document.querySelectorAll('.auth-only'));
  const BUSINESS_CONTEXT_KEY = 'rcBusinessContext';
  const MAX_PLACE_TYPE_CHARS = 80;
  const MAX_PLACE_NAME_CHARS = 120;

  function setText(el, text){
    if (el) el.textContent = text || '-';
  }

  function setAuthenticatedUiVisible(visible){
    authOnlyEls.forEach((el) => {
      el.style.display = visible ? '' : 'none';
    });
  }

  function normalizeSpaces(value){
    return (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  }

  function truncate(value, maxLength){
    if (!value) return '';
    return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
  }

  function readContextForm(){
    return {
      placeType: truncate(normalizeSpaces(placeTypeInput?.value || ''), MAX_PLACE_TYPE_CHARS),
      placeName: truncate(normalizeSpaces(placeNameInput?.value || ''), MAX_PLACE_NAME_CHARS)
    };
  }

  function setContextStatus(text, kind){
    if (!contextSaveStatusEl) return;
    contextSaveStatusEl.textContent = text || '';
    contextSaveStatusEl.className = `save-status ${kind === 'error' ? 'status-err' : (kind === 'ok' ? 'status-ok' : 'muted')}`;
  }

  function setUpgradeStatus(text, kind){
    if (!upgradeStatusEl) return;
    upgradeStatusEl.textContent = text || '';
    upgradeStatusEl.className = `upgrade-status ${kind === 'error' ? 'status-err' : (kind === 'ok' ? 'status-ok' : 'muted')}`;
  }

  async function loadBusinessContext(){
    if (!chrome?.storage?.local) {
      setContextStatus('Storage rozszerzenia jest niedostepny.', 'error');
      return;
    }
    try {
      const stored = await chrome.storage.local.get([BUSINESS_CONTEXT_KEY]);
      const value = stored && stored[BUSINESS_CONTEXT_KEY] && typeof stored[BUSINESS_CONTEXT_KEY] === 'object'
        ? stored[BUSINESS_CONTEXT_KEY]
        : {};
      if (placeTypeInput) placeTypeInput.value = truncate(normalizeSpaces(value.placeType || ''), MAX_PLACE_TYPE_CHARS);
      if (placeNameInput) placeNameInput.value = truncate(normalizeSpaces(value.placeName || ''), MAX_PLACE_NAME_CHARS);
    } catch (err) {
      console.error('[RC] Nie udalo sie wczytac kontekstu miejsca', err);
      setContextStatus('Nie udalo sie wczytac kontekstu miejsca.', 'error');
    }
  }

  async function saveBusinessContext(){
    if (!chrome?.storage?.local) {
      setContextStatus('Storage rozszerzenia jest niedostepny.', 'error');
      return;
    }
    const context = readContextForm();
    if (placeTypeInput) placeTypeInput.value = context.placeType;
    if (placeNameInput) placeNameInput.value = context.placeName;
    if (saveContextBtn) saveContextBtn.disabled = true;
    setContextStatus('Zapisywanie...', 'muted');
    try {
      await chrome.storage.local.set({
        [BUSINESS_CONTEXT_KEY]: {
          ...context,
          updatedAt: new Date().toISOString(),
          source: 'options'
        }
      });
      setContextStatus('Kontekst miejsca zapisany.', 'ok');
    } catch (err) {
      console.error('[RC] Nie udalo sie zapisac kontekstu miejsca', err);
      setContextStatus('Nie udalo sie zapisac kontekstu miejsca.', 'error');
    } finally {
      if (saveContextBtn) saveContextBtn.disabled = false;
    }
  }

  function formatNumber(value){
    return Number.isFinite(value)
      ? new Intl.NumberFormat(navigator.language || 'pl-PL').format(value)
      : null;
  }

  function formatDate(value){
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString(navigator.language || 'pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatDuration(seconds){
    if (!Number.isFinite(seconds)) return null;
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days} dni`;
    if (hours > 0) return `${hours} godz.`;
    if (minutes > 0) return `${minutes} min`;
    return 'mniej niz minute';
  }

  function planLabel(profile, quota){
    const plan = (profile?.plan || '').toString().toLowerCase();
    if (plan === 'pro') return 'Pro';
    if (plan === 'trial') return 'Okres probny';
    if (plan === 'expired') return 'Wygasla';
    if (quota?.lifetime === true) return 'Licencja bezterminowa';
    if (profile?.licenseId || quota) return 'Aktywna licencja';
    return '-';
  }

  function quotaLabel(quota){
    if (!quota) return 'Brak danych.';
    if ((quota.type || '').toLowerCase() === 'time') {
      const remaining = Number(quota.remainingSeconds);
      const duration = formatDuration(remaining);
      return duration ? `Pozostalo ${duration}.` : 'Brak danych o pozostalej ilosci czasu.';
    }
    const remaining = Number(quota.remaining);
    const limit = Number(quota.limit);
    const remainingText = formatNumber(remaining);
    const limitText = formatNumber(limit);
    if (remainingText && limitText) return `${remainingText} z ${limitText} odpowiedzi.`;
    if (limitText) return `Limit: ${limitText} odpowiedzi.`;
    return 'Brak danych.';
  }

  function nextPaymentLabel(profile, quota){
    if (quota?.lifetime === true) return 'Brak - licencja bezterminowa.';
    const expiresAt = formatDate(quota?.expiresAt);
    const plan = (profile?.plan || '').toString().toLowerCase();
    if (plan === 'trial' && expiresAt) return `Brak platnosci. Okres probny do ${expiresAt}.`;
    if (plan === 'pro' && expiresAt) return `${expiresAt} (na podstawie odnowienia dostepu).`;
    if (expiresAt) return `Odnowienie dostepu: ${expiresAt}.`;
    return 'Brak danych w rozszerzeniu.';
  }

  function renderStatus(profile, quota){
    const loggedIn = Boolean(profile && profile.email);
    const plan = (profile?.plan || '').toString().toLowerCase();
    const isTrial = loggedIn && plan === 'trial';
    if (loggedIn) {
      authStatusEl.textContent = `Zalogowany jako ${profile.email}.`;
      authStatusEl.className = 'status-ok';
    } else {
      authStatusEl.textContent = 'Nie jestes zalogowany.';
      authStatusEl.className = 'muted';
    }
    setText(accountEmailEl, loggedIn ? profile.email : '-');
    setText(licenseTypeEl, loggedIn ? planLabel(profile, quota) : '-');
    setText(quotaLeftEl, loggedIn ? quotaLabel(quota) : '-');
    setText(nextPaymentEl, loggedIn ? nextPaymentLabel(profile, quota) : '-');
    setAuthenticatedUiVisible(loggedIn);
    if (logoutBtn) logoutBtn.disabled = !loggedIn;
    if (logoutBtn) logoutBtn.style.display = loggedIn ? 'inline-flex' : 'none';
    if (googleLoginBtn) googleLoginBtn.textContent = loggedIn ? 'Zmien konto Google' : 'Zaloguj przez Google';
    if (upgradeBtn) upgradeBtn.style.display = isTrial ? 'inline-flex' : 'none';
    if (!isTrial) setUpgradeStatus('', 'muted');
    if (loggedIn) {
      loadBusinessContext();
    } else {
      if (placeTypeInput) placeTypeInput.value = '';
      if (placeNameInput) placeNameInput.value = '';
      setContextStatus('', 'muted');
    }
  }

  function setButtonsDisabled(disabled){
    if (googleLoginBtn) googleLoginBtn.disabled = disabled;
    if (logoutBtn) logoutBtn.disabled = disabled;
    if (upgradeBtn) upgradeBtn.disabled = disabled;
  }

  function requestAuthStatus(){
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, resp => {
      if (chrome.runtime.lastError){
        authStatusEl.textContent = chrome.runtime.lastError.message;
        authStatusEl.className = 'status-err';
        return;
      }
      renderStatus(resp?.profile || null, resp?.quota || null);
    });
  }

  if (googleLoginBtn){
    googleLoginBtn.addEventListener('click', ()=>{
      setButtonsDisabled(true);
      authStatusEl.textContent = 'Otwieranie logowania Google...';
      authStatusEl.className = 'muted';
      chrome.runtime.sendMessage({ type: 'START_GOOGLE_LOGIN' }, resp => {
        setButtonsDisabled(false);
        if (chrome.runtime.lastError){
          authStatusEl.textContent = chrome.runtime.lastError.message;
          authStatusEl.className = 'status-err';
          return;
        }
        if (resp && resp.error){
          authStatusEl.textContent = resp.error;
          authStatusEl.className = 'status-err';
          requestAuthStatus();
          return;
        }
        renderStatus(resp?.profile || null, resp?.quota || null);
      });
    });
  }

  if (logoutBtn){
    logoutBtn.addEventListener('click', ()=>{
      setButtonsDisabled(true);
      chrome.runtime.sendMessage({ type: 'LOGOUT' }, resp => {
        setButtonsDisabled(false);
        if (chrome.runtime.lastError){
          authStatusEl.textContent = chrome.runtime.lastError.message;
          authStatusEl.className = 'status-err';
          return;
        }
        if (resp && resp.error){
          authStatusEl.textContent = resp.error;
          authStatusEl.className = 'status-err';
          return;
        }
        renderStatus(null, null);
      });
    });
  }

  if (upgradeBtn){
    upgradeBtn.addEventListener('click', ()=>{
      const previousText = upgradeBtn.textContent;
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = 'Przekierowanie...';
      setUpgradeStatus('Otwieranie platnosci Stripe...', 'muted');
      chrome.runtime.sendMessage({ type: 'OPEN_UPGRADE_PAGE' }, resp => {
        upgradeBtn.disabled = false;
        upgradeBtn.textContent = previousText || 'Kup abonament';
        if (chrome.runtime.lastError){
          setUpgradeStatus(chrome.runtime.lastError.message, 'error');
          return;
        }
        if (resp && resp.error){
          setUpgradeStatus(resp.error, 'error');
          return;
        }
        setUpgradeStatus('Otworzono platnosc w nowej karcie.', 'ok');
      });
    });
  }

  if (saveContextBtn){
    saveContextBtn.addEventListener('click', saveBusinessContext);
  }

  document.addEventListener('DOMContentLoaded', () => {
    requestAuthStatus();
  });
})();
