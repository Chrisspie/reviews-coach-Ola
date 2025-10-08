(function initDom(global){
  const RC = global.RC;
  const state = RC.state;
  const config = RC.config;
  const dom = RC.dom = RC.dom || {};

  dom.escapeHtml = function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  };

  dom.escapeAndNl2br = function escapeAndNl2br(str){
    if (str == null || str === '') return '';
    const s = String(str);
    let out = '';
    let prev = 0;
    const len = s.length;
    for (let i = 0; i < len; i++){
      const ch = s.charCodeAt(i);
      if (ch === 13){
        out += dom.escapeHtml(s.slice(prev, i)) + '<br>';
        if (i + 1 < len && s.charCodeAt(i + 1) === 10) i++;
        prev = i + 1;
      } else if (ch === 10 || ch === 8232 || ch === 8233){
        out += dom.escapeHtml(s.slice(prev, i)) + '<br>';
        prev = i + 1;
      }
    }
    if (prev < len) out += dom.escapeHtml(s.slice(prev));
    return out;
  };

  dom.normalizeSpaces = function normalizeSpaces(str){
    if (!str) return '';
    let out = '';
    let inSpace = false;
    for (let i = 0; i < str.length; i++){
      const c = str[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'){
        if (!inSpace){ out += ' '; inSpace = true; }
      } else {
        out += c;
        inSpace = false;
      }
    }
    return out.trim();
  };

  dom.hash = function hash(str){
    let h = 0;
    for (let i = 0; i < str.length; i++){
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  };

  dom.qsaDeep = function qsaDeep(sel, root=document){
    const result = [];
    const visited = new Set();
    let start = root || document;
    if (start && start.nodeType === 9 && start.documentElement) start = start.documentElement;
    if (!start) return result;
    const stack = [start];
    while (stack.length){
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
      } else if (node.nodeType === 11){
        const children = node.children || [];
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    }
    return result;
  };

  dom.ensureRoot = function ensureRoot(){
    let root = document.getElementById('rc_root');
    if (!root){
      root = document.createElement('div');
      root.id = 'rc_root';
      document.body.appendChild(root);
    }
    return root;
  };

  dom.closeCurrentPanel = function closeCurrentPanel(){
    if (state.currentPanelCleanup){
      try { state.currentPanelCleanup(); } catch (_){ }
      state.currentPanelCleanup = null;
    }
    if (state.currentPanel){
      try { state.currentPanel.remove(); } catch (_){ }
      state.currentPanel = null;
    }
  };

  dom.showToast = function showToast(msg){
    const toast = document.createElement('div');
    toast.className = 'rc-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(()=> toast.remove(), 2200);
  };

  dom.getScrollParents = function getScrollParents(el){
    const out = [];
    let node = el?.parentElement;
    const scrollable = /(auto|scroll|overlay)/i;
    while (node && node !== document.body){
      try {
        const style = window.getComputedStyle(node);
        if (scrollable.test(style.overflowY) || scrollable.test(style.overflowX) || scrollable.test(style.overflow)){
          out.push(node);
        }
      } catch (_){ }
      node = node.parentElement;
    }
    if (!out.includes(window)) out.push(window);
    return out;
  };

  dom.findReplyButton = function findReplyButton(root){
    const buttons = dom.qsaDeep('button, [role="button"]', root);
    return buttons.find(btn => {
      if (!btn || btn.classList?.contains('rc-chip-btn')) return false;
      const text = (btn.textContent || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return /(odpowiedz|reply|respond)/.test(text);
    }) || null;
  };

  dom.isElementVisible = function isElementVisible(el){
    if (!el || !el.isConnected) return false;
    if (el.offsetParent !== null) return true;
    const rect = el.getBoundingClientRect();
    if ((rect.width > 0 || rect.height > 0) && rect.top < window.innerHeight && rect.bottom > 0) return true;
    const style = window.getComputedStyle(el);
    return !(style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0');
  };

  dom.findWritableField = function findWritableField(root, allowHidden=false){
    const candidates = dom.qsaDeep(config.selectors.textInputs, root);
    for (const el of candidates){
      if (!el) continue;
      if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
      if (el.tagName === 'INPUT' && el.type && el.type.toLowerCase() !== 'text') continue;
      if (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'INPUT'){
        if (dom.isElementVisible(el)) return el;
      }
    }
    if (!allowHidden) return null;
    return candidates[0] || null;
  };

  dom.waitForCondition = function waitForCondition(check, timeoutMs=3500, intervalMs=120){
    return new Promise(resolve => {
      const start = performance.now();
      const tick = ()=>{
        try {
          const value = check();
          if (value){ resolve(value); return; }
        } catch (_){ }
        if (performance.now() - start >= timeoutMs){ resolve(null); return; }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  };
})(window);
