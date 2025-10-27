(function initPanel(global){
  const RC = global.RC;
  const { state, dom, reviews, chips } = RC;
  const panelApi = RC.panel = RC.panel || {};

  panelApi.openForCard = async function openForCard(card, anchor){
    if (!card) return;
    const root = dom.ensureRoot();
    dom.closeCurrentPanel();

    const wrap = document.createElement('div');
    wrap.className = 'rc-panel-wrap';
    wrap.dataset.rcTarget = card.dataset.rcHash || '';

    const panelEl = document.createElement('div');
    panelEl.className = state.panelId;
    wrap.appendChild(panelEl);
    root.appendChild(wrap);
    state.currentPanel = wrap;

    const reviewSource = {
      text: (card.dataset.rcReviewText || reviews.extractText(card) || '').trim(),
      rating: (card.dataset.rcRating || reviews.extractRating(card) || '').toString().trim()
    };
    card.dataset.rcReviewText = reviewSource.text;
    card.dataset.rcRating = reviewSource.rating;

    const margin = 16;
    let raf = 0;
    const position = { target: card, anchor };
    const scrollListeners = [];

    const repositionNow = ()=>{
      const ref = (position.target && position.target.isConnected) ? position.target : card;
      if (!ref || !document.body.contains(ref)){
        dom.closeCurrentPanel();
        return;
      }
      const rect = ref.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const anchorSource = (position.anchor && position.anchor.isConnected && position.anchor.getBoundingClientRect)
        ? position.anchor
        : ref;
      const anchorRect = anchorSource.getBoundingClientRect ? anchorSource.getBoundingClientRect() : rect;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const panelRect = panelEl.getBoundingClientRect();
      const mode = wrap.dataset.rcMode || 'card';
      let left;
      let top;
      if (mode === 'dialog'){
        left = anchorRect.left;
        if (left + panelRect.width + margin > viewportWidth){ left = viewportWidth - panelRect.width - margin; }
        if (left < margin) left = margin;
        top = anchorRect.bottom + margin;
        if (top + panelRect.height + margin > viewportHeight){
          top = Math.max(margin, anchorRect.top - panelRect.height - margin);
        }
      } else {
        left = anchorRect.right + margin;
        if (left + panelRect.width + margin > viewportWidth){
          left = rect.left - panelRect.width - margin;
          if (left < margin){ left = Math.max(margin, viewportWidth - panelRect.width - margin); }
        }
        top = Math.min(rect.top, anchorRect.top);
        const maxTop = viewportHeight - panelRect.height - margin;
        top = Math.min(Math.max(margin, top), Math.max(margin, maxTop));
      }
      wrap.style.top = `${Math.round(top)}px`;
      wrap.style.left = `${Math.round(left)}px`;
    };

    const scheduleReposition = ()=>{
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(()=>{
        raf = 0;
        repositionNow();
      });
    };

    const onWindowResize = ()=> scheduleReposition();
    const resizeObserver = window.ResizeObserver ? new ResizeObserver(()=> scheduleReposition()) : null;
    const intersectionObserver = window.IntersectionObserver ? new IntersectionObserver(()=> scheduleReposition(), { threshold: [0, 0.5, 1] }) : null;

    const resetObservers = ()=>{
      while (scrollListeners.length){
        const { node, handler } = scrollListeners.pop();
        try { node.removeEventListener('scroll', handler); } catch (_){ }
      }
      const nodesToTrack = new Set();
      if (position.target && position.target.isConnected) dom.getScrollParents(position.target).forEach(n => nodesToTrack.add(n));
      if (position.anchor && position.anchor.isConnected) dom.getScrollParents(position.anchor).forEach(n => nodesToTrack.add(n));
      if (!nodesToTrack.size) nodesToTrack.add(window);
      nodesToTrack.forEach(node => {
        if (!node) return;
        const handler = ()=> scheduleReposition();
        try { node.addEventListener('scroll', handler, { passive: true }); }
        catch (_){ try { node.addEventListener('scroll', handler); } catch (__){ } }
        scrollListeners.push({ node, handler });
      });
      if (resizeObserver){
        resizeObserver.disconnect();
        [position.target, position.anchor, panelEl].forEach(el => {
          if (el && el.isConnected){
            try { resizeObserver.observe(el); } catch (_){ }
          }
        });
      }
      if (intersectionObserver){
        intersectionObserver.disconnect();
        [position.target, position.anchor].forEach(el => {
          if (el && el.isConnected){
            try { intersectionObserver.observe(el); } catch (_){ }
          }
        });
      }
    };

    const cleanup = ()=>{
      while (scrollListeners.length){
        const { node, handler } = scrollListeners.pop();
        try { node.removeEventListener('scroll', handler); } catch (_){ }
      }
      window.removeEventListener('resize', onWindowResize);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver?.disconnect?.();
      intersectionObserver?.disconnect?.();
      state.fieldResetTracker?.stop?.('cleanup');
      if (state.currentPanel === wrap) state.currentPanel = null;
      state.currentPanelCleanup = null;
      if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
    };

    state.currentPanelCleanup = cleanup;
    wrap.reposition = scheduleReposition;
    wrap.updatePositionTargets = (target, anchorEl)=>{
      if (target && target.isConnected) position.target = target;
      if (anchorEl && anchorEl.isConnected) position.anchor = anchorEl;
      const isDialog = position.target && (position.target.getAttribute?.('role') === 'dialog' || position.target.getAttribute?.('aria-modal') === 'true');
      if (isDialog) wrap.dataset.rcMode = 'dialog';
      else delete wrap.dataset.rcMode;
      resetObservers();
      scheduleReposition();
    };

    window.addEventListener('resize', onWindowResize);
    resetObservers();
    repositionNow();

    try {
      const { apiKey } = await chrome.storage.sync.get(['apiKey']);
      if (!wrap.isConnected || state.currentPanel !== wrap) return;
      if (!apiKey){
        renderKeyForm(panelEl, card, reviewSource);
      } else {
        renderMainPanel(panelEl, card, reviewSource);
      }
    } catch (err){
      console.error('[RC] Nie udalo sie pobrac konfiguracji', err);
      if (wrap.isConnected){
        panelEl.innerHTML = '<div class="rc-error">Nie udalo sie wczytac konfiguracji.</div>';
      }
    }
  };

  function renderKeyForm(panelEl, card, reviewSource){
    if (!panelEl.parentElement || !panelEl.parentElement.isConnected) return;
    const source = reviewSource || { text: reviews.extractText(card), rating: reviews.extractRating(card) };
    const reviewText = (source.text || '').trim();
    const reviewRating = (source.rating || '').toString().trim();
    card.dataset.rcReviewText = reviewText;
    card.dataset.rcRating = reviewRating;
    const ratingLabel = reviewRating ? `Ocena: ${reviewRating}/5` : 'Ocena: brak danych';
    const ratingHtml = dom.escapeHtml(ratingLabel);
    const reviewTrimmed = reviewText.length > 320 ? reviewText.slice(0, 320).trim() + '...' : reviewText;
    const reviewHtml = reviewTrimmed
      ? dom.escapeAndNl2br(reviewTrimmed)
      : '<span class="rc-context-empty">Brak tresci opinii.</span>';

    panelEl.innerHTML = `
      <div class="rc-head"><div class="rc-title"><span class="rc-dot"></span> Klucz Gemini</div></div>
      <div class="rc-context" style="margin:12px 0 16px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;">
        <div class="rc-context-rating" style="font-size:13px;font-weight:600;color:#111827;">${ratingHtml}</div>
        <div class="rc-context-review" style="margin-top:6px;font-size:13px;line-height:1.45;color:#374151;">${reviewHtml}</div>
      </div>
      <div class="rc-body" style="display:flex;align-items:center;gap:8px">
        <input id="rc_apiKey" type="password" placeholder="Wklej Gemini API key" class="rc-input" style="flex:1">
        <button id="rc_save" class="rc-primary">Zapisz</button>
        <button id="rc_close" class="rc-secondary">Zamknij</button>
      </div>
      <div class="rc-note" style="margin-top:8px">Klucz uzywany tylko lokalnie. Mozesz go usunac w kazdej chwili.</div>`;

    panelEl.querySelector('#rc_save').onclick = async () => {
      const keyField = panelEl.querySelector('#rc_apiKey');
      const value = keyField?.value.trim();
      if (!value) return;
      await chrome.storage.sync.set({ apiKey: value });
      renderMainPanel(panelEl, card, source);
    };
    panelEl.querySelector('#rc_close').onclick = ()=> dom.closeCurrentPanel();
    panelEl.parentElement?.reposition?.();
  }

  function renderMainPanel(panelEl, card, reviewSource){
    if (!panelEl.parentElement || !panelEl.parentElement.isConnected) return;
    const source = reviewSource || { text: reviews.extractText(card), rating: reviews.extractRating(card) };
    const reviewText = (source.text || '').trim();
    const reviewRating = (source.rating || '').toString().trim();
    const ratingLabel = reviewRating ? `Ocena: ${reviewRating}/5` : 'Ocena: brak danych';
    const ratingHtml = dom.escapeHtml(ratingLabel);
    const reviewTrimmed = reviewText.length > 320 ? reviewText.slice(0, 320).trim() + '...' : reviewText;
    const reviewHtml = reviewTrimmed
      ? dom.escapeAndNl2br(reviewTrimmed)
      : '<span class="rc-context-empty">Brak tresci opinii.</span>';
    const variants = { soft: '', brief: '', proactive: '' };

    panelEl.innerHTML = `
      <div class="rc-head">
        <div class="rc-title"><span class="rc-dot"></span> Wybierz styl i sprawdz odpowiedz</div>
        <div class="rc-seg" id="rc_seg">
          <button data-style="soft" class="active">Delikatna</button>
          <button data-style="brief">Rzeczowa</button>
          <button data-style="proactive">Proaktywna</button>
        </div>
      </div>
      <div class="rc-context" style="margin:12px 0 16px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;">
        <div class="rc-context-rating" style="font-size:13px;font-weight:600;color:#111827;">${ratingHtml}</div>
        <div class="rc-context-review" style="margin-top:6px;font-size:13px;line-height:1.45;color:#374151;">${reviewHtml}</div>
      </div>
      <div class="rc-preview" id="rc_preview"><div style="display:flex;align-items:center;gap:8px"><div class="rc-spinner"></div><span>Generuje...</span></div></div>
      <div class="rc-actions">
        <button id="rc_insert" class="rc-primary">Wstaw wybrana</button>
        <button id="rc_regen" class="rc-secondary">Regeneruj</button>
        <button id="rc_close" class="rc-secondary">Zamknij</button>
        <span class="rc-note">Tylko wkleja do pola - <b>nie publikuje automatycznie</b>.</span>
      </div>
      <div id="rc_err" class="rc-error"></div>
    `;

    const seg = panelEl.querySelector('#rc_seg');
    seg.addEventListener('click', (event)=>{
      const button = event.target.closest('button[data-style]');
      if (!button) return;
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      button.classList.add('active');
      panelEl.querySelector('#rc_preview').textContent = variants[button.dataset.style] || '...';
    });

    panelEl.querySelector('#rc_insert').onclick = async ()=>{
      const targetHash = panelEl.parentElement?.dataset.rcTarget || card.dataset.rcHash || '';
      const activeStyle = seg.querySelector('.active')?.dataset.style || 'soft';
      const textValue = variants[activeStyle] || '';
      if (!textValue){
        panelEl.querySelector('#rc_err').textContent = 'Brak tresci do wstawienia.';
        return;
      }
      await panelApi.pasteIntoReply(targetHash, card, textValue);
    };

    panelEl.querySelector('#rc_regen').onclick = ()=>{
      variants.soft = variants.brief = variants.proactive = '';
      panelEl.querySelector('#rc_err').textContent = '';
      panelApi.generateReplies(panelEl, card, variants, true, { text: reviews.extractText(card), rating: reviews.extractRating(card) });
    };

    panelEl.querySelector('#rc_close').onclick = ()=> dom.closeCurrentPanel();

    panelApi.generateReplies(panelEl, card, variants, false, { text: reviewText, rating: reviewRating });
    panelEl.parentElement?.reposition?.();
  }

  panelApi.generateReplies = function generateReplies(panelEl, card, variants, force, reviewSource){
    const preview = panelEl.querySelector('#rc_preview');
    const seg = panelEl.querySelector('#rc_seg');
    if (!force && variants.soft){
      const active = seg.querySelector('.active')?.dataset.style || 'soft';
      preview.textContent = variants[active] || '...';
      return;
    }

    preview.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><div class="rc-spinner"></div><span>Generuje...</span></div>';
    panelEl.parentElement?.reposition?.();

    const source = reviewSource || { text: reviews.extractText(card), rating: reviews.extractRating(card) };
    const payload = {
      text: (source.text || '').trim(),
      rating: (source.rating || '').toString().trim()
    };
    console.log('[RC] payload wysylany do SW:', { ...payload });

    chrome.runtime.sendMessage({ type: 'GENERATE_ALL', payload }, (resp)=>{
      if (!panelEl.isConnected) return;
      const errorBox = panelEl.querySelector('#rc_err');
      if (!resp || resp.error){
        errorBox.textContent = resp?.error || 'Blad generowania (sprawdz klucz).';
        preview.textContent = '...';
        panelEl.parentElement?.reposition?.();
        return;
      }
      variants.soft = resp.soft || '';
      variants.brief = resp.brief || '';
      variants.proactive = resp.proactive || '';
      const active = seg.querySelector('.active')?.dataset.style || 'soft';
      preview.textContent = variants[active] || '...';
      errorBox.textContent = '';
      panelEl.parentElement?.reposition?.();
    });
  };

  function describeField(field){
    if (!field) return null;
    return {
      tag: field.tagName,
      type: field.type || '',
      isContentEditable: !!field.isContentEditable,
      valueLength: readFieldValue(field).length
    };
  }

  function readFieldValue(input){
    if (!input) return '';
    if (input.tagName === 'TEXTAREA') return input.value;
    if (input.tagName === 'INPUT' && typeof input.value === 'string') return input.value;
    if (input.isContentEditable) return input.innerText || '';
    if (typeof input.value === 'string') return input.value;
    return input.textContent || '';
  }

  function writeFieldValue(input, text){
    if (!input) return false;
    if (input.tagName === 'TEXTAREA' || (input.tagName === 'INPUT' && typeof input.value === 'string')){
      input.value = text;
    } else if (input.isContentEditable){
      input.innerHTML = dom.escapeAndNl2br(text);
    } else {
      input.textContent = text;
    }
    let inputEventDispatched = false;
    try {
      const evt = new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' });
      input.dispatchEvent(evt);
      inputEventDispatched = true;
    } catch (_){ }
    if (!inputEventDispatched){
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_){ }
    }
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_){ }
    return true;
  }

  function focusField(input){
    try { input.focus?.(); } catch (_){ }
    try {
      if (input.setSelectionRange){
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
      } else if (input.isContentEditable){
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges?.();
        selection?.addRange(range);
      }
    } catch (_){ }
  }

  panelApi.pasteIntoReply = async function pasteIntoReply(targetHash, fallbackCard, text){
    let card = chips.findCardForHash(targetHash);
    if ((!card || !card.isConnected) && fallbackCard?.isConnected) card = fallbackCard;
    if (!card){
      dom.showToast('Nie moge znalezc opinii. Sprobuj ponownie.');
      return;
    }

    const wrap = state.currentPanel;
    const inlineField = dom.findWritableField(card);
    if (inlineField && dom.isElementVisible(inlineField)){
      wrap?.updatePositionTargets?.(card, inlineField);
      await panelApi.fillReplyField(card, text, false);
      return;
    }

    const replyBtn = dom.findReplyButton(card);
    if (replyBtn){
      try { replyBtn.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_){ }
      try { replyBtn.focus?.(); } catch (_){ }
      try { replyBtn.click?.(); } catch (_){ }
      ['pointerdown','pointerup','mousedown','mouseup','click'].forEach(ev => {
        try { replyBtn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })); } catch (_){ }
      });
    }

    const target = await dom.waitForCondition(()=>{
      const inline = dom.findWritableField(card);
      if (inline && dom.isElementVisible(inline)) return { root: card, anchor: inline };
      const dialogs = dom.qsaDeep('[role="dialog"], [aria-modal="true"]');
      for (const dlg of dialogs){
        const field = dom.findWritableField(dlg);
        if (field && dom.isElementVisible(field)) return { root: dlg, anchor: field };
        const fallbackField = dom.findWritableField(dlg, true);
        if (fallbackField) return { root: dlg, anchor: fallbackField };
      }
      return null;
    }, 4200, 150);

    if (!target){
      dom.showToast('Nie moge otworzyc pola odpowiedzi. Otworz je recznie i uzyj paska AI w oknie.');
      return;
    }

    const anchorEl = target.anchor || dom.findWritableField(target.root, true) || target.root;
    wrap?.updatePositionTargets?.(target.root, anchorEl);
    await panelApi.fillReplyField(target.root, text, target.root !== card);
  };

  panelApi.fillReplyField = async function fillReplyField(root, text, allowHidden=false){
    const input = dom.findWritableField(root, allowHidden);
    if (!input){
      dom.showToast('Nie widze pola odpowiedzi w oknie.');
      return;
    }
    const rawCurrentValue = readFieldValue(input);
    const currentValue = (input.tagName === 'TEXTAREA' || (input.tagName === 'INPUT' && typeof input.value === 'string'))
      ? rawCurrentValue
      : rawCurrentValue.trim();
    if (currentValue && currentValue !== text){
      const ok = confirm('W oknie jest juz wpisana tresc. Czy zastapic ja wygenerowana?');
      if (!ok) return;
    }
    writeFieldValue(input, text);
    focusField(input);
    panelApi.observeFieldForReset(root, text, { allowHidden });
  };

  panelApi.observeFieldForReset = function observeFieldForReset(root, text, options={}){
    if (!root || !text) return;
    const allowHidden = !!options.allowHidden;
    const timeoutMs = Math.max(2000, options.timeoutMs || 16000);

    state.fieldResetTracker?.stop?.('replaced');

    const tracker = { stop: ()=>{} };
    state.fieldResetTracker = tracker;

    console.log('[RC][panel] observeFieldForReset start', {
      root: root?.tagName || root?.nodeName || 'UNKNOWN',
      textLength: text.length,
      preview: text.slice(0, 80)
    });

    let field = dom.findWritableField(root, allowHidden);
    if (!field){
      console.log('[RC][panel] observeFieldForReset stop (no field)');
      state.fieldResetTracker = null;
      return;
    }

    console.log('[RC][panel] observeFieldForReset tracking new field', describeField(field));

    let attempts = 0;
    let stableTicks = 0;
    let stopped = false;

    const stop = (reason)=>{
      if (stopped) return;
      stopped = true;
      if (poller) clearInterval(poller);
      if (timeoutId) clearTimeout(timeoutId);
      try { observer?.disconnect?.(); } catch (_){ }
      console.log('[RC][panel] observeFieldForReset stop', { reason, attempts });
      if (state.fieldResetTracker === tracker) state.fieldResetTracker = null;
    };

    tracker.stop = stop;

    const ensureField = ()=>{
      if (field && field.isConnected) return field;
      const next = dom.findWritableField(root, allowHidden);
      if (next){
        field = next;
        console.log('[RC][panel] observeFieldForReset tracking new field', describeField(field));
      }
      return field;
    };

    const restoreValue = (reason)=>{
      const target = ensureField();
      if (!target) return;
      attempts++;
      console.log('[RC][panel] observeFieldForReset restoring value', { reason, attempts });
      writeFieldValue(target, text);
    };

    const poller = setInterval(()=>{
      const target = ensureField();
      if (!target){
        stop('field-missing');
        return;
      }
      const value = readFieldValue(target);
      if (value === text){
        stableTicks++;
        if (stableTicks >= 5) stop('stable');
        return;
      }
      if (!value || !value.trim()){
        if (attempts >= 3){
          stop('max-attempts');
          return;
        }
        stableTicks = 0;
        restoreValue('empty');
        return;
      }
      stop('changed-by-user');
    }, 180);

    const observer = new MutationObserver(()=>{
      const value = readFieldValue(field);
      if (value === text) return;
      if (!value || !value.trim()){
        if (attempts < 3){
          stableTicks = 0;
          restoreValue('mutation');
        } else {
          stop('max-attempts');
        }
      }
    });

    try {
      observer.observe(field, { childList: true, characterData: true, subtree: true, attributes: true });
    } catch (_){ }

    const timeoutId = setTimeout(()=> stop('expired'), timeoutMs);

    console.log('[RC][panel] observeFieldForReset armed', {
      observer: !!observer,
      poller: true,
      timeoutMs
    });
  };
})(window);


