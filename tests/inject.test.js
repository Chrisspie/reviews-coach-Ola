const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function loadInjection(dom){
  const sandbox = {
    window: dom.window,
    document: dom.window.document,
    console,
    Node: dom.window.Node,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (cb)=>{ if (typeof cb === 'function') cb(0); return 0; },
    cancelAnimationFrame: ()=>{},
    setTimeout,
    clearTimeout,
    setInterval: ()=>0,
    clearInterval: ()=>{},
    performance: dom.window.performance,
    showToast: ()=>{},
    openCardPanel: ()=>{},
    closeCurrentPanel: ()=>{},
    findCardForHash: ()=>null,
    chrome: { storage: { sync: { get: async()=>({}), set: async()=>{} } } },
    module: { exports: {} },
    exports: {},
  };
  const prefixStart = contentSource.indexOf('const chipRegistry');
  const injectStart = contentSource.indexOf('function findReplyButton');
  const injectEnd = contentSource.indexOf('function renderKeyForm');
    const extractTextStart = contentSource.indexOf('function extractText');
  const extractTextEnd = contentSource.indexOf('function extractRating');
  const extractRatingEnd = contentSource.indexOf('async function pasteIntoReplyViaPopup');
  const snippet = contentSource.slice(prefixStart, injectEnd)
    + contentSource.slice(extractTextStart, extractTextEnd)
    + contentSource.slice(extractTextEnd, extractRatingEnd)
    + '\nmodule.exports = { injectForCards, chipRegistry, qsaDeep, createChipButton, extractText, extractRating };';
  const context = vm.createContext(sandbox);
  new vm.Script(snippet, { filename: 'inject-snippet.js' }).runInContext(context);
  return context.module.exports;
}

function buildCard(dom, text, includeReplyButton = true, attrs = {}){
  const card = dom.window.document.createElement('div');
  card.setAttribute('role', 'article');
  card.setAttribute('data-review-id', attrs.reviewId || 'rev-' + Math.random().toString(16).slice(2));
  const body = dom.window.document.createElement('div');
  body.className = 'ODSEW-ShBeI-text';
  body.textContent = text;
  card.appendChild(body);
  if (includeReplyButton){
    const reply = dom.window.document.createElement('button');
    reply.textContent = 'Odpowiedz';
    card.appendChild(reply);
  }
  dom.window.document.body.appendChild(card);
  return card;
}

function resetEnvironment(dom, helpers){
  if (helpers && helpers.chipRegistry){ helpers.chipRegistry.clear(); }
  const existing = [...dom.window.document.querySelectorAll('.rc-chip-btn')];
  existing.forEach(btn => btn.remove());
}

function runInject(dom, helpers){
  // simulate MutationObserver scan call
  helpers.injectForCards();
}

(function testChipAppears(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Swietna obsluga i mila atmosfera, polecam!', true, { reviewId: 'rev1' });
  runInject(dom, helpers);
  const chip = card.querySelector('.rc-chip-btn');
  assert.ok(chip, 'expected rc-chip-btn to be inserted for valid review');
})();

(function testChipSkippedForTooShort(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'ok', true, { reviewId: 'rev-short' });
  runInject(dom, helpers);
  const chip = card.querySelector('.rc-chip-btn');
  assert.strictEqual(chip, null, 'expected no chip for extremely short review');
})();

console.log('? injectForCards attaches chip for eligible cards');

