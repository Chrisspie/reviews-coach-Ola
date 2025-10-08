(function initScan(global){
  const RC = global.RC;
  const { state, config, dom, reviews, chips } = RC;
  const scanApi = RC.scan = RC.scan || {};

  scanApi.queue = function queueScan(force=false){
    const now = performance.now();
    const elapsed = now - state.lastScanRun;
    if (!force && elapsed < state.throttleMs){
      if (!state.scanTimerId){
        state.scanTimerId = setTimeout(()=>{
          state.scanTimerId = 0;
          scanApi.queue(true);
        }, Math.max(120, state.throttleMs - elapsed));
      }
      return;
    }
    if (state.scanPending) return;
    state.scanPending = true;
    requestAnimationFrame(()=>{
      state.scanPending = false;
      state.lastScanRun = performance.now();
      scanApi.scan();
    });
  };

  scanApi.scan = function scan(){
    scanApi.injectForCards();
  };

  scanApi.injectForCards = function injectForCards(){
    const cards = dom.qsaDeep(config.selectors.cards);
    const activeHashes = new Set();

    cards.forEach(card => {
      const extracted = reviews.extractText(card) || '';
      const fallback = (card.innerText || card.textContent || '').trim();
      const rawText = extracted || fallback;
      const normalizedText = rawText.replace(/\s+/g, ' ').trim();
      if (normalizedText.length < config.minReviewLength) return;
      const hashVal = (card.getAttribute('data-review-id') || '') + '|' + dom.hash(normalizedText.slice(0, 300));
      card.dataset.rcHash = hashVal;
      if (rawText) card.dataset.rcReviewText = rawText;
      const ratingSnapshot = reviews.extractRating(card) || card.dataset.rcRating || '';
      if (ratingSnapshot) card.dataset.rcRating = ratingSnapshot;
      const replyField = dom.qsaDeep(config.selectors.textInputs, card)[0];
      const replyBtn = dom.findReplyButton(card);
      if (!(replyField || replyBtn)) return;
      chips.ensureChipForCard(card, hashVal);
      activeHashes.add(hashVal);
    });

    chips.cleanupRegistry(activeHashes);
  };
})(window);
