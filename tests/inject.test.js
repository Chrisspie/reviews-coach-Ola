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

function createChipObserver(dom, target){
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(target, { childList: true, subtree: true });
  return observer;
}

function drainChipMutations(observer){
  const records = observer.takeRecords();
  let added = 0;
  let removed = 0;
  for (const record of records){
    record.addedNodes.forEach(node => {
      if (node?.classList?.contains('rc-chip-btn')) added += 1;
    });
    record.removedNodes.forEach(node => {
      if (node?.classList?.contains('rc-chip-btn')) removed += 1;
    });
  }
  return { added, removed };
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

(function testChipPersistsWithoutReplyButtonOnceEligible(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Obsluga na najwyzszym poziomie, bardzo dziekuje!', true, { reviewId: 'rev-liked' });
  runInject(dom, helpers);
  let chip = card.querySelector('.rc-chip-btn');
  assert.ok(chip, 'expected rc-chip-btn after initial injection');
  const reply = card.querySelector('button:not(.rc-chip-btn)');
  if (reply) reply.remove();
  runInject(dom, helpers);
  chip = card.querySelector('.rc-chip-btn');
  assert.ok(chip, 'expected rc-chip-btn to persist even when reply button temporarily missing');
})();

(function testChipAnchorsNearReviewerHeader(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Personel pomocny, lokal czysty i zadbany, polecam serdecznie!', true, { reviewId: 'rev-header' });
  const header = dom.window.document.createElement('div');
  header.className = 'author-block';
  header.textContent = 'Jan Kowalski';
  card.insertBefore(header, card.firstChild);
  runInject(dom, helpers);
  const chip = card.querySelector('.rc-chip-btn');
  const slot = card.querySelector('.rc-chip-slot');
  assert.ok(chip, 'expected rc-chip-btn near reviewer header');
  assert.ok(slot, 'expected rc-chip-slot after reviewer header');
  const slotVsHeader = slot.compareDocumentPosition(header);
  assert.ok(slotVsHeader & dom.window.Node.DOCUMENT_POSITION_PRECEDING, 'expected reviewer header to precede slot');
  assert.strictEqual(slot.contains(chip), true, 'expected chip to reside inside slot');
  assert.ok(chip.classList.contains('rc-chip-anchored'), 'expected anchored styling for header placement');
})();

(function testChipDoesNotFlickerOnStableCard(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Fantastyczna obsluga, polecam kazdemu znajomemu!', true, { reviewId: 'rev-stable' });
  const header = dom.window.document.createElement('div');
  header.textContent = 'Anna Nowak';
  card.insertBefore(header, card.firstChild);
  const observer = createChipObserver(dom, card);
  runInject(dom, helpers);
  let changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 1, 'expected single chip insertion on first pass');
  assert.strictEqual(changes.removed, 0, 'expected no chip removals on first pass');
  const chip = card.querySelector('.rc-chip-btn');
  const slot = card.querySelector('.rc-chip-slot');
  assert.ok(chip, 'chip should stay in the DOM');
  assert.ok(slot, 'expected rc-chip-slot for stable card');
  const slotRelation = slot.compareDocumentPosition(header);
  assert.ok(slotRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING, 'slot should render after reviewer header');
  assert.strictEqual(slot.contains(chip), true, 'chip should remain inside slot');
  changes = drainChipMutations(observer);
  runInject(dom, helpers);
  changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 0, 'chip should not be reinserted on stable scans');
  assert.strictEqual(changes.removed, 0, 'chip should not be removed on stable scans');
  runInject(dom, helpers);
  changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 0, 'chip should remain steady after additional scans');
  assert.strictEqual(changes.removed, 0, 'no removals expected after additional scans');
  const currentSlot = card.querySelector('.rc-chip-slot');
  assert.ok(currentSlot, 'slot should persist across scans');
  const currentRelation = currentSlot.compareDocumentPosition(header);
  assert.ok(currentRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING, 'slot should remain after reviewer header');
  assert.strictEqual(currentSlot.contains(chip), true, 'chip should remain inside slot after extra scans');
  observer.disconnect();
})();

