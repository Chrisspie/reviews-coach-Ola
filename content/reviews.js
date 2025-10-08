(function initReviews(global){
  const RC = global.RC;
  const { dom, config } = RC;
  const reviews = RC.reviews = RC.reviews || {};

  function clean(value){
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function normalize(value){
    return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }

  function isOwnUi(node){
    if (!node) return false;
    if (node.closest('#rc_root')) return true;
    if (node.closest('.rc-chip-btn')) return true;
    if (node.closest('.rc-panel')) return true;
    return false;
  }

  reviews.extractText = function extractText(card){
    if (!card) return '';
    const seen = new Set();
    let best = '';

    const consider = (raw) => {
      const value = clean(raw);
      if (!value) return;
      const normalized = normalize(value);
      for (const phrase of config.blockedNormalizedText){
        if (normalized.includes(phrase)) return;
      }
      if (seen.has(value)) return;
      seen.add(value);
      if (value.length > best.length) best = value;
    };

    for (const selector of config.reviewSelectors){
      const nodes = dom.qsaDeep(selector, card);
      for (const node of nodes){
        if (!node || isOwnUi(node)) continue;
        consider(node.innerText || node.textContent || '');
      }
    }

    if (!best){
      dom.qsaDeep('*', card).forEach((node) => {
        if (!node || isOwnUi(node)) return;
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
        consider(node.innerText || node.textContent || '');
      });
    }

    if (!best){
      const raw = card.innerText || '';
      let start = 0;
      for (let i = 0; i < raw.length; i++){
        const ch = raw.charCodeAt(i);
        if (ch === 10 || ch === 13 || ch === 8232 || ch === 8233){
          consider(raw.slice(start, i));
          if (ch === 13 && raw.charCodeAt(i + 1) === 10) i++;
          start = i + 1;
        }
      }
      if (start < raw.length) consider(raw.slice(start));
    }

    if (best) return best;

    const selection = clean((window.getSelection?.() || '').toString());
    return selection;
  };

  reviews.extractRating = function extractRating(card){
    if (!card) return '';

    const parseValue = (source) => {
      if (!source) return '';
      const normalized = String(source).replace(/\s+/g, ' ').trim().replace(/,/g, '.');
      if (!normalized) return '';
      let match = normalized.match(/([0-5](?:\.[0-9])?)(?=\s*\/\s*5)/);
      if (match) return match[1];
      match = normalized.match(/([0-5](?:\.[0-9])?)(?=\s*(?:na|out of|z)\s*5)/i);
      if (match) return match[1];
      match = normalized.match(/([0-5](?:\.[0-9])?)/);
      if (!match) return '';
      const num = parseFloat(match[1]);
      if (Number.isNaN(num) || num < 0 || num > 5) return '';
      return String(num);
    };

    let ratingValue = '';

    const capture = (source) => {
      if (ratingValue || !source) return;
      const value = parseValue(source);
      if (value) ratingValue = value;
    };

    for (const selector of config.ratingAriaSelectors){
      const el = dom.qsaDeep(selector, card)[0];
      if (!el) continue;
      capture(el.getAttribute('aria-label'));
      capture(el.textContent);
      if (ratingValue) return ratingValue;
    }

    for (const attr of config.ratingAttrNames){
      const el = dom.qsaDeep(`[${attr}]`, card)[0];
      if (!el) continue;
      capture(el.getAttribute(attr));
      if (ratingValue) return ratingValue;
    }

    const meta = dom.qsaDeep('[itemprop="reviewRating"] [itemprop="ratingValue"]', card)[0];
    if (meta){
      capture(meta.getAttribute('content'));
      capture(meta.textContent);
    }

    if (!ratingValue){
      dom.qsaDeep('[aria-label]', card).forEach((node) => capture(node.getAttribute('aria-label')));
    }

    if (!ratingValue){
      dom.qsaDeep('*', card).forEach((node) => {
        if (!node || ratingValue) return;
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        capture(node.getAttribute?.('aria-label'));
        capture(node.textContent);
      });
    }

    if (!ratingValue){
      capture(card.getAttribute?.('aria-label'));
      capture(card.innerText || '');
      capture(card.textContent || '');
    }

    return ratingValue || '';
  };
})(window);
