from pathlib import Path
p = Path('content.js')
text = p.read_text(encoding='utf-8')
old_segment = "    const rawText = (card.innerText || card.textContent || '').trim();\r\n    const text = normalizeSpaces(rawText);\r\n    if (text.length < 16) return;\r\n    const normalized = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');\r\n    if (/podpowiedzodpowiedz|dodajodpowiedz|edytujodpowiedz|twojaodpowiedz|odpowiedzfirm|odpowiedzispodzielono/.test(normalized)) return;\r\n    const hashVal = (card.getAttribute('data-review-id') || '') + '|' + hash(text.slice(0, 300));"
if old_segment not in text:
    raise SystemExit('segment not found')
new_segment = "    const rawText = extractText(card) || '';\r\n    const text = normalizeSpaces(rawText);\r\n    if (text.length < 16) return;\r\n    const normalized = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');\r\n    if (/podpowiedzodpowiedz|dodajodpowiedz|edytujodpowiedz|twojaodpowiedz|odpowiedzfirm|odpowiedzispodzielono/.test(normalized)) return;\r\n    const hashVal = (card.getAttribute('data-review-id') || '') + '|' + hash(text.slice(0, 300));"
p.write_text(text.replace(old_segment, new_segment, 1), encoding='utf-8')
