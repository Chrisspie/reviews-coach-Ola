(function(){
  const baseEl = document.getElementById('config-base');
  const sourceEl = document.getElementById('config-source');
  const upgradeEl = document.getElementById('config-upgrade');
  const statusEl = document.getElementById('status');
  const authStatusEl = document.getElementById('auth-status');
  const emailInput = document.getElementById('email_input');
  const codeInput = document.getElementById('code_input');
  const magicLinkBtn = document.getElementById('magic_link_btn');
  const completeBtn = document.getElementById('complete_btn');
  const logoutBtn = document.getElementById('logout_btn');
  const CONFIG_FILES = [
    { label: 'config.json', path: 'config.json' },
    { label: 'config.default.json', path: 'config.default.json' }
  ];

  function renderUpgrade(url){
    if (!upgradeEl) return;
    upgradeEl.textContent = 'brak';
    const trimmed = (url || '').trim();
    if (!trimmed) return;
    try {
      const link = document.createElement('a');
      link.href = trimmed;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = trimmed;
      upgradeEl.textContent = '';
      upgradeEl.appendChild(link);
    } catch (_){
      upgradeEl.textContent = trimmed;
    }
  }

  async function readConfig(candidate){
    const url = chrome.runtime.getURL(candidate.path);
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok){ throw new Error('HTTP ' + resp.status); }
    const data = await resp.json();
    return {
      file: candidate.label,
      proxyBase: data.proxyBase || data.apiBase || '',
      upgradeUrl: data.upgradeUrl || data.billingUrl || ''
    };
  }

  async function loadConfig(){
    for (const candidate of CONFIG_FILES){
      try {
        const cfg = await readConfig(candidate);
        baseEl.textContent = cfg.proxyBase || 'brak';
        sourceEl.textContent = cfg.file;
        renderUpgrade(cfg.upgradeUrl);
        statusEl.textContent = `Konfiguracja pochodzi z ${cfg.file}. Aby ja zmienic, edytuj plik i przeladuj rozszerzenie.`;
        statusEl.className = 'muted';
        return;
      } catch (err){
        console.warn('[RC] Nie udalo sie odczytac', candidate.label, err);
      }
    }
    baseEl.textContent = 'brak';
    sourceEl.textContent = 'brak';
    renderUpgrade('');
    statusEl.textContent = 'Brak pliku config.json ani config.default.json. Dodaj go przed uruchomieniem rozszerzenia.';
    statusEl.className = 'status-err';
  }

  function updateAuthStatus(profile){
    if (!authStatusEl) return;
    if (profile && profile.email){
      authStatusEl.textContent = `Zalogowany jako ${profile.email}.`;
      authStatusEl.className = 'status-ok';
      logoutBtn.disabled = false;
    } else {
      authStatusEl.textContent = 'Brak aktywnej sesji.';
      authStatusEl.className = 'muted';
      logoutBtn.disabled = true;
    }
  }

  function requestAuthStatus(){
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, resp => {
      if (chrome.runtime.lastError){
        authStatusEl.textContent = chrome.runtime.lastError.message;
        authStatusEl.className = 'status-err';
        return;
      }
      updateAuthStatus(resp && resp.profile ? resp.profile : null);
    });
  }

  function setButtonsDisabled(disabled){
    if (magicLinkBtn) magicLinkBtn.disabled = disabled;
    if (completeBtn) completeBtn.disabled = disabled;
    if (logoutBtn) logoutBtn.disabled = disabled;
  }

  if (magicLinkBtn && logoutBtn && completeBtn){
    magicLinkBtn.addEventListener('click', ()=>{
      const email = (emailInput && emailInput.value ? emailInput.value : '').trim();
      if (!email){
        authStatusEl.textContent = 'Podaj adres e-mail.';
        authStatusEl.className = 'status-err';
        return;
      }
      setButtonsDisabled(true);
      authStatusEl.textContent = 'Wysylanie linku...';
      authStatusEl.className = 'muted';
      chrome.runtime.sendMessage({ type: 'START_MAGIC_LINK', email }, resp => {
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
        if (resp && resp.pending){
          authStatusEl.textContent = 'Sprawdz skrzynke i kliknij w link.';
          authStatusEl.className = 'muted';
          return;
        }
        updateAuthStatus(resp && resp.profile ? resp.profile : null);
      });
    });

    completeBtn.addEventListener('click', ()=>{
      const code = (codeInput && codeInput.value ? codeInput.value : '').trim();
      if (!code){
        authStatusEl.textContent = 'Wklej kod z linku.';
        authStatusEl.className = 'status-err';
        return;
      }
      setButtonsDisabled(true);
      authStatusEl.textContent = 'Finalizowanie logowania...';
      authStatusEl.className = 'muted';
      chrome.runtime.sendMessage({ type: 'COMPLETE_MAGIC_LINK', code }, resp => {
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
        updateAuthStatus(resp && resp.profile ? resp.profile : null);
      });
    });

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
        updateAuthStatus(null);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    loadConfig();
    requestAuthStatus();
  });
})();
