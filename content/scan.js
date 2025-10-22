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
      const extracted = (reviews.extractText(card) || '').trim();
      const stored = (card.dataset.rcReviewText || '').trim();
      const fallback = (card.innerText || card.textContent || '').trim();
      const rawText = extracted || stored || fallback;

      if (extracted){
        card.dataset.rcReviewText = extracted;
      } else if (!stored && fallback){
        card.dataset.rcReviewText = fallback;
      }

      const extractedRating = (reviews.extractRating(card) || '').toString().trim();
      const storedRating = (card.dataset.rcRating || '').toString().trim();
      const ratingSnapshot = extractedRating || storedRating;

      const normalizedText = rawText.replace(/\s+/g, ' ').trim();
      const normalizedForHash = normalizedText.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      const sanitizedForHash = reviews.stripBlockedNormalizedText(normalizedForHash);
      const hashBasis = sanitizedForHash || normalizedForHash;
      if (hashBasis.length < config.minReviewLength) return;

      const reviewIdAttr = card.getAttribute('data-review-id') || card.getAttribute('data-reviewid') || '';
      const hashSource = reviewIdAttr ? '' : hashBasis.slice(0, 300);
      const hashVal = reviewIdAttr ? 'id:' + reviewIdAttr : 'text:' + dom.hash(hashSource);
      const prevHash = card.dataset.rcHash || '';
      if (prevHash && prevHash !== hashVal){
        delete card.dataset.rcReplyEligible;
      }
      card.dataset.rcHash = hashVal;

      if (ratingSnapshot) card.dataset.rcRating = ratingSnapshot;

      const replyField = dom.qsaDeep(config.selectors.textInputs, card)[0];
      const replyBtn = dom.findReplyButton(card);
      const hasReplyUi = Boolean(replyField || replyBtn);
      if (hasReplyUi){
        card.dataset.rcReplyEligible = '1';
      }
      if (!hasReplyUi && card.dataset.rcReplyEligible !== '1') return;

      chips.ensureChipForCard(card, hashVal);
      activeHashes.add(hashVal);
    });

    chips.cleanupRegistry(activeHashes);
  };
})(window);
