const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function setupPanelEnv(overrides = {}){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    pretendToBeVisual: true,
    url: 'https://example.com'
  });
  const { window } = dom;
  const customSetTimeout = typeof overrides.setTimeout === 'function' ? overrides.setTimeout : null;
  const customClearTimeout = typeof overrides.clearTimeout === 'function' ? overrides.clearTimeout : null;
  const sandbox = {
    window,
    document: window.document,
    console,
    Node: window.Node,
    Element: window.Element,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (cb)=>{ if (typeof cb === 'function') cb(); return 0; },
    cancelAnimationFrame: ()=>{},
    setTimeout: customSetTimeout || setTimeout,
    clearTimeout: customClearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    performance: window.performance,
    confirm: ()=>true,
    InputEvent: window.InputEvent,
    Event: window.Event,
    MouseEvent: window.MouseEvent
  };
  sandbox.window.getSelection = window.getSelection.bind(window);
  sandbox.window.HTMLElement = window.HTMLElement;
  if (customSetTimeout){
    sandbox.window.setTimeout = customSetTimeout;
  }
  if (customClearTimeout){
    sandbox.window.clearTimeout = customClearTimeout;
  }
  sandbox.global = sandbox.window;
  sandbox.navigator = window.navigator;

  if (!window.ResizeObserver){
    class FakeResizeObserver{
      observe(){ }
      unobserve(){ }
      disconnect(){ }
    }
    window.ResizeObserver = FakeResizeObserver;
  }
  sandbox.ResizeObserver = window.ResizeObserver;
  if (!window.IntersectionObserver){
    class FakeIntersectionObserver{
      constructor(){ }
      observe(){ }
      unobserve(){ }
      disconnect(){ }
    }
    window.IntersectionObserver = FakeIntersectionObserver;
  }
  sandbox.IntersectionObserver = window.IntersectionObserver;

  const navigatorOverride = window.navigator;
  if (Object.prototype.hasOwnProperty.call(overrides, 'clipboard')){
    Object.defineProperty(navigatorOverride, 'clipboard', {
      value: overrides.clipboard,
      configurable: true,
      writable: true
    });
  } else {
    Object.defineProperty(navigatorOverride, 'clipboard', {
      value: { writeText: async ()=>{} },
      configurable: true,
      writable: true
    });
  }

  const execCommand = Object.prototype.hasOwnProperty.call(overrides, 'execCommand')
    ? overrides.execCommand
    : (()=>true);
  window.document.execCommand = execCommand;

  const storageGet = overrides.storageGet || (async ()=>({}));
  const storageSet = overrides.storageSet || (async ()=>{});
  const sendMessageResponse = overrides.sendMessageResponse || {
    soft: 'Delikatna odpowiedz',
    brief: 'Rzeczowa odpowiedz',
    proactive: 'Proaktywna odpowiedz'
  };
  const quotaResponse = overrides.initialQuota ? { quota: overrides.initialQuota } : { quota: null };
  const sendMessageImpl = overrides.sendMessage || ((message, cb)=>{
    if (message && message.type === 'GET_QUOTA_STATUS'){
      if (typeof cb === 'function') cb(quotaResponse);
      return;
    }
    if (typeof cb === 'function') cb(sendMessageResponse);
  });

  sandbox.chrome = {
    storage: { sync: { get: storageGet, set: storageSet } },
    runtime: { sendMessage: sendMessageImpl }
  };

  const context = vm.createContext(sandbox);
  const readScript = (rel)=> fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  new vm.Script(readScript('content/namespace.js'), { filename: 'namespace.js' }).runInContext(context);

  const { RC } = context.window;
  const cardMap = overrides.cardMap instanceof Map ? overrides.cardMap : new Map();
  RC.reviews = RC.reviews || {};
  if (overrides.reviews){
    Object.assign(RC.reviews, overrides.reviews);
  } else {
    RC.reviews.extractText = (card)=> card?.textContent || '';
    RC.reviews.extractRating = ()=> '';
  }
  RC.chips = RC.chips || {};
  RC.chips.findCardForHash = (hash)=> cardMap.get(hash) || null;

  new vm.Script(readScript('content/dom.js'), { filename: 'dom.js' }).runInContext(context);

  const toasts = [];
  const domApi = RC.dom;
  domApi.showToast = (msg)=>{ toasts.push(msg); };
  if (overrides.findWritableField){
    domApi.findWritableField = overrides.findWritableField;
  }
  if (overrides.isElementVisible){
    domApi.isElementVisible = overrides.isElementVisible;
  }
  if (overrides.waitForCondition){
    domApi.waitForCondition = overrides.waitForCondition;
  }

  new vm.Script(readScript('content/panel.js'), { filename: 'panel.js' }).runInContext(context);

  return {
    panelApi: RC.panel,
    window: context.window,
    document: context.window.document,
    RC,
    dom: domApi,
    toasts,
    cardMap,
    reviews: RC.reviews,
    state: RC.state,
    flush: (ticks = 1)=> new Promise(resolve => {
      let remaining = ticks;
      const step = ()=>{
        if (--remaining <= 0){ resolve(); return; }
        setTimeout(step, 0);
      };
      setTimeout(step, 0);
    })
  };
}

