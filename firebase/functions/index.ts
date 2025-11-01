/* CLARITY AI - Firebase Functions Fallback (Gemini 1.5 Flash, asia-south1)
   Endpoint: https://asia-south1-<project>.cloudfunctions.net/clarityAiPrompt
   Env: Set GEMINI_API_KEY in functions environment or .env during local emulation.

   Tasks:
   - label       -> { labels: string[], summaries: string[] }
   - summary     -> { summaries: string[] }
   - connections -> { text: string, suggestions?: Array<{label:string,action:string,payload:any}> }
   - chat        -> { text: string }

   Privacy: Only receive minimal tab metadata (titles, host, pathTokens). No full URLs.
*/

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import corsLib from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

const cors = corsLib({ origin: true });
const MODEL_NAME = "gemini-1.5-flash";
const API_KEY = process.env.GEMINI_API_KEY || "";

// Util ------------------------------------------------------------------------

function sanitizeString(s: unknown, max = 400): string {
  if (typeof s !== "string") return "";
  const out = s.replace(/\r/g, " ").replace(/\t/g, " ").trim();
  return out.slice(0, max);
}
function sanitizeStringArray(a: unknown, maxItems = 16, itemMax = 200): string[] {
  if (!Array.isArray(a)) return [];
  return a.slice(0, maxItems).map((x) => sanitizeString(x, itemMax)).filter(Boolean);
}
function ok(res: any, body: any) {
  res.set("Cache-Control", "no-store").status(200).json(body);
}
function bad(res: any, code: number, msg: string) {
  res.set("Cache-Control", "no-store").status(code).json({ error: msg });
}
function ensureModel() {
  if (!API_KEY) throw new Error("missing_api_key");
  const genAI = new GoogleGenerativeAI(API_KEY);
  return genAI.getGenerativeModel({ model: MODEL_NAME });
}
function extractText(resp: any): string {
  try {
    const txt = resp?.response?.text?.() ?? resp?.text ?? "";
    return String(txt || "");
  } catch {
    return "";
  }
}
function toSuggestions(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Array<{ label: string; action: string; payload: any }> = [];
  for (const line of lines) {
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const label = line.replace(/^([-*]|\d+\.)\s+/, "");
      out.push({ label, action: "search", payload: { q: label.replace(/^(Next step:)\s*/i, "") } });
    }
  }
  return out.slice(0, 6);
}

// Prompts ---------------------------------------------------------------------

function promptLabel(groups: Array<{ tabTitles: string[]; sampleHost?: string }>) {
  const clusters = groups
    .map((g, i) => `#${i + 1} Titles: ${sanitizeStringArray(g.tabTitles, 8, 120).join(" | ")}${g.sampleHost ? ` (host: ${sanitizeString(g.sampleHost)})` : ""}`)
    .join("\n");
  return [
    "You are CLARITY AI.",
    "Create concise human-readable labels (1–3 words) and a 1-sentence summary per cluster.",
    "Avoid brand overfit. Prefer generic intents like 'Trip Planning', 'React Auth', 'Laptop Shopping'.",
    "",
    clusters,
    "",
    "Return strict JSON only: { \"labels\": string[], \"summaries\": string[] }"
  ].join("\n");
}

function promptSummary(groups: Array<{ label?: string; tabTitles: string[] }>) {
  return [
    "Summarize each group with a 1-sentence overview and 3 short bullets.",
    "Use only the provided titles; do not hallucinate details.",
    JSON.stringify({ groups }, null, 2)
  ].join("\n");
}

function promptConnections(context: { active: any; others: any[] }) {
  return [
    "Given the active group and other groups, explain how they connect in 1–2 bullets and propose 2 next steps.",
    "Keep it generic (e.g., refine search terms, consolidate tabs, compare sources).",
    JSON.stringify(context, null, 2)
  ].join("\n");
}

function promptChat(system: string, ctx: any, userInput: string) {
  return [
    `System: ${sanitizeString(system, 800)}`,
    "Context (group summaries and titles only):",
    JSON.stringify(ctx, null, 2),
    "",
    `User: ${sanitizeString(userInput, 1000)}`,
    "Assistant:"
  ].join("\n");
}

// Handler ---------------------------------------------------------------------