(function testChipRespectsLikesStrip(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Personel bardzo pomocny, polecam!', true, { reviewId: 'rev-polubienia' });
  const header = dom.window.document.createElement('div');
  header.className = 'section-review-header';
  header.textContent = 'Ewa Wlasciciel';
  card.insertBefore(header, card.firstChild);
  const likes = dom.window.document.createElement('div');
  likes.className = 'section-review-vote';
  likes.setAttribute('aria-label', 'Polubienia: 4');
  likes.textContent = '4 polubienia';
  header.insertAdjacentElement('afterend', likes);
  const observer = createChipObserver(dom, card);
  runInject(dom, helpers);
  let changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 1, 'expected single chip insertion alongside likes strip');
  assert.strictEqual(changes.removed, 0, 'expected no chip removals alongside likes strip');
  const chip = card.querySelector('.rc-chip-btn');
  const slot = card.querySelector('.rc-chip-slot');
  assert.ok(chip && slot, 'chip and slot should exist next to likes strip');
  const relation = likes.compareDocumentPosition(slot);
  assert.ok(relation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'slot should render after likes strip');
  assert.strictEqual(slot.contains(chip), true, 'chip should stay inside slot next to likes strip');
  drainChipMutations(observer);
  likes.insertAdjacentElement('beforebegin', slot);
  drainChipMutations(observer);
  runInject(dom, helpers);
  changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 0, 'realigning likes order should not duplicate chip');
  assert.strictEqual(changes.removed, 0, 'realigning likes order should not remove chip');
  const relationAfter = likes.compareDocumentPosition(slot);
  assert.ok(relationAfter & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'slot should remain after likes strip after realign');
  assert.strictEqual(slot.contains(chip), true, 'chip should remain anchored inside slot after realign');
  observer.disconnect();
})();

(function testChipHandlesOwnerLikeBadge(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Polecam serdecznie, wlasciciel bardzo pomocny!', true, { reviewId: 'rev-liked-owner' });
  const header = dom.window.document.createElement('div');
  header.textContent = 'Zofia Wlasciciel';
  card.insertBefore(header, card.firstChild);
  const badge = dom.window.document.createElement('div');
  badge.className = 'owner-badge';
  badge.textContent = 'Polubione przez wlasciciela';
  header.insertAdjacentElement('afterend', badge);
  const observer = createChipObserver(dom, card);
  runInject(dom, helpers);
  let changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 1, 'expected chip insertion with owner badge');
  assert.strictEqual(changes.removed, 0, 'expected no removals on first pass with owner badge');
  const chip = card.querySelector('.rc-chip-btn');
  let slot = card.querySelector('.rc-chip-slot');
  assert.ok(chip, 'chip should be present with owner badge');
  assert.ok(slot, 'slot should be created alongside owner badge');
  assert.strictEqual(slot.contains(chip), true, 'chip should be inside slot with owner badge');
  const headerRelation = slot.compareDocumentPosition(header);
  assert.ok(headerRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING, 'slot should remain below reviewer header');
  const badgeInitialRelation = badge.compareDocumentPosition(slot);
  assert.ok(badgeInitialRelation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'slot should follow owner badge initially');
  drainChipMutations(observer);
  card.insertBefore(badge, slot.nextSibling);
  runInject(dom, helpers);
  changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 0, 'badge reorder should not reinsert chip');
  assert.strictEqual(changes.removed, 0, 'badge reorder should not remove chip');
  slot = card.querySelector('.rc-chip-slot');
  assert.ok(slot.contains(chip), 'chip should stay inside slot after badge moves');
  const badgeMoveRelation = badge.compareDocumentPosition(slot);
  assert.ok(badgeMoveRelation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'slot should realign after badge moves');
  const newBadge = dom.window.document.createElement('div');
  newBadge.className = 'owner-badge';
  newBadge.textContent = 'Polubione przez wlasciciela';
  badge.replaceWith(newBadge);
  drainChipMutations(observer);
  runInject(dom, helpers);
  changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 0, 'badge replacement should not add chip again');
  assert.strictEqual(changes.removed, 0, 'badge replacement should not remove chip');
  slot = card.querySelector('.rc-chip-slot');
  assert.ok(slot.contains(chip), 'chip should remain after badge replacement');
  const newBadgeRelation = newBadge.compareDocumentPosition(slot);
  assert.ok(newBadgeRelation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'slot should follow new owner badge');
  observer.disconnect();
})();

(function testCardHashIgnoresOwnerLikeLabel(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const baseText = 'Rewelacyjna jakosc produktow i mila obsluga, wroce ponownie!';
  const card = buildCard(dom, baseText, true, { reviewId: '' });
  card.removeAttribute('data-review-id');
  runInject(dom, helpers);
  let chip = card.querySelector('.rc-chip-btn');
  assert.ok(chip, 'expected chip before owner like label added');
  const initialHash = card.dataset.rcHash;
  assert.ok(initialHash && initialHash.startsWith('text:'), 'expected text-based hash when no review id present');
  const body = card.querySelector('.ODSEW-ShBeI-text');
  body.textContent = baseText + ' Polubione przez wlasciciela';
  runInject(dom, helpers);
  chip = card.querySelector('.rc-chip-btn');
  assert.ok(chip, 'expected chip to persist after owner like label appended');
  const updatedHash = card.dataset.rcHash;
  assert.strictEqual(updatedHash, initialHash, 'expected hash to ignore owner like label additions');
  const chips = card.querySelectorAll('.rc-chip-btn');
  assert.strictEqual(chips.length, 1, 'expected exactly one chip after owner like label append');
})();

