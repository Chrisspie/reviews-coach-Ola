(function initChips(global){
  const RC = global.RC;
  const { state, dom } = RC;
  const chips = RC.chips = RC.chips || {};

  chips.findCardForHash = function findCardForHash(hashVal){
    if (!hashVal) return null;
    const entry = state.chipRegistry.get(hashVal);
    if (entry){
      if (entry.card?.isConnected) return entry.card;
      if (entry.button?.isConnected){
        const host = entry.button.closest('[data-rc-hash]');
        if (host){ entry.card = host; return host; }
      }
    }
    try {
      return document.querySelector(`[data-rc-hash="${hashVal}"]`);
    } catch (_){
      return null;
    }
  };

  function onChipClick(event){
    const button = event.currentTarget;
    const targetHash = button.getAttribute('data-rc-hash') || '';
    const hostCard = button.closest('[data-rc-hash]');
    const card = (hostCard && hostCard.dataset.rcHash === targetHash)
      ? hostCard
      : chips.findCardForHash(targetHash);
    if (!card){
      dom.showToast('Nie moge znalezc opinii dla tej podpowiedzi.');
      return;
    }
    const panel = global.RC.panel;
    if (!panel || typeof panel.openForCard !== 'function'){
      dom.showToast('Panel jeszcze sie laduje, sprobuj ponownie.');
      return;
    }
    panel.openForCard(card, button);
  }

  chips.createChipButton = function createChipButton(hashVal){
    const btn = document.createElement('button');
    btn.className = 'rc-chip-btn';
    btn.setAttribute('data-rc-hash', hashVal);
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.6 3.7L17 8.2l-3.4 1.5L12 13l-1.6-3.3L7 8.2l3.4-1.5L12 3z" stroke="currentColor" stroke-width="1.6"/></svg><span>Podpowiedz odpowiedz</span>';
    btn.addEventListener('click', onChipClick);
    return btn;
  };

  chips.placeChip = function placeChip(card, btn){
    if (!card || !btn) return;
    if (!card.dataset.rcHash) card.dataset.rcHash = btn.getAttribute('data-rc-hash') || '';
    const duplicates = card.querySelectorAll('.rc-chip-btn');
    duplicates.forEach(el => { if (el !== btn) el.remove(); });
    if (btn.parentElement && card.contains(btn)) return;

    const replyBtn = dom.findReplyButton(card);
    if (replyBtn && replyBtn.parentElement){
      replyBtn.insertAdjacentElement('afterend', btn);
      return;
    }

    const replyField = dom.qsaDeep(RC.config.selectors.textInputs, card)[0];
    if (replyField && replyField.parentElement){
      replyField.insertAdjacentElement('beforebegin', btn);
      return;
    }

    card.appendChild(btn);
  };

  chips.ensureChipForCard = function ensureChipForCard(card, hashVal){
    if (!card || !hashVal) return;
    let entry = state.chipRegistry.get(hashVal);
    if (entry && (!entry.button || !entry.button.isConnected)){
      state.chipRegistry.delete(hashVal);
      entry = null;
    }
    if (!entry){
      entry = { button: chips.createChipButton(hashVal), card };
      state.chipRegistry.set(hashVal, entry);
    }
    entry.card = card;
    chips.placeChip(card, entry.button);
  };

  chips.cleanupRegistry = function cleanupRegistry(activeHashes){
    state.chipRegistry.forEach((entry, hashVal) => {
      if (!entry || !entry.button || !entry.button.isConnected || !activeHashes.has(hashVal)){
        try { entry?.button?.remove(); } catch (_){ }
        state.chipRegistry.delete(hashVal);
      }
    });
  };
})(window);
