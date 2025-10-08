const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const scriptPaths = [
  path.join(__dirname, '..', 'content', 'namespace.js'),
  path.join(__dirname, '..', 'content', 'dom.js'),
  path.join(__dirname, '..', 'content', 'reviews.js'),
  path.join(__dirname, '..', 'content', 'chips.js'),
  path.join(__dirname, '..', 'content', 'scan.js')
];

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
    confirm: ()=>true,
    chrome: { storage: { sync: { get: async()=>({}), set: async()=>{} } } },
    module: { exports: {} },
    exports: {}
  };
  sandbox.window.getSelection = dom.window.getSelection.bind(dom.window);
  sandbox.global = sandbox.window;
  const context = vm.createContext(sandbox);
  for (const scriptPath of scriptPaths){
    const code = fs.readFileSync(scriptPath, 'utf8');
    const script = new vm.Script(code, { filename: path.basename(scriptPath) });
    script.runInContext(context);
  }
  const { RC } = context.window;
  return {
    injectForCards: RC.scan.injectForCards,
    chipRegistry: RC.state.chipRegistry,
    qsaDeep: RC.dom.qsaDeep,
    createChipButton: RC.chips.createChipButton
  };
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

console.log('[ok] injectForCards attaches chip for eligible cards');
