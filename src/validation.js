/**
 * Enhanced validation & normalization for ChatGPT translation response (n8n Code node).
 *
 * Input assumptions:
 *   1) Original prompt context is available as $("Promt").item.json and contains:
 *        { label, description, meta, en, languages }
 *   2) Model reply JSON (or text containing JSON / fenced code) is at:
 *        $input.item.json.message.content
 *
 * Expected normalized output shape:
 *   {
 *     label: string,
 *     localization: { [lang]: { text: string } }
 *   }
 */

// -------------------- Helpers --------------------
function fail(msg, extra) {
  const err = new Error(msg);
  if (extra) err.extra = extra;
  throw err;
}

function extractJson(raw) {
  if (raw == null) fail('Empty response content');
  if (typeof raw === 'object') return raw; // already parsed upstream
  const txt = String(raw).trim();
  if (!txt) fail('Blank response content');
  // Try fenced code blocks first ```json ... ```
  const fenceMatch = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const core = fenceMatch ? fenceMatch[1].trim() : txt;
  try {
    return JSON.parse(core);
  } catch (e) {
    // Attempt to recover minor trailing commas
    const cleaned = core
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']');
    try {
      return JSON.parse(cleaned);
    } catch (_e2) {
      fail('Cannot parse JSON from response', { snippet: core.slice(0, 400) });
    }
  }
}

function normalizeLangCode(code) {
  return String(code).trim();
}

// Accept: {text:"..."} or plain string -> { text: string }
function normalizeEntry(val, lang, label) {
  if (val == null) fail(`Locale "${lang}" for label "${label}" is null/undefined`);
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t) fail(`Locale "${lang}" for label "${label}" is empty string`);
    return { text: t };
  }
  if (typeof val === 'object') {
    if (typeof val.text !== 'string') fail(`Locale "${lang}" for label "${label}" missing "text" field`);
    const t = val.text.trim();
    if (!t) fail(`Locale "${lang}" for label "${label}" has blank text`);
    return { text: t };
  }
  fail(`Locale "${lang}" for label "${label}" has invalid type: ${typeof val}`);
}

function validateLanguageCode(code) {
  // Allow: xx, xxx, xx_XX, xx-XX
  const re = /^[a-z]{2,3}(?:[_-][A-Z]{2})?$/;
  return re.test(code);
}

// -------------------- Main --------------------
const { label, description, meta, en, languages } = $("Promt").item.json;
const rawResp = $input.item.json.message.content;
const response = extractJson(rawResp);

if (!response || typeof response !== 'object') fail('Response not an object');
if (!response.label) fail('Missing label in response');
if (response.label !== label) fail(`Label mismatch. Expected "${label}" got "${response.label}"`);

if (!('localization' in response)) fail('Missing "localization" root field');
if (!response.localization || typeof response.localization !== 'object') fail('"localization" must be an object');

const required = Array.isArray(languages) ? languages : [];
if (!required.length) fail('No required languages in original context');

const outLoc = {};

for (const lang of required) {
  const normalizedCode = normalizeLangCode(lang);
  if (!validateLanguageCode(normalizedCode)) fail(`Invalid requested language code "${lang}"`);
  if (!Object.prototype.hasOwnProperty.call(response.localization, normalizedCode)) {
    fail(`Missing locale "${normalizedCode}" for label "${label}"`);
  }
  outLoc[normalizedCode] = normalizeEntry(response.localization[normalizedCode], normalizedCode, label);
}

// Detect unexpected extra languages - can warn or strip; here we ignore extras but enforce structure
for (const key of Object.keys(response.localization)) {
  if (!outLoc[key]) {
    // Silently normalize if valid code & value
    if (validateLanguageCode(key)) {
      try {
        outLoc[key] = normalizeEntry(response.localization[key], key, label);
      } catch (_e) {
        // ignore failing extras
      }
    }
  }
}

return {
  label,
  localization: outLoc
};