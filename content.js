const PANEL='rc-panel';
    let currentPanel=null;
    let currentPanelCleanup=null;
    const chipRegistry = new Map();
    const throttleMs = 400;
    let lastRun = 0;
    let scanPending = false;
    let scanTimer = 0;

    const mo = new MutationObserver(()=> queueScan());
    mo.observe(document, {childList:true, subtree:true});
    if (!window.__rcScrollHandler){
      window.__rcScrollHandler = ()=> queueScan();
      window.addEventListener('scroll', window.__rcScrollHandler, {passive:true});
    }
    if (!window.__rcResizeHandler){
      window.__rcResizeHandler = ()=> queueScan();
      window.addEventListener('resize', window.__rcResizeHandler);
    }
    if (!document.__rcVisibilityHandler){
      document.__rcVisibilityHandler = ()=>{ if (!document.hidden) queueScan(true); };
      document.addEventListener('visibilitychange', document.__rcVisibilityHandler);
    }
    if (!window.__rcScanInterval){
      window.__rcScanInterval = setInterval(()=> queueScan(), 2800);
    }
    queueScan(true);

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

    function queueScan(force=false){
      const now = performance.now();
      const elapsed = now - lastRun;
      if (!force && elapsed < throttleMs){
        if (!scanTimer){
          scanTimer = setTimeout(()=>{
            scanTimer = 0;
            queueScan(true);
          }, Math.max(120, throttleMs - elapsed));
        }
        return;
      }
      if (scanPending) return;
      scanPending = true;
      requestAnimationFrame(()=>{
        scanPending = false;
        lastRun = performance.now();
        scan();
      });
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

    function isElementVisible(el){
      if (!el || !el.isConnected) return false;
      if (el.offsetParent !== null) return true;
      const rect = el.getBoundingClientRect();
      if ((rect.width > 0 || rect.height > 0) && rect.top < window.innerHeight && rect.bottom > 0) return true;
      const style = window.getComputedStyle(el);
      return !(style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0');
    }

    function findWritableField(root, allowHidden=false){
      const candidates = qsaDeep('textarea, [contenteditable="true"], input[type="text"]', root);
      for (const el of candidates){
        if (!el) continue;
        if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
        if (el.tagName === 'INPUT' && (el.type && el.type.toLowerCase() !== 'text')) continue;
        if (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'INPUT'){
          if (isElementVisible(el)) return el;
        }
      }
      if (!allowHidden) return null;
      return candidates[0] || null;
    }

    function waitForCondition(check, timeoutMs=3500, intervalMs=120){
      return new Promise(resolve => {
        const start = performance.now();
        const tick = ()=>{
          try{
            const value = check();
            if (value){ resolve(value); return; }
          }catch(_){ }
          if (performance.now() - start >= timeoutMs){ resolve(null); return; }
          setTimeout(tick, intervalMs);
        };
        tick();
      });
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
      const position = { target: card, anchor: anchor };
      const scrollListeners = [];

      const repositionNow = ()=>{
        const ref = (position.target && position.target.isConnected) ? position.target : card;
        if (!ref || !document.body.contains(ref)){ closeCurrentPanel(); return; }
        const rect = ref.getBoundingClientRect();
        if (!rect.width && !rect.height) return;
        const anchorSource = (position.anchor && position.anchor.isConnected && position.anchor.getBoundingClientRect) ? position.anchor : ref;
        const anchorRect = anchorSource.getBoundingClientRect ? anchorSource.getBoundingClientRect() : rect;
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

      const onWindowResize = ()=> scheduleReposition();
      const ro = window.ResizeObserver ? new ResizeObserver(()=> scheduleReposition()) : null;
      const io = window.IntersectionObserver ? new IntersectionObserver(()=> scheduleReposition(), {threshold:[0,0.5,1]}) : null;

      const resetObservers = ()=>{
        while(scrollListeners.length){
          const { node, handler } = scrollListeners.pop();
          try{ node.removeEventListener('scroll', handler); }catch(_){ }
        }
        const nodesToTrack = new Set();
        if (position.target && position.target.isConnected) getScrollParents(position.target).forEach(n=> nodesToTrack.add(n));
        if (position.anchor && position.anchor.isConnected) getScrollParents(position.anchor).forEach(n=> nodesToTrack.add(n));
        if (!nodesToTrack.size) nodesToTrack.add(window);
        nodesToTrack.forEach(node=>{
          if (!node) return;
          const handler = ()=> scheduleReposition();
          try{ node.addEventListener('scroll', handler, {passive:true}); }
          catch(_){ try{ node.addEventListener('scroll', handler); }catch(__){} }
          scrollListeners.push({ node, handler });
        });
        if (ro){
          ro.disconnect();
          [position.target, position.anchor, panel].forEach(el=>{ if (el && el.isConnected){ try{ ro.observe(el); }catch(_){ } } });
        }
        if (io){
          io.disconnect();
          [position.target, position.anchor].forEach(el=>{ if (el && el.isConnected){ try{ io.observe(el); }catch(_){ } } });
        }
      };

      const cleanup = ()=>{
        while(scrollListeners.length){
          const { node, handler } = scrollListeners.pop();
          try{ node.removeEventListener('scroll', handler); }catch(_){ }
        }
        window.removeEventListener('resize', onWindowResize);
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
      wrap.updatePositionTargets = (target, anchorEl)=>{
        if (target && target.isConnected) position.target = target;
        if (anchorEl && anchorEl.isConnected) position.anchor = anchorEl;
        const isDialog = position.target && (position.target.getAttribute?.('role') === 'dialog' || position.target.getAttribute?.('aria-modal') === 'true');
        if (isDialog){ wrap.dataset.rcMode = 'dialog'; }
        else { delete wrap.dataset.rcMode; }
        resetObservers();
        scheduleReposition();
      };

      window.addEventListener('resize', onWindowResize);
      resetObservers();
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

      const wrap = currentPanel;
      const inlineField = findWritableField(card);
      if (inlineField && isElementVisible(inlineField)){
        wrap?.updatePositionTargets?.(card, inlineField);
        await pasteIntoExistingTextarea(card, text, false);
        return;
      }

      const replyBtn = findReplyButton(card);
      if (replyBtn){
        try{ replyBtn.scrollIntoView({block:'center', behavior:'smooth'}); }catch(_){ }
        try{ replyBtn.focus?.(); }catch(_){ }
        try{ replyBtn.click?.(); }catch(_){ }
        ['pointerdown','pointerup','mousedown','mouseup','click'].forEach(ev=>{
          try{ replyBtn.dispatchEvent(new MouseEvent(ev, {bubbles:true, cancelable:true, view:window})); }catch(_){ }
        });
      }

      const target = await waitForCondition(()=>{
        const inline = findWritableField(card);
        if (inline && isElementVisible(inline)) return { root: card, anchor: inline };
        const dialogs = qsaDeep('[role="dialog"], [aria-modal="true"]');
        for (const dlg of dialogs){
          const field = findWritableField(dlg);
          if (field){ return { root: dlg, anchor: field }; }
        }
        return null;
      }, 4200, 150);

      if (!target){
        showToast('Nie mogę otworzyć pola odpowiedzi. Otwórz je ręcznie i użyj paska AI w oknie.');
        return;
      }

      const anchorEl = target.anchor || findWritableField(target.root, true) || target.root;
      wrap?.updatePositionTargets?.(target.root, anchorEl);
      await pasteIntoExistingTextarea(target.root, text, target.root !== card);
    }

    async function pasteIntoExistingTextarea(root, text, allowHidden=false){
      const input = findWritableField(root, allowHidden);
      if(!input){ showToast('Nie widzę pola odpowiedzi w oknie.'); return; }
      const current = (input.tagName==='TEXTAREA') ? input.value : input.innerText.trim();
      if (current && current !== text){
        const ok = confirm('W oknie jest już wpisana treść. Czy zastąpić ją wygenerowaną?');
        if (!ok) return;
      }
      if(input.tagName==='TEXTAREA'){ input.value = text; }
      else { input.innerHTML = text.replace(/(?:\r?\n)/g,'<br>'); }
      let inputEventDispatched = false;
      try{
        const evt = new InputEvent('input',{bubbles:true, cancelable:true, data:text, inputType:'insertText'});
        input.dispatchEvent(evt);
        inputEventDispatched = true;
      }catch(_){ }
      if (!inputEventDispatched){ input.dispatchEvent(new Event('input',{bubbles:true})); }
      try{ input.dispatchEvent(new Event('change',{bubbles:true})); }catch(_){ }
      try{ input.focus?.(); }catch(_){ }
      try{
        if (input.setSelectionRange){ const pos = input.value.length; input.setSelectionRange(pos, pos); }
        else if (input.isContentEditable){
          const range = document.createRange();
          range.selectNodeContents(input);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }catch(_){ }
    }

