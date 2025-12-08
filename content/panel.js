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
      if (!wrap.isConnected || state.currentPanel !== wrap) return;
      renderMainPanel(panelEl, card, reviewSource);
    } catch (err){
      console.error('[RC] Nie udalo sie otworzyc panelu', err);
      if (wrap.isConnected){
        panelEl.innerHTML = '<div class="rc-error">Nie udalo sie otworzyc panelu.</div>';
      }
    }
  };

  function formatTrialDuration(seconds){
    if (!Number.isFinite(seconds)) return null;
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const parts = [];
    if (days > 0){
      parts.push(`${days} ${days === 1 ? 'dzień' : 'dni'}`);
    }
    if (hours > 0 && parts.length < 2){
      parts.push(`${hours} godz.`);
    }
    if (days === 0 && minutes > 0 && parts.length < 2){
      parts.push(`${minutes} min`);
    }
    if (!parts.length) return 'mniej niż minutę';
    return parts.join(' ');
  }

  function getRemainingSeconds(quota){
    if (!quota) return null;
    if (typeof quota.remainingSeconds === 'number') return quota.remainingSeconds;
    if (quota.expiresAt){
      const ts = new Date(quota.expiresAt).getTime();
      if (!Number.isNaN(ts)){
        return Math.max(0, Math.floor((ts - Date.now()) / 1000));
      }
    }
    return null;
  }

  function updateQuotaInfo(panelEl, quota){
    const box = panelEl.querySelector('#rc_quota');
    const upgradeBtn = panelEl.querySelector('#rc_upgrade');
    if (!box) return;
    box.innerHTML = '';
    box.classList.remove('rc-quota-warning');
    box.style.display = 'none';
    if (upgradeBtn){
      upgradeBtn.style.display = 'none';
      upgradeBtn.removeAttribute('data-url');
    }
    if (!quota) return;
    const upgradeUrl = (quota.upgradeUrl || '').trim();
    const type = quota.type || (quota.limit ? 'usage' : null);
    const attachUpgradeCta = ()=>{
      if (!upgradeUrl) return;
      box.appendChild(document.createTextNode(' '));
      const link = document.createElement('a');
      link.href = upgradeUrl;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = 'Kup abonament';
      link.className = 'rc-link';
      box.appendChild(link);
      if (upgradeBtn){
        upgradeBtn.dataset.url = upgradeUrl;
        upgradeBtn.style.display = 'inline-flex';
      }
    };
    if (type === 'time'){
      box.style.display = 'block';
      const remainingSeconds = getRemainingSeconds(quota);
      if (Number.isFinite(remainingSeconds) && remainingSeconds > 0){
        const human = formatTrialDuration(remainingSeconds) || '';
        const expiresAt = quota.expiresAt ? new Date(quota.expiresAt) : null;
        const expiresLabel = expiresAt && !Number.isNaN(expiresAt.getTime())
          ? expiresAt.toLocaleString(navigator.language || 'pl-PL', { dateStyle: 'short', timeStyle: 'short' })
          : null;
        box.textContent = human ? `Darmowy okres próbny kończy się za ${human}.` : 'Darmowy okres próbny nadal trwa.';
        if (expiresLabel){
          const extra = document.createElement('span');
          extra.textContent = ` (do ${expiresLabel})`;
          box.appendChild(extra);
        }
        return;
      }
      box.classList.add('rc-quota-warning');
      const text = document.createElement('span');
      text.textContent = 'Darmowy okres próbny wygasł.';
      box.appendChild(text);
      attachUpgradeCta();
      return;
    }
    const limit = Number(quota.limit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const remaining = Math.max(0, Number(quota.remaining ?? 0));
    box.style.display = 'block';
    if (remaining > 0){
      box.textContent = `Pozostało ${remaining} z ${limit} darmowych odpowiedzi.`;
      return;
    }
    box.classList.add('rc-quota-warning');
    const text = document.createElement('span');
    text.textContent = `Limit ${limit} darmowych odpowiedzi został wykorzystany.`;
    box.appendChild(text);
    attachUpgradeCta();
  }

  function renderMainPanel(panelEl, card, reviewSource){
    if (!panelEl.parentElement || !panelEl.parentElement.isConnected) return;
    const source = reviewSource || { text: reviews.extractText(card), rating: reviews.extractRating(card) };
    const reviewText = (source.text || '').trim();
    const reviewRating = (source.rating || '').toString().trim();
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
      <div class="rc-preview" id="rc_preview"><div style="display:flex;align-items:center;gap:8px"><div class="rc-spinner"></div><span>Generuje...</span></div></div>
      <div id="rc_quota" class="rc-quota"></div>
      <div class="rc-actions">
        <button id="rc_copy" class="rc-primary">Skopiuj wygenerowana odpowiedz</button>
        <button id="rc_regen" class="rc-secondary">Regeneruj</button>
        <button id="rc_upgrade" class="rc-primary rc-upgrade" style="display:none">Kup abonament</button>
        <button id="rc_close" class="rc-secondary">Zamknij</button>
        <span class="rc-note">Kopiuje do schowka i otwiera okno odpowiedzi.</span>
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

    panelEl.querySelector('#rc_copy').onclick = async ()=>{
      const targetHash = panelEl.parentElement?.dataset.rcTarget || card.dataset.rcHash || '';
      const activeStyle = seg.querySelector('.active')?.dataset.style || 'soft';
      const textValue = variants[activeStyle] || '';
      if (!textValue){
        panelEl.querySelector('#rc_err').textContent = 'Brak tresci do skopiowania.';
        return;
      }
      panelEl.querySelector('#rc_err').textContent = '';
      const copied = await panelApi.copyToClipboard(textValue);
      if (!copied){
        panelEl.querySelector('#rc_err').textContent = 'Nie udalo sie skopiowac tresci.';
        return;
      }
      dom.showToast('Skopiowano do schowka.');
      await panelApi.openReplyPopup(targetHash, card, { suppressWarnings: true });
    };

    panelEl.querySelector('#rc_regen').onclick = ()=>{
      panelEl.querySelector('#rc_err').textContent = '';
      panelApi.generateReplies(panelEl, card, variants, true, { text: reviews.extractText(card), rating: reviews.extractRating(card) });
    };

    panelEl.querySelector('#rc_close').onclick = ()=> dom.closeCurrentPanel();

    const upgradeBtn = panelEl.querySelector('#rc_upgrade');
    if (upgradeBtn){
      upgradeBtn.addEventListener('click', ()=>{
        const url = (upgradeBtn.dataset.url || '').trim();
        if (!url){
          dom.showToast('Brak linku do abonamentu.');
          return;
        }
        try {
          window.open(url, '_blank', 'noopener');
        } catch (_){
          window.location.href = url;
        }
      });
    }

    panelApi.generateReplies(panelEl, card, variants, false, { text: reviewText, rating: reviewRating });
    panelEl.parentElement?.reposition?.();
    chrome.runtime.sendMessage({ type: 'GET_QUOTA_STATUS' }, (resp)=>{
      if (panelEl.isConnected) updateQuotaInfo(panelEl, resp && resp.quota ? resp.quota : null);
    });
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
      updateQuotaInfo(panelEl, resp && resp.quota ? resp.quota : null);
      if (!resp || resp.error){
        errorBox.textContent = resp?.error || 'Blad generowania (sprawdz klucz).';
        if (resp?.errorCode === 'AUTH_REQUIRED'){
          panelEl.parentElement?.reposition?.();
          return;
        }
        if (resp?.errorCode === 'FREE_LIMIT_REACHED' && resp?.upgradeUrl){
          const quota = resp?.quota || { limit: resp.freeLimit || 0, remaining: 0, upgradeUrl: resp.upgradeUrl };
          updateQuotaInfo(panelEl, quota);
        }
        const activeStyle = seg.querySelector('.active')?.dataset.style || 'soft';
        const fallback = variants[activeStyle] || variants.soft || variants.brief || variants.proactive || '...';
        preview.textContent = fallback;
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

  panelApi.copyToClipboard = async function copyToClipboard(text){
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText){
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_){ }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_){ ok = false; }
    textarea.remove();
    return ok;
  };

  panelApi.openReplyPopup = async function openReplyPopup(targetHash, fallbackCard, options = {}){
    const suppressWarnings = Boolean(options && options.suppressWarnings);
    let card = chips.findCardForHash(targetHash);
    if ((!card || !card.isConnected) && fallbackCard?.isConnected) card = fallbackCard;
    if (!card){
      if (!suppressWarnings) dom.showToast('Nie moge znalezc opinii. Sprobuj ponownie.');
      return;
    }

    const wrap = state.currentPanel;
    const inlineField = dom.findWritableField(card);
    if (inlineField && dom.isElementVisible(inlineField)){
      wrap?.updatePositionTargets?.(card, inlineField);
      panelApi.focusReplyField(inlineField);
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
      if (!suppressWarnings) dom.showToast('Nie moge otworzyc pola odpowiedzi. Otworz je recznie i wklej odpowiedz.');
      return;
    }

    const anchorEl = target.anchor || dom.findWritableField(target.root, true) || target.root;
    wrap?.updatePositionTargets?.(target.root, anchorEl);
    panelApi.focusReplyField(target.root, target.root !== card);
  };

  panelApi.focusReplyField = function focusReplyField(target, allowHidden=false){
    let input = null;
    if (target && target.nodeType === 1 && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)){
      input = target;
    } else {
      input = dom.findWritableField(target, allowHidden);
    }
    if (!input){
      dom.showToast('Nie widze pola odpowiedzi w oknie.');
      return;
    }
    try { input.focus?.(); } catch (_){ }
    try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_){ }
    try {
      if (input.tagName === 'TEXTAREA' && input.setSelectionRange){
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
      } else if (input.isContentEditable){
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    } catch (_){ }
  };
})(window);

