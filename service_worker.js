async function getCfg(){ return chrome.storage.sync.get(['apiKey']); }
async function incUsage(){
  const today = new Date().toISOString().slice(0,10);
  const u = await chrome.storage.sync.get(['usage']);
  const usage = u.usage || { date: today, count: 0 };
  if (usage.date !== today){ usage.date = today; usage.count = 0; }
  usage.count++;
  await chrome.storage.sync.set({ usage });
  return usage;
}

function geminiErrorText(j){
  if (j && j.error && (j.error.message || j.error.status)) return (j.error.message || j.error.status);
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  (async ()=>{
    const { apiKey } = await getCfg();
    if (!apiKey){ sendResponse({ error:'Brak Gemini API key.' }); return; }
    if (msg.type === 'GENERATE_ALL'){
      const usage = await incUsage();
      if (usage.count > 60){ sendResponse({ error: 'Limit Free dzisiaj wyczerpany.' }); return; }
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
        ' + reviewText + ',
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
      console.log('[RC] Gemini request payload:', { prompt: promptPayload });
      const url = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=' + apiKey;
      const body = { contents: [{ role: 'user', parts: [{ text: promptPayload }]}] };
      try{
        const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const j = await resp.json();
        const err = geminiErrorText(j);
        if (err) { sendResponse({ error: err }); return; }
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
        sendResponse({ soft, brief, proactive, _prompt: promptPayload });
      }catch(e){
        sendResponse({ error: String(e) });
      }
      return;
    }
  })();
  return true;
});
