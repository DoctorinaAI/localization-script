const DEFAULTS = {
  API_URL: "", // Add this url to Script Properties
  API_KEY: "", // Add this API key to Script Properties
  OVERWRITE: "false",
  TIMEOUT_MS: "360000",
  BATCH_SIZE: "3",
  RETRY_MAX: "2",
  RETRY_DELAY_MS: "1000",
  HIGHLIGHT_COLOR: "220,255,220",
  DRY_RUN: "false",
  HIGHLIGHT_CLEAR_MINUTES: "1", // 0 = do not auto clear
};

/** ===================== MENU ===================== **/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Localization")
    .addItem("Translate all empty cells", "runLocalization")
    .addSeparator()
    .addItem("Fill GOOGLETRANSLATE formulas", "fillGoogleTranslateFormulas")
    .addItem("Freeze GOOGLETRANSLATE formulas", "freezeGoogleTranslateFormulas")
    .addItem("Clear GOOGLETRANSLATE formulas", "clearGoogleTranslateFormulas")
    .addSeparator()
    .addItem("Clear translation highlight now", "clearLocalizationHighlight")
    .addToUi();
}

/** ===================== ENTRYPOINT ===================== **/
function runLocalization() {
  const started = new Date();
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2)
    throw new Error("Sheet is empty or has no data.");

  const config = getConfig();
  if (!config.API_URL && !config.dryRun)
    throw new Error("API_URL is not set in Script Properties.");

  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);

  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0)
    throw new Error('No language columns found after "en".');

  const rows = values.slice(1); // without header
  const uiOffset = 1; // shift for 1-based index
  const effectiveCount = detectEffectiveDataRowCount(rows, idx.label);
  const rowsEffective = rows.slice(0, effectiveCount);

  // Build request batch and mapping for write-back
  const batch = [];
  const byLabel = new Map(); // label -> { uiRow, requestedCodes:Set, targets:[{code, colIndex}] }
  const seenLabels = new Set();

  for (let r = 0; r < rowsEffective.length; r++) {
    const uiRow = r + 1 + uiOffset;
    const row = rowsEffective[r];

    const label = safeStr(row[idx.label]);
    const description = safeStr(row[idx.description]);
    const en = safeStr(row[idx.en]);
    const meta = parseMetaAllowEmpty(row[idx.meta], uiRow);

    if (!label || !en) continue;

    if (seenLabels.has(label)) {
      setRowNote(uiRow, 1, `Duplicate label: "${label}". Must be unique.`);
      throw new Error(`Duplicate label found: "${label}" (row ${uiRow}).`);
    }
    seenLabels.add(label);

    // Even with OVERWRITE=true request ONLY empty cells to avoid wasting quota
    const targets = pickEmptyTargetsForRow(sheet, uiRow, langsAll);
    if (targets.codes.length === 0) continue;

    batch.push({
      label,
      description,
      meta: meta ?? {},
      en,
      languages: targets.codes,
    });

    byLabel.set(label, {
      uiRow,
      requestedCodes: new Set(targets.codes),
      targets: targets.targets,
    });
  }

  if (batch.length === 0) {
    setStatus(config, "No empty cells");
    SpreadsheetApp.getActive().toast(
      "No cells need localization. Done.",
      "OK",
      5
    );
    return;
  }

  let totalWritten = 0;
  const batchesTotal = Math.ceil(batch.length / config.batchSize);

  for (let i = 0; i < batch.length; i += config.batchSize) {
    const slice = batch.slice(i, i + config.batchSize);
    const batchNum = Math.floor(i / config.batchSize) + 1;

    setStatus(config, `Batch ${batchNum}/${batchesTotal}`);

    let resp;
    if (config.dryRun) {
      resp = {
        data: slice.map((x) => ({
          label: x.label,
          localization: Object.fromEntries(
            x.languages.map((l) => [l, { text: `[SIM:${l}] ${x.en}` }])
          ),
        })),
      };
    } else {
      resp = callApiBatchWithRetry(config, { batch: slice });
    }

    const normalized = validateBatchResponse(resp, byLabel, { slice });

    const writtenNow = config.dryRun
      ? 0
      : writeBackSliceImmediate(sheet, normalized, byLabel, config);

    totalWritten += writtenNow;

    SpreadsheetApp.getActive().toast(
      `Batch ${batchNum}/${batchesTotal} OK${writtenNow ? `, written ${writtenNow}` : ""}`,
      "Progress",
      3
    );
  }

  if (totalWritten > 0 && config.highlightClearMinutes > 0) {
    scheduleHighlightClear(config.highlightClearMinutes);
  }

  const finished = new Date();
  const msg = `Localization: rows=${batch.length}; cells=${totalWritten}; batches=${Math.ceil(batch.length / config.batchSize)}; time=${finished - started}ms${config.dryRun ? " (DRY RUN)" : ""}`;
  setStatus(config, msg);
  SpreadsheetApp.getActive().toast(msg, "OK", 8);
  // logging removed
}

/** ===================== HEADER & LANG DETECTION ===================== **/
function indexHeader(header) {
  const req = ["label", "description", "meta", "en"];
  const map = {};
  for (const k of req) {
    const pos = header.findIndex((h) => h.toLowerCase() === k);
    if (pos < 0) throw new Error(`Required header column is missing: "${k}".`);
    map[k] = pos;
  }
  map.afterEnCol = map.en + 1;
  return map;
}

function detectLanguageColumns(header, startFrom) {
  const langRe = /^[a-z]{2,3}([_-][A-Z]{2})?$/;
  const result = [];
  for (let c = startFrom; c < header.length; c++) {
    const raw = (header[c] || "").trim();
    if (!raw) continue;
    if (!langRe.test(raw)) continue;
    const code = normalizeLangCode(raw);
    result.push({ code, colIndex: c, header: raw });
  }
  return result;
}

// Determine actual number of data rows until the first empty label.
function detectEffectiveDataRowCount(rows, labelColIndex) {
  for (let i = 0; i < rows.length; i++) {
    const label = rows[i][labelColIndex];
    if (!label || String(label).trim() === "") {
      return i; // until first empty label
    }
  }
  return rows.length;
}

function normalizeLangCode(raw) {
  const parts = String(raw).split(/[_-]/);
  if (parts.length === 1) return parts[0].toLowerCase();
  return `${parts[0].toLowerCase()}_${parts[1].toUpperCase()}`;
}

/** ===================== ROW UTILITIES ===================== **/
function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseMetaAllowEmpty(cell, uiRow) {
  const s = safeStr(cell);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_e) {
    setRowNote(uiRow, 3, `meta: invalid JSON`);
    throw new Error(`Row ${uiRow}: meta invalid JSON.`);
  }
}

// Collect only empty target cells (even if OVERWRITE=true) to avoid extra API calls.
function pickEmptyTargetsForRow(sheet, uiRow, langsAll) {
  const codes = [];
  const targets = [];
  for (const l of langsAll) {
    const cell = sheet.getRange(uiRow, l.colIndex + 1);
    const cur = safeStr(cell.getValue());
    if (cur === "") {
      codes.push(l.code);
      targets.push({ code: l.code, colIndex: l.colIndex });
    }
  }
  return { codes, targets };
}

/** ===================== API CALL & VALIDATION ===================== **/
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const API_URL = props.getProperty("API_URL") || DEFAULTS.API_URL;
  const API_KEY = props.getProperty("API_KEY") || DEFAULTS.API_KEY;
  const OVERWRITE =
    (props.getProperty("OVERWRITE") || DEFAULTS.OVERWRITE).toLowerCase() ===
    "true";
  const TIMEOUT_MS = parseInt(
    props.getProperty("TIMEOUT_MS") || DEFAULTS.TIMEOUT_MS,
    10
  );
  const BATCH_SIZE = parseInt(
    props.getProperty("BATCH_SIZE") || DEFAULTS.BATCH_SIZE,
    10
  );
  const RETRY_MAX = parseInt(
    props.getProperty("RETRY_MAX") || DEFAULTS.RETRY_MAX,
    10
  );
  const RETRY_DELAY_MS = parseInt(
    props.getProperty("RETRY_DELAY_MS") || DEFAULTS.RETRY_DELAY_MS,
    10
  );
  const HIGHLIGHT_COLOR =
    props.getProperty("HIGHLIGHT_COLOR") || DEFAULTS.HIGHLIGHT_COLOR;
  const DRY_RUN =
    (props.getProperty("DRY_RUN") || DEFAULTS.DRY_RUN).toLowerCase() === "true";
  const HIGHLIGHT_CLEAR_MINUTES = parseInt(
    props.getProperty("HIGHLIGHT_CLEAR_MINUTES") ||
      DEFAULTS.HIGHLIGHT_CLEAR_MINUTES,
    10
  );
  const batchSize = isFinite(BATCH_SIZE) && BATCH_SIZE > 0 ? BATCH_SIZE : 3;
  return {
    API_URL,
    API_KEY,
    overwrite: OVERWRITE,
    timeout: isFinite(TIMEOUT_MS) ? TIMEOUT_MS : 60000,
    batchSize,
    retryMax: isFinite(RETRY_MAX) ? RETRY_MAX : 2,
    retryDelay: isFinite(RETRY_DELAY_MS) ? RETRY_DELAY_MS : 1000,
    highlightRGB: HIGHLIGHT_COLOR,
    dryRun: DRY_RUN,
    highlightClearMinutes: isFinite(HIGHLIGHT_CLEAR_MINUTES)
      ? HIGHLIGHT_CLEAR_MINUTES
      : 0,
  };
}

function callApiBatch(config, payload) {
  const headers = { "Content-Type": "application/json" };
  if (config.API_KEY) {
    headers.Authorization = config.API_KEY.startsWith("Bearer ")
      ? config.API_KEY
      : `Bearer ${config.API_KEY}`;
  }

  const resp = UrlFetchApp.fetch(config.API_URL, {
    method: "post",
    muteHttpExceptions: true,
    contentType: "application/json",
    headers,
    payload: JSON.stringify(payload),
    followRedirects: true,
    validateHttpsCertificates: true,
    escaping: false,
    timeout: config.timeout,
  });

  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`API HTTP ${code}: ${resp.getContentText().slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(resp.getContentText());
  } catch (_e) {
    throw new Error("API returned non-JSON response.");
  }
  return data;
}

function callApiBatchWithRetry(config, payload) {
  let attempt = 0;
  let delay = config.retryDelay;
  let lastErr;
  while (attempt <= config.retryMax) {
    try {
      if (attempt > 0) Utilities.sleep(delay);
      return callApiBatch(config, payload);
    } catch (e) {
      lastErr = e;
      delay = Math.min(delay * 2, 30000);
      attempt++;
    }
  }
  throw lastErr || new Error("API retry failed");
}

function validateBatchResponse(resp, byLabel, ctx) {
  if (!resp || typeof resp !== "object" || !Array.isArray(resp.data)) {
    throw new Error(`Response object missing array \"data\".`);
  }

  const normalized = [];
  const serverByLabel = new Map();
  for (const item of resp.data) {
    if (!item || typeof item !== "object") continue;
    const label = safeStr(item.label);
    if (!label) continue;
    if (serverByLabel.has(label)) {
      throw new Error(`Response contains duplicate label "${label}".`);
    }
    serverByLabel.set(label, item);
  }

  for (const [label, meta] of byLabel.entries()) {
    const got = serverByLabel.get(label);
    if (!got) continue; // может быть в другом батче
    if (!got.localization || typeof got.localization !== "object") {
      throw new Error(`label "${label}": missing \"localization\" object.`);
    }
    const outLoc = {};
    const missing = [];
    for (const code of meta.requestedCodes) {
      const rawVal = got.localization[code];
      if (rawVal == null) {
        missing.push(code);
        continue;
      }
      if (
        rawVal &&
        typeof rawVal === "object" &&
        typeof rawVal.text !== "undefined"
      ) {
        outLoc[code] = safeStr(rawVal.text);
      } else {
        outLoc[code] = safeStr(rawVal);
      }
      if (!outLoc[code]) missing.push(code);
    }
    if (missing.length) {
      setRowNote(meta.uiRow, 1, `Missing languages: ${missing.join(", ")}`);
      throw new Error(
        `label "${label}": API did not return translations for: ${missing.join(", ")}`
      );
    }
    normalized.push({ label, localization: outLoc, uiRow: meta.uiRow });
  }

  return normalized;
}

/** ===================== WRITE BACK ===================== **/
function writeBackSliceImmediate(sheet, normalizedItems, byLabel, config) {
  if (!normalizedItems || !normalizedItems.length) return 0;
  const color = parseRGB(config.highlightRGB);
  let written = 0;

  for (const item of normalizedItems) {
    const info = byLabel.get(item.label);
    if (!info) continue;

    const loc = item.localization || {};
    for (const code of Object.keys(loc)) {
      // записываем только то, что изначально запрашивали
      if (!info.requestedCodes.has(code)) continue;

      const target = info.targets.find((t) => t.code === code);
      if (!target) continue;

      const uiRow = info.uiRow; // уже 1-based
      const col = target.colIndex + 1; // в A1 это 1-based
      const cell = sheet.getRange(uiRow, col);

      const cur = safeStr(cell.getValue());
      if (cur !== "") continue; // кто-то уже заполнил

      const next = safeStr(loc[code]);
      if (!next) continue;

      cell.setValue(next);
      if (color) cell.setBackgroundRGB(color.r, color.g, color.b);
      written++;
    }
  }
  return written;
}