(function testChipSettlesAfterHeaderChange(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Profesjonalna obsluga i szybka realizacja zamowienia, polecam!', true, { reviewId: 'rev-liked-badge' });
  let header = dom.window.document.createElement('div');
  header.setAttribute('data-reviewer-name', 'Marek Wlasciciel');
  header.textContent = 'Marek Wlasciciel';
  card.insertBefore(header, card.firstChild);
  const observer = createChipObserver(dom, card);
  runInject(dom, helpers);
  drainChipMutations(observer);
  const chip = card.querySelector('.rc-chip-btn');
  let slot = card.querySelector('.rc-chip-slot');
  assert.ok(chip, 'chip should be present after first scan');
  assert.ok(slot, 'slot should exist after first scan');
  assert.strictEqual(slot.contains(chip), true, 'chip should reside inside slot after first scan');
  const initialRelation = slot.compareDocumentPosition(header);
  assert.ok(initialRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING, 'slot should trail the initial header');
  card.removeChild(header);
  header = dom.window.document.createElement('div');
  header.setAttribute('data-reviewer-name', 'Marek Wlasciciel');
  header.textContent = 'Marek Wlasciciel';
  card.appendChild(header);
  drainChipMutations(observer);
  runInject(dom, helpers);
  let changes = drainChipMutations(observer);
  assert.ok(changes.added + changes.removed >= 1, 'expected chip reposition when header changes');
  drainChipMutations(observer);
  runInject(dom, helpers);
  changes = drainChipMutations(observer);
  assert.strictEqual(changes.added, 0, 'chip should settle after header stabilises');
  assert.strictEqual(changes.removed, 0, 'chip should not flicker after settling');
  slot = card.querySelector('.rc-chip-slot');
  assert.ok(slot, 'slot should realign after header change');
  assert.strictEqual(slot.contains(chip), true, 'chip should stay within slot after header change');
  const headerRelation = slot.compareDocumentPosition(header);
  assert.ok(headerRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING, 'slot should follow new header');
  assert.ok(chip.classList.contains('rc-chip-anchored'), 'chip should keep anchored styling after header change');
  observer.disconnect();
})();



(async function testChipFallsBackWhenHeaderEjectsSlot(){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const helpers = loadInjection(dom);
  resetEnvironment(dom, helpers);
  const card = buildCard(dom, 'Fantastyczna obsluga, dziekujemy!', true, { reviewId: 'rev-liked-loop' });
  const header = dom.window.document.createElement('div');
  header.setAttribute('data-reviewer-name', 'Anna Wlasciciel');
  header.textContent = 'Anna Wlasciciel';
  card.insertBefore(header, card.firstChild);

  let slotRemovals = 0;
  const sentinel = new dom.window.MutationObserver(records => {
    records.forEach(record => {
      record.addedNodes.forEach(node => {
        if (node?.classList?.contains('rc-chip-slot')){
          slotRemovals += 1;
          node.remove();
        }
      });
    });
  });
  sentinel.observe(card, { childList: true });

  runInject(dom, helpers);
  await new Promise(resolve => setTimeout(resolve, 25));

  sentinel.disconnect();

  const chip = card.querySelector('.rc-chip-btn');
  assert.ok(chip, 'chip should survive hostile header removals');
  assert.ok(slotRemovals >= 3, 'expected multiple header insert attempts before fallback engaged');
  assert.strictEqual(card.querySelector('.rc-chip-slot'), null, 'fallback should avoid recreating header slots');
  assert.strictEqual(chip.classList.contains('rc-chip-anchored'), false, 'chip should drop anchored class after fallback');
  const replyBtn = card.querySelector('button:not(.rc-chip-btn)');
  assert.ok(replyBtn, 'reply button should remain available for fallback placement');
  assert.strictEqual(replyBtn.nextElementSibling, chip, 'chip should fall back immediately after reply button');
  assert.ok(card.contains(chip), 'chip should remain within card after fallback');
})();
console.log('[ok] injectForCards attaches chip for eligible cards');
