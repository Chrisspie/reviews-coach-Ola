from pathlib import Path
p = Path('content.js')
text = p.read_text(encoding='utf-8')
old = "    const rawText = extractText(card) || '';\n    const text = normalizeSpaces(rawText);\n"
if old not in text:
    raise SystemExit('pattern not found for normalizeSpaces block')
new = "    const rawText = extractText(card) || '';\n    const text = rawText.replace(/\\s+/g, ' ').trim();\n"
p.write_text(text.replace(old, new, 1), encoding='utf-8')
