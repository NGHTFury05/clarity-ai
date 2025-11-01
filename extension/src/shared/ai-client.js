// CLARITY AI - AI Client (local-first with Firebase Gemini Flash fallback)
// Exposed API (all return { text, ... } or task-specific payloads):
// - labelGroups({ groups, tabs }) => { labels: string[], summaries: string[] }
// - summarizeGroups({ groups, tabs }) => { summaries: string[] }
// - connectionHints({ active, others }) => { text: string, suggestions?: Array<{label,action,payload}> }
// - chatReply({ userText, context }) => { text: string }
// - transcribeFromMic() => Promise<string>
//
// Privacy: Only send minimal tab metadata (titles, host, derived tokens). No full URLs or query strings.
// Notes: This runs in the Side Panel context (document), not the service worker.

const FALLBACK_ENDPOINT = "https://asia-south1-chrome-built-in-ai-chall-592d2.cloudfunctions.net/clarityAiPrompt";
const REQ_TIMEOUT_MS = 15000;

// ----------------------------
// Local Prompt API detection
// ----------------------------
let textSession = null;
let modelSession = null; // Prompt API session wrapper

function hasLocalTextAPI() {
  try {
    // Preferred (Prompt API): global LanguageModel or extension self.ai.languageModel
    if (typeof globalThis !== "undefined" && globalThis.LanguageModel && typeof globalThis.LanguageModel.create === "function") return true;
    if (typeof self !== "undefined" && self.ai?.languageModel && typeof self.ai.languageModel.create === "function") return true;

    // Legacy/early APIs:
    if (typeof window !== "undefined" && window.ai && typeof window.ai.createTextSession === "function") return true;
    if (typeof chrome !== "undefined" && chrome.ai?.prompt && typeof chrome.ai.prompt.create === "function") return true;
  } catch {}
  return false;
}

async function getLocalTextSession() {
  // If we've already created a wrapper for any local API, reuse it
  if (modelSession) return modelSession;
  if (textSession) return textSession;

  // 1) Preferred Prompt API: global LanguageModel (side panel/document context)
  try {
    if (globalThis.LanguageModel?.create) {
      // Optionally hint languages; harmless if ignored
      const options = {
        temperature: 0.2,
        topK: 32,
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        monitor(m) {
          try {
            m.addEventListener?.("downloadprogress", (e) => {
              // eslint-disable-next-line no-console
              console.info("[PromptAPI] downloadprogress", Math.round((e.loaded || 0) * 100), "%");
            });
          } catch {}
        }
      };
      
      // Check availability before creating session (recommended best practice)
      if (globalThis.LanguageModel.availability) {
        const avail = await globalThis.LanguageModel.availability(options).catch(() => "unavailable");
        console.info("[PromptAPI] Availability status:", avail);
        
        if (avail === "unavailable") {
          console.warn("[PromptAPI] Model unavailable on this device. Falling back to Firebase.");
          return null;
        }
        
        if (avail === "downloadable") {
          console.info("[PromptAPI] Model needs download. User interaction required.");
          // Note: create() will require user activation if downloadable
        }
      }

      const sess = await globalThis.LanguageModel.create(options);
      modelSession = {
        prompt: async (input) => {
          const res = await sess.prompt(input);
          return typeof res === "string" ? res : String(res ?? "");
        },
        close: () => sess.destroy?.()
      };
      return modelSession;
    }
  } catch (error) {
    console.warn("[PromptAPI] Failed to create session:", error.message);
    // continue to other variants
  }

  // 2) Extension worker/page variant: self.ai.languageModel
  try {
    if (self?.ai?.languageModel?.create) {
      const sess = await self.ai.languageModel.create({
        temperature: 0.2,
        topK: 32,
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        monitor(m) {
          try {
            m.addEventListener?.("downloadprogress", (e) => {
              console.info("[PromptAPI] downloadprogress", Math.round((e.loaded || 0) * 100), "%");
            });
          } catch {}
        }
      });
      modelSession = {
        prompt: async (input) => {
          const res = await sess.prompt(input);
          return typeof res === "string" ? res : String(res ?? "");
        },
        close: () => sess.destroy?.()
      };
      return modelSession;
    }
  } catch {
    // continue
  }

  // 3) Early window.ai text session
  if (window.ai && typeof window.ai.createTextSession === "function") {
    textSession = await window.ai.createTextSession?.({ topK: 32, temperature: 0.2 }).catch(() => null);
    if (textSession) return textSession;
  }

  // 4) Early chrome.ai.prompt
  if (chrome.ai?.prompt?.create) {
    const sess = await chrome.ai.prompt.create({ topK: 32, temperature: 0.2 }).catch(() => null);
    if (sess) {
      textSession = {
        prompt: async (input) => {
          const res = await sess.prompt?.(input);
          if (typeof res === "string") return res;
          if (res?.output) return res.output;
          return String(res ?? "");
        },
        close: () => sess.destroy?.()
      };
      return textSession;
    }
  }

  return null;
}

