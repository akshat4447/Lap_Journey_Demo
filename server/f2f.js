import Anthropic from "@anthropic-ai/sdk";

// Face-to-face (F2F) discussion extraction: turns a loan officer's recorded LAP
// discussion transcript into the F2F form's fields. The frontend sends its field
// schema with each request, so the form and the extractor can never drift apart.

const F2F_MODEL = "claude-opus-5-5";
const MAX_TRANSCRIPT_CHARS = 60000;
const MAX_FIELDS = 120;

function buildTool(fields) {
  return {
    name: "record_f2f_fields",
    description: "Record every F2F form field that the discussion transcript actually states, each with a verbatim supporting quote.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        extractions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fieldKey: { type: "string", enum: fields.map(f => f.key) },
              value: { type: "string", description: "The field value. Currency/number fields: plain digits in rupees or units (e.g. \"4500000\", \"12\"), no symbols or commas. Select fields: exactly one of the listed options." },
              evidence: { type: "string", description: "The shortest verbatim span copied character-for-character from the transcript that supports the value." },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["fieldKey", "value", "evidence", "confidence"],
            additionalProperties: false,
          },
        },
        summary: { type: "string", description: "3-5 sentence neutral summary of the discussion for the credit team." },
      },
      required: ["extractions", "summary"],
      additionalProperties: false,
    },
  };
}

function describeFields(fields) {
  return fields.map(f => {
    let line = `- ${f.key} — ${f.label} (${f.type}`;
    if (Array.isArray(f.options) && f.options.length) line += `; options: ${f.options.join(" | ")}`;
    line += ")";
    if (f.hint) line += ` — ${f.hint}`;
    return line;
  }).join("\n");
}

const SYSTEM_PROMPT = `You extract structured data from the transcript of a face-to-face (personal discussion) meeting between a lender's loan officer and a Loan Against Property (LAP) applicant in India. The transcript comes from automatic speech recognition, so expect missing punctuation, no speaker labels, and occasional misheard words.

Your output fills the officer's F2F form, which feeds a credit decision — so accuracy matters more than coverage:
- Only fill a field when the transcript states it or makes it unambiguous. Leave a field out rather than guess. Officer-judgment fields (conduct, risk flags, recommendation, remarks) should be filled only if the officer says them aloud.
- The evidence must be copied verbatim from the transcript so it can be highlighted; keep it short (the phrase carrying the value, not the whole turn).
- Convert Indian amount words to rupees: "45 thousand" = 45000, "3.2 lakh" = 320000, "1.5 crore" = 15000000. Monthly vs annual matters — don't put an annual figure in a monthly field.
- Attribute facts to the right person: a spouse's salary is spouse income, not the applicant's.
- For select fields, the value must be one of the listed options verbatim; if none fits, omit the field.

Record your answer by calling the record_f2f_fields tool exactly once.`;

let client = null;
function getClient(apiKey) {
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

function normalise(s) {
  return String(s).toLowerCase().replace(/[\s,.;:!?"'’]+/g, " ").trim();
}

export function registerF2fRoutes(app, { apiKey }) {
  app.post("/api/f2f/extract", async (req, res) => {
    if (!apiKey) {
      res.status(500).json({ error: "ANTHROPIC_API_KEY is not set. Add it to .env and restart the server." });
      return;
    }
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
    const fields = Array.isArray(req.body?.fields)
      ? req.body.fields.filter(f => f && typeof f.key === "string" && typeof f.label === "string").slice(0, MAX_FIELDS)
      : [];
    if (!transcript) { res.status(400).json({ error: "No transcript provided." }); return; }
    if (transcript.length > MAX_TRANSCRIPT_CHARS) { res.status(413).json({ error: `Transcript is longer than ${MAX_TRANSCRIPT_CHARS} characters.` }); return; }
    if (fields.length === 0) { res.status(400).json({ error: "No field schema provided." }); return; }

    const applicant = req.body?.applicant || {};
    const context = [
      applicant.name ? `Applicant on file: ${applicant.name}` : null,
      applicant.loanAmount ? `Loan amount on file: ₹${Number(applicant.loanAmount).toLocaleString("en-IN")}` : null,
    ].filter(Boolean).join("\n");

    try {
      const response = await getClient(apiKey).beta.messages.create({
        model: F2F_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: SYSTEM_PROMPT,
        tools: [buildTool(fields)],
        tool_choice: { type: "auto" },
        messages: [{
          role: "user",
          content: `F2F form fields:\n${describeFields(fields)}\n\n${context ? context + "\n\n" : ""}<transcript>\n${transcript}\n</transcript>`,
        }],
      });

      if (response.stop_reason === "refusal") {
        res.status(422).json({ error: "The model declined to process this transcript." });
        return;
      }
      const toolUse = response.content.find(block => block.type === "tool_use" && block.name === "record_f2f_fields");
      if (!toolUse) {
        res.status(502).json({ error: "Claude did not return structured F2F output." });
        return;
      }

      const known = new Set(fields.map(f => f.key));
      const haystack = normalise(transcript);
      const seen = new Set();
      const extractions = [];
      for (const ex of toolUse.input.extractions || []) {
        if (!known.has(ex.fieldKey) || seen.has(ex.fieldKey) || !String(ex.value || "").trim()) continue;
        seen.add(ex.fieldKey);
        // A quote that isn't in the transcript can't be traced — downgrade it
        // so the officer knows to double-check rather than silently trusting it.
        const evidenceFound = !!ex.evidence && haystack.includes(normalise(ex.evidence));
        extractions.push({ ...ex, confidence: evidenceFound ? ex.confidence : "low", evidenceFound });
      }
      res.json({ extractions, summary: toolUse.input.summary || "", source: "ai" });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        res.status(429).json({ error: "Rate limited by Claude API — retry shortly." });
      } else if (err instanceof Anthropic.APIError) {
        res.status(err.status || 502).json({ error: err.message || "Claude API error." });
      } else {
        res.status(500).json({ error: err?.message || "F2F extraction failed." });
      }
    }
  });
}
