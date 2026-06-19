# Querydeck

Talk to your data. Upload a CSV, get a typed preview, and ask questions about it in plain English — the model answers and, when it helps, draws a chart.

Querydeck is a single static page. There is no backend and no build step. Your CSV is parsed and analyzed entirely in the browser, and you bring your own LLM API key.

**Live demo:** https://vansh4195.github.io/querydeck/

## What it does

- **Parse in the browser.** Drop in a CSV (or load the bundled sample) and it's parsed client-side with [PapaParse](https://www.papaparse.com/).
- **Inferred schema.** Each column is typed — number, string, date, boolean — with a couple of example values shown as chips.
- **Table preview.** The first 50 rows render in a scrollable table with numeric columns right-aligned.
- **Ask in plain English.** Type a question; the LLM returns an analysis and, when a chart communicates the answer better, a chart spec that renders with [Chart.js](https://www.chartjs.org/) (bar, line, pie, doughnut, scatter).
- **Suggested questions.** Querydeck proposes a few starter questions based on the columns it found.

## Privacy model

The full dataset never leaves your machine. Only two things are sent to the model:

1. the **inferred schema** (column names + types + a few example values), and
2. a **small row sample** (the first 12 rows).

Everything else — all the rows, the table preview, the parsing — happens in the browser. The UI states this where you ask questions so it's never a surprise.

Your API key is stored in this browser's `localStorage` and sent **directly to the provider's API** from the page. It is never transmitted anywhere else (there is no Querydeck server to send it to).

## Bring your own key

Click **Settings** and paste a key from either provider:

- **Anthropic (Claude)** — calls `api.anthropic.com` directly using the `anthropic-dangerous-direct-browser-access` header. Default model `claude-opus-4-8`; `claude-sonnet-4-6` and `claude-haiku-4-5` also work.
- **OpenAI (GPT)** — calls `api.openai.com` with a standard bearer token and JSON mode. Default model `gpt-4o`; `gpt-4o-mini`, `gpt-4.1`, etc. also work.

Pick whichever you have a key for. The key and chosen model persist locally until you change them.

> Calling these APIs straight from the browser exposes your key to client-side code on this page. That's the nature of a keyless, serverless tool — use a key scoped to what you're comfortable with, and revoke it if needed. For shared or production use you'd put a small proxy in front instead.

## Run it locally

It's static files, so any static server works:

```bash
git clone https://github.com/Vansh4195/querydeck.git
cd querydeck
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly via `file://` mostly works too, but a local server avoids browser quirks around `fetch`.

Then: open Settings, add your key, click **Load sample data** (or drop your own CSV), and ask something like *"Total revenue by region"* or *"Which products get returned most?"*.

## How it works

```
CSV ──PapaParse──▶ rows (kept in memory)
                    │
                    ├─▶ type inference ──▶ schema chips + table preview
                    │
   your question ───┘
        │
        ▼
   schema + 12-row sample + question
        │
        ▼  (direct fetch, your key)
   Anthropic / OpenAI ──▶ { answer, chart? }
        │
        ▼
   formatted answer + Chart.js render
```

The model is asked to reply with a single JSON object (`{ answer, chart }`). The parser is tolerant of stray markdown fences or surrounding prose, and falls back to showing the raw text if the response isn't valid JSON. Chart specs are validated and constrained to a known set of types before rendering.

## Project layout

```
index.html   markup + CDN script tags (PapaParse, Chart.js)
styles.css   styling (light/dark via prefers-color-scheme)
app.js       parsing, type inference, rendering, provider calls
sample_sales.csv   the bundled demo dataset
```

## Tech

Vanilla HTML/CSS/JS — no framework, no bundler. PapaParse and Chart.js are loaded from a CDN. Works in any modern browser.

## License

MIT — see [LICENSE](LICENSE).
