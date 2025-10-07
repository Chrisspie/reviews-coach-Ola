(function(){
  const $ = (s)=>document.querySelector(s);
  const status = $("#status");
  const keyInput = $("#apiKey");

  function setStatus(txt, cls=''){
    status.className = cls || 'muted';
    status.textContent = txt;
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    chrome.storage.sync.get({ apiKey: '' }, (cfg)=>{
      keyInput.value = cfg.apiKey || '';
      setStatus(cfg.apiKey ? 'Załadowano istniejący klucz.' : 'Brak klucza — wklej i zapisz.');
    });
  });

  $("#save").addEventListener('click', ()=>{
    const apiKey = (keyInput.value||'').trim();
    chrome.storage.sync.set({ apiKey }, ()=>{
      if (chrome.runtime.lastError){
        setStatus('Błąd zapisu: ' + chrome.runtime.lastError.message, 'err');
        return;
      }
      setStatus(apiKey ? 'Zapisano. ✅' : 'Usunięto klucz.', apiKey ? 'ok' : 'muted');
    });
  });
})();
