import "dotenv/config";
import express from "express";
import { registerF2fRoutes } from "./f2f.js";

const PORT = process.env.PORT || 8787;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";

const DOC_TYPES = ["pan", "aadhaar", "bank_statement", "salary", "itr", "sale_agreement", "sale_deed", "property_tax_receipt", "property_other", "address_proof", "photo", "other"];

const EXTRACT_TOOL = {
  name: "extract_documents",
  description: "Classify each uploaded document and report the merged set of fields that could be read from them, for a Loan Against Property (LAP) application.",
  input_schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        description: "One entry per uploaded document, in the order given.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            docType: { type: "string", enum: DOC_TYPES },
            holderName: { type: "string", description: "The person's full name as printed on THIS specific document — account holder, PAN/Aadhaar name, ITR assessee, or (for property_tax_receipt / property_other) whoever the document is issued to or lists as owner. Only if legible. Not used for sale_agreement/sale_deed — use buyerName/sellerName instead, since those documents name two different parties." },
            panOnDocument: { type: "string", description: "salary/itr only: the PAN number printed on THIS specific document, if legible (e.g. on a Form 16 or salary slip header). This is a stronger identity signal than the name, so report it whenever visible." },
            buyerName: { type: "string", description: "sale_agreement/sale_deed only: the buyer's/purchaser's full name as printed on the document." },
            sellerName: { type: "string", description: "sale_agreement/sale_deed only: the seller's/vendor's (current owner's) full name as printed on the document." },
            statementRecent: { type: "boolean", description: "Bank statements only: true if the statement's date range ends within roughly the last 6 months of today, false if it's older. Omit for non-bank-statement documents." },
          },
          required: ["name", "docType"],
        },
      },
      extracted: {
        type: "object",
        description: "Only include a field if it was actually legible in one of the documents. Never guess or fabricate a value.",
        properties: {
          identity: {
            type: "object",
            properties: {
              firstName: { type: "string" },
              middleName: { type: "string" },
              lastName: { type: "string" },
              fatherName: { type: "string" },
              gender: { type: "string" },
              dob: { type: "string", description: "DD/MM/YYYY" },
              panNumber: { type: "string" },
            },
          },
          banking: {
            type: "object",
            properties: {
              bankName: { type: "string" },
              accountNumber: { type: "string" },
              ifsc: { type: "string" },
              accountType: { type: "string" },
              availableBalance: { type: "string" },
              avgMonthlyBalance: { type: "string" },
              statementPeriod: { type: "string" },
            },
          },
          kyc: {
            type: "object",
            properties: {
              aadhaar: { type: "string" },
              addressLine1: { type: "string" },
              addressLine2: { type: "string" },
              pincode: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
            },
          },
          property: {
            type: "object",
            properties: {
              propertyType: { type: "string", description: "e.g. Apartment, Independent House, Plot, Commercial" },
              addressLine1: { type: "string" },
              addressLine2: { type: "string" },
              pincode: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
            },
          },
        },
      },
    },
    required: ["documents", "extracted"],
  },
};

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a document-OCR assistant for a Loan Against Property (LAP) onboarding app used by a bank's loan officer. Today's date is ${today}. You will be shown one or more scanned documents: PAN card, Aadhaar card, bank statement, salary slip, Form16/ITR, sale_agreement, sale_deed, property_tax_receipt, property_other (e.g. an older title deed), an address proof like a utility bill, or a plain photo.

For each document, classify its docType, then read off whichever identity fields are legible on THAT specific document:
- pan / aadhaar / bank_statement / salary / itr / property_tax_receipt / property_other: read the name the document belongs to into "holderName".
- salary / itr: also read the PAN number printed on the document (if any) into "panOnDocument" — this is a stronger identity signal than the name, so report it whenever visible, even if you also report holderName.
- sale_agreement / sale_deed: these name TWO different parties — read the buyer's/purchaser's name into "buyerName" and the seller's/vendor's (current owner's) name into "sellerName". Do not use "holderName" for these two document types.
- bank_statement: also set "statementRecent" to true if the statement's date range ends within roughly the last 6 months of today (${today}), or false if it's older — judge by the actual printed dates, not assumptions.

Then extract whatever identity, banking, KYC/address, and property fields are actually legible across all the documents combined into "extracted". Only report a field if you can actually read it — leave it out rather than guessing. Always respond by calling the extract_documents tool.`;
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const app = express();
app.use(express.json({ limit: "40mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "finflo-ocr-backend" });
});

app.post("/api/ocr", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not set. Add it to finflo-project/.env and restart the server." });
    return;
  }
  const documents = Array.isArray(req.body?.documents) ? req.body.documents : [];
  if (documents.length === 0) {
    res.status(400).json({ error: "No documents provided." });
    return;
  }

  const content = documents.flatMap((doc) => [
    { type: "text", text: `Document: ${doc.name}` },
    doc.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.base64 } }
      : { type: "image", source: { type: "base64", media_type: doc.mediaType || "image/jpeg", data: doc.base64 } },
  ]);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content }],
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "extract_documents" },
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      res.status(response.status).json({ error: errBody?.error?.message || `Claude API error (${response.status})` });
      return;
    }

    const data = await response.json();
    const toolUse = data.content?.find((block) => block.type === "tool_use");
    if (!toolUse) {
      res.status(502).json({ error: "Claude did not return structured extraction output." });
      return;
    }
    res.json(toolUse.input);
  } catch (err) {
    res.status(500).json({ error: err.message || "OCR request failed." });
  }
});

registerF2fRoutes(app, { apiKey: ANTHROPIC_API_KEY });

// Locally, bind to loopback only — keeps the key-holding endpoint unreachable
// from other devices on the same network (e.g. shared Wi-Fi). On Render (and
// most other hosts), the service must accept traffic from outside the
// container, so bind to all interfaces there instead.
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
app.listen(PORT, HOST, () => {
  console.log(`FinFlo OCR server listening on http://${HOST}:${PORT}`);
  if (!ANTHROPIC_API_KEY) console.warn("Warning: ANTHROPIC_API_KEY not set — /api/ocr will return an error until it is.");
});
