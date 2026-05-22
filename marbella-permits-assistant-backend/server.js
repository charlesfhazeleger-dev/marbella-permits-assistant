// Marbella Permits — AI assistant backend.
// Zero-dependency Node (>=18) HTTP server, designed to run on Render as a Web Service.
// It holds the Anthropic API key (never exposed to the browser), grounds every answer
// in the permit guide + the customer's case facts, refuses off-topic questions, blocks
// any invented bank account number, and caps usage per IP (plus a global daily ceiling).
//
// Env vars (set these in the Render dashboard):
//   ANTHROPIC_API_KEY   (required)  your Anthropic key
//   ALLOWED_ORIGIN      (recommended) e.g. https://charlesfhazeleger-dev.github.io
//   MODEL               (optional)  default: claude-haiku-4-5-20251001
//   PER_IP_LIMIT        (optional)  default: 10
//   MAX_DAILY_TOTAL     (optional)  default: 500   (global safety ceiling)
//   PORT                (set automatically by Render)

const http = require("http");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MODEL = process.env.MODEL || "claude-haiku-4-5-20251001";
const PER_IP_LIMIT = parseInt(process.env.PER_IP_LIMIT || "10", 10);
const MAX_DAILY_TOTAL = parseInt(process.env.MAX_DAILY_TOTAL || "500", 10);
const PORT = process.env.PORT || 3000;

// ---------- grounding: the only knowledge the assistant may rely on ----------
const GUIDE = `
MARBELLA PERMITS — PROCESS KNOWLEDGE (the only source you may use)

WHAT THIS IS: helping a foreign property owner file a "Declaración Responsable de Obras"
(a minor-works permit, "DR") with Marbella town hall, for simple renovations, without an
architect. We are software, not a gestor or lawyer. We provide documents and instructions;
the owner submits and pays the town hall themselves.

IN SCOPE (simple DR track): kitchen replacement (same layout), bathroom redo (no wall
changes), interior painting/finishes, façade painting (non-structural), terrace/patio
refurbishment, pool maintenance/re-tiling, window/door replacement (same openings).
Total budget under €100,000.

OUT OF SCOPE (needs a stamped architect's project — we cannot do these): moving/removing
walls, structural changes, adding floors or m², new façade openings, budget over €100,000,
properties in historic or coastal-protection zones.

EXEMPT (no permit at all): under Marbella's January 2026 instrucción urbanística, simple
works under €10,000 (painting, finishes, certain interior installations) that are NOT in a
protected zone need no permit and no fee — only a self-certification for the owner's records.

FEES: licence fee = 4.72% of the project budget (PEM, the cost of works without VAT).
Waste deposit ("fianza") = 2% of demolition cost + 1% of the rest; it is REFUNDABLE after
the works, on proof of correct waste disposal. The owner pays the town hall directly; we add
no markup. Our own service fee is €99.

THE PACK (files the owner downloads): 00-START-HERE-instructions.pdf (the step-by-step
guide), 01-form-to-sign.pdf (the DR form), 02-cost-breakdown.pdf (presupuesto, in Spanish),
03-first-email.pdf, 04-second-email.pdf, 05-permission-letter-optional.pdf.

THE 7 SUBMISSION STEPS:
1) Print and sign 01-form-to-sign.pdf; scan/photo it back to PDF.
2) Collect in one folder: the signed form, a passport/NIE/DNI copy, a property map from
   the Spanish cadastre (sedecatastro.gob.es), and the cost breakdown (file 02). A company
   owner also needs its escrituras and CIF certificate.
3) Send the FIRST email to oficinaliquidadora@marbella.es (text in file 03), attaching the
   step-2 documents. The town hall replies in ~5–10 working days with a "carta de pago" (a
   bill with a reference number).
4) Pay the licence bill at the bank — UNICAJA BANCO, IBAN ES59 2103 1001 5702 3000 0222,
   SWIFT UCJAES2M. In the payment concept put the reference number from the bill plus the
   owner/company name. Keep the receipt.
5) Pay the refundable waste deposit (you calculate it; no bill is sent first) — BBVA,
   account holder Ayuntamiento de Marbella, IBAN ES73 0182 5918 4502 0150 6063, SWIFT
   BBVAESMMXXX, concept "Fianza [amount] € – [property address]". Keep the receipt.
6) Send the SECOND email to caja@marbella.es (text in file 04), attaching the deposit
   receipt; they reply with the matching bill.
7) Upload everything at the town hall's sede electrónica (www.marbella.es → Sede electrónica
   → Trámites → Instancia General → Acceder con Certificado Digital). In the "Delegación"
   dropdown you MUST choose LICENCIAS (never urbanismo/obras/proyectos). Attach the signed
   form, cost breakdown, property map, ID copy, both bank receipts and both town-hall bills.
   Click "Presentar" and SAVE the "acuse de recibo / justificante" — that is legal proof of
   submission, and the works may legally start the moment it appears.

REQUIREMENTS: submitting at the sede electrónica needs a Spanish digital certificate (FNMT)
or Cl@ve PIN; or a Spanish company's administrator certificate; or a trusted person who has
one (give them file 05, the permission letter).

CRITICAL RULE: the town hall gives only ONE chance to fix mistakes ("subsanación"). If the
file is incomplete and not corrected the first time they ask ("requerimiento"), the case is
thrown out and you start over.

HUMAN HELP: phone +34 690 380 502, email hello@marbellapermits.com.
`;

const ALLOWED_IBANS = [
  "ES5921031001570230000222",
  "ES7301825918450201506063",
];

