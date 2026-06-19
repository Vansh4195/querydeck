#!/usr/bin/env node
/* Querydeck E2E — free LLM smoke test via Google Gemini.
 *
 * Proves the request/parse logic Querydeck uses against a real model, for free.
 * It mirrors the app's OpenAI-compatible call shape (callOpenAI in app.js) but
 * points at Gemini's OpenAI-compatible endpoint, which is free on the AI Studio
 * tier. Because this is a Node script there is no browser and therefore no CORS
 * — it isolates the request/parse path from any browser policy.
 *
 *   GEMINI_API_KEY=...  node tests/e2e.mjs
 *
 * Get a free key at https://aistudio.google.com/apikey
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 0 (with SKIP) when no key is set.
 */

"use strict";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-2.0-flash";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("SKIP: GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey");
    process.exit(0);
  }

  // Same request shape the app uses for OpenAI-compatible providers
  // (see callOpenAI in app.js): bearer auth, chat/completions, messages array.
  // Tokens are kept tiny so this costs ~nothing on the free tier.
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
        max_tokens: 20,
      }),
    });
  } catch (err) {
    fail(`network error reaching Gemini: ${err && err.message ? err.message : err}`);
    return;
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body.error && (body.error.message || JSON.stringify(body.error))) || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    if (res.status === 401 || res.status === 403) {
      fail(`auth failed (${res.status}). Check GEMINI_API_KEY. ${detail}`);
    } else if (res.status === 429) {
      fail(`rate limited / out of quota (429). Try again shortly. ${detail}`);
    } else if (res.status === 404) {
      fail(`model not found (404): ${MODEL}. ${detail}`);
    } else {
      fail(`HTTP ${res.status}: ${detail || "request failed"}`);
    }
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    fail(`response was not valid JSON: ${err && err.message ? err.message : err}`);
    return;
  }

  // Parse exactly the way the app reads an OpenAI-compatible reply.
  const text =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";

  if (!text || !String(text).trim()) {
    fail(`response parsed but contained no text. Raw: ${JSON.stringify(data).slice(0, 400)}`);
    return;
  }

  console.log(`Model replied: ${JSON.stringify(String(text).trim().slice(0, 80))}`);
  console.log("PASS");
  process.exit(0);
}

function fail(reason) {
  console.log(`FAIL: ${reason}`);
  process.exit(1);
}

main();