async function localPrompt(prompt) {
  const sess = await getLocalTextSession();
  if (!sess) throw new Error("local_prompt_unavailable");
  // Try common methods
  if (typeof sess.prompt === "function") {
    const out = await sess.prompt(prompt);
    return typeof out === "string" ? out : String(out ?? "");
  }
  if (typeof sess.send === "function") {
    const out = await sess.send(prompt);
    return typeof out === "string" ? out : String(out ?? "");
  }
  throw new Error("local_prompt_no_method");
}

// ----------------------------
// Fallback call (Firebase Functions, Gemini 1.5 Flash)
// ----------------------------

// Chat-first helpers for new UX
export async function summarizeOpenTabs(tabs = []) {
 const titles = tabs.map(t => (t?.title || "").trim()).filter(Boolean).slice(0, 20);
 const hosts = Array.from(new Set(tabs.map(t => hostOf(t?.url || "")))).filter(Boolean).slice(0, 10);
 const prompt = [
  "You are CLARITY AI. Summarize open tabs based ONLY on provided titles and hosts.",
  "## Output Format",
  "Line 1: One-sentence overview of main task or theme",
  "Lines 2-4: Three short bullets (5-8 words each)(without any hashtags or points) covering key topics",
  "",
  "## Example",
  "Input: ['React Hooks Tutorial', 'useState Documentation', 'GitHub: my-react-app'] from [react.dev, react.dev, github.com]",
  "Output:",
  "Researching React state management for an active project.",
  "React Hooks fundamentals and patterns",
  "useState hook implementation details", 
  "Working on React application repository",
  "",
  "## Constraints",
  "- Maximum 4 lines total (1 overview + 3 specifics)",
  "- Do NOT invent details not present in titles/hosts",
  "- Identify connections between tabs",
  "",
  "## Tab Data",
  `Titles: ${JSON.stringify(titles)}`,
  `Hosts: ${JSON.stringify(hosts)}`
].join("\n");


 if (hasLocalTextAPI()) {
   try {
     const out = await localPrompt(prompt);
     return (out || "").trim();
   } catch {}
 }
 // Graceful fallback: heuristic summary (do not throw)
 const n = titles.length;
 const hostStr = hosts.slice(0, 5).join(", ");
 return `You have ${n} open tabs. Hosts include: ${hostStr || "various sources"}. Focus on the most relevant items and close distractions.`;
}

