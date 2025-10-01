async function getCfg(){ return chrome.storage.sync.get(['apiKey']); }
    async function incUsage(){
      const today = new Date().toISOString().slice(0,10);
      const u = await chrome.storage.sync.get(['usage']);
      const usage = u.usage || { date: today, count: 0 };
      if (usage.date !== today){ usage.date = today; usage.count = 0; }
      usage.count++; await chrome.storage.sync.set({ usage }); return usage;
    }
    function geminiErrorText(j){
      if (j && j.error && (j.error.message || j.error.status)) return (j.error.message || j.error.status);
      return null;
    }
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
      (async()=>{
        const { apiKey } = await getCfg();
        if (!apiKey){ sendResponse({ error:'Brak Gemini API key.' }); return; }
        if (msg.type === 'GENERATE_ALL'){
          const usage = await incUsage();
          if (usage.count > 60){ sendResponse({ error: 'Limit Free dzisiaj wyczerpany.' }); return; }
          const rating = msg.payload.rating || '?';
          const r = parseFloat(rating);
          let toneHint = 'neutralny i uprzejmy';
          if (!isNaN(r)){
            if (r <= 2) toneHint = 'empatyczny i spokojny, z zachętą do kontaktu przez profil';
            else if (r <= 3.5) toneHint = 'rzeczowy i uprzejmy';
            else toneHint = 'serdeczny, wdzięczny i krótki';
          }
      const system =
    'Jesteś asystentem firmy, który odpowiada na opinie klientów w Google. Język: polski.\n' +
    'Nie podawaj e-maili ani danych kontaktowych. Jeśli trzeba, zaproś do kontaktu przez informacje w profilu firmy.\n' +
    'Unikaj frazy "Pan/Pani". Jeżeli imię recenzenta jednoznacznie wskazuje płeć, użyj poprawnej formy z imieniem w wołaczu (np. "Pani Katarzyno", "Panie Piotrze"); w przeciwnym razie pozostań przy neutralnych zwrotach (np. "Dzień dobry").\n' +
    'Każda odpowiedź musi odwoływać się do konkretnych elementów opinii (cytat lub precyzyjna parafraza) i adekwatnie reagować na emocje autora.\n' +
    'Ton ogólny (wg oceny): ' + toneHint + '. Długość: 2–4 zdania.';
      const user =
    'OPINIA (ocena ' + rating + '/5):\n' +
    '"""' + (msg.payload.text||'') + '"""\n' +
    'Zwróć JSON z trzema polami: { "soft": "...", "brief": "...", "proactive": "..." }.\n' +
    'soft = delikatny i serdeczny; brief = rzeczowy i zwięzły; proactive = proaktywny z konkretną zachętą do kontaktu przez profil.\n' +
    'Każdy wariant ma brzmieć wyraźnie inaczej (inne słownictwo, długość). W każdym wpleć co najmniej jeden konkretny szczegół z opinii (cytat lub parafraza) i, gdy to naturalne, odnieś się do emocji klienta.\n' +
    'Bez dodatkowych komentarzy.';
          const url = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=' + apiKey;
          const body = { contents: [{ role: "user", parts: [{ text: system + "\n\n" + user }]}] };
          try{
            const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            const j = await resp.json();
            const err = geminiErrorText(j);
            if (err) { sendResponse({ error: err }); return; }
            const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts)
              ? j.candidates[0].content.parts.map(p=>p.text||'').join('\n')
              : '';
            let soft='', brief='', proactive='';
            try{
              const m = text.match(/\{[\s\S]*\}/);
              const jsonText = m ? m[0] : text;
              const obj = JSON.parse(jsonText);
              soft = (obj.soft||'').trim();
              brief = (obj.brief||'').trim();
              proactive = (obj.proactive||'').trim();
            }catch(_){
              const parts = text.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
              soft = parts[0]||''; brief = parts[1]||''; proactive = parts[2]||'';
            }
            sendResponse({ soft, brief, proactive });
          }catch(e){
            sendResponse({ error: String(e) });
          }
          return;
        }
      })();
      return true;
    });
    
