const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const scriptPaths = [
  path.join(__dirname, '..', 'content', 'namespace.js'),
  path.join(__dirname, '..', 'content', 'dom.js'),
  path.join(__dirname, '..', 'content', 'reviews.js')
];

function loadExtractors(dom){
  const sandbox = {
    window: dom.window,
    document: dom.window.document,
    console,
    Node: dom.window.Node,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
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
    extractText: RC.reviews.extractText,
    extractRating: RC.reviews.extractRating,
    qsaDeep: RC.dom.qsaDeep
  };
}

function withDom(html, fn){
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, { pretendToBeVisual: true });
  try {
    const extractors = loadExtractors(dom);
    fn({ ...extractors, dom });
  } finally {
    dom.window.close();
  }
}

describe('Extraction Logic', () => {
  test('extractText prefers review text over extension UI', () => {
    withDom(`
      <div id="card" data-review-id="1">
        <div class="ODSEW-ShBeI-text">Swietna obsluga!</div>
        <button class="rc-chip-btn"><span>Podpowiedz odpowiedz</span></button>
      </div>
      <div id="rc_root"></div>
    `, ({ extractText, dom }) => {
      const card = dom.window.document.getElementById('card');
      const result = extractText(card);
      expect(result).toBe('Swietna obsluga!');
    });
  });

  test('extractText falls back to longest meaningful chunk', () => {
    withDom(`
      <div id="card">
        <div class="rc-chip-btn">Podpowiedz odpowiedz</div>
        <p>Ok</p>
      </div>
    `, ({ extractText, dom }) => {
      const card = dom.window.document.getElementById('card');
      const result = extractText(card);
      expect(result).toBe('Ok');
    });
  });

  test('extractRating reads value from aria-label', () => {
    withDom(`
      <div id="card">
        <div aria-label="Ocena 4,5 na 5"><span>?????</span></div>
      </div>
    `, ({ extractRating, dom }) => {
      const card = dom.window.document.getElementById('card');
      const result = extractRating(card);
      expect(result).toBe('4.5');
    });
  });

  test('extractRating reads data-rating attributes', () => {
    withDom(`
      <div id="card">
        <div data-rating="3.0"></div>
      </div>
    `, ({ extractRating, dom }) => {
      const card = dom.window.document.getElementById('card');
      const result = extractRating(card);
      expect(result).toBe('3');
    });
  });

  test('extractRating falls back to inline text patterns', () => {
    withDom(`
      <div id="card">Ocena klienta: 2 / 5</div>
    `, ({ extractRating, dom }) => {
      const card = dom.window.document.getElementById('card');
      const result = extractRating(card);
      expect(result).toBe('2');
    });
  });
});