export async function suggestNextSteps(tabs = []) {
 const titles = tabs.map(t => (t?.title || "").trim()).filter(Boolean).slice(0, 20);
 const hosts = Array.from(new Set(tabs.map(t => hostOf(t?.url || "")))).filter(Boolean).slice(0, 10);
 // Use local Prompt API to act like a "writer" for actionable next steps
 const prompt = [
   "You are CLARITY AI. Based on the user's open tab titles and hosts, write 3–5 concrete next steps.",
   "- Keep steps short and actionable.",
   "- Prefer generic actions (refine query, compare sources, outline plan).",
   "- If search would help, include a suggested query in quotes.",
   "- Do not include any PII or speculate beyond titles.",
   "",
   JSON.stringify({ titles, hosts }, null, 2)
 ].join("\n");

 if (hasLocalTextAPI()) {
   try {
     const out = await localPrompt(prompt);
     return (out || "").trim();
   } catch {}
 }
 // Graceful fallback: heuristic suggestions (do not throw)
 const first = titles[0] || "your current topic";
 return [
   `- Skim top sources for “${first}”.`,
   "- Compare two strongest references and note differences.",
   "- Draft a short outline of what you need to decide next.",
   "- Save key links; close distractions and proceed."
 ].join("\n");
}

async function withTimeout(promise, ms, label = "request") {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function redactText(s = "") {
  // Basic redaction to strip query strings and obvious IDs
  return (s || "").replace(/\?.*$/g, "").replace(/[A-Z0-9]{16,}/gi, "[id]");
}

function hostOf(url = "") {
  const u = urlFromString(url);
  return u?.host || "";
}

function pathTokensOf(url = "") {
  const u = urlFromString(url);
  return u ? (u.pathname || "").split(/[\/\-\_]+/).filter(Boolean).slice(0, 6) : [];
}

function minimalTabs(tabs = [], limit = 10) {
  return tabs.slice(0, limit).map(t => ({
    title: redactText(t.title || ""),
    host: hostOf(t.url || ""),
    pathTokens: pathTokensOf(t.url || "")
  }));
}

async function fallbackFetch(body) {
  const res = await withTimeout(fetch(FALLBACK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Ensure CORS on the function side allows extension origins
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
    mode: "cors"
  }), REQ_TIMEOUT_MS, "fallback");
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`fallback_http_${res.status}:${txt.slice(0, 180)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (data?.safety?.blocked) throw new Error(`fallback_safety_blocked:${data.safety.reason || "unspecified"}`);
  return data;
}

// ----------------------------
// Public APIs
// ----------------------------

/**
 * Check if the local Prompt API is available and ready to use.
 * @returns {Promise<{available: boolean, status: string, needsUserActivation: boolean}>}
 */
export async function checkModelAvailability() {
  try {
    if (!globalThis.LanguageModel?.availability) {
      return { available: false, status: "unavailable", needsUserActivation: false };
    }
    
    const options = {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    };
    
    const status = await globalThis.LanguageModel.availability(options);
    
    return {
      available: status === "available" || status === "downloading" || status === "downloadable",
      status,
      needsUserActivation: status === "downloadable"
    };
  } catch (error) {
    console.warn("[PromptAPI] Availability check failed:", error);
    return { available: false, status: "unavailable", needsUserActivation: false };
  }
}

export async function labelGroups({ groups = [], tabs = [] } = {}) {
  const meta = groups.map(g => ({
    tabTitles: (g.tabIds || []).map(id => titleOf(tabs, id)).filter(Boolean).slice(0, 8),
    sampleHost: sampleHostOf(tabs, g.tabIds || [])
  }));

  const prompt = [
    "You are CLARITY AI. Create concise human-readable labels (1–3 words) and 1-sentence summaries for user intent clusters.",
    "Avoid brand overfit; prefer generic intent labels like 'Trip Planning', 'React Auth', 'Laptop Shopping'.",
    "",
    "Clusters:",
    ...meta.map((m, i) => `#${i + 1} Titles: ${m.tabTitles.join(" | ")} ${m.sampleHost ? `(host: ${m.sampleHost})` : ""}`),
    "",
    "Respond as JSON with fields { labels: string[], summaries: string[] } only."
  ].join("\n");

  if (hasLocalTextAPI()) {
    try {
      const out = await localPrompt(prompt);
      return parseJsonObject(out, { labels: [], summaries: [] });
    } catch (e) {
      // fall through to fallback
    }
  }
  // FALLBACK DISABLED - Uncomment to enable Firebase fallback
  // try {
  //   const fb = await fallbackFetch({
  //     task: "label",
  //     language: "en",
  //     groups: meta
  //   });
  //   return { labels: fb.labels || [], summaries: fb.summaries || [] };
  // } catch {
  //   // Swallow fallback errors gracefully
  //   return { labels: [], summaries: [] };
  // }
  return { labels: [], summaries: [] };
}

