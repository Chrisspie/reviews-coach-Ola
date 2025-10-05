const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

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
  const qsaStart = contentSource.indexOf('function qsaDeep');
  const qsaEnd = contentSource.indexOf('function ensureRoot');
  const extractTextStart = contentSource.indexOf('function extractText');
  const extractTextEnd = contentSource.indexOf('function extractRating');
  const extractRatingStart = contentSource.indexOf('function extractRating');
  const extractRatingEnd = contentSource.indexOf('async function pasteIntoReplyViaPopup');
  const code = [
    contentSource.slice(qsaStart, qsaEnd),
    contentSource.slice(extractTextStart, extractTextEnd),
    contentSource.slice(extractRatingStart, extractRatingEnd),
    'module.exports = { extractText, extractRating, qsaDeep };'
  ].join('\n');
  const script = new vm.Script(code, { filename: 'extractors.js' });
  const context = vm.createContext(sandbox);
  script.runInContext(context);
  return context.module.exports;
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

const tests = [
  {
    name: 'extractText prefers review text over extension UI',
    run(){
      withDom(`
        <div id="card" data-review-id="1">
          <div class="ODSEW-ShBeI-text">Swietna obsluga!</div>
          <button class="rc-chip-btn"><span>Podpowiedz odpowiedz</span></button>
        </div>
        <div id="rc_root"></div>
      `, ({ extractText, dom }) => {
        const card = dom.window.document.getElementById('card');
        const result = extractText(card);
        assert.strictEqual(result, 'Swietna obsluga!');
      });
    }
  },
  {
    name: 'extractText falls back to longest meaningful chunk',
    run(){
      withDom(`
        <div id="card">
          <div class="rc-chip-btn">Podpowiedz odpowiedz</div>
          <p>Ok</p>
        </div>
      `, ({ extractText, dom }) => {
        const card = dom.window.document.getElementById('card');
        const result = extractText(card);
        assert.strictEqual(result, 'Ok');
      });
    }
  },
  {
    name: 'extractRating reads value from aria-label',
    run(){
      withDom(`
        <div id="card">
          <div aria-label="Ocena 4,5 na 5"><span>?????</span></div>
        </div>
      `, ({ extractRating, dom }) => {
        const card = dom.window.document.getElementById('card');
        const result = extractRating(card);
        assert.strictEqual(result, '4.5');
      });
    }
  },
  {
    name: 'extractRating reads data-rating attributes',
    run(){
      withDom(`
        <div id="card">
          <div data-rating="3.0"></div>
        </div>
      `, ({ extractRating, dom }) => {
        const card = dom.window.document.getElementById('card');
        const result = extractRating(card);
        assert.strictEqual(result, '3');
      });
    }
  },
  {
    name: 'extractRating falls back to inline text patterns',
    run(){
      withDom(`
        <div id="card">Ocena klienta: 2 / 5</div>
      `, ({ extractRating, dom }) => {
        const card = dom.window.document.getElementById('card');
        const result = extractRating(card);
        assert.strictEqual(result, '2');
      });
    }
  }
];

let passed = 0;
for (const test of tests){
  try {
    test.run();
    console.log(`? ${test.name}`);
    passed++;
  } catch (err){
    console.error(`? ${test.name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1){
  console.log(`All ${passed} tests passed.`);
}
