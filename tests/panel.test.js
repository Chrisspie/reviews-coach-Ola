const assert = require('assert');

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

  const sandbox = {

    window,

    document: window.document,

    console,

    Node: window.Node,

    Element: window.Element,

    MutationObserver: window.MutationObserver,

    requestAnimationFrame: (cb)=>{ if (typeof cb === 'function') cb(); return 0; },

    cancelAnimationFrame: ()=>{},

    setTimeout,

    clearTimeout,

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



async function testPanelRendersWithoutContext(){

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

  assert.ok(wrap, 'panel powinien dodac rc-panel-wrap');

  assert.strictEqual(wrap.querySelector('.rc-context'), null, 'w panelu nie powinno byc sekcji rc-context');

  assert.strictEqual(wrap.querySelector('#rc_preview').textContent, 'Wybrana delikatna', 'podglad powinien pokazac odpowiedz w stylu domyslnym');

}



async function testCopyToClipboardUsesNavigator(){

  const writes = [];

  const env = setupPanelEnv({ clipboard: { writeText: async (value)=> writes.push(value) } });

  await env.window.navigator.clipboard.writeText('Manual');

  assert.deepStrictEqual(writes, ['Manual'], 'manual wywolanie clipboardu powinno dzialac');

  writes.length = 0;

  const ok = await env.panelApi.copyToClipboard('Skopiuj to prosze');

  assert.strictEqual(ok, true, 'copyToClipboard powinno zwrocic true dla navigator.clipboard');

  assert.deepStrictEqual(writes, ['Skopiuj to prosze']);

}



async function testCopyToClipboardFallbackSuccess(){

  const calls = [];

  const env = setupPanelEnv({ clipboard: undefined, execCommand: (cmd)=>{ calls.push(cmd); return true; } });

  const before = env.document.querySelectorAll('textarea').length;

  const ok = await env.panelApi.copyToClipboard('Fallback kopiowanie');

  const after = env.document.querySelectorAll('textarea').length;

  assert.strictEqual(ok, true, 'fallback powinien zwrocic true gdy execCommand zwraca true');

  assert.deepStrictEqual(calls, ['copy']);

  assert.strictEqual(after, before, 'tymczasowe pole tekstowe powinno zostac usuniete');

}



async function testCopyToClipboardFallbackFailure(){

  const env = setupPanelEnv({ clipboard: undefined, execCommand: ()=>false });

  const ok = await env.panelApi.copyToClipboard('Nie skopiuje');

  assert.strictEqual(ok, false, 'gdy execCommand zawiedzie, funkcja powinna zwrocic false');

}



async function testCopyToClipboardEmpty(){

  const env = setupPanelEnv();

  const ok = await env.panelApi.copyToClipboard('');

  assert.strictEqual(ok, false, 'pusty tekst nie powinien byc kopiowany');

}



async function testOpenReplyPopupInlineField(){

  const env = setupPanelEnv();

  const { window, panelApi, RC, state } = env;

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



  assert.strictEqual(focused, field, 'inline pole powinno zostac przekazane do focusReplyField');

}



async function testOpenReplyPopupWithDialogWait(){

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



  assert.ok(updates.length > 0, 'updatePositionTargets powinno zostac wywolane');

  assert.strictEqual(updates[0][0], dialog, 'panel powinien sledzic okno dialogowe');

  assert.strictEqual(updates[0][1], dialogField, 'panel powinien ustawic anchor na polu dialogowym');

  assert.deepStrictEqual(focusCall, { target: dialog, allowHidden: true }, 'focusReplyField powinno otrzymac dialog i allowHidden=true');

}



async function testOpenReplyPopupNoCard(){

  const env = setupPanelEnv();

  const { panelApi, toasts } = env;

  await panelApi.openReplyPopup('missing-hash', null);

  assert.deepStrictEqual(toasts, ['Nie moge znalezc opinii. Sprobuj ponownie.']);

}



async function testOpenReplyPopupTimeout(){

  const env = setupPanelEnv({ findWritableField: ()=>null, waitForCondition: async ()=> null });

  const { window, panelApi, state, toasts } = env;

  const card = window.document.createElement('div');

  card.dataset.rcHash = 'hash-timeout';

  window.document.body.appendChild(card);

  env.cardMap.set('hash-timeout', card);

  state.currentPanel = { updatePositionTargets: ()=>{} };



  await panelApi.openReplyPopup('hash-timeout', null);

  assert.deepStrictEqual(toasts, ['Nie moge otworzyc pola odpowiedzi. Otworz je recznie i wklej odpowiedz.']);

}



async function testFocusReplyFieldWithoutInput(){

  const env = setupPanelEnv({ findWritableField: ()=>null });

  const { window, panelApi, toasts } = env;

  const root = window.document.createElement('div');

  await panelApi.focusReplyField(root);

  assert.deepStrictEqual(toasts, ['Nie widze pola odpowiedzi w oknie.']);

}



async function testCopyButtonNoVariant(){

  const env = setupPanelEnv({ sendMessageResponse: { soft: '', brief: '', proactive: '' } });

  const { panelApi, window, reviews } = env;

  const card = window.document.createElement('div');

  card.dataset.rcHash = 'hash-empty';

  window.document.body.appendChild(card);

  reviews.extractText = ()=> 'Testowa opinia';



  await panelApi.openForCard(card, null);

  await env.flush();



  const button = window.document.querySelector('#rc_copy');

  assert.ok(button, 'przycisk kopiowania powinien istniec');

  await button.onclick();

  const err = window.document.querySelector('#rc_err');

  assert.strictEqual(err.textContent, 'Brak tresci do skopiowania.');

}



async function testCopyButtonCopyFailure(){

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

  assert.strictEqual(err.textContent, 'Nie udalo sie skopiowac tresci.');

}



async function testCopyButtonSuccessTriggersPopup(){

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

  assert.strictEqual(err.textContent, '', 'nie powinno byc komunikatu o bledzie');

  assert.deepStrictEqual(toasts, ['Skopiowano do schowka.']);

  assert.ok(calledWith, 'openReplyPopup powinno zostac wywolane');

  assert.strictEqual(calledWith[0], 'hash-success');

  assert.strictEqual(calledWith[1], card);

  assert.ok(calledWith[2], 'powinno przekazac opcje do openReplyPopup');
  assert.strictEqual(calledWith[2].suppressWarnings, true);

}



async function main(){

  await testPanelRendersWithoutContext();

  await testCopyToClipboardUsesNavigator();

  await testCopyToClipboardFallbackSuccess();

  await testCopyToClipboardFallbackFailure();

  await testCopyToClipboardEmpty();

  await testOpenReplyPopupInlineField();

  await testOpenReplyPopupWithDialogWait();

  await testOpenReplyPopupNoCard();

  await testOpenReplyPopupTimeout();

  await testFocusReplyFieldWithoutInput();

  await testCopyButtonNoVariant();

  await testCopyButtonCopyFailure();

  await testCopyButtonSuccessTriggersPopup();

}



main().catch(err => {

  console.error(err);

  process.exit(1);

});