export async function summarizeGroups({ groups = [], tabs = [] } = {}) {
  const meta = groups.map(g => ({
    label: g.label || "",
    tabTitles: (g.tabIds || []).map(id => titleOf(tabs, id)).filter(Boolean).slice(0, 8)
  }));
  const prompt = [
    "Summarize each group as a 1-sentence overview plus 3 short bullets.",
    "Use only the titles below. No speculation.",
    "",
    JSON.stringify({ groups: meta })
  ].join("\n");

  if (hasLocalTextAPI()) {
    try {
      const out = await localPrompt(prompt);
      return parseJsonObject(out, { summaries: [] });
    } catch {}
  }
  // FALLBACK DISABLED - Uncomment to enable Firebase fallback
  // try {
  //   const fb = await fallbackFetch({
  //     task: "summary",
  //     language: "en",
  //     groups: meta
  //   });
  //   return { summaries: fb.summaries || [] };
  // } catch {
  //   return { summaries: [] };
  // }
  return { summaries: [] };
}

export async function connectionHints({ active, others = [] } = {}) {
  const meta = {
    active: {
      label: active?.label || "",
      summary: active?.summary || "",
      tabTitles: (active?.tabIds || []).slice(0, 8).map(id => id + "") // placeholders if needed
    },
    others: others.slice(0, 4).map(g => ({
      label: g.label || "",
      summary: g.summary || ""
    }))
  };

  const prompt = [
    "Given an active group and other groups, explain how they connect in 1–2 bullets and propose 2 next steps.",
    "Keep suggestions generic (search terms, consolidate tabs, compare sources).",
    "",
    JSON.stringify(meta)
  ].join("\n");

  if (hasLocalTextAPI()) {
    try {
      const text = await localPrompt(prompt);
      const suggestions = extractSuggestions(text);
      return { text, suggestions };
    } catch {}
  }
  // FALLBACK DISABLED - Uncomment to enable Firebase fallback
  // try {
  //   const fb = await fallbackFetch({
  //     task: "connections",
  //     language: "en",
  //     context: meta
  //   });
  //   return { text: fb.text || "", suggestions: fb.suggestions || [] };
  // } catch {
  //   return { text: "", suggestions: [] };
  // }
  return { text: "", suggestions: [] };
}

export async function chatReply({ userText = "", context = {} } = {}) {
  const titles = (context?.titles || []).slice(0, 20);
  const hosts = (context?.hosts || []).slice(0, 10);
  const snippets = Array.isArray(context?.summaries) ? context.summaries.slice(0, 6) : [];

  const sys = [
    "You are CLARITY AI, a browser assistant analyzing open tabs.",
    "STRICT RULE: Base responses ONLY on provided tab context (titles, hosts, content snippets). Never use external knowledge.",
    "Respond concisely (1–3 sentences). Do NOT include 'Next Steps', suggestions, advice, or questions.",
    "Focus on synthesizing the provided content: connections, main theme, and key overlaps.",
    "If context is insufficient, reply exactly: 'Insufficient context.'"
  ].join(" ");

  const lines = [];
  lines.push(`System: ${sys}`);
  lines.push("Open tabs (titles and hosts):");
  lines.push(JSON.stringify({ titles, hosts }, null, 2));

  if (snippets.length) {
    lines.push("");
    lines.push("Saved snippets:");
    for (const it of snippets) {
      const host = it.url ? hostOf(it.url) : "";
      lines.push(`- ${it.title}${host ? ` (${host})` : ""}: ${String(it.summary || "").slice(0, 420)}`);
    }
  }

  lines.push("");
  lines.push(`User: ${userText}`);
  lines.push("Assistant:");

  const prompt = lines.join("\n");

  if (hasLocalTextAPI()) {
    try {
      const text = await localPrompt(prompt);
      return { text: cleanAssistantText(text) };
    } catch {}
  }

  // Graceful fallback (no cloud call)
  const first = titles?.[0] || "your topic";
  const hostList = hosts && hosts.length ? ` Hosts include: ${hosts.slice(0,3).join(", ")}.` : "";
  return { text: `Open tabs focus on “${first}”.${hostList}` };
}

