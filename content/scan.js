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

  function normalizeActionText(node){
    return String(node || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isExactReplyAction(node){
    if (!node || node.classList?.contains('rc-chip-btn')) return false;
    if (node.closest?.('#rc_root')) return false;
    const labels = [
      node.getAttribute?.('aria-label') || '',
      node.getAttribute?.('title') || '',
      node.textContent || ''
    ].map(normalizeActionText).filter(Boolean);
    return labels.some(text => /^(odpowiedz|reply|respond)$/.test(text));
  }

  function exactReplyActionCount(root){
    if (!root) return 0;
    return dom.qsaDeep('button, [role="button"], a[href], [role="link"]', root).filter(isExactReplyAction).length;
  }

  function findCardFromReplyAction(button, stats){
    let node = button?.parentElement || null;
    let depth = 0;
    let lastReject = 'no-parent';
    while (node && node !== document.body && depth < 8){
      depth += 1;
      if (node.closest?.('#rc_root')){
        stats.rejected.ownUi += 1;
        return null;
      }

      const replyActionCount = exactReplyActionCount(node);
      if (replyActionCount > 1){
        stats.rejected.tooManyReplyActions += 1;
        return null;
      }

      const rating = (reviews.extractRating(node) || '').toString().trim();
      const text = (reviews.extractText(node) || '').trim();
      if (replyActionCount === 1 && rating && text.length >= config.minReviewLength){
        stats.fallbackCards += 1;
        return node;
      }
      lastReject = `depth:${depth} rating:${rating ? 'yes' : 'no'} textLength:${text.length}`;

      if (node.getAttribute?.('role') === 'dialog' || node.getAttribute?.('aria-modal') === 'true'){
        stats.rejected.dialogBoundary += 1;
        stats.samples.push(lastReject);
        return null;
      }
      node = node.parentElement;
    }
    stats.rejected.noCandidate += 1;
    stats.samples.push(lastReject);
    return null;
  }

  function discoverCards(){
    const cards = dom.qsaDeep(config.selectors.cards);
    const seen = new Set(cards);
    const replyButtons = dom.qsaDeep('button, [role="button"], a[href], [role="link"]');
    const stats = {
      selectorCards: cards.length,
      scannedActions: replyButtons.length,
      exactReplyActions: 0,
      fallbackCards: 0,
      rejected: {
        ownUi: 0,
        tooManyReplyActions: 0,
        dialogBoundary: 0,
        noCandidate: 0
      },
      samples: []
    };

    replyButtons.forEach(button => {
      if (!isExactReplyAction(button)) return;
      stats.exactReplyActions += 1;
      const card = findCardFromReplyAction(button, stats);
      if (card && !seen.has(card)){
        seen.add(card);
        cards.push(card);
      }
    });

    stats.totalCards = cards.length;
    if (stats.samples.length > 5) stats.samples = stats.samples.slice(0, 5);
    return { cards, stats };
  }

  scanApi.injectForCards = function injectForCards(){
    const discovery = discoverCards();
    const cards = discovery.cards;
    const debugSummary = {
      ...(discovery.stats || {}),
      processed: 0,
      eligible: 0,
      chipsEnsured: 0,
      skipped: {
        tooShort: 0,
        noReplyUi: 0
      }
    };
    const activeHashes = new Set();

    cards.forEach(card => {
      debugSummary.processed += 1;
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
      if (hashBasis.length < config.minReviewLength){
        debugSummary.skipped.tooShort += 1;
        return;
      }

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
      if (!hasReplyUi && card.dataset.rcReplyEligible !== '1'){
        debugSummary.skipped.noReplyUi += 1;
        return;
      }

      debugSummary.eligible += 1;
      chips.ensureChipForCard(card, hashVal);
      debugSummary.chipsEnsured += 1;
      activeHashes.add(hashVal);
    });

    chips.cleanupRegistry(activeHashes);
    debugSummary.activeHashes = activeHashes.size;
    debugSummary.domChips = document.querySelectorAll('.rc-chip-btn').length;
    RC.debug?.log?.('scan', debugSummary);
  };
})(window);
