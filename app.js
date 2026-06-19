/* Querydeck — talk to your data.
 *
 * Everything runs client-side. The full CSV is parsed and held in memory in the
 * browser; only the inferred schema and a small row sample are ever sent to the
 * LLM. The API key lives in localStorage and goes straight to the provider.
 */

"use strict";

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const STORE_KEY = "querydeck.settings.v1";

const DEFAULT_MODELS = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
};

const MODEL_HINTS = {
  anthropic: "e.g. claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5",
  openai: "e.g. gpt-4o, gpt-4o-mini, gpt-4.1",
};

// How many rows to send to the model as a sample. Kept small on purpose —
// the model only needs to see the shape of the data, not all of it.
const SAMPLE_ROWS = 12;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  fileName: "",
  columns: [], // [{ name, type, samples }]
  rows: [], // array of objects, the full dataset (stays local)
};

let lastChart = null; // active Chart.js instance for cleanup

/* ------------------------------------------------------------------ *
 * Element refs
 * ------------------------------------------------------------------ */

const el = (id) => document.getElementById(id);

const dom = {
  dropZone: el("dropZone"),
  fileInput: el("fileInput"),
  sampleBtn: el("sampleBtn"),
  parseError: el("parseError"),
  workspace: el("workspace"),
  fileName: el("fileName"),
  changeFileBtn: el("changeFileBtn"),
  schemaList: el("schemaList"),
  tableWrap: el("tableWrap"),
  rowMeta: el("rowMeta"),
  messages: el("messages"),
  askForm: el("askForm"),
  question: el("question"),
  askBtn: el("askBtn"),
  suggestions: el("suggestions"),
  // settings
  settingsBtn: el("settingsBtn"),
  settingsDialog: el("settingsDialog"),
  provider: el("provider"),
  apiKey: el("apiKey"),
  model: el("model"),
  modelHint: el("modelHint"),
  saveSettings: el("saveSettings"),
  settingsError: el("settingsError"),
};

/* ------------------------------------------------------------------ *
 * Settings (localStorage, BYO-key)
 * ------------------------------------------------------------------ */

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { provider: "anthropic", apiKey: "", model: DEFAULT_MODELS.anthropic };
    const parsed = JSON.parse(raw);
    return {
      provider: parsed.provider === "openai" ? "openai" : "anthropic",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : DEFAULT_MODELS[parsed.provider] || DEFAULT_MODELS.anthropic,
    };
  } catch {
    return { provider: "anthropic", apiKey: "", model: DEFAULT_MODELS.anthropic };
  }
}

function saveSettings(s) {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

function openSettings() {
  const s = loadSettings();
  dom.provider.value = s.provider;
  dom.apiKey.value = s.apiKey;
  dom.model.value = s.model;
  syncModelHint();
  dom.settingsError.hidden = true;
  dom.settingsDialog.showModal();
}

function syncModelHint() {
  const p = dom.provider.value;
  dom.modelHint.textContent = MODEL_HINTS[p] || "";
}

dom.provider.addEventListener("change", () => {
  // When provider switches, suggest its default model if the field is empty
  // or still holds the other provider's default.
  const otherDefaults = Object.values(DEFAULT_MODELS);
  if (!dom.model.value || otherDefaults.includes(dom.model.value)) {
    dom.model.value = DEFAULT_MODELS[dom.provider.value];
  }
  syncModelHint();
});

dom.settingsBtn.addEventListener("click", openSettings);

dom.settingsDialog.addEventListener("close", () => {
  if (dom.settingsDialog.returnValue !== "save") return;
  const provider = dom.provider.value;
  const apiKey = dom.apiKey.value.trim();
  const model = dom.model.value.trim() || DEFAULT_MODELS[provider];
  saveSettings({ provider, apiKey, model });
});

// Validate on save without closing if the key is missing.
dom.saveSettings.addEventListener("click", (e) => {
  if (!dom.apiKey.value.trim()) {
    e.preventDefault();
    dom.settingsError.textContent = "Enter an API key, or click Cancel.";
    dom.settingsError.hidden = false;
  }
});

/* ------------------------------------------------------------------ *
 * CSV parsing + type inference
 * ------------------------------------------------------------------ */

function inferType(values) {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (nonEmpty.length === 0) return "empty";

  let numeric = 0;
  let booleanish = 0;
  let dateish = 0;

  for (const v of nonEmpty) {
    const s = String(v).trim();
    if (isNumeric(s)) numeric++;
    if (/^(true|false|yes|no|y|n|0|1)$/i.test(s)) booleanish++;
    if (isDateish(s)) dateish++;
  }

  const n = nonEmpty.length;
  if (numeric / n >= 0.9) return "number";
  // Only call it boolean when the distinct set is genuinely binary.
  if (booleanish / n >= 0.9 && new Set(nonEmpty.map((v) => String(v).toLowerCase())).size <= 3) return "boolean";
  if (dateish / n >= 0.8) return "date";
  return "string";
}

function isNumeric(s) {
  if (s === "") return false;
  // Allow thousands separators and currency-ish prefixes.
  const cleaned = s.replace(/[$,€£\s%]/g, "");
  return cleaned !== "" && !isNaN(Number(cleaned)) && isFinite(Number(cleaned));
}

function isDateish(s) {
  if (/^\d{4}-\d{1,2}-\d{1,2}([ T].*)?$/.test(s)) return true; // ISO
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return true; // US
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(s)) return true; // 01-Jan-2024
  return false;
}

function buildSchema(fields, rows) {
  return fields.map((name) => {
    const values = rows.map((r) => r[name]);
    const samples = [];
    for (const v of values) {
      const s = v === null || v === undefined ? "" : String(v).trim();
      if (s !== "" && !samples.includes(s)) samples.push(s);
      if (samples.length >= 3) break;
    }
    return { name, type: inferType(values), samples };
  });
}

function handleParsed(fileName, result) {
  if (!result || !result.data || !result.data.length) {
    return showParseError("That file had no rows we could read.");
  }
  const fields = result.meta && result.meta.fields ? result.meta.fields.filter((f) => f !== "") : Object.keys(result.data[0]);
  if (!fields.length) return showParseError("Could not detect any columns. Is this a CSV with a header row?");

  state.fileName = fileName;
  state.rows = result.data;
  state.columns = buildSchema(fields, result.data);

  renderWorkspace();
}

function parseFile(file) {
  hideParseError();
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    return showParseError("That file is over 50 MB. Try a smaller export.");
  }
  Papa.parse(file, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false, // keep strings; we infer types ourselves
    complete: (result) => handleParsed(file.name, result),
    error: (err) => showParseError("Could not parse file: " + err.message),
  });
}

function showParseError(msg) {
  dom.parseError.textContent = msg;
  dom.parseError.hidden = false;
}
function hideParseError() {
  dom.parseError.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Rendering: preview, schema, table
 * ------------------------------------------------------------------ */

function renderWorkspace() {
  dom.dropZone.hidden = true;
  dom.workspace.hidden = false;
  dom.fileName.textContent = "· " + state.fileName;
  dom.rowMeta.textContent = `${state.rows.length.toLocaleString()} rows · ${state.columns.length} cols`;

  renderSchema();
  renderTable();
  renderSuggestions();
  resetChat();
  dom.question.focus();
}

function renderSchema() {
  dom.schemaList.innerHTML = "";
  for (const col of state.columns) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("span");
    name.textContent = col.name;
    const type = document.createElement("span");
    type.className = "ctype";
    type.textContent = col.type;
    chip.append(name, type);
    chip.title = col.samples.length ? "e.g. " + col.samples.join(", ") : col.type;
    dom.schemaList.appendChild(chip);
  }
}

function renderTable() {
  const cols = state.columns;
  const rows = state.rows.slice(0, 50);
  const numericByName = new Set(cols.filter((c) => c.type === "number").map((c) => c.name));

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c.name;
    if (numericByName.has(c.name)) th.className = "num";
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const td = document.createElement("td");
      const val = r[c.name];
      td.textContent = val === null || val === undefined ? "" : String(val);
      if (numericByName.has(c.name)) td.className = "num";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  dom.tableWrap.innerHTML = "";
  dom.tableWrap.appendChild(table);
}

function renderSuggestions() {
  const cols = state.columns;
  const numCols = cols.filter((c) => c.type === "number");
  const catCols = cols.filter((c) => c.type === "string");
  const dateCols = cols.filter((c) => c.type === "date");

  const ideas = [];
  if (numCols.length && catCols.length) {
    ideas.push(`Total ${numCols[0].name} by ${catCols[0].name}`);
  }
  if (catCols.length) {
    ideas.push(`How many rows per ${catCols[0].name}?`);
  }
  if (numCols.length) {
    ideas.push(`Summarize the ${numCols[0].name} column`);
  }
  if (dateCols.length && numCols.length) {
    ideas.push(`${numCols[0].name} over time`);
  }
  ideas.push("What stands out in this data?");

  dom.suggestions.innerHTML = "";
  for (const idea of ideas.slice(0, 4)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "suggestion";
    b.textContent = idea;
    b.addEventListener("click", () => {
      dom.question.value = idea;
      dom.question.focus();
    });
    dom.suggestions.appendChild(b);
  }
}

/* ------------------------------------------------------------------ *
 * Chat rendering
 * ------------------------------------------------------------------ */

function resetChat() {
  dom.messages.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-chat";
  empty.textContent = "Ask a question about your data. The model sees the column types and a small sample — your full dataset stays in this browser.";
  dom.messages.appendChild(empty);
}

function clearEmptyState() {
  const empty = dom.messages.querySelector(".empty-chat");
  if (empty) empty.remove();
}

function addQuestion(text) {
  clearEmptyState();
  const div = document.createElement("div");
  div.className = "msg msg-q";
  div.textContent = text;
  dom.messages.appendChild(div);
  scrollMessages();
}

function addThinking() {
  const div = document.createElement("div");
  div.className = "thinking";
  div.innerHTML = '<span class="dot-pulse"></span><span>Thinking…</span>';
  dom.messages.appendChild(div);
  scrollMessages();
  return div;
}

function addAnswer(answerText, chartSpec) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-a";

  const text = document.createElement("div");
  text.className = "answer-text";
  text.innerHTML = formatAnswer(answerText);
  wrap.appendChild(text);

  if (chartSpec) {
    const box = renderChart(chartSpec);
    if (box) wrap.appendChild(box);
  }

  dom.messages.appendChild(wrap);
  scrollMessages();
}

function addError(msg) {
  const div = document.createElement("div");
  div.className = "msg msg-a";
  const text = document.createElement("div");
  text.className = "answer-text";
  text.style.color = "var(--error)";
  text.textContent = msg;
  div.appendChild(text);
  dom.messages.appendChild(div);
  scrollMessages();
}

// Minimal, safe formatting: bold (**x**) and bullet lines. Everything is
// escaped first so model output can never inject markup.
function formatAnswer(raw) {
  const escaped = String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[-*]\s+(.*)$/gm, "• $1");
}

function scrollMessages() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Chart rendering (Chart.js)
 * ------------------------------------------------------------------ */

const ALLOWED_CHART_TYPES = ["bar", "line", "pie", "doughnut", "scatter"];

function renderChart(spec) {
  if (!spec || typeof spec !== "object") return null;
  const type = ALLOWED_CHART_TYPES.includes(spec.type) ? spec.type : "bar";
  const labels = Array.isArray(spec.labels) ? spec.labels.map(String) : [];
  const datasets = Array.isArray(spec.datasets) ? spec.datasets : [];
  if (!datasets.length || (!labels.length && type !== "scatter")) return null;

  const box = document.createElement("div");
  box.className = "chart-box";
  if (spec.title) {
    const t = document.createElement("p");
    t.className = "chart-title";
    t.textContent = String(spec.title);
    box.appendChild(t);
  }
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);

  const palette = chartPalette(Math.max(labels.length, datasets.length, 6));
  const isCategorical = type === "pie" || type === "doughnut";

  const ds = datasets.map((d, i) => ({
    label: d.label || "Value",
    data: Array.isArray(d.data) ? d.data : [],
    backgroundColor: isCategorical ? palette : withAlpha(palette[i % palette.length], 0.7),
    borderColor: isCategorical ? palette : palette[i % palette.length],
    borderWidth: type === "line" ? 2 : 1,
    fill: false,
    tension: 0.25,
  }));

  // Defer construction so the canvas is laid out in the DOM first.
  requestAnimationFrame(() => {
    if (lastChart) {
      // keep prior charts; only track the latest for safety. (multiple ok)
    }
    try {
      lastChart = new Chart(canvas.getContext("2d"), {
        type,
        data: { labels, datasets: ds },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: datasets.length > 1 || isCategorical, labels: { color: cssVar("--text") } },
          },
          scales: isCategorical
            ? {}
            : {
                x: { ticks: { color: cssVar("--muted") }, grid: { color: cssVar("--border") } },
                y: { ticks: { color: cssVar("--muted") }, grid: { color: cssVar("--border") }, beginAtZero: true },
              },
        },
      });
    } catch (err) {
      box.innerHTML = '<p class="muted">Could not render chart.</p>';
    }
  });

  return box;
}

function chartPalette(n) {
  const base = ["#3b6ea5", "#c1666b", "#6a994e", "#d4a017", "#7d5ba6", "#48a9a6", "#bc6c25", "#5c677d"];
  const out = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out;
}
function withAlpha(hex, a) {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

/* ------------------------------------------------------------------ *
 * Building the model request
 * ------------------------------------------------------------------ */

function buildSchemaText() {
  return state.columns
    .map((c) => {
      const ex = c.samples.length ? ` (e.g. ${c.samples.join(", ")})` : "";
      return `- ${c.name}: ${c.type}${ex}`;
    })
    .join("\n");
}

function buildSampleText() {
  const sample = state.rows.slice(0, SAMPLE_ROWS);
  const names = state.columns.map((c) => c.name);
  const lines = [names.join("\t")];
  for (const row of sample) {
    lines.push(names.map((n) => (row[n] === null || row[n] === undefined ? "" : String(row[n]))).join("\t"));
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are Querydeck, a data analyst assistant. The user has loaded a CSV into their browser. You are given the column schema and a SMALL SAMPLE of rows (not the full dataset) — so do not claim exact totals you cannot compute from the sample. Reason about the data, describe the method, and answer the user's question in clear, plain English.

When a chart would genuinely help communicate the answer, include a chart spec. Only include a chart when it adds value, and only use values you can support from the sample (or clearly labelled illustrative estimates).

Respond ONLY with a single JSON object, no markdown fences, of this exact shape:
{
  "answer": "string — your plain-English analysis. Use \\n for line breaks. You may use **bold** and lines starting with - for bullets.",
  "chart": null OR {
    "type": "bar" | "line" | "pie" | "doughnut" | "scatter",
    "title": "short chart title",
    "labels": ["..."],
    "datasets": [ { "label": "Series name", "data": [numbers...] } ]
  }
}

Rules:
- "answer" is required. "chart" is optional — use null when no chart helps.
- labels and dataset data arrays must be the same length.
- Keep the answer focused and concise. Mention if the sample is too small to be confident.`;

function buildUserPrompt(question) {
  return `COLUMNS (${state.rows.length} total rows in the file):\n${buildSchemaText()}\n\nSAMPLE ROWS (first ${Math.min(SAMPLE_ROWS, state.rows.length)} of ${state.rows.length}, tab-separated):\n${buildSampleText()}\n\nQUESTION: ${question}`;
}

/* ------------------------------------------------------------------ *
 * Provider calls (direct from browser, BYO key)
 * ------------------------------------------------------------------ */

async function callAnthropic(settings, system, userPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      // Required to call the Anthropic API directly from a browser.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) throw await providerError(res, "Anthropic");
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "text");
  return block ? block.text : "";
}

async function callOpenAI(settings, system, userPrompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) throw await providerError(res, "OpenAI");
  const data = await res.json();
  return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
}

async function providerError(res, name) {
  let detail = "";
  try {
    const body = await res.json();
    detail = (body.error && (body.error.message || body.error)) || JSON.stringify(body);
  } catch {
    detail = await res.text().catch(() => "");
  }
  if (res.status === 401) return new Error(`${name}: invalid API key (401). Check it in Settings.`);
  if (res.status === 429) return new Error(`${name}: rate limited or out of quota (429). Try again shortly.`);
  if (res.status === 404) return new Error(`${name}: model not found (404). Check the model id in Settings. ${detail}`);
  return new Error(`${name} error ${res.status}: ${detail || "request failed"}`);
}

/* ------------------------------------------------------------------ *
 * Parse the model's JSON answer (tolerant of stray fences/prose)
 * ------------------------------------------------------------------ */

function parseModelResponse(raw) {
  if (!raw || !raw.trim()) throw new Error("The model returned an empty response.");
  let text = raw.trim();

  // Strip ```json fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Find the outermost JSON object if there's surrounding prose.
  if (text[0] !== "{") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }

  try {
    const obj = JSON.parse(text);
    return {
      answer: typeof obj.answer === "string" ? obj.answer : raw,
      chart: obj.chart && typeof obj.chart === "object" ? obj.chart : null,
    };
  } catch {
    // Not JSON — fall back to showing the raw text as the answer.
    return { answer: raw, chart: null };
  }
}

/* ------------------------------------------------------------------ *
 * Ask flow
 * ------------------------------------------------------------------ */

async function ask(question) {
  const settings = loadSettings();
  if (!settings.apiKey) {
    openSettings();
    return;
  }
  if (!state.rows.length) return;

  addQuestion(question);
  dom.question.value = "";
  dom.askBtn.disabled = true;
  const thinking = addThinking();

  try {
    const system = SYSTEM_PROMPT;
    const userPrompt = buildUserPrompt(question);
    const raw =
      settings.provider === "openai"
        ? await callOpenAI(settings, system, userPrompt)
        : await callAnthropic(settings, system, userPrompt);

    thinking.remove();
    const { answer, chart } = parseModelResponse(raw);
    addAnswer(answer, chart);
  } catch (err) {
    thinking.remove();
    addError(err.message || "Something went wrong.");
  } finally {
    dom.askBtn.disabled = false;
    dom.question.focus();
  }
}

/* ------------------------------------------------------------------ *
 * Sample dataset
 * ------------------------------------------------------------------ */

const SAMPLE_CSV = `order_id,date,region,product,category,units,revenue,returned
1001,2024-01-05,West,Wireless Mouse,Accessories,3,74.97,no
1002,2024-01-08,East,Mechanical Keyboard,Accessories,1,119.00,no
1003,2024-01-11,North,27" Monitor,Displays,2,498.00,no
1004,2024-01-15,South,USB-C Hub,Accessories,5,199.95,yes
1005,2024-01-19,West,Laptop Stand,Accessories,4,159.96,no
1006,2024-02-02,East,27" Monitor,Displays,1,249.00,no
1007,2024-02-07,North,Webcam 1080p,Peripherals,3,134.97,no
1008,2024-02-12,South,Mechanical Keyboard,Accessories,2,238.00,no
1009,2024-02-18,West,Noise-Cancel Headset,Audio,2,259.98,yes
1010,2024-02-25,East,USB-C Hub,Accessories,6,239.94,no
1011,2024-03-03,North,Laptop Stand,Accessories,3,119.97,no
1012,2024-03-09,South,34" Ultrawide,Displays,1,549.00,no
1013,2024-03-14,West,Webcam 1080p,Peripherals,4,179.96,no
1014,2024-03-20,East,Noise-Cancel Headset,Audio,1,129.99,no
1015,2024-03-28,North,Wireless Mouse,Accessories,7,174.93,no
1016,2024-04-04,South,34" Ultrawide,Displays,2,1098.00,no
1017,2024-04-10,West,Mechanical Keyboard,Accessories,3,357.00,yes
1018,2024-04-16,East,Laptop Stand,Accessories,5,199.95,no
1019,2024-04-22,North,27" Monitor,Displays,3,747.00,no
1020,2024-04-29,South,USB-C Hub,Accessories,4,159.96,no
1021,2024-05-06,West,Noise-Cancel Headset,Audio,2,259.98,no
1022,2024-05-13,East,Webcam 1080p,Peripherals,6,269.94,no
1023,2024-05-21,North,Wireless Mouse,Accessories,9,224.91,no
1024,2024-05-28,South,Mechanical Keyboard,Accessories,1,119.00,no
1025,2024-06-04,West,34" Ultrawide,Displays,1,549.00,no
1026,2024-06-11,East,Laptop Stand,Accessories,2,79.98,yes
1027,2024-06-18,North,USB-C Hub,Accessories,3,119.97,no
1028,2024-06-25,South,27" Monitor,Displays,2,498.00,no
1029,2024-07-02,West,Webcam 1080p,Peripherals,5,224.95,no
1030,2024-07-09,East,Wireless Mouse,Accessories,4,99.96,no`;

function loadSample() {
  hideParseError();
  Papa.parse(SAMPLE_CSV, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
    complete: (result) => handleParsed("sample_sales.csv", result),
  });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

dom.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  parseFile(file);
  e.target.value = ""; // allow re-selecting the same file
});

dom.sampleBtn.addEventListener("click", loadSample);

dom.changeFileBtn.addEventListener("click", () => {
  dom.workspace.hidden = true;
  dom.dropZone.hidden = false;
  hideParseError();
});

// Drag & drop
["dragenter", "dragover"].forEach((ev) =>
  dom.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dom.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dom.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove("dragover");
  })
);
dom.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) parseFile(file);
});

dom.askForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = dom.question.value.trim();
  if (q) ask(q);
});

// Enter to submit, Shift+Enter for newline.
dom.question.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    dom.askForm.requestSubmit();
  }
});

// First run: nudge the user to add a key if none is set.
(function init() {
  const s = loadSettings();
  if (!s.apiKey) {
    // Don't pop the dialog immediately — let them see the app first.
    dom.settingsBtn.classList.add("btn-primary");
    dom.settingsBtn.classList.remove("btn-ghost");
  }
})();
