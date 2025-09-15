const DEFAULTS = {
  API_URL: "",
  API_KEY: "",
  OVERWRITE: "false",
  TIMEOUT_MS: "360000",
  BATCH_SIZE: "3",
  RETRY_MAX: "2",
  RETRY_DELAY_MS: "1000",
  HIGHLIGHT_COLOR: "220,255,220",
  DRY_RUN: "false",
};

/** ===================== MENU ===================== **/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Localization")
    .addItem("Run", "runLocalization")
    .addSeparator()
    .addItem("Fill GOOGLETRANSLATE formulas", "fillGoogleTranslateFormulas")
    .addItem("Freeze GOOGLETRANSLATE formulas", "freezeGoogleTranslateFormulas")
    .addItem("Clear GOOGLETRANSLATE formulas", "clearGoogleTranslateFormulas")
    .addToUi();
}

/** ===================== ENTRYPOINT ===================== **/
function runLocalization() {
  const started = new Date();
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2)
    throw new Error("Лист пустой или нет данных.");

  const config = getConfig();
  if (!config.API_URL && !config.dryRun)
    throw new Error("Не задан API_URL в Script Properties.");

  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);

  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0)
    throw new Error('Не найдено ни одной языковой колонки после "en".');

  const rows = values.slice(1); // без заголовка
  const uiOffset = 1; // сдвиг для 1-based

  // Собираем батч ЗАПРОСОВ и карту соответствий для записи
  const batch = [];
  const byLabel = new Map(); // label -> { uiRow, requestedCodes:Set, targets:[{code, colIndex}] }
  const seenLabels = new Set();

  for (let r = 0; r < rows.length; r++) {
    const uiRow = r + 1 + uiOffset;
    const row = rows[r];

    const label = safeStr(row[idx.label]);
    const description = safeStr(row[idx.description]);
    const en = safeStr(row[idx.en]);
    const meta = parseMetaAllowEmpty(row[idx.meta], uiRow);

    if (!label || !en) continue;

    if (seenLabels.has(label)) {
      setRowNote(uiRow, 1, `Дублирующийся label: "${label}". Уникализируй.`);
      throw new Error(
        `Найден дублирующийся label: "${label}" (строка ${uiRow}).`
      );
    }
    seenLabels.add(label);

    // Теперь даже при OVERWRITE=true запрашиваем ТОЛЬКО пустые ячейки, чтобы не палить квоты
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
    setStatus(config, "Нет пустых ячеек");
    SpreadsheetApp.getActive().toast(
      "Нет ячеек для локализации. Готово.",
      "OK",
      5
    );
    return;
  }

  // Разбиваем на батчи по config.batchSize
  const allData = [];
  const batchesTotal = Math.ceil(batch.length / config.batchSize);
  for (let i = 0; i < batch.length; i += config.batchSize) {
    const slice = batch.slice(i, i + config.batchSize);
    const batchNum = Math.floor(i / config.batchSize) + 1;
    setStatus(config, `Батч ${batchNum}/${batchesTotal}`);
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
    const dataPart = validateBatchResponse(resp, byLabel, { slice });
    allData.push(...dataPart);
    SpreadsheetApp.getActive().toast(
      `Batch ${batchNum}/${batchesTotal} OK`,
      "Progress",
      3
    );
  }
  const data = allData;

  // Готовим буферы для пакетной записи по колонкам
  const numRows = rows.length;
  const buffers = Object.fromEntries(
    langsAll.map((l) => [l.code, new Array(numRows).fill(null)])
  );

  for (const item of data) {
    const info = byLabel.get(item.label);
    if (!info) continue;
    const loc = item.localization || {};
    for (const code of info.requestedCodes) {
      const val = loc[code];
      let text = "";
      if (val && typeof val === "object" && typeof val.text !== "undefined") {
        text = safeStr(val.text);
      } else {
        text = safeStr(val);
      }
      buffers[code][info.uiRow - 1 - uiOffset] = text;
    }
  }

  let written = 0;
  if (!config.dryRun) {
    written = writeBackBuffers(sheet, langsAll, buffers, numRows, config);
  }
  const finished = new Date();
  const msg = `Localization: rows=${batch.length}; cells=${written}; batches=${Math.ceil(batch.length / config.batchSize)}; time=${finished - started}ms${config.dryRun ? " (DRY RUN)" : ""}`;
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
    if (pos < 0)
      throw new Error(`В заголовке отсутствует обязательная колонка: "${k}".`);
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
    throw new Error(`Строка ${uiRow}: meta некорректный JSON.`);
  }
}

// Берем только пустые target-ячейки, чтобы не дёргать API лишний раз,
// в том числе при OVERWRITE=true.
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
    throw new Error("API вернул не-JSON ответ.");
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
    throw new Error(`В ответе отсутствует массив "data".`);
  }

  const normalized = [];
  const serverByLabel = new Map();
  for (const item of resp.data) {
    if (!item || typeof item !== "object") continue;
    const label = safeStr(item.label);
    if (!label) continue;
    if (serverByLabel.has(label)) {
      throw new Error(`Ответ содержит дубликат label "${label}".`);
    }
    serverByLabel.set(label, item);
  }

  for (const [label, meta] of byLabel.entries()) {
    const got = serverByLabel.get(label);
    if (!got) continue; // может быть в другом батче
    if (!got.localization || typeof got.localization !== "object") {
      throw new Error(`label "${label}": отсутствует объект "localization".`);
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
      setRowNote(meta.uiRow, 1, `Отсутствуют языки: ${missing.join(", ")}`);
      throw new Error(
        `label "${label}": API не вернул переводы для: ${missing.join(", ")}`
      );
    }
    normalized.push({ label, localization: outLoc, uiRow: meta.uiRow });
  }

  return normalized;
}

/** ===================== WRITE BACK ===================== **/
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
    throw new Error("Лист пустой или нет данных.");

  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);
  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0) {
    SpreadsheetApp.getActive().toast(
      "Нет языковых колонок после EN",
      "Auto Translate",
      5
    );
    return;
  }

  const numRows = values.length - 1; // без заголовка
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
    throw new Error("Лист пустой или нет данных.");
  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);
  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0) {
    SpreadsheetApp.getActive().toast("Нет языковых колонок", "Freeze", 5);
    return;
  }
  const numRows = values.length - 1;
  let frozen = 0;
  for (const l of langsAll) {
    const col = l.colIndex + 1;
    const rng = sheet.getRange(2, col, numRows, 1);
    const formulas = rng.getFormulas();
    const vals = rng.getValues();
    const outValues = new Array(numRows);
    const outFormulas = new Array(numRows);
    for (let i = 0; i < numRows; i++) {
      const f = formulas[i][0];
      if (f && /GOOGLETRANSLATE/i.test(f)) {
        outValues[i] = [vals[i][0]]; // freeze value
        outFormulas[i] = [""]; // remove formula
        frozen++;
      } else if (f) {
        // preserve other formulas untouched
        outValues[i] = [""];
        outFormulas[i] = [f];
      } else {
        outValues[i] = [vals[i][0]];
        outFormulas[i] = [""];
      }
    }
    rng.setValues(outValues);
    rng.setFormulas(outFormulas); // reapply non-translate formulas
  }
  SpreadsheetApp.getActive().toast(`Frozen ${frozen} formulas`, "Freeze", 6);
}

/** ===================== CLEAR GOOGLETRANSLATE FORMULAS ===================== **/
function clearGoogleTranslateFormulas() {
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2)
    throw new Error("Лист пустой или нет данных.");
  const header = values[0].map((h) => String(h || "").trim());
  const idx = indexHeader(header);
  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0) {
    SpreadsheetApp.getActive().toast("Нет языковых колонок", "Clear", 5);
    return;
  }
  const numRows = values.length - 1;
  let cleared = 0;
  for (const l of langsAll) {
    const col = l.colIndex + 1;
    const rng = sheet.getRange(2, col, numRows, 1);
    const formulas = rng.getFormulas();
    const vals = rng.getValues();
    const outValues = new Array(numRows);
    const outFormulas = new Array(numRows);
    for (let i = 0; i < numRows; i++) {
      const f = formulas[i][0];
      if (f && /GOOGLETRANSLATE/i.test(f)) {
        outValues[i] = [""]; // clear only translate formulas
        outFormulas[i] = [""];
        cleared++;
      } else if (f) {
        // keep other formulas
        outValues[i] = [""];
        outFormulas[i] = [f];
      } else {
        outValues[i] = [vals[i][0]];
        outFormulas[i] = [""];
      }
    }
    rng.setValues(outValues);
    rng.setFormulas(outFormulas);
  }
  SpreadsheetApp.getActive().toast(
    `Cleared ${cleared} GOOGLETRANSLATE formulas`,
    "Clear",
    6
  );
}
