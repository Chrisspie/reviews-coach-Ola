(function bootstrap(global){
  const RC = global.RC;
  const { state, dom, scan } = RC;

  if (state.mutationObserver){
    try { state.mutationObserver.disconnect(); } catch (_){ }
  }
  const observer = new MutationObserver(()=> scan.queue());
  observer.observe(document, { childList: true, subtree: true });
  state.mutationObserver = observer;

  if (!state.handlers.scroll){
    const handler = ()=> scan.queue();
    window.addEventListener('scroll', handler, { passive: true });
    state.handlers.scroll = handler;
  }

  if (!state.handlers.resize){
    const handler = ()=> scan.queue();
    window.addEventListener('resize', handler);
    state.handlers.resize = handler;
  }

  if (!state.handlers.visibility){
    const handler = ()=>{ if (!document.hidden) scan.queue(true); };
    document.addEventListener('visibilitychange', handler);
    state.handlers.visibility = handler;
  }

  if (!state.handlers.pointerDown){
    const handler = (event)=>{
      if (!state.currentPanel) return;
      const btn = event.target.closest('button, [role="button"]');
      if (!btn) return;
      if (state.currentPanel.contains(btn)) return;
      if (btn.classList?.contains('rc-chip-btn')) return;
      const text = (btn.textContent || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (/(odpowiedz|reply|respond)/.test(text)){
        dom.closeCurrentPanel();
      }
    };
    document.addEventListener('pointerdown', handler);
    state.handlers.pointerDown = handler;
  }

  if (!state.scanIntervalId){
    state.scanIntervalId = setInterval(()=> scan.queue(), 2800);
  }

  state.initialized = true;
  scan.queue(true);
})(window);
