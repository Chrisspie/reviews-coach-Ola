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

describe('Injection Logic', () => {
  test('Chip appears for valid review', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
    const helpers = loadInjection(dom);
    resetEnvironment(dom, helpers);
    const card = buildCard(dom, 'Swietna obsluga i mila atmosfera, polecam!', true, { reviewId: 'rev1' });
    runInject(dom, helpers);
    const chip = card.querySelector('.rc-chip-btn');
    expect(chip).toBeTruthy();
  });

  test('Chip skipped for too short review', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
    const helpers = loadInjection(dom);
    resetEnvironment(dom, helpers);
    const card = buildCard(dom, 'ok', true, { reviewId: 'rev-short' });
    runInject(dom, helpers);
    const chip = card.querySelector('.rc-chip-btn');
    expect(chip).toBeNull();
  });

  test('Chip persists without reply button once eligible', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
    const helpers = loadInjection(dom);
    resetEnvironment(dom, helpers);
    const card = buildCard(dom, 'Obsluga na najwyzszym poziomie, bardzo dziekuje!', true, { reviewId: 'rev-liked' });
    runInject(dom, helpers);
    let chip = card.querySelector('.rc-chip-btn');
    expect(chip).toBeTruthy();
    const reply = card.querySelector('button:not(.rc-chip-btn)');
    if (reply) reply.remove();
    runInject(dom, helpers);
    chip = card.querySelector('.rc-chip-btn');
    expect(chip).toBeTruthy();
  });

  test('Chip anchors near reviewer header', () => {
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
    expect(chip).toBeTruthy();
    expect(slot).toBeTruthy();
    const slotVsHeader = slot.compareDocumentPosition(header);
    expect(slotVsHeader & dom.window.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(slot.contains(chip)).toBe(true);
    expect(chip.classList.contains('rc-chip-anchored')).toBe(true);
  });

  test('Chip does not flicker on stable card', () => {
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
    expect(changes.added).toBe(1);
    expect(changes.removed).toBe(0);
    const chip = card.querySelector('.rc-chip-btn');
    const slot = card.querySelector('.rc-chip-slot');
    expect(chip).toBeTruthy();
    expect(slot).toBeTruthy();
    const slotRelation = slot.compareDocumentPosition(header);
    expect(slotRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(slot.contains(chip)).toBe(true);
    changes = drainChipMutations(observer);
    runInject(dom, helpers);
    changes = drainChipMutations(observer);
    expect(changes.added).toBe(0);
    expect(changes.removed).toBe(0);
    runInject(dom, helpers);
    changes = drainChipMutations(observer);
    expect(changes.added).toBe(0);
    expect(changes.removed).toBe(0);
    const currentSlot = card.querySelector('.rc-chip-slot');
    expect(currentSlot).toBeTruthy();
    const currentRelation = currentSlot.compareDocumentPosition(header);
    expect(currentRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(currentSlot.contains(chip)).toBe(true);
    observer.disconnect();
  });

  test('Chip respects likes strip', () => {
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
    expect(changes.added).toBe(1);
    expect(changes.removed).toBe(0);
    const chip = card.querySelector('.rc-chip-btn');
    const slot = card.querySelector('.rc-chip-slot');
    expect(chip && slot).toBeTruthy();
    const relation = likes.compareDocumentPosition(slot);
    expect(relation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.contains(chip)).toBe(true);
    drainChipMutations(observer);
    likes.insertAdjacentElement('beforebegin', slot);
    drainChipMutations(observer);
    runInject(dom, helpers);
    changes = drainChipMutations(observer);
    expect(changes.added).toBe(0);
    expect(changes.removed).toBe(0);
    const relationAfter = likes.compareDocumentPosition(slot);
    expect(relationAfter & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.contains(chip)).toBe(true);
    observer.disconnect();
  });

  test('Chip handles owner like badge', () => {
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
    expect(changes.added).toBe(1);
    expect(changes.removed).toBe(0);
    const chip = card.querySelector('.rc-chip-btn');
    let slot = card.querySelector('.rc-chip-slot');
    expect(chip).toBeTruthy();
    expect(slot).toBeTruthy();
    expect(slot.contains(chip)).toBe(true);
    const headerRelation = slot.compareDocumentPosition(header);
    expect(headerRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const badgeInitialRelation = badge.compareDocumentPosition(slot);
    expect(badgeInitialRelation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    drainChipMutations(observer);
    card.insertBefore(badge, slot.nextSibling);
    runInject(dom, helpers);
    changes = drainChipMutations(observer);
    expect(changes.added).toBe(0);
    expect(changes.removed).toBe(0);
    slot = card.querySelector('.rc-chip-slot');
    expect(slot.contains(chip)).toBeTruthy();
    const badgeMoveRelation = badge.compareDocumentPosition(slot);
    expect(badgeMoveRelation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const newBadge = dom.window.document.createElement('div');
    newBadge.className = 'owner-badge';
    newBadge.textContent = 'Polubione przez wlasciciela';
    badge.replaceWith(newBadge);
    drainChipMutations(observer);
    runInject(dom, helpers);
    changes = drainChipMutations(observer);
    expect(changes.added).toBe(0);
    expect(changes.removed).toBe(0);
    slot = card.querySelector('.rc-chip-slot');
    expect(slot.contains(chip)).toBeTruthy();
    const newBadgeRelation = newBadge.compareDocumentPosition(slot);
    expect(newBadgeRelation & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    observer.disconnect();
  });

  test('Card hash ignores owner like label', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
    const helpers = loadInjection(dom);
    resetEnvironment(dom, helpers);
    const baseText = 'Rewelacyjna jakosc produktow i mila obsluga, wroce ponownie!';
    const card = buildCard(dom, baseText, true, { reviewId: '' });
    card.removeAttribute('data-review-id');
    runInject(dom, helpers);
    let chip = card.querySelector('.rc-chip-btn');
    expect(chip).toBeTruthy();
    const initialHash = card.dataset.rcHash;
    expect(initialHash && initialHash.startsWith('text:')).toBeTruthy();
    const body = card.querySelector('.ODSEW-ShBeI-text');
    body.textContent = baseText + ' Polubione przez wlasciciela';
    runInject(dom, helpers);
    chip = card.querySelector('.rc-chip-btn');
    expect(chip).toBeTruthy();
    const updatedHash = card.dataset.rcHash;
    expect(updatedHash).toBe(initialHash);
    const chips = card.querySelectorAll('.rc-chip-btn');
    expect(chips.length).toBe(1);
  });

  test('Chip settles after header change', () => {
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
    expect(chip).toBeTruthy();
    expect(slot).toBeTruthy();
    expect(slot.contains(chip)).toBe(true);
    const initialRelation = slot.compareDocumentPosition(header);
    expect(initialRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    card.removeChild(header);
    header = dom.window.document.createElement('div');
    header.setAttribute('data-reviewer-name', 'Marek Wlasciciel');
    header.textContent = 'Marek Wlasciciel';
    card.appendChild(header);
    drainChipMutations(observer);
    runInject(dom, helpers);
    let changes = drainChipMutations(observer);
    expect(changes.added + changes.removed).toBeGreaterThanOrEqual(1);
    drainChipMutations(observer);
    runInject(dom, helpers);
    changes = drainChipMutations(observer);
    expect(changes.added).toBe(0);
    expect(changes.removed).toBe(0);
    slot = card.querySelector('.rc-chip-slot');
    expect(slot).toBeTruthy();
    expect(slot.contains(chip)).toBe(true);
    const headerRelation = slot.compareDocumentPosition(header);
    expect(headerRelation & dom.window.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(chip.classList.contains('rc-chip-anchored')).toBe(true);
    observer.disconnect();
  });

  test('Chip falls back when header ejects slot', async () => {
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
    expect(chip).toBeTruthy();
    expect(slotRemovals).toBeGreaterThanOrEqual(3);
    expect(card.querySelector('.rc-chip-slot')).toBeNull();
    expect(chip.classList.contains('rc-chip-anchored')).toBe(false);
    const replyBtn = card.querySelector('button:not(.rc-chip-btn)');
    expect(replyBtn).toBeTruthy();
    expect(replyBtn.nextElementSibling).toBe(chip);
    expect(card.contains(chip)).toBe(true);
  });
});