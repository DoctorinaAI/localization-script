/** ===================== CONFIG (Script Properties override these) ===================== **
 *   API_URL    : https://your.endpoint/translate
 *   API_KEY    : <optional bearer or custom token>
 *   OVERWRITE  : "true" | "false"  (legacy; now only empty cells are filled)
 *   TIMEOUT_MS : integer ms (default: 60000)
 *   BATCH_SIZE : integer (max rows per API request, default: 3)
 *
 *   Формат запроса: { batch: [ { label, description, meta, en, languages:["es","de"] }, ... ] }
 *   Формат ответа (один объект на язык):
 *     {
 *       "data": [
 *         {
 *           "label": "myButton",
 *           "localization": {
 *             "ru": { "text": "Моя Кнопка" },
 *             "es": { "text": "Mi Botón" }
 *           }
 *         }
 *       ]
 *     }
 *   Также допустим упрощённый ответ: localization[code] = "строка".
 *   Скрипт выбирает localization[code].text если объект, иначе значение как строку.
 */

const DEFAULTS = {
  API_URL: '',
  API_KEY: '',
  OVERWRITE: 'false',
  TIMEOUT_MS: '360000',
  BATCH_SIZE: '3'
};

/** ===================== MENU ===================== **/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Localization')
    .addItem('Run', 'runLocalization')
    .addToUi();
}

/** ===================== ENTRYPOINT ===================== **/
function runLocalization() {
  const { sheet, values } = readActiveSheet();
  if (!values || values.length < 2) throw new Error('Лист пустой или нет данных.');

  const config = getConfig();
  if (!config.API_URL) throw new Error('Не задан API_URL в Script Properties.');

  const header = values[0].map(h => String(h || '').trim());
  const idx = indexHeader(header);

  const langsAll = detectLanguageColumns(header, idx.afterEnCol);
  if (langsAll.length === 0) throw new Error('Не найдено ни одной языковой колонки после "en".');

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
      throw new Error(`Найден дублирующийся label: "${label}" (строка ${uiRow}).`);
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
      languages: targets.codes
    });

    byLabel.set(label, { uiRow, requestedCodes: new Set(targets.codes), targets: targets.targets });
  }

  if (batch.length === 0) {
    SpreadsheetApp.getActive().toast('Нет ячеек для локализации. Готово.', 'OK', 5);
    return;
  }

  // Разбиваем на батчи по config.batchSize
  const allData = [];
  for (let i = 0; i < batch.length; i += config.batchSize) {
    const slice = batch.slice(i, i + config.batchSize);
    const resp = callApiBatch(config, { batch: slice });
    const dataPart = validateBatchResponse(resp, byLabel, { slice });
    allData.push(...dataPart);
  }
  const data = allData;

  // Готовим буферы для пакетной записи по колонкам
  const numRows = rows.length;
  const buffers = Object.fromEntries(langsAll.map(l => [l.code, new Array(numRows).fill(null)]));

  for (const item of data) {
    const info = byLabel.get(item.label);
    if (!info) continue;
    const loc = item.localization || {};
    for (const code of info.requestedCodes) {
      const val = loc[code];
      let text = '';
      if (val && typeof val === 'object' && typeof val.text !== 'undefined') {
        text = safeStr(val.text);
      } else {
        text = safeStr(val);
      }
      buffers[code][info.uiRow - 1 - uiOffset] = text;
    }
  }

  // Записываем разом только изменяемые клетки
  writeBackBuffers(sheet, langsAll, buffers, numRows);

  SpreadsheetApp.getActive().toast(`Localization: updated ${batch.length} row(s)`, 'OK', 5);
}

/** ===================== HEADER & LANG DETECTION ===================== **/
function indexHeader(header) {
  const req = ['label', 'description', 'meta', 'en'];
  const map = {};
  for (const k of req) {
    const pos = header.findIndex(h => h.toLowerCase() === k);
    if (pos < 0) throw new Error(`В заголовке отсутствует обязательная колонка: "${k}".`);
    map[k] = pos;
  }
  map.afterEnCol = map.en + 1;
  return map;
}

