(function(){
cd  const baseEl = document.getElementById('config-base');
  const licenseEl = document.getElementById('config-license');
  const sourceEl = document.getElementById('config-source');
  const statusEl = document.getElementById('status');
  const CONFIG_FILES = [
    { label: 'config.json', path: 'config.json' },
    { label: 'config.default.json', path: 'config.default.json' }
  ];

  function maskValue(value){
    if (!value) return 'brak';
    if (value.length <= 6) return '*'.repeat(value.length);
    return value.slice(0, 3) + '...' + value.slice(-3);
  }

  async function readConfig(candidate){
    const url = chrome.runtime.getURL(candidate.path);
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok){ throw new Error('HTTP ' + resp.status); }
    const data = await resp.json();
    return {
      file: candidate.label,
      proxyBase: data.proxyBase || data.apiBase || '',
      licenseKey: data.licenseKey || data.accessKey || ''
    };
  }

  async function init(){
    for (const candidate of CONFIG_FILES){
      try{
        const cfg = await readConfig(candidate);
        baseEl.textContent = cfg.proxyBase || 'brak';
        licenseEl.textContent = maskValue(cfg.licenseKey);
        sourceEl.textContent = cfg.file;
        statusEl.textContent = `Konfiguracja pochodzi z ${cfg.file}. Aby ja zmienic, edytuj plik i przeladuj rozszerzenie.`;
        statusEl.className = 'muted';
        return;
      }catch(err){
        console.warn('[RC] Nie udalo sie odczytac', candidate.label, err);
      }
    }
    baseEl.textContent = 'brak';
    licenseEl.textContent = 'brak';
    sourceEl.textContent = 'brak';
    statusEl.textContent = 'Brak pliku config.json ani config.default.json. Dodaj go przed uruchomieniem rozszerzenia.';
    statusEl.className = 'err';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