export function transcribeFromMic() {
  // Use Web Speech API as default for Chrome stable
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return reject(new Error("SpeechRecognition API not available"));
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      const tx = e.results?.[0]?.[0]?.transcript || "";
      resolve(tx);
    };
    rec.onerror = (e) => reject(new Error(e?.error || "speech_error"));
    rec.onend = () => {};
    try {
      rec.start();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Summarize tab content in chunks and merge to a concise paragraph.
 * @param {string[]|object} chunksOrObj - Array of text chunks, or { title, host, excerpt, segments }
 * @param {{targetTokens?: number, title?: string, host?: string}} options
 * @returns {Promise<string>}
 */

/**
 * Compress multiple per-tab summaries into a single narrative under targetTokens.
 * @param {string[]} summaries
 * @param {number} targetTokens
 * @returns {Promise<string>}
 */

// ----------------------------
// Helpers
// ----------------------------

function urlFromString(str) {
 if (typeof str === "string" && str && /^https?:/i.test(str)) {
   try { return new URL(str); } catch { return null; }
 }
 return null;
}
function titleOf(tabs = [], id) {
  const t = tabs.find(x => x.id === id);
  return (t?.title || "").trim();
}

function sampleHostOf(tabs = [], ids = []) {
  for (const id of ids) {
    const t = tabs.find(x => x.id === id);
    if (t?.url) {
      const h = hostOf(t.url);
      if (h) return h.replace(/^www\./, "");
    }
  }
  return "";
}

function parseJsonObject(text, fallback) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const obj = JSON.parse(text.slice(start, end + 1));
      return obj;
    }
  } catch {}
  return fallback;
}

function extractSuggestions(text = "") {
  // Very simple parser: look for lines starting with '-' or numbered lists and map to generic actions
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const label = line.replace(/^([-*]|\d+\.)\s+/, "");
      out.push({ label, action: "search", payload: { q: label.replace(/^(Next step:)\s*/i, "") } });
    }
  }
  return out.slice(0, 5);
}

function cleanAssistantText(s = "") {
  // Remove any accidental JSON wrappers
  if (s.trim().startsWith("{")) {
    const obj = parseJsonObject(s, null);
    if (obj?.text) return String(obj.text);
  }
  return s.trim();
}

function pruneContext(ctx = {}) {
  // Remove anything heavy; keep only labels, summaries, and short title arrays
  const active = ctx.active ? {
    id: ctx.active.id,
    label: (ctx.active.label || "").slice(0, 80),
    summary: (ctx.active.summary || "").slice(0, 280),
    tabTitles: (ctx.active.tabTitles || []).slice(0, 8).map(s => (s || "").slice(0, 100))
  } : null;
  const others = Array.isArray(ctx.others) ? ctx.others.slice(0, 4).map(g => ({
    id: g.id,
    label: (g.label || "").slice(0, 80),
    summary: (g.summary || "").slice(0, 200)
  })) : [];
  return { active, others };
}

// Optional: clean up session when panel unloads
if (typeof window !== "undefined") {
  window.addEventListener("unload", () => {
    try { textSession?.close?.(); } catch {}
    textSession = null;
  });
}