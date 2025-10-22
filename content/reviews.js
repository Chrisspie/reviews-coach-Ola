(function initReviews(global){
  const RC = global.RC;
  const { dom, config } = RC;
  const reviews = RC.reviews = RC.reviews || {};

  function clean(value){
    if (!value) return '';
    return String(value).replace(/[\u2022\u00b7]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalize(value){
    return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }

  reviews.stripBlockedNormalizedText = function stripBlockedNormalizedText(str){
    if (!str) return '';
    let out = str;
    for (const phrase of config.blockedNormalizedText){
      if (!phrase) continue;
      out = out.split(phrase).join(' ');
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  reviews.stripBlockedTextValue = function stripBlockedTextValue(raw){
    if (raw == null || raw === '') return '';
    const input = String(raw);
    let normalized = '';
    const indexMap = [];
    for (let i = 0; i < input.length; i++){
      const chunk = input[i].normalize('NFKD');
      for (let j = 0; j < chunk.length; j++){
        const code = chunk.charCodeAt(j);
        if (code >= 0x0300 && code <= 0x036f) continue;
        normalized += chunk[j].toLowerCase();
        indexMap.push(i);
      }
    }
    if (!normalized){
      return clean(input);
    }
    const ranges = [];
    for (const phrase of config.blockedNormalizedText){
      if (!phrase) continue;
      let idx = normalized.indexOf(phrase);
      while (idx !== -1){
        const endIdx = idx + phrase.length - 1;
        const startOriginal = indexMap[idx];
        const endOriginal = indexMap[endIdx] + 1;
        ranges.push([startOriginal, endOriginal]);
        idx = normalized.indexOf(phrase, idx + 1);
      }
    }
    if (!ranges.length){
      return clean(input);
    }
    ranges.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const merged = [];
    for (const range of ranges){
      const start = range[0];
      const end = range[1];
      if (!merged.length){
        merged.push([start, end]);
        continue;
      }
      const last = merged[merged.length - 1];
      if (start <= last[1]){
        if (end > last[1]) last[1] = end;
        continue;
      }
      merged.push([start, end]);
    }
    let cursor = 0;
    let result = '';
    for (const range of merged){
      const start = range[0];
      const end = range[1];
      if (cursor < start) result += input.slice(cursor, start);
      cursor = Math.max(cursor, end);
    }
    if (cursor < input.length) result += input.slice(cursor);
    return clean(result);
  };

  function looksLikeReviewerMeta(normalized){
    if (!normalized) return false;
    const squashed = normalized.replace(/\s+/g, '');
    if (/^(?:local guide|przewodnik lokalny)/.test(normalized)) return true;
    if (squashed.length > 80) return false;
    if (/\blvl\s*\d+/.test(normalized)) return true;
    if (/\d+\s*(?:opini|recenz|review)/.test(normalized)) return true;
    if (/\d+\s*(?:zdjec|zdjecia|photos?)/.test(normalized)) return true;
    if (squashed.includes('polubioneprzezwlasciciela')) return true;
    if (squashed.includes('likedbyowner')) return true;
    return false;
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
    const seenNormalized = new Set();
    let best = '';
    let bestWeight = -1;
    let bestNormalizedLength = -1;

    const consider = (raw, weight = 0)=>{
      let value = clean(raw);
      if (!value) return;
      value = reviews.stripBlockedTextValue(value);
      if (!value) return;
      const normalized = normalize(value);
      const scrubbed = reviews.stripBlockedNormalizedText(normalized);
      if (!scrubbed) return;
      if (looksLikeReviewerMeta(scrubbed)) return;
      if (seenNormalized.has(scrubbed)) return;
      seenNormalized.add(scrubbed);
      if (seen.has(value)) return;
      seen.add(value);
      const candidateLength = scrubbed.length;
      if (weight > bestWeight || (weight === bestWeight && (candidateLength > bestNormalizedLength || (candidateLength === bestNormalizedLength && value.length > best.length)))){
        best = value;
        bestWeight = weight;
        bestNormalizedLength = candidateLength;
      }
    };

    for (const selector of config.reviewSelectors){
      const nodes = dom.qsaDeep(selector, card);
      for (const node of nodes){
        if (!node || isOwnUi(node)) continue;
        consider(node.innerText || node.textContent || '', 2);
      }
    }

    if (bestWeight < 2){
      dom.qsaDeep('*', card).forEach((node) => {
        if (!node || isOwnUi(node)) return;
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
        consider(node.innerText || node.textContent || '', 1);
      });
    }

    if (bestWeight < 1){
      const raw = card.innerText || '';
      let start = 0;
      for (let i = 0; i < raw.length; i++){
        const ch = raw.charCodeAt(i);
        if (ch === 10 || ch === 13 || ch === 8232 || ch === 8233){
          consider(raw.slice(start, i), 0);
          if (ch === 13 && raw.charCodeAt(i + 1) === 10) i++;
          start = i + 1;
        }
      }
      if (start < raw.length) consider(raw.slice(start), 0);
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
      const selector = `[${attr}]`;
      const el = dom.qsaDeep(selector, card)[0];
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