function writeBackBuffers(sheet, langsAll, buffers, numRows, config) {
  let written = 0;
  const color = parseRGB(config.highlightRGB);
  for (const l of langsAll) {
    const col = l.colIndex + 1;
    const rng = sheet.getRange(2, col, numRows, 1);
    const existing = rng.getValues();
    const buf = buffers[l.code];
    let hasAny = false;
    const out = new Array(numRows);
    const highlightRows = [];
    for (let i = 0; i < numRows; i++) {
      const cur = existing[i][0];
      const next = buf[i];
      if (next != null && String(cur).trim() === "") {
        out[i] = [next];
        hasAny = true;
        written++;
        highlightRows.push(i);
      } else {
        out[i] = [cur];
      }
    }
    if (hasAny) {
      rng.setValues(out);
      if (color) {
        for (const r of highlightRows) {
          sheet
            .getRange(r + 2, col)
            .setBackgroundRGB(color.r, color.g, color.b);
        }
      }
    }
  }
  return written;
}

function parseRGB(str) {
  if (!str) return null;
  const parts = String(str)
    .split(/[,;]/)
    .map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some((n) => !isFinite(n))) return null;
  return { r: clamp(parts[0]), g: clamp(parts[1]), b: clamp(parts[2]) };
}
function clamp(n) {
  return Math.max(0, Math.min(255, n));
}

function rgbToHex(rgb) {
  if (!rgb) return null;
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toLowerCase();
}

/** ===================== FORMULA HELPERS ===================== **/
function isGoogleTranslateFormula(f) {
  if (!f) return false;
  return /(^|[^A-Z])GOOGLETRANSLATE\s*\(/i.test(f);
}

/** ===================== STATUS ===================== **/

function setStatus(config, text) {
  try {
    SpreadsheetApp.getActive().toast(text, "Localization", 5);
  } catch (e) {
    /* ignore */
  }
}

/** ===================== SHEET I/O & NOTES ===================== **/
function readActiveSheet() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const values = sheet.getDataRange().getValues();
  return { sheet, values };
}

function setRowNote(uiRow, uiColOrNull, message) {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (uiColOrNull == null) {
    sheet.getRange(uiRow, 1).setNote(message);
    return;
  }
  sheet.getRange(uiRow, uiColOrNull).setNote(message);
}

/** ===================== AUTO GOOGLETRANSLATE FORMULAS ===================== **/
function fillGoogleTranslateFormulas() {
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2)
    throw new Error("Sheet is empty or has no data.");

  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);
  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0) {
    SpreadsheetApp.getActive().toast(
      "No language columns after EN",
      "Auto Translate",
      5
    );
    return;
  }

  const dataRows = values.slice(1);
  const effectiveCount = detectEffectiveDataRowCount(dataRows, idx.label);
  const numRows = effectiveCount; // ограничиваемся фактическими строками
  const enColLetter = columnToLetter(idx.en + 1);
  let inserted = 0;

  for (const l of langsAll) {
    const col = l.colIndex + 1; // 1-based
    const rng = sheet.getRange(2, col, numRows, 1);
    const vals = rng.getValues();
    const formulasExisting = rng.getFormulas();
    const targetCode = l.code.split(/[_-]/)[0]; // ru_RU -> ru
    for (let i = 0; i < numRows; i++) {
      const existingFormula = formulasExisting[i][0];
      if (existingFormula) continue; // уже формула
      const v = safeStr(vals[i][0]);
      if (v) continue; // есть вручную заполненное значение
      const rowNum = i + 2; // фактический номер строки на листе
      const formula = `=IF($${enColLetter}${rowNum}="","",GOOGLETRANSLATE($${enColLetter}${rowNum},"en","${targetCode}"))`;
      sheet.getRange(rowNum, col).setFormula(formula);
      inserted++;
    }
  }

  SpreadsheetApp.getActive().toast(
    `Inserted ${inserted} GOOGLETRANSLATE formulas`,
    "Auto Translate",
    7
  );
}

