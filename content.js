const PANEL='rc-panel';
    let currentPanel=null;
    let currentPanelCleanup=null;
    const chipRegistry = new Map();
    const throttleMs = 400;
    let lastRun = 0;

    const mo = new MutationObserver(()=> {
      const now = performance.now();
      if (now - lastRun > throttleMs){
        lastRun = now;
        requestAnimationFrame(scan);
      }
    });
    mo.observe(document, {childList:true, subtree:true});
    scan();

    function hash(str){ let h=0,i=0; for(;i<str.length;i++) h=(h<<5)-h + str.charCodeAt(i)|0; return String(h); }
    function qsaDeep(sel, root=document){
      const result=[];
      const visited=new Set();
      let start = root || document;
      if (start && start.nodeType === 9 && start.documentElement) start = start.documentElement;
      if (!start) return result;
      const stack=[start];
      while(stack.length){
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === 1){
          if (node.matches && node.matches(sel) && !visited.has(node)){
            visited.add(node);
            result.push(node);
          }
          if (node.shadowRoot) stack.push(node.shadowRoot);
          const children = node.children;
          for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }else if (node.nodeType === 11){
          const children = node.children || [];
          for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
      }
      return result;
    }
    function ensureRoot(){
      let r=document.getElementById('rc_root');
      if (!r){ r=document.createElement('div'); r.id='rc_root'; document.body.appendChild(r); }
      return r;
    }
    function closeCurrentPanel(){
      if (currentPanelCleanup){ const fn=currentPanelCleanup; currentPanelCleanup=null; try{ fn(); }catch(_){} }
      if (currentPanel){ currentPanel.remove(); currentPanel=null; }
    }
    function showToast(msg){
      const t=document.createElement('div'); t.className='rc-toast'; t.textContent=msg;
      document.body.appendChild(t); setTimeout(()=> t.remove(), 2200);
    }

    function getScrollParents(el){
      const out=[];
      let node = el?.parentElement;
      const scrollable = /(auto|scroll|overlay)/i;
      while(node && node !== document.body){
        try{
          const style = window.getComputedStyle(node);
          if (scrollable.test(style.overflowY) || scrollable.test(style.overflowX) || scrollable.test(style.overflow)){
            out.push(node);
          }
        }catch(_){ }
        node = node.parentElement;
      }
      if (!out.includes(window)) out.push(window);
      return out;
    }

    function findCardForHash(hash){
      if (!hash) return null;
      const entry = chipRegistry.get(hash);
      if (entry){
        if (entry.card?.isConnected) return entry.card;
        if (entry.button?.isConnected){
          const host = entry.button.closest('[data-rc-hash]');
          if (host){ entry.card = host; return host; }
        }
      }
      try{
        return document.querySelector(`[data-rc-hash="${hash}"]`);
      }catch(_){ return null; }
    }

    function findReplyButton(root){
      const buttons = qsaDeep('button, [role="button"]', root);
      return buttons.find(btn => {
        if (!btn || btn.classList?.contains('rc-chip-btn')) return false;
        const text = (btn.textContent||'').toLowerCase();
        return /odpowiedz|odpowiedź|reply|respond/.test(text);
      }) || null;
    }

    function createChipButton(hash){
      const btn = document.createElement('button');
      btn.className = 'rc-chip-btn';
      btn.setAttribute('data-rc-hash', hash);
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.6 3.7L17 8.2l-3.4 1.5L12 13l-1.6-3.3L7 8.2l3.4-1.5L12 3z" stroke="currentColor" stroke-width="1.6"/></svg>
          <span>Podpowiedz odpowiedź</span>`;
      btn.addEventListener('click', (e)=>{
        const button = e.currentTarget;
        const targetHash = button.getAttribute('data-rc-hash') || '';
        const hostCard = button.closest('[data-rc-hash]');
        const card = (hostCard && hostCard.dataset.rcHash === targetHash) ? hostCard : findCardForHash(targetHash);
        if (!card){ showToast('Nie mogę znaleźć opinii dla tej podpowiedzi.'); return; }
        openCardPanel(card, button);
      });
      return btn;
    }

    function placeChip(card, btn){
      if (!card) return;
      if (!card.dataset.rcHash) card.dataset.rcHash = btn.getAttribute('data-rc-hash') || '';
      const duplicates = card.querySelectorAll('.rc-chip-btn');
      duplicates.forEach(el => { if (el !== btn) el.remove(); });
      if (btn.parentElement && card.contains(btn)) return;
      const replyBtn = findReplyButton(card);
      if (replyBtn && replyBtn.parentElement){
        replyBtn.insertAdjacentElement('afterend', btn);
        return;
      }
      const replyField = qsaDeep('textarea, [contenteditable="true"], input[type="text"]', card)[0];
      if (replyField && replyField.parentElement){
        replyField.insertAdjacentElement('beforebegin', btn);
        return;
      }
      card.appendChild(btn);
    }

    function ensureChipForCard(card, hash){
      if (!hash) return;
      let entry = chipRegistry.get(hash);
      if (entry && (!entry.button || !entry.button.isConnected)){
        chipRegistry.delete(hash);
        entry = null;
      }
      if (!entry){
        const button = createChipButton(hash);
        entry = { button, card };
        chipRegistry.set(hash, entry);
      }
      entry.card = card;
      placeChip(card, entry.button);
    }

    function cleanupChipRegistry(activeHashes){
      chipRegistry.forEach((entry, hash)=>{
        if (!entry || !entry.button){ chipRegistry.delete(hash); return; }
        if (!entry.button.isConnected){ chipRegistry.delete(hash); return; }
        if (!activeHashes.has(hash)){
          entry.button.remove();
          chipRegistry.delete(hash);
        }
      });
    }

    function scan(){
      injectForCards();
      injectForDialog();
    }

    function injectForCards(){
      const candidates = qsaDeep('[role="article"], [data-review-id], div[aria-label*="review"], div.hxVHQb');
      const activeHashes = new Set();
      candidates.forEach(card => {
        const text = (card.innerText||'').trim();
        if (text.length < 40) return;
        const hashVal = (card.getAttribute('data-review-id') || '') + '|' + hash(text.slice(0,300));
        card.dataset.rcHash = hashVal;
        const replyField = qsaDeep('textarea, [contenteditable="true"], input[type="text"]', card)[0];
        const replyBtn = findReplyButton(card);
        if (!(replyField || replyBtn)) return;
        ensureChipForCard(card, hashVal);
        activeHashes.add(hashVal);
      });
      cleanupChipRegistry(activeHashes);
    }

    async function openCardPanel(card, anchor){
      const root = ensureRoot();
      closeCurrentPanel();
      const wrap = document.createElement('div'); wrap.className='rc-panel-wrap'; wrap.dataset.rcTarget = card.dataset.rcHash||'';
      const panel = document.createElement('div'); panel.className = PANEL;
      wrap.appendChild(panel); root.appendChild(wrap);
      currentPanel = wrap;

      const margin = 16;
      let raf = 0;
      const repositionNow = ()=>{
        if (!document.body.contains(card)){ closeCurrentPanel(); return; }
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const anchorRect = (anchor && anchor.isConnected && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : rect;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const panelRect = panel.getBoundingClientRect();
        let left = anchorRect.right + margin;
        if (left + panelRect.width + margin > viewportWidth){
          left = rect.left - panelRect.width - margin;
          if (left < margin){ left = Math.max(margin, viewportWidth - panelRect.width - margin); }
        }
        let top = Math.min(rect.top, anchorRect.top);
        const maxTop = viewportHeight - panelRect.height - margin;
        top = Math.min(Math.max(margin, top), Math.max(margin, maxTop));
        wrap.style.top = `${Math.round(top)}px`;
        wrap.style.left = `${Math.round(left)}px`;
      };
      const scheduleReposition = ()=>{
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(()=>{ raf=0; repositionNow(); });
      };

      const onResize = ()=> scheduleReposition();

      const scrollParents = getScrollParents(card);
      const scrollListeners = scrollParents.map(node=>{
        const handler = ()=> scheduleReposition();
        node.addEventListener('scroll', handler, {passive:true});
        return { node, handler };
      });

      window.addEventListener('resize', onResize);

      const ro = window.ResizeObserver ? new ResizeObserver(scheduleReposition) : null;
      if (ro){
        try{ ro.observe(card); ro.observe(panel); if(anchor && anchor.isConnected) ro.observe(anchor); }catch(_){ }
      }
      const io = window.IntersectionObserver ? new IntersectionObserver(()=> scheduleReposition(), {threshold:[0,0.5,1]}) : null;
      if (io){
        try{ io.observe(card); if(anchor && anchor.isConnected) io.observe(anchor); }catch(_){ }
      }

      const cleanup = ()=>{
        scrollListeners.forEach(({node, handler})=>{
          try{ node.removeEventListener('scroll', handler); }catch(_){ }
        });
        window.removeEventListener('resize', onResize);
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        if (currentPanel === wrap) currentPanel=null;
        currentPanelCleanup=null;
        if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
      };
      currentPanelCleanup = cleanup;
      wrap.reposition = scheduleReposition;

      repositionNow();

      const { apiKey } = await chrome.storage.sync.get(['apiKey']);
      if (!wrap.isConnected || currentPanel !== wrap){ return; }
      if (!apiKey){ renderKeyForm(panel, card); return; }
      renderMainPanel(panel, card);
    }

    function renderKeyForm(panel, card){
      if (!panel.parentElement || !panel.parentElement.isConnected) return;
      panel.innerHTML = `
        <div class="rc-head"><div class="rc-title"><span class="rc-dot"></span> Klucz Gemini</div></div>
        <div class="rc-body" style="display:flex;align-items:center;gap:8px">
          <input id="rc_apiKey" type="password" placeholder="Wklej Gemini API key (AI Studio)" class="rc-input" style="flex:1">
          <button id="rc_save" class="rc-primary">Zapisz</button>
          <button id="rc_close" class="rc-secondary">Zamknij</button>
        </div>
        <div class="rc-note" style="margin-top:8px">Klucz używany tylko lokalnie. Możesz go usunąć w każdej chwili.</div>`;
      panel.querySelector('#rc_save').onclick = async () => {
        const k = panel.querySelector('#rc_apiKey').value.trim(); if(!k) return;
        await chrome.storage.sync.set({ apiKey:k }); renderMainPanel(panel, card);
      };
      panel.querySelector('#rc_close').onclick = ()=> { closeCurrentPanel(); };
      panel.parentElement?.reposition?.();
    }

    function renderMainPanel(panel, card){
      if (!panel.parentElement || !panel.parentElement.isConnected) return;
      panel.innerHTML = `
        <div class="rc-head">
          <div class="rc-title"><span class="rc-dot"></span> Wybierz styl i sprawdź odpowiedź</div>
          <div class="rc-seg" id="rc_seg">
            <button data-style="soft" class="active">Delikatna</button>
            <button data-style="brief">Rzeczowa</button>
            <button data-style="proactive">Proaktywna</button>
          </div>
        </div>
        <div class="rc-preview" id="rc_preview"><div style="display:flex;align-items:center;gap:8px"><div class="rc-spinner"></div><span>Generuję…</span></div></div>
        <div class="rc-actions">
          <button id="rc_insert" class="rc-primary">Wstaw wybraną</button>
          <button id="rc_regen" class="rc-secondary">Regeneruj</button>
          <button id="rc_close" class="rc-secondary">Zamknij</button>
          <span class="rc-note">Tylko wkleja do pola – <b>nie publikuje automatycznie</b>.</span>
        </div>
        <div id="rc_err" class="rc-error"></div>
      `;
      const state = { soft:'', brief:'', proactive:'' };

      const seg = document.getElementById('rc_seg');
      seg.addEventListener('click', (e)=>{
        const b = e.target.closest('button[data-style]'); if(!b) return;
        seg.querySelectorAll('button').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        document.getElementById('rc_preview').textContent = state[b.dataset.style] || '—';
      });

      document.getElementById('rc_insert').onclick = async ()=> {
        const targetHash = panel.parentElement?.dataset.rcTarget || card.dataset.rcHash || '';
        const key = seg.querySelector('.active')?.dataset.style || 'soft';
        const text = state[key] || '';
        if(!text){ document.getElementById('rc_err').textContent='Brak treści do wstawienia.'; return; }
        await pasteIntoReplyViaPopup(targetHash, card, text);
      };
      document.getElementById('rc_regen').onclick = ()=> generateAll(panel, card, state, true);
      document.getElementById('rc_close').onclick = ()=> { closeCurrentPanel(); };

      generateAll(panel, card, state, false);
      panel.parentElement?.reposition?.();
    }

    function injectForDialog(){
      const dialogs = qsaDeep('[role="dialog"], [aria-modal="true"]');
      dialogs.forEach(dialog => {
        if (dialog.querySelector('.rc-toolbar')) return;
        const textarea = qsaDeep('textarea, [contenteditable="true"]', dialog)[0];
        if (!textarea) return;

        const tb = document.createElement('div');
        tb.className = 'rc-toolbar';
        tb.innerHTML = `
          <strong>AI</strong>
          <div class="rc-seg" id="rc_seg_tb">
            <button data-style="soft" class="active">Delikatna</button>
            <button data-style="brief">Rzeczowa</button>
            <button data-style="proactive">Proaktywna</button>
          </div>
          <button id="rc_gen_tb" class="rc-secondary rc-mini">Generuj</button>
          <button id="rc_apply_tb" class="rc-primary rc-mini" disabled>Wstaw</button>
          <span class="rc-note">Nie publikuje automatycznie</span>
          <span id="rc_err_tb" class="rc-error" style="margin-left:6px"></span>
        `;
        dialog.insertBefore(tb, dialog.firstChild);

        const state = { soft:'', brief:'', proactive:'' };
        const seg = tb.querySelector('#rc_seg_tb');

        const updateApply = ()=>{
          const key = seg.querySelector('.active')?.dataset.style || 'soft';
          tb.querySelector('#rc_apply_tb').disabled = !(state[key] && state[key].trim().length);
        }

        seg.addEventListener('click', (e)=>{
          const b = e.target.closest('button[data-style]'); if(!b) return;
          seg.querySelectorAll('button').forEach(x=>x.classList.remove('active'));
          b.classList.add('active');
          updateApply();
        });

        tb.querySelector('#rc_gen_tb').onclick = ()=>{
          tb.querySelector('#rc_err_tb').textContent='';
          tb.querySelector('#rc_gen_tb').innerHTML = '<span class="rc-spinner"></span>';
          const payload = { text: getCurrentReviewContext(), rating: detectRatingNear(dialog) };
          chrome.runtime.sendMessage({ type:'GENERATE_ALL', payload }, (resp)=>{
            tb.querySelector('#rc_gen_tb').textContent='Generuj';
            if(!resp || resp.error){
              tb.querySelector('#rc_err_tb').textContent = resp?.error || 'Błąd (klucz?)';
              return;
            }
            state.soft = resp.soft||''; state.brief=resp.brief||''; state.proactive=resp.proactive||'';
            updateApply();
          });
        };

        tb.querySelector('#rc_apply_tb').onclick = async ()=>{
          const key = seg.querySelector('.active')?.dataset.style || 'soft';
          const text = state[key] || '';
          if(!text){ tb.querySelector('#rc_err_tb').textContent='Najpierw wygeneruj tekst.'; return; }
          await pasteIntoExistingTextarea(dialog, text);
        };
      });
    }

    function getCurrentReviewContext(){
      const el = qsaDeep('[data-review-id], [role="article"]')[0];
      return (el?.innerText||'').trim().slice(0, 2000);
    }
    function detectRatingNear(root){
      const starEl = qsaDeep('[aria-label*="stars"], [aria-label*="gwiaz"]', root)[0] || qsaDeep('[aria-label*="stars"], [aria-label*="gwiaz"]')[0];
      const label = starEl?.getAttribute('aria-label')||'';
      const m = label.match(/([0-5](?:[,\.][0-9])?)\s*\/\s*5/);
      return m ? m[1].replace(',','.') : '';
    }

    function generateAll(panel, card, state, force){
      const preview = panel.querySelector('#rc_preview');
      if (!force && state.soft) {
        const active = document.querySelector('#rc_seg .active')?.dataset.style || 'soft';
        preview.textContent = state[active] || '—'; return;
      }
      preview.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><div class="rc-spinner"></div><span>Generuję…</span></div>';
      panel.parentElement?.reposition?.();
      const payload = { text: extractText(card), rating: extractRating(card) };
      chrome.runtime.sendMessage({ type:'GENERATE_ALL', payload }, (resp)=>{
        if(!resp || resp.error){
          document.getElementById('rc_err').textContent = resp?.error || 'Błąd generowania (sprawdź klucz).';
          preview.textContent = '—';
          panel.parentElement?.reposition?.();
          return;
        }
        state.soft = resp.soft || '';
        state.brief = resp.brief || '';
        state.proactive = resp.proactive || '';
        const active = document.querySelector('#rc_seg .active')?.dataset.style || 'soft';
        preview.textContent = state[active] || '—';
        panel.parentElement?.reposition?.();
      });
    }

    function extractText(card){
      let best = '';
      qsaDeep('*', card).forEach(n=>{
        const t = (n.innerText||'').trim();
        if (t && t.length > best.length && t.length < 5000) best = t;
      });
      return best || window.getSelection().toString() || '';
    }
    function extractRating(card){
      const starEl = qsaDeep('[aria-label*="stars"], [aria-label*="gwiaz"]', card)[0];
      const label = starEl?.getAttribute('aria-label') || '';
      const m = label.match(/([0-5](?:[,\.][0-9])?)\s*\/\s*5/);
      return m ? m[1].replace(',','.') : '';
    }

    async function pasteIntoReplyViaPopup(targetHash, fallbackCard, text){
      let card = findCardForHash(targetHash);
      if ((!card || !card.isConnected) && fallbackCard?.isConnected) card = fallbackCard;
      if (!card){ showToast('Nie mogę znaleźć opinii. Spróbuj ponownie.'); return; }
      const inlineField = qsaDeep('textarea, [contenteditable="true"], input[type="text"]', card)[0];
      if (inlineField){ await pasteIntoExistingTextarea(card, text); return; }
      let dialog = qsaDeep('[role="dialog"], [aria-modal="true"]')[0];
      if (!dialog){
        const replyBtn = findReplyButton(card);
        if (replyBtn){
          replyBtn.scrollIntoView({block:'center'});
          ['mouseover','mousedown','mouseup','click'].forEach(ev=> replyBtn.dispatchEvent(new MouseEvent(ev, {bubbles:true, cancelable:true, view:window})));
          await new Promise(r=> setTimeout(r, 1800));
          dialog = qsaDeep('[role="dialog"], [aria-modal="true"]')[0];
        }
      }
      if (dialog){ await pasteIntoExistingTextarea(dialog, text); return; }
      showToast('Nie mogę otworzyć pola odpowiedzi. Otwórz je ręcznie i użyj paska AI w oknie.');
    }

    async function pasteIntoExistingTextarea(root, text){
      const input = qsaDeep('textarea, [contenteditable="true"]', root)[0];
      if(!input){ showToast('Nie widzę pola odpowiedzi w oknie.'); return; }
      const current = (input.tagName==='TEXTAREA') ? input.value : input.innerText.trim();
      if (current && current !== text){
        const ok = confirm('W oknie jest już wpisana treść. Czy zastąpić ją wygenerowaną?');
        if (!ok) return;
      }
      if(input.tagName==='TEXTAREA'){ input.value = text; }
      else { input.innerHTML = text.replace(/\n/g,'<br>'); }
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    