function systemPrompt(caseFacts, lang) {
  return `You are the Marbella Permits assistant. You help one property owner who is doing
their own minor-works permit. Answer ONLY using the PROCESS KNOWLEDGE and CASE FACTS below.

RULES — follow strictly:
- Only answer questions about THIS permit process and these steps. If asked anything else
  (legal advice, taxes, other towns, unrelated topics), politely decline in one sentence and
  point them to the steps or to human help. Do not answer it.
- Never invent or guess facts. Bank account numbers (IBAN), SWIFT codes, fee amounts,
  deadlines and legal thresholds must come verbatim from PROCESS KNOWLEDGE or CASE FACTS. If
  a specific number is not provided, say you don't have it and tell them which file to open or
  to contact human help — do NOT make one up.
- When giving an amount or bank detail for this customer, use the exact values in CASE FACTS.
- Keep answers short, warm and in plain words. The reader may be elderly and not speak
  Spanish. Prefer 2–5 short sentences. Use the file names and step numbers above.
- You are software, not a lawyer or gestor. This is guidance, not legal advice. Do not say
  you can submit on their behalf.
- If you are unsure or the question is outside the knowledge, say so and give the human help
  contact (+34 690 380 502 / hello@marbellapermits.com).
- Reply in this language code: ${lang || "en"}.

PROCESS KNOWLEDGE:
${GUIDE}

CASE FACTS (this customer; may be partial):
${JSON.stringify(caseFacts || {}, null, 0)}`;
}

// ---------- per-IP + global rate limiting (in-memory; fine for a single instance) ----------
const ipHits = new Map(); // ip -> { day, count }
let globalDay = todayStr();
let globalCount = 0;

function todayStr() { return new Date().toISOString().slice(0, 10); }

function rollDayIfNeeded() {
  const d = todayStr();
  if (d !== globalDay) { globalDay = d; globalCount = 0; ipHits.clear(); }
}

function remainingFor(ip) {
  rollDayIfNeeded();
  const rec = ipHits.get(ip);
  const used = rec && rec.day === globalDay ? rec.count : 0;
  return Math.max(0, PER_IP_LIMIT - used);
}

function consume(ip) {
  rollDayIfNeeded();
  if (globalCount >= MAX_DAILY_TOTAL) return { ok: false, reason: "global", remaining: 0 };
  let rec = ipHits.get(ip);
  if (!rec || rec.day !== globalDay) { rec = { day: globalDay, count: 0 }; ipHits.set(ip, rec); }
  if (rec.count >= PER_IP_LIMIT) return { ok: false, reason: "ip", remaining: 0 };
  rec.count++; globalCount++;
  return { ok: true, remaining: PER_IP_LIMIT - rec.count };
}

function refund(ip) {
  const rec = ipHits.get(ip);
  if (rec && rec.count > 0) rec.count--;
  if (globalCount > 0) globalCount--;
}

// ---------- guardrail: block any IBAN that isn't one of ours ----------
function ibanSafe(text) {
  const found = String(text).match(/ES\d{2}[\s\d]{18,}/gi) || [];
  for (const f of found) {
    const norm = f.replace(/\s/g, "").slice(0, 24);
    if (!ALLOWED_IBANS.includes(norm)) return false;
  }
  return true;
}

// ---------- helpers ----------
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function callAnthropic(sys, messages) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system: sys, messages }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error("anthropic " + resp.status + " " + t.slice(0, 200));
  }
  const data = await resp.json();
  return (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : "";
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "GET" && req.url.startsWith("/health")) {
    return sendJson(res, 200, { ok: true, model: MODEL, configured: !!ANTHROPIC_API_KEY });
  }

  if (req.method === "POST" && req.url.startsWith("/ask")) {
    if (!ANTHROPIC_API_KEY) return sendJson(res, 500, { error: "Server not configured (missing ANTHROPIC_API_KEY)." });

    const ip = clientIp(req);
    if (remainingFor(ip) <= 0) {
      return sendJson(res, 429, { error: "limit", message: "You've reached the limit of " + PER_IP_LIMIT + " questions. For more help, contact +34 690 380 502 or hello@marbellapermits.com.", remaining: 0 });
    }

    let payload;
    try { payload = JSON.parse(await readBody(req) || "{}"); }
    catch (e) { return sendJson(res, 400, { error: "bad_json" }); }

    const question = (payload.question || "").toString().slice(0, 1000).trim();
    if (!question) return sendJson(res, 400, { error: "empty_question" });
    const lang = (payload.lang || "en").toString().slice(0, 5);
    const caseFacts = payload.caseFacts || {};
    const history = Array.isArray(payload.history) ? payload.history.slice(-6).filter(
      m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    ) : [];

    const taken = consume(ip);
    if (!taken.ok) {
      return sendJson(res, 429, { error: taken.reason, message: "Question limit reached. Contact +34 690 380 502 or hello@marbellapermits.com.", remaining: 0 });
    }

    try {
      const messages = [...history, { role: "user", content: question }];
      let answer = await callAnthropic(systemPrompt(caseFacts, lang), messages);
      if (!ibanSafe(answer)) {
        answer = "I want to be sure I give you the right bank details rather than risk an error. Please open the instruction guide (file 00) for the exact account numbers, or contact us: +34 690 380 502 / hello@marbellapermits.com.";
      }
      return sendJson(res, 200, { answer: answer.trim(), remaining: taken.remaining });
    } catch (err) {
      refund(ip); // don't burn the customer's quota on our error
      return sendJson(res, 502, { error: "upstream", message: "Sorry — I couldn't answer just now. Please try again, or contact +34 690 380 502 / hello@marbellapermits.com.", remaining: remainingFor(ip) });
    }
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("Marbella Permits assistant listening on :" + PORT + " (model " + MODEL + ")"));