describe('Panel Logic', () => {
  test('Panel renders without context', async () => {
    const env = setupPanelEnv({
      sendMessageResponse: { soft: 'Wybrana delikatna', brief: 'Wybrana rzeczowa', proactive: 'Wybrana proaktywna' }
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'card-1';
    card.textContent = 'Pierwotna opinia klienta o dluzszej tresci';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Testowa opinia';
    reviews.extractRating = ()=> '5';

    await panelApi.openForCard(card, null);
    await env.flush();

    const wrap = window.document.querySelector('.rc-panel-wrap');
    expect(wrap).toBeTruthy();
    expect(wrap.querySelector('.rc-context')).toBeNull();
    expect(wrap.querySelector('#rc_preview').textContent).toBe('Wybrana delikatna');
  });

  test('CopyToClipboard uses navigator', async () => {
    const writes = [];
    const env = setupPanelEnv({ clipboard: { writeText: async (value)=> writes.push(value) } });
    await env.window.navigator.clipboard.writeText('Manual');
    expect(writes).toEqual(['Manual']);
    writes.length = 0;
    const ok = await env.panelApi.copyToClipboard('Skopiuj to prosze');
    expect(ok).toBe(true);
    expect(writes).toEqual(['Skopiuj to prosze']);
  });

  test('CopyToClipboard fallback success', async () => {
    const calls = [];
    const env = setupPanelEnv({ clipboard: undefined, execCommand: (cmd)=>{ calls.push(cmd); return true; } });
    const before = env.document.querySelectorAll('textarea').length;
    const ok = await env.panelApi.copyToClipboard('Fallback kopiowanie');
    const after = env.document.querySelectorAll('textarea').length;
    expect(ok).toBe(true);
    expect(calls).toEqual(['copy']);
    expect(after).toBe(before);
  });

  test('CopyToClipboard fallback failure', async () => {
    const env = setupPanelEnv({ clipboard: undefined, execCommand: ()=>false });
    const ok = await env.panelApi.copyToClipboard('Nie skopiuje');
    expect(ok).toBe(false);
  });

  test('CopyToClipboard empty', async () => {
    const env = setupPanelEnv();
    const ok = await env.panelApi.copyToClipboard('');
    expect(ok).toBe(false);
  });

  test('OpenReplyPopup inline field', async () => {
    const env = setupPanelEnv();
    const { window, panelApi, state } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-inline';
    const field = window.document.createElement('textarea');
    card.appendChild(field);
    window.document.body.appendChild(card);
    env.cardMap.set('hash-inline', card);
    state.currentPanel = { updatePositionTargets: ()=>{} };
    let focused = null;
    const originalFocus = panelApi.focusReplyField;
    panelApi.focusReplyField = function(target){
      focused = target;
      return originalFocus.call(this, target);
    };

    await panelApi.openReplyPopup('hash-inline', null);

    expect(focused).toBe(field);
  });

  test('OpenReplyPopup with dialog wait', async () => {
    const env = setupPanelEnv();
    const { window, panelApi, RC, state } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-dialog';
    const reply = window.document.createElement('button');
    reply.textContent = 'Odpowiedz';
    card.appendChild(reply);
    window.document.body.appendChild(card);
    env.cardMap.set('hash-dialog', card);

    const dialog = window.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogField = window.document.createElement('textarea');
    dialog.appendChild(dialogField);
    window.document.body.appendChild(dialog);

    RC.dom.findWritableField = (root)=>{
      if (root === card) return null;
      if (root === dialog) return dialogField;
      return null;
    };
    RC.dom.isElementVisible = ()=> true;
    RC.dom.waitForCondition = async (check)=>
      check() || { root: dialog, anchor: dialogField };

    const updates = [];
    state.currentPanel = { updatePositionTargets: (...args)=> updates.push(args) };
    let focusCall = null;
    const originalFocus = panelApi.focusReplyField;
    panelApi.focusReplyField = function(target, allowHidden){
      focusCall = { target, allowHidden };
      return originalFocus.call(this, target, allowHidden);
    };

    await panelApi.openReplyPopup('hash-dialog', null);

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0][0]).toBe(dialog);
    expect(updates[0][1]).toBe(dialogField);
    expect(focusCall).toEqual({ target: dialog, allowHidden: true });
  });

  test('OpenReplyPopup no card', async () => {
    const env = setupPanelEnv();
    const { panelApi, toasts } = env;
    await panelApi.openReplyPopup('missing-hash', null);
    expect(toasts).toEqual(['Nie moge znalezc opinii. Sprobuj ponownie.']);
  });

  test('OpenReplyPopup timeout', async () => {
    const env = setupPanelEnv({ findWritableField: ()=>null, waitForCondition: async ()=> null });
    const { window, panelApi, state, toasts } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-timeout';
    window.document.body.appendChild(card);
    env.cardMap.set('hash-timeout', card);
    state.currentPanel = { updatePositionTargets: ()=>{} };

    await panelApi.openReplyPopup('hash-timeout', null);
    expect(toasts).toEqual(['Nie moge otworzyc pola odpowiedzi. Otworz je recznie i wklej odpowiedz.']);
  });

  test('FocusReplyField without input', async () => {
    const env = setupPanelEnv({ findWritableField: ()=>null });
    const { window, panelApi, toasts } = env;
    const root = window.document.createElement('div');
    await panelApi.focusReplyField(root);
    expect(toasts).toEqual(['Nie widze pola odpowiedzi w oknie.']);
  });

  test('CopyButton no variant', async () => {
    const env = setupPanelEnv({ sendMessageResponse: { soft: '', brief: '', proactive: '' } });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-empty';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Testowa opinia';

    await panelApi.openForCard(card, null);
    await env.flush();

    const button = window.document.querySelector('#rc_copy');
    expect(button).toBeTruthy();
    await button.onclick();
    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('Brak tresci do skopiowania.');
  });

  test('CopyButton copy failure', async () => {
    const env = setupPanelEnv();
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-fail';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Testowa opinia';

    await panelApi.openForCard(card, null);
    await env.flush();

    panelApi.copyToClipboard = async ()=> false;
    panelApi.openReplyPopup = async ()=>{ throw new Error('nie powinno wywolac openReplyPopup przy bledzie kopiowania'); };

    const button = window.document.querySelector('#rc_copy');
    await button.onclick();
    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('Nie udalo sie skopiowac tresci.');
  });

  test('CopyButton success triggers popup', async () => {
    const env = setupPanelEnv({ sendMessageResponse: { soft: 'Odpowiedz A', brief: 'Odpowiedz B', proactive: 'Odpowiedz C' } });
    const { panelApi, window, reviews, state, toasts } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-success';
    window.document.body.appendChild(card);
    env.cardMap.set('hash-success', card);
    state.currentPanel = { dataset: { rcTarget: 'hash-success' } };
    reviews.extractText = ()=> 'Dluga opinia klienta';

    await panelApi.openForCard(card, null);
    await env.flush();

    let calledWith = null;
    panelApi.copyToClipboard = async ()=> true;
    panelApi.openReplyPopup = async (...args)=>{ calledWith = args; };

    const button = window.document.querySelector('#rc_copy');
    await button.onclick();

    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('');
    expect(toasts).toEqual(['Skopiowano do schowka.']);
    expect(calledWith).toBeTruthy();
    expect(calledWith[0]).toBe('hash-success');
    expect(calledWith[1]).toBe(card);
    expect(calledWith[2].suppressWarnings).toBe(true);
  });

  test('GenerateReplies shows timeout error when worker stays silent', async () => {
    const timerQueue = [];
    const fakeTimeout = (cb)=>{
      timerQueue.push(cb);
      return timerQueue.length;
    };
    const fakeClearTimeout = (id)=>{
      const idx = Number(id) - 1;
      if (idx >= 0 && idx < timerQueue.length){
        timerQueue[idx] = null;
      }
    };
    const env = setupPanelEnv({
      sendMessage: (message, cb)=>{
        if (message?.type === 'GET_QUOTA_STATUS'){
          if (typeof cb === 'function') cb({ quota: null });
        }
      },
      setTimeout: fakeTimeout,
      clearTimeout: fakeClearTimeout
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'silent-hash';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Klient nie odpowiedzial';
    reviews.extractRating = ()=> '4';

    await panelApi.openForCard(card, null);
    await env.flush();

    timerQueue.forEach((cb, idx)=>{
      if (typeof cb === 'function'){
        cb();
        timerQueue[idx] = null;
      }
    });

    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('Brak odpowiedzi z uslugi generowania. Sprobuj ponownie.');
    const preview = window.document.querySelector('#rc_preview');
    expect(preview.textContent).toBe('...');
  });
});