function columnToLetter(col) {
  // 1-based -> A1 notation letter(s)
  let temp = "";
  let n = col;
  while (n > 0) {
    let rem = (n - 1) % 26;
    temp = String.fromCharCode(65 + rem) + temp;
    n = Math.floor((n - 1) / 26);
  }
  return temp;
}

/** ===================== FREEZE GOOGLETRANSLATE FORMULAS ===================== **/
function freezeGoogleTranslateFormulas() {
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2)
    throw new Error("Sheet is empty or has no data.");
  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);
  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0) {
    SpreadsheetApp.getActive().toast("No language columns", "Freeze", 5);
    return;
  }
  const dataRows = values.slice(1);
  const effectiveCount = detectEffectiveDataRowCount(dataRows, idx.label);
  const numRows = effectiveCount;
  let frozen = 0;
  for (const l of langsAll) {
    const col = l.colIndex + 1;
    const rng = sheet.getRange(2, col, numRows, 1);
    const formulas = rng.getFormulas();
    const vals = rng.getValues();
    for (let i = 0; i < numRows; i++) {
      const f = formulas[i][0];
      if (isGoogleTranslateFormula(f)) {
        const displayVal = vals[i][0];
        const cell = sheet.getRange(i + 2, col);
        cell.setValue(displayVal);
        frozen++;
      }
    }
  }
  SpreadsheetApp.getActive().toast(`Frozen ${frozen} formulas`, "Freeze", 6);
}

/** ===================== CLEAR GOOGLETRANSLATE FORMULAS ===================== **/
function clearGoogleTranslateFormulas() {
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2)
    throw new Error("Sheet is empty or has no data.");
  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);
  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0) {
    SpreadsheetApp.getActive().toast("No language columns", "Clear", 5);
    return;
  }
  const dataRows = values.slice(1);
  const effectiveCount = detectEffectiveDataRowCount(dataRows, idx.label);
  const numRows = effectiveCount;
  let cleared = 0;
  for (const l of langsAll) {
    const col = l.colIndex + 1;
    const rng = sheet.getRange(2, col, numRows, 1);
    const formulas = rng.getFormulas();
    for (let i = 0; i < numRows; i++) {
      const f = formulas[i][0];
      if (isGoogleTranslateFormula(f)) {
        const cell = sheet.getRange(i + 2, col);
        cell.clearContent(); // clear only that single cell
        cleared++;
      }
    }
  }
  SpreadsheetApp.getActive().toast(
    `Cleared ${cleared} GOOGLETRANSLATE formulas`,
    "Clear",
    6
  );
}

function clearLocalizationHighlight() {
  const config = getConfig();
  const highlightRGB = parseRGB(config.highlightRGB);
  if (!highlightRGB) {
    SpreadsheetApp.getActive().toast(
      "No valid highlight color set",
      "Highlight",
      5
    );
    return;
  }
  const targetHex = rgbToHex(highlightRGB);
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2) return;
  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);
  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (!langsAll.length) return;
  const dataRows = values.slice(1);
  const effectiveCount = detectEffectiveDataRowCount(dataRows, idx.label);
  const numRows = effectiveCount;
  let clearedAny = 0;
  for (const l of langsAll) {
    const col = l.colIndex + 1;
    const rng = sheet.getRange(2, col, numRows, 1);
    const bgs = rng.getBackgrounds();
    let changed = false;
    for (let r = 0; r < numRows; r++) {
      const cur = (bgs[r][0] || "").toLowerCase();
      if (cur === targetHex) {
        bgs[r][0] = null; // reset
        changed = true;
        clearedAny++;
      }
    }
    if (changed) rng.setBackgrounds(bgs);
  }
  SpreadsheetApp.getActive().toast(
    `Highlight cleared from ${clearedAny} cells`,
    "Highlight",
    5
  );
}

function scheduleHighlightClear(minutes) {
  // Remove previous scheduled clears to avoid piling up
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (
      t.getHandlerFunction &&
      t.getHandlerFunction() === "clearLocalizationHighlight"
    ) {
      try {
        ScriptApp.deleteTrigger(t);
      } catch (e) {}
    }
  }
  ScriptApp.newTrigger("clearLocalizationHighlight")
    .timeBased()
    .after(minutes * 60 * 1000)
    .create();
  SpreadsheetApp.getActive().toast(
    `Highlight will clear in ${minutes} min`,
    "Highlight",
    5
  );
}