function detectLanguageColumns(header, startFrom) {
  const langRe = /^[a-z]{2,3}([_-][A-Z]{2})?$/;
  const result = [];
  for (let c = startFrom; c < header.length; c++) {
    const raw = (header[c] || '').trim();
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
  if (v === null || v === undefined) return '';
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
    if (cur === '') {
      codes.push(l.code);
      targets.push({ code: l.code, colIndex: l.colIndex });
    }
  }
  return { codes, targets };
}

/** ===================== API CALL & VALIDATION ===================== **/
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const API_URL = props.getProperty('API_URL') || DEFAULTS.API_URL;
  const API_KEY = props.getProperty('API_KEY') || DEFAULTS.API_KEY;
  const OVERWRITE = (props.getProperty('OVERWRITE') || DEFAULTS.OVERWRITE).toLowerCase() === 'true';
  const TIMEOUT_MS = parseInt(props.getProperty('TIMEOUT_MS') || DEFAULTS.TIMEOUT_MS, 10);
  const BATCH_SIZE = parseInt(props.getProperty('BATCH_SIZE') || DEFAULTS.BATCH_SIZE, 10);

  // OVERWRITE оставляем для совместимости, но теперь оно не влияет на выбор целей:
  // мы ВСЕГДА запрашиваем только пустые ячейки.
  const batchSize = isFinite(BATCH_SIZE) && BATCH_SIZE > 0 ? BATCH_SIZE : 3;
  return { API_URL, API_KEY, overwrite: OVERWRITE, timeout: isFinite(TIMEOUT_MS) ? TIMEOUT_MS : 60000, batchSize };
}

function callApiBatch(config, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.API_KEY) {
    headers.Authorization = config.API_KEY.startsWith('Bearer ') ? config.API_KEY : `Bearer ${config.API_KEY}`;
  }

  const resp = UrlFetchApp.fetch(config.API_URL, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers,
    payload: JSON.stringify(payload),
    followRedirects: true,
    validateHttpsCertificates: true,
    escaping: false,
    timeout: config.timeout
  });

  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`API HTTP ${code}: ${resp.getContentText().slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(resp.getContentText());
  } catch (_e) {
    throw new Error('API вернул не-JSON ответ.');
  }
  return data;
}

function validateBatchResponse(resp, byLabel, ctx) {
  if (!resp || typeof resp !== 'object' || !Array.isArray(resp.data)) {
    throw new Error(`В ответе отсутствует массив "data".`);
  }

  const normalized = [];
  const serverByLabel = new Map();
  for (const item of resp.data) {
    if (!item || typeof item !== 'object') continue;
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
    if (!got.localization || typeof got.localization !== 'object') {
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
      if (rawVal && typeof rawVal === 'object' && typeof rawVal.text !== 'undefined') {
        outLoc[code] = safeStr(rawVal.text);
      } else {
        outLoc[code] = safeStr(rawVal);
      }
      if (!outLoc[code]) missing.push(code);
    }
    if (missing.length) {
      setRowNote(meta.uiRow, 1, `Отсутствуют языки: ${missing.join(', ')}`);
      throw new Error(`label "${label}": API не вернул переводы для: ${missing.join(', ')}`);
    }
    normalized.push({ label, localization: outLoc, uiRow: meta.uiRow });
  }

  return normalized;
}

/** ===================== WRITE BACK ===================== **/
function writeBackBuffers(sheet, langsAll, buffers, numRows) {
  for (const l of langsAll) {
    const col = l.colIndex + 1;
    const rng = sheet.getRange(2, col, numRows, 1);
    const existing = rng.getValues(); // [[v],[v],...]
    const buf = buffers[l.code];

    let hasAny = false;
    const out = new Array(numRows);
    for (let i = 0; i < numRows; i++) {
      const cur = existing[i][0];
      const next = buf[i];
      if (next != null && String(cur).trim() === '') {
        out[i] = [next];
        hasAny = true;
      } else {
        out[i] = [cur];
      }
    }
  if (hasAny) rng.setValues(out);
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
