from pathlib import Path
path = Path('tests/inject.test.js')
text = path.read_text()
needle = "const snippet = contentSource.slice(prefixStart, injectEnd) + '\\nmodule.exports = { injectForCards, chipRegistry, qsaDeep, createChipButton };';"
replace = "  const extractTextStart = contentSource.indexOf('function extractText');\n  const extractTextEnd = contentSource.indexOf('function extractRating');\n  const snippet = contentSource.slice(prefixStart, injectEnd) + contentSource.slice(extractTextStart, extractTextEnd) + '\\nmodule.exports = { injectForCards, chipRegistry, qsaDeep, createChipButton, extractText };';"
if needle not in text:
    raise SystemExit('needle not found in inject test')
path.write_text(text.replace(needle, replace, 1))
