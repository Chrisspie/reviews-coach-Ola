from pathlib import Path
p = Path('content.js')
text = p.read_text(encoding='utf-8')
old = "  const clean = (str = '') => normalizeSpaces(str);\n"
if old not in text:
    raise SystemExit('clean pattern missing')
new = "  const clean = (str = '') => (str || '').replace(/\\s+/g, ' ').trim();\n"
p.write_text(text.replace(old, new, 1), encoding='utf-8')