export const clarityAiPrompt = onRequest(
  {
    region: "asia-south1",
    cors: true,
    maxInstances: 5,
    timeoutSeconds: 15,
    memory: "256MiB"
  },
  async (req, res) => {
    return cors(req, res, async () => {
      try {
        if (req.method !== "POST") return bad(res, 405, "method_not_allowed");
        const task = String(req.body?.task || "").toLowerCase();
        const language = String(req.body?.language || "en");

        const model = ensureModel();

        // Routing per task
        if (task === "label") {
          const groupsIn = Array.isArray(req.body?.groups) ? req.body.groups : [];
          const groups = groupsIn.map((g: any) => ({
            tabTitles: sanitizeStringArray(g?.tabTitles || [], 8, 120),
            sampleHost: sanitizeString(g?.sampleHost || "", 60)
          }));
          const prompt = promptLabel(groups);
          const resp = await model.generateContent([{ text: prompt }]);
          const text = extractText(resp);
          // Try to parse JSON
          let labels: string[] = [];
          let summaries: string[] = [];
          try {
            const start = text.indexOf("{");
            const end = text.lastIndexOf("}");
            if (start >= 0 && end > start) {
              const obj = JSON.parse(text.slice(start, end + 1));
              labels = sanitizeStringArray(obj.labels || [], groups.length, 40);
              summaries = sanitizeStringArray(obj.summaries || [], groups.length, 280);
            }
          } catch (e) {
            logger.warn("label_parse_error", e);
          }
          return ok(res, { labels, summaries });

        } else if (task === "summary") {
          const groupsIn = Array.isArray(req.body?.groups) ? req.body.groups : [];
          const groups = groupsIn.map((g: any) => ({
            label: sanitizeString(g?.label || "", 60),
            tabTitles: sanitizeStringArray(g?.tabTitles || [], 8, 120)
          }));
          const prompt = promptSummary(groups);
          const resp = await model.generateContent([{ text: prompt }]);
          const text = extractText(resp);
          // Split into group paragraphs if JSON missing
          let summaries: string[] = [];
          try {
            const start = text.indexOf("{");
            const end = text.lastIndexOf("}");
            if (start >= 0 && end > start) {
              const obj = JSON.parse(text.slice(start, end + 1));
              summaries = sanitizeStringArray(obj.summaries || [], groups.length, 320);
            } else {
              // fallback: split by double newline
              summaries = text.split(/\n\s*\n/).map((s) => sanitizeString(s, 320)).slice(0, groups.length);
            }
          } catch {
            summaries = text.split(/\n\s*\n/).map((s) => sanitizeString(s, 320)).slice(0, groups.length);
          }
          return ok(res, { summaries });

        } else if (task === "connections") {
          const ctxIn = req.body?.context || {};
          const active = {
            label: sanitizeString(ctxIn?.active?.label || "", 80),
            summary: sanitizeString(ctxIn?.active?.summary || "", 280),
            tabTitles: sanitizeStringArray(ctxIn?.active?.tabTitles || [], 8, 120)
          };
          const others = Array.isArray(ctxIn?.others) ? ctxIn.others.slice(0, 4).map((g: any) => ({
            label: sanitizeString(g?.label || "", 80),
            summary: sanitizeString(g?.summary || "", 200)
          })) : [];
          const prompt = promptConnections({ active, others });
          const resp = await model.generateContent([{ text: prompt }]);
          const text = extractText(resp);
          const suggestions = toSuggestions(text);
          return ok(res, { text, suggestions });

        } else if (task === "chat") {
          const ctxIn = req.body?.ctx || {};
          const userInput = sanitizeString(req.body?.userInput || "", 1000);
          const active = ctxIn?.active ? {
            id: sanitizeString(ctxIn.active.id || "", 36),
            label: sanitizeString(ctxIn.active.label || "", 80),
            summary: sanitizeString(ctxIn.active.summary || "", 280),
            tabTitles: sanitizeStringArray(ctxIn.active.tabTitles || [], 8, 120)
          } : null;
          const others = Array.isArray(ctxIn?.others) ? ctxIn.others.slice(0, 4).map((g: any) => ({
            id: sanitizeString(g?.id || "", 36),
            label: sanitizeString(g?.label || "", 80),
            summary: sanitizeString(g?.summary || "", 200)
          })) : [];
          const system = "Answer using only the provided context of group summaries and titles. If insufficient, suggest a next step. Be concise.";
          const prompt = promptChat(system, { active, others }, userInput);
          const resp = await model.generateContent([{ text: prompt }]);
          const text = extractText(resp);
          return ok(res, { text: text.trim() });
        }

        return bad(res, 400, "unknown_task");
      } catch (err: any) {
        logger.error("clarityAiPrompt_error", err);
        const msg = String(err?.message || err || "internal_error");
        if (/timeout/i.test(msg)) return bad(res, 504, "timeout");
        if (/missing_api_key/.test(msg)) return bad(res, 500, "missing_api_key");
        return bad(res, 500, "internal_error");
      }
    });
  }
);