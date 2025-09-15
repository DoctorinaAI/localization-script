const { label, description, meta, en, languages } = $input.item.json;

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function safeStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

const normLabel = safeStr(label);
const normDesc = safeStr(description);
const normEn = safeStr(en);
const langs = uniq(languages).map(l => safeStr(l));

// Basic validation (soft) - we don't throw here to keep node flexible.
if (!normLabel) throw new Error('Missing label');
if (!normEn) throw new Error('Missing source English text');
if (!langs.length) throw new Error('No target languages provided');

const metaJson = meta ? JSON.stringify(meta) : null;

// JSON schema (informal) to force strict shape.
const schema = `"label": string,\n  "localization": {\n    <language_code>: { "text": string (non-empty) } (one entry per requested language, no extras)\n  }`;

// Output skeleton for clarity.
const skeletonLines = [];
skeletonLines.push('{');
skeletonLines.push(`  "label": "${normLabel}",`);
skeletonLines.push('  "localization": {');
langs.forEach((l, i) => {
  const comma = i === langs.length - 1 ? '' : ',';
  skeletonLines.push(`    "${l}": { "text": "" }${comma}`);
});
skeletonLines.push('  }');
skeletonLines.push('}');

const p = [];
p.push('You are a professional localization engine for a medical symptom-based advice chatbot.');
p.push('Localize the item below into the target languages.');
p.push('--- CONTEXT INPUT ---');
p.push(`label: ${normLabel}`);
if (normDesc) p.push(`description: ${normDesc}`);
if (metaJson) p.push(`meta_placeholders (ICU / intl format): ${metaJson}`);
p.push(`en_source: ${normEn}`);
p.push(`target_languages: ${langs.join(', ')}`);
p.push('--- OUTPUT REQUIREMENTS ---');
p.push('Return ONLY valid minified JSON (no comments, no markdown fences).');
p.push('Do NOT add explanatory text before or after JSON.');
p.push('All requested languages MUST be present, no additional keys.');
p.push('Preserve ICU/intl placeholders exactly (e.g., {name}, {version}, {count}).');
p.push('Preserve HTML-like or XML-like tags verbatim if present.');
p.push('Do not introduce new placeholders or variables.');
p.push('If translation would be identical to English, repeat the English text.');
p.push('Avoid adding periods if original does not have one; keep stylistic equivalence.');
p.push('No leading/trailing spaces in values.');
p.push('Each value MUST be culturally and medically appropriate, neutral and concise.');
p.push('No quotes escaping beyond standard JSON string escaping.');
p.push('--- JSON SCHEMA (informal) ---');
p.push(schema);
p.push('--- OUTPUT SKELETON (structure to follow) ---');
p.push(skeletonLines.join('\n'));
p.push('--- RULES SUMMARY ---');
p.push('1. Output only JSON.');
p.push('2. Keys: label, localization.');
p.push('3. localization contains exactly the target languages.');
p.push('4. Each language object: {"text": "<translation>"}.');
p.push('5. Do not include description, meta, or extra metadata fields.');
p.push('6. Do not translate placeholders or modify their braces.');
p.push('7. Keep punctuation style consistent with source.');
p.push('8. Avoid hallucinating additional medical advice beyond the source meaning.');
p.push('9. Keep resulting JSON compact (no unnecessary whitespace).');
p.push('10. Use UTF-8 characters directly (no HTML entities).');

const prompt = p.join('\n');

return {
  label: normLabel,
  description: normDesc || undefined,
  meta: meta || undefined,
  en: normEn,
  languages: langs,
  prompt,
  promt: prompt // backward compatibility
};