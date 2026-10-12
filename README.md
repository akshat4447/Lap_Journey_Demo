# FinFlo — OCR Backend

Small Express server that proxies document-OCR requests to the Claude API for the FinFlo LAP onboarding frontend. This is the backend only — pair it with the `finflo-frontend` package (or point any frontend's `/api/ocr` calls at wherever you deploy this).

## Local Development

```bash
npm install
cp .env.example .env   # paste your Anthropic API key into .env
npm start              # listens on http://127.0.0.1:8787
```

## Deploy (Render)

1. Push this folder to its own GitHub repo (or a subfolder Render can target).
2. Create a new **Web Service** on [render.com](https://render.com), connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Environment variables:
   - `ANTHROPIC_API_KEY` — required, your Claude API key.
   - `ALLOWED_ORIGIN` — set to your deployed frontend's origin (e.g. `https://your-app.netlify.app`) to lock down CORS. Defaults to `*` (any origin) if unset.
   - `PORT` — Render sets this automatically; no action needed.
5. Once deployed, copy the service URL (e.g. `https://finflo-backend.onrender.com`) into the frontend's `public/config.js` — no frontend rebuild needed.

Render (and most other hosts) need the server to bind to all interfaces, which happens automatically when `RENDER` is present in the environment (Render sets this itself). Locally, it binds to loopback only (`127.0.0.1`) so the key-holding endpoint isn't reachable from other devices on the same network.

## API

`POST /api/ocr` — body: `{ documents: [{ name, mediaType, base64 }, ...] }`. Classifies each document (PAN, Aadhaar, bank statement, salary slip, ITR, sale agreement/deed, property tax receipt, address proof, photo) and extracts identity/banking/KYC/property fields via a single Claude tool-use call, returning structured JSON.

`POST /api/f2f/extract` — body: `{ transcript, fields: [{ key, label, type, options?, hint? }], applicant?: { name, loanAmount }, discussionLanguage? }`. The transcript may be English, an Indian language (Hindi, Marathi, Tamil, Telugu, Kannada, Malayalam, Bengali, Gujarati) or code-mixed, in any script. Values and the summary always come back in English (names transliterated to Latin script, spoken numbers converted to digits), while `evidence` quotes stay in the transcript's original script. Extracts face-to-face discussion fields from a meeting transcript using Claude (`claude-opus-5-5`, strict tool schema, server-side refusal fallback enabled). Returns `{ extractions: [{ fieldKey, value, evidence, confidence, evidenceFound }], summary }`. `evidence` is a verbatim transcript quote; if the quote can't be found in the transcript, `evidenceFound` is `false` and confidence is downgraded to `low`. The field schema comes from the frontend (`src/f2f/fields.js`), so the two can't drift apart. Audio never reaches the backend, because transcription happens in the browser.

`GET /` — health check, returns `{ status: "ok", service: "finflo-ocr-backend" }`.
