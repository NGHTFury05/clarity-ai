// CLARITY AI - Side Panel (Chat-first MVP)
// Requirements from feedback:
// - Make chat the main content; remove separate Groups/Summary/Connections sections
// - Use Chrome built-in Prompt API (local model) for summaries and chat
// - Add buttons for "Summarize open tabs" and "Suggest next steps" (suggestions via Google Writer API if configured; otherwise local fallback)
// - Ask for microphone permission explicitly via a button and before recording
//
// Notes:
// - Shortcut cannot directly open the side panel (Chrome policy). Use toolbar icon or context menu entry.
// - Voice uses Web Speech API by default; we request getUserMedia first to ensure permission dialog.

let AI = null;
let STATE = {
  tabs: [],
  groups: [],
  assignments: {},
  settings: {},
  summarizer: { available: false, reason: "not_checked", checkedAt: 0 },
  extractions: {},
  tabSummaries: {},
  groupSummaries: {},
  contextEntries: [],
  contextOverview: ""
};

const CAPTURE_OPTIONS = {
  maxSegments: 8,
  segmentCharLimit: 700,
  minSegmentCharLength: 120,
  includeExcerpt: true
};

const MAX_CONTEXT_ENTRIES = 6;
const GROUP_REFRESH_DELAY_MS = 900;


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OPTIONAL_AI_PERMS = { permissions: ["ai"] };

document.addEventListener("DOMContentLoaded", async () => {
  wireUi();
  updateGroupToggleUi();
  await tryLoadAiClient();
  await refreshState();
  wireRuntimeListeners();
  // DISABLED: ensureSummarizerStatus() - Using Prompt API instead of chrome.ai.summarizer
  // await ensureSummarizerStatus({ force: false });
  diagnostics();
});

// ----------------------------
// Load AI client
// ----------------------------
async function tryLoadAiClient() {
  try {
    AI = await import("../src/shared/ai-client.js");
  } catch (e) {
    AI = null;
    msg("assistant", "Local AI client not available in this build. I will use simple heuristics.");
  }
}

// ----------------------------
// UI wiring
// ----------------------------
function wireUi() {
  // Chat
  $("#chatForm")?.addEventListener("submit", onChatSubmit);
  $("#micBtn")?.addEventListener("click", onMicClick);

  // Group toggle
  $("#groupToggleBtn")?.addEventListener("click", onGroupToggleClick);
  $("#addContextBtn")?.addEventListener("click", onAddContextClick);

  // Attach Material ripple haptics (and optional vibration) to interactive controls
  ["#micBtn", "#groupToggleBtn", "#addContextBtn", "#sendBtn", "#summarizeBtn"].forEach((sel) => {
    const el = document.querySelector(sel);
    attachRipple(el);
  });
}

async function onGroupToggleClick() {
  const button = $("#groupToggleBtn");
  if (button?.disabled) return;
  if (button) button.disabled = true;

  status("Grouping tabs with AI…");
  try {
    // Always trigger grouping via background (no ungroup toggle)
    const res = await sendMessage({
      type: "regroupByIntent",
      scope: "current-window",
      overwrite: "ungroup-first",
      maxGroups: 6
    });
    if (!res?.ok) throw new Error(res?.error || "group_failed");
    msg("assistant", "Tabs grouped by intent. Ask me about any group.");
  } catch (e) {
    msg("assistant", `Group error: ${e?.message || e}`);
  } finally {
    await sleep(GROUP_REFRESH_DELAY_MS);
    try {
      await refreshState();
    } catch (refreshError) {
      console.warn("[CLARITY PANEL] refreshState after group action failed:", refreshError);
    }
    status("");
    updateGroupToggleUi();
    if (button) button.disabled = false;
  }
}

async function onAddContextClick() {
  status("Adding active tab to context...");
  try {
    const ctx = await fetchActiveContext();
    const tabId = typeof ctx.tabId === "number" ? ctx.tabId : null;
    if (tabId === null) throw new Error("no_active_tab");

    let extraction = null;
    if (!ctx.hasExtraction) {
      const capture = await sendMessage({ type: "captureActiveTabContext", options: CAPTURE_OPTIONS });
      if (!capture?.ok || !capture.data?.extraction) {
        throw new Error(capture?.error || "capture_failed");
      }
      extraction = capture.data.extraction;
      storeExtraction(tabId, extraction);
    }

    const summary = await ensureTabSummary(tabId, extraction);
    if (!summary) throw new Error("summary_unavailable");

    addContextEntry({
      tabId,
      title: ctx.title || `Tab ${tabId}`,
      url: ctx.url || "",
      summary
    });

    await rebuildContextOverview();
    msg("assistant", `Added “${(ctx.title || "Current tab").slice(0, 120)}” to context.`);
  } catch (e) {
    msg("assistant", `Context error: ${e?.message || e}`);
  } finally {
    status("");
  }
}

async function onCaptureClick() {
  status("Capturing page context…");
  try {
    const res = await sendMessage({ type: "captureActiveTabContext", options: CAPTURE_OPTIONS });
    if (!res?.ok) throw new Error(res?.error || "capture_failed");
    const payload = res.data || {};
    const { tabId, url, extraction } = payload;
    if (typeof tabId !== "number" || !extraction) {
      throw new Error("capture_payload_invalid");
    }
    storeExtraction(tabId, extraction);
    const summaryText = await ensureTabSummary(tabId, extraction);
    await refreshState();
    const tab = getTabById(tabId);
    const displayTitle = extraction.title || tab?.title || safeHostOf(url || extraction.sourceUrl || "") || "Captured page";
    const renderedSummary = summaryText ? `\n${truncateText(summaryText, 360)}` : "";
    msg("assistant", `Captured context for “${displayTitle}”.${renderedSummary}`);
  } catch (e) {
    msg("assistant", `Capture error: ${e?.message || e}`);
  } finally {
    status("");
  }
}

function hasActiveGroups() {
  return Array.isArray(STATE.groups) && STATE.groups.some(g => (g?.tabIds?.length || 0) > 0);
}

function updateGroupToggleUi() {
  const button = $("#groupToggleBtn");
  if (!button) return;
  // Single-action UX: always present as "Group"
  button.textContent = "Group";
  button.title = "Group tabs by intent with AI";
  button.dataset.mode = "idle";
}

async function handleRegroupAction() {
  status("Regrouping tabs by intent…");
  try {
    const res = await sendMessage({
      type: "regroupByIntent",
      scope: "current-window",
      overwrite: "ungroup-first",
      maxGroups: 6
    });
    if (res?.ok) {
      msg("assistant", "Tabs regrouped by intent in the current window.");
    } else {
      msg("assistant", `Regroup failed${res?.error ? `: ${res.error}` : ""}`);
    }
  } catch (e) {
    msg("assistant", `Regroup error: ${e?.message || e}`);
  } finally {
    await refreshState();
    status("");
  }
}

async function fetchActiveContext() {
  const res = await sendMessage({ type: "getActiveContext" });
  if (res?.ok) return res.data || {};
  throw new Error(res?.error || "active_context_unavailable");
}

async function onGroupMetaSummary() {
  status("Synthesizing group summary…");
  try {
    const ctx = await fetchActiveContext();
    const groupId = ctx?.groupId;
    if (typeof groupId !== "number") {
      msg("assistant", "Capture a tab first so I know which intent group to summarize.");
      return;
    }
    await refreshState();
    const group = STATE.groups.find(g => g.id === groupId);
    if (!group) {
      msg("assistant", "Active group metadata is not available yet. Try regrouping or refreshing.");
      return;
    }
    const tabs = Array.isArray(group.tabIds) ? group.tabIds : [];
    const collected = [];
    for (const tabId of tabs) {
      await ensureTabSummary(tabId);
      const summaryEntry = STATE.tabSummaries[String(tabId)];
      if (summaryEntry?.summary) {
        const tab = getTabById(tabId);
        collected.push({
          tabId,
          title: (tab?.title || `Tab ${tabId}`).slice(0, 160),
          summary: summaryEntry.summary
        });
      }
    }
    if (!collected.length) {
      msg("assistant", "Capture at least one tab in this group before requesting a meta summary.");
      return;
    }
    const summaryText = await ensureGroupSummary(groupId, {
      label: group.label || "",
      baseSummary: group.summary || "",
      tabs: collected
    });
    if (summaryText) {
      msg("assistant", `Group summary for “${group.label || "current intent"}”:\n${summaryText}`);
    } else {
      msg("assistant", "Unable to compose a group summary at the moment.");
    }
  } catch (e) {
    msg("assistant", `Group summary error: ${e?.message || e}`);
  } finally {
    status("");
  }
}

function storeExtraction(tabId, extraction) {
  if (typeof tabId !== "number" || !extraction) return;
  const key = String(tabId);
  STATE.extractions[key] = {
    data: extraction,
    signature: makeTabSignature(extraction),
    capturedAt: extraction.capturedAt || Date.now()
  };
}


async function ensureTabSummary(tabId, extraction) {
  if (typeof tabId !== "number") return null;
  const key = String(tabId);
  const source = extraction || STATE.extractions[key]?.data;
  if (!source) return null;

  const signature = makeTabSignature(source);
  const cached = STATE.tabSummaries[key];
  if (cached && cached.signature === signature && cached.summary) {
    return cached.summary;
  }

  // ≤420 char summary from excerpt or first segment only (manual capture path)
  const fallback = truncateText(
    (source.excerpt || (Array.isArray(source.segments) ? source.segments[0] : "") || "").trim(),
    420
  );
  STATE.tabSummaries[key] = {
    summary: fallback,
    signature,
    tokenBudget: 0,
    strategy: "fallback-420",
    updatedAt: Date.now(),
    sourceUrl: source.sourceUrl || ""
  };
  return fallback;
}

async function ensureGroupSummary(groupId, descriptor = {}) {
  const label = descriptor.label || "";
  const baseSummary = descriptor.baseSummary || "";
  const tabs = Array.isArray(descriptor.tabs) ? descriptor.tabs : [];
  const key = String(groupId);
  const signature = makeGroupSignature(label, tabs, baseSummary);
  const cached = STATE.groupSummaries[key];
  if (cached && cached.signature === signature) {
    return cached.summary;
  }
  let summaryText = "";
  if (AI?.summarizeGroupContext && tabs.length) {
    try {
      summaryText = await AI.summarizeGroupContext({
        label,
        baseSummary,
        tabs
      });
    } catch (error) {
      console.warn("[CLARITY PANEL] summarizeGroupContext failed:", error);
    }
  }
  if (!summaryText) {
    const bullets = tabs.slice(0, 5).map(t => `- ${t.title}`).join("\n");
    summaryText = [baseSummary, bullets].filter(Boolean).join("\n").trim();
  }
  summaryText = truncateText((summaryText || "").trim(), 600);
  STATE.groupSummaries[key] = {
    summary: summaryText,
    signature,
    updatedAt: Date.now()
  };
  return summaryText;
}

function pruneCaches() {
  // Remove stale context entries whose tabs vanished
  if (Array.isArray(STATE.contextEntries) && STATE.contextEntries.length) {
    const liveTabIds = new Set(STATE.tabs.map((t) => t.id));
    STATE.contextEntries = STATE.contextEntries.filter((entry) => !entry.tabId || liveTabIds.has(entry.tabId));
    STATE.contextEntries = cleanContextEntries(STATE.contextEntries);
  } else {
    STATE.contextEntries = [];
  }
  if (!STATE.contextEntries.length) {
    STATE.contextOverview = "";
  }
  const validTabIds = new Set((STATE.tabs || []).map(t => String(t.id)));
  for (const key of Object.keys(STATE.extractions)) {
    if (!validTabIds.has(key)) {
      delete STATE.extractions[key];
    }
  }
  for (const key of Object.keys(STATE.tabSummaries)) {
    if (!validTabIds.has(key)) {
      delete STATE.tabSummaries[key];
    }
  }
  const validGroupIds = new Set((STATE.groups || []).map(g => String(g.id)));
  for (const key of Object.keys(STATE.groupSummaries)) {
    if (!validGroupIds.has(key)) {
      delete STATE.groupSummaries[key];
    }
  }
}

function getTabById(tabId) {
  return STATE.tabs.find(t => t.id === tabId);
}

function makeTabSignature(extraction = {}) {
  if (extraction.signature) return extraction.signature;
  const parts = [
    extraction.title || "",
    extraction.sourceUrl || "",
    ...(Array.isArray(extraction.segments) ? extraction.segments : [])
  ];
  return computeHash(parts.join("|"));
}

function makeGroupSignature(label, tabs = [], baseSummary = "") {
  const parts = [label || "", baseSummary || ""];
  for (const item of tabs) {
    parts.push(`${item.tabId ?? ""}::${item.title || ""}::${item.summary || ""}`);
  }
  return computeHash(parts.join("|"));
}

function truncateText(text, limit = 400) {
  const value = text || "";
  if (value.length <= limit) return value;
  const slice = value.slice(0, limit - 1);
  const boundary = slice.lastIndexOf(" ");
  return `${slice.slice(0, boundary > limit * 0.6 ? boundary : slice.length).trim()}…`;
}

function computeHash(input = "") {
  let hash = 0;
  const value = String(input);
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

// ----------------------------
// State
// ----------------------------
async function refreshState() {
  try {
    const res = await sendMessage({ type: "getState" });
    if (res?.ok) {
      const data = res.data || {};
      STATE.tabs = data.tabs || [];
      STATE.groups = data.groups || [];
      STATE.assignments = data.assignments || {};
      STATE.settings = data.settings || {};
      STATE.summarizer = data.summarizer || STATE.summarizer;
      pruneCaches();
      updateGroupToggleUi();
      updateSummarizerUi();
    }
  } catch (e) {
    status(`Failed to refresh: ${e?.message || e}`);
  }
}

function wireRuntimeListeners() {
  try {
    chrome.runtime.onMessage.addListener(async (message) => {
      if (message?.type === "clarity-summarizer-status" && message.payload) {
        STATE.summarizer = message.payload;
        updateSummarizerUi();
        return;
      }
      if (message?.type === "state-updated" && message.payload) {
        const data = message.payload;
        STATE.groups = data.groups || [];
        STATE.assignments = data.assignments || {};
        STATE.tabs = data.tabs || [];
        STATE.settings = data.settings || STATE.settings;
        pruneCaches();
        updateGroupToggleUi();
        return;
      }

      // Overtab SR path: receive UI-forwarded messages from background/content
      if (message?.action === "showLoading") {
        status("Thinking…");
        if (typeof message.sourceText === "string" && message.sourceText.trim()) {
          // Echo the question in chat for continuity (e.g., Q: "...")
          msg("user", message.sourceText);
        }
        return;
      }
      if (message?.action === "showResult") {
        const text = typeof message.result === "string" ? message.result : "";
        if (text) {
          msg("assistant", text);
        }
        status("");
        const mic = $("#micBtn");
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
        return;
      }
      if (message?.action === "showError") {
        const err = message.error || "Voice processing failed.";
        msg("assistant", `Error: ${err}`);
        status("");
        const mic = $("#micBtn");
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
        return;
      }
    });
  } catch (e) {
    console.warn("Failed to wire runtime listeners", e);
  }
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

// ----------------------------
// Actions
// ----------------------------
async function onChatSubmit(ev) {
  ev.preventDefault();
  const input = $("#chatText");
  const text = (input.value || "").trim();
  if (!text) return;
  input.value = "";
  msg("user", text);
  status("Thinking…");

  const ctx = await contextFromTabs(STATE.tabs);
  try {
    if (AI?.chatReply) {
      const res = await AI.chatReply({ userText: text, context: ctx });
      msg("assistant", res?.text || "(No answer)");
    } else {
      msg("assistant", heuristicChat(text, ctx));
    }
  } catch (e) {
    msg("assistant", `Error: ${e?.message || e}`);
  } finally {
    status("");
  }
}

async function onSummarizeClick() {
  // UPDATED: Using Prompt API (LanguageModel) instead of chrome.ai.summarizer
  // No permissions needed for Prompt API
  status("Summarizing open tabs…");
  try {
    if (AI?.summarizeOpenTabs) {
      const text = await AI.summarizeOpenTabs(STATE.tabs);
      msg("assistant", text || "I couldn't produce a summary.");
    } else {
      msg("assistant", heuristicSummary(STATE.tabs));
    }
  } catch (e) {
    msg("assistant", `Summary error: ${e?.message || e}`);
  } finally {
    status("");
  }
}

async function onSuggestClick() {
  status("Generating suggestions…");
  try {
    if (AI?.suggestNextSteps) {
      const text = await AI.suggestNextSteps(STATE.tabs);
      msg("assistant", text || "I couldn't produce suggestions.");
    } else {
      msg("assistant", heuristicSuggestions(STATE.tabs));
    }
  } catch (e) {
    msg("assistant", `Suggest error: ${e?.message || e}`);
  } finally {
    status("");
  }
}

async function onMicPermissionClick() {
  try {
    await ensureMicPermission(true);
    msg("assistant", "Microphone permission granted. You can now use voice input (🎤).");
  } catch (e) {
    msg("assistant", "Microphone permission denied. Voice input will not work until permission is granted.");
  }
}

async function onMicClick() {
  // Overtab SR path: trigger SR in page content script and route results via background
  const mic = $("#micBtn");
  if (mic?.classList.contains("recording")) return;

  mic?.classList.add("recording");
  if (mic) mic.disabled = true;

  try {
    // Ensure the side panel is open (trusted user gesture)
    try { chrome.runtime.sendMessage({ action: "openSidebar" }); } catch {}
    status("Listening…");

    // Find active tab and ensure content scripts are present
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        status("Voice failed to start.");
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
        return;
      }
      const tab = tabs && tabs[0];
      const tabId = tab && tab.id;
      const url = tab && tab.url;
      if (!tabId || !url || !/^https?:/i.test(url)) {
        status("Voice not supported on this page.");
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
        return;
      }

      try {
        // Inject content scripts if needed (works when not pre-injected)
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["src/content/readability.js", "src/content/content.js"]
          });
        } catch (_) {
          // ignore injection errors (may already be present)
        }

        // Kick off Overtab-style SR in content
        chrome.tabs.sendMessage(tabId, { action: "startVoiceCapture" }, () => {
          // We don't rely on a response; UI updates come via runtime messages (showLoading/showResult/showError)
          // Swallow any errors (content script will likely still run if already present)
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            // If sending failed, notify and reset UI
            status("Unable to start voice on this page.");
            mic?.classList.remove("recording");
            if (mic) mic.disabled = false;
          }
        });
      } catch {
        status("Unable to start voice on this page.");
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
      }
    });
  } catch (_) {
    status("Voice failed to start.");
    mic?.classList.remove("recording");
    if (mic) mic.disabled = false;
  }
}

// ----------------------------
// AI helpers and fallbacks
// ----------------------------
async function ensureSummarizerStatus(options = {}) {
  // DISABLED: chrome.ai.summarizer requires invalid 'ai' permission
  // Using Prompt API (LanguageModel) instead - no permissions needed
  const status = { available: false, reason: "disabled_using_prompt_api", checkedAt: Date.now() };
  STATE.summarizer = status;
  updateSummarizerUi();
  return status;
}

async function ensureSummarizerPermission(prompt = false) {
  // DISABLED: 'ai' permission doesn't exist - using Prompt API instead
  return { granted: false, reason: "disabled_using_prompt_api" };
}

async function checkSummarizerPermission() {
  // DISABLED: 'ai' permission doesn't exist - using Prompt API instead
  return { granted: false, reason: "disabled_using_prompt_api" };
}

function summarizerUnavailableText(status) {
  const reason = status?.reason || "unknown";
  if (reason === "permission_missing") {
    return "I need Chrome's experimental AI permission to use the on-device Summarizer. Accept the permission prompt to enable richer summaries.";
  }
  if (reason === "permissions_api_unavailable") {
    return "This Chrome build does not expose the permission request APIs needed for the Summarizer. I will stick to heuristic summaries here.";
  }
  if (reason === "user_denied") {
    return "Without the AI permission I can only provide heuristic summaries. Re-run the summarize action if you change your mind.";
  }
  if (reason === "device_incompatible") {
    return "This device does not meet the requirements for the on-device Summarizer. I'll keep using chat responses and metadata summaries.";
  }
  if (reason.startsWith("download")) {
    return "The on-device Summarizer model is still downloading. I'll use metadata-only heuristics until it finishes.";
  }
  if (reason.includes("unsupported")) {
    return "Summarizer API is unsupported on this device. I'll keep using tab titles and hosts for summaries.";
  }
  if (reason.startsWith("error")) {
    return `Summarizer check failed (${reason}). I'll retry shortly and fall back to heuristics meanwhile.`;
  }
  if (reason === "api_missing") {
    return "Summarizer API not detected. Ensure chrome://flags/#prompt-api-for-gemini-nano is enabled and the model is installed.";
  }
  return `Summarizer currently unavailable (${reason}). Falling back to heuristic summaries.`;
}

function updateSummarizerUi() {
  const badge = $("#summarizeBtn");
  if (!badge) return;
  const available = !!STATE?.summarizer?.available;
  const reason = STATE?.summarizer?.reason || "unknown";
  const permissionOk = reason !== "permission_missing" && reason !== "permissions_api_unavailable" && reason !== "user_denied";
  badge.disabled = (!available && !AI?.summarizeOpenTabs) || !permissionOk;
  badge.dataset.status = available ? "ready" : "degraded";
  badge.dataset.reason = reason;
  badge.title = available
    ? "Summarize open tabs with on-device model"
    : summarizerUnavailableText(STATE.summarizer);
}

async function contextFromTabs(tabs = []) {
  const titles = tabs.map(t => (t?.title || "").trim()).filter(Boolean);
  const hosts = Array.from(new Set(tabs.map(t => safeHostOf(t?.url || "")))).filter(Boolean);

  const contextEntries = getContextEntriesSnapshot();
  const summaries = contextEntries.slice(0, 6).map(e => ({
    title: e.title,
    summary: truncateText(e.summary, 360),
    url: e.url
  }));

  return {
    titles: titles.slice(0, 20),
    hosts: hosts.slice(0, 10),
    summaries
  };
}

/**
 * Stage 2: Build "summary of summaries" bundle for chat context.
 * - Collect per-tab summaries within the provided scope.
 * - If combined tokens exceed budget, compress via AI.summaryOfSummaries.
 * - Else, concatenate with brief headers (title + host).
 * - Cache by scope key and underlying summary signatures.
 */

function getContextEntriesSnapshot() {
  STATE.contextEntries = cleanContextEntries(STATE.contextEntries);
  return STATE.contextEntries.map((entry, idx) => ({
    tabId: entry.tabId,
    title: entry.title,
    summary: truncateText(entry.summary, 360),
    url: entry.url,
    addedAt: entry.addedAt,
    index: idx + 1
  }));
}

function addContextEntry(entry = {}) {
  if (!entry || typeof entry.summary !== "string" || !entry.summary.trim()) {
    throw new Error("context_entry_invalid");
  }

  const normalized = {
    tabId: typeof entry.tabId === "number" ? entry.tabId : null,
    title: (entry.title || "").trim(),
    url: entry.url || "",
    summary: entry.summary.trim(),
    addedAt: typeof entry.addedAt === "number" ? entry.addedAt : Date.now()
  };

  if (!normalized.title) {
    normalized.title = normalized.url ? safeHostOf(normalized.url) || "Untitled tab" : "Untitled tab";
  }

  const combined = [normalized, ...(Array.isArray(STATE.contextEntries) ? STATE.contextEntries : [])];
  STATE.contextEntries = cleanContextEntries(combined);

  if (!STATE.contextEntries.length) {
    STATE.contextOverview = "";
  }

  return normalized;
}

function cleanContextEntries(entries = []) {
  if (!Array.isArray(entries)) return [];
  const result = [];
  const seenTabs = new Set();
  const seenUrls = new Set();

  for (const raw of entries) {
    if (!raw || typeof raw.summary !== "string") continue;

    const normalized = {
      tabId: typeof raw.tabId === "number" ? raw.tabId : null,
      title: (raw.title || "").trim(),
      url: raw.url || "",
      summary: raw.summary.trim(),
      addedAt: typeof raw.addedAt === "number" ? raw.addedAt : Date.now()
    };

    if (!normalized.summary) continue;
    if (!normalized.title) {
      normalized.title = normalized.url ? safeHostOf(normalized.url) || "Untitled tab" : "Untitled tab";
    }

    const tabKey = normalized.tabId;
    const urlKey = normalized.url ? normalized.url.split("#")[0].toLowerCase() : null;

    if (tabKey !== null) {
      if (seenTabs.has(tabKey)) continue;
      seenTabs.add(tabKey);
    } else if (urlKey) {
      if (seenUrls.has(urlKey)) continue;
      seenUrls.add(urlKey);
    }

    result.push(normalized);
    if (result.length >= MAX_CONTEXT_ENTRIES) break;
  }

  return result;
}

async function rebuildContextOverview() {
  STATE.contextEntries = cleanContextEntries(STATE.contextEntries);
  if (!STATE.contextEntries.length) {
    STATE.contextOverview = "";
    return "";
  }

  let overview = "";
  try {
    overview = await synthesizeContextOverview(STATE.contextEntries);
  } catch (error) {
    console.warn("[CLARITY PANEL] synthesizeContextOverview failed:", error);
  }

  if (!overview) {
    overview = fallbackContextOverview(STATE.contextEntries);
  }

  overview = truncateText((overview || "").trim(), 900);
  STATE.contextOverview = overview;
  return overview;
}

async function synthesizeContextOverview(entries = []) {
  if (!entries.length) return "";

  if (AI?.summarizeGroupContext) {
    try {
      const summary = await AI.summarizeGroupContext({
        label: "Context bundle",
        baseSummary: "",
        tabs: entries.map((entry, idx) => ({
          tabId: entry.tabId ?? idx,
          title: entry.title,
          summary: truncateText(entry.summary, 420)
        }))
      });
      if (summary) return summary.trim();
    } catch (error) {
      console.warn("[CLARITY PANEL] summarizeGroupContext failed for context overview:", error);
    }
  }

  if (AI?.summarizeOpenTabs) {
    try {
      const summary = await AI.summarizeOpenTabs(entries.map(entry => ({
        title: entry.title,
        url: entry.url
      })));
      if (summary) return summary.trim();
    } catch (error) {
      console.warn("[CLARITY PANEL] summarizeOpenTabs fallback failed for context overview:", error);
    }
  }

  if (AI?.chatReply) {
    try {
      const response = await AI.chatReply({
        userText: "Summarize the saved context entries for a quick recap.",
        context: {
          titles: entries.map(entry => entry.title),
          hosts: entries.map(entry => safeHostOf(entry.url || "")).filter(Boolean),
          summaries: entries.slice(0, 6).map(entry => ({
            title: entry.title,
            summary: truncateText(entry.summary, 220)
          }))
        }
      });
      if (response?.text) return response.text.trim();
    } catch (error) {
      console.warn("[CLARITY PANEL] chatReply fallback failed for context overview:", error);
    }
  }

  return "";
}

function fallbackContextOverview(entries = []) {
  if (!entries.length) return "";
  const lines = entries.map((entry, idx) => {
    const label = entry.title || `Context item ${idx + 1}`;
    const summary = truncateText(entry.summary, 200);
    const host = safeHostOf(entry.url || "");
    const suffix = host ? ` (${host})` : "";
    return `• ${label}${suffix}: ${summary}`;
  });
  return `Context recap:\n${lines.join("\n")}`;
}

function heuristicChat(text, ctx) {
  const key = (ctx?.titles?.[0] || "your topic");
  if (/what|summary|overview/i.test(text)) {
    return `You're exploring ${key}. Open tabs indicate multiple sources; skim top 2–3 and close the rest.`;
  }
  if (/next|how|proceed|plan/i.test(text)) {
    return `Try this plan: 1) Skim best sources. 2) Compare 2 options. 3) Decide and bookmark. Ask me to "summarize open tabs" if needed.`;
  }
  return `Ask "summarize open tabs" or "suggest next steps" to proceed.`;
}

function heuristicSummary(tabs) {
  const n = tabs.length;
  const hosts = Array.from(new Set(tabs.map(t => safeHostOf(t.url)).filter(Boolean))).slice(0, 5).join(", ");
  return `You have ${n} open tabs. Hosts include: ${hosts || "various sources"}. Focus on the most relevant items and close distractions.`;
}

function heuristicSuggestions(tabs) {
  const first = (tabs?.[0]?.title || "your current topic");
  return [
    `- Skim the top results related to “${first}”.`,
    "- Compare two strongest sources side by side.",
    "- Capture 3 key takeaways and decide next action."
  ].join("\n");
}

// ----------------------------
// Voice (Web Speech API with pre-permission)
// ----------------------------
async function promptMicEnable() {
  // Lightweight consent prompt shown inside a user gesture (click)
  const ok = window.confirm("Enable microphone for voice input? You can change this later in site permissions.");
  return !!ok;
}

async function ensureMicPermission(requireGesture = false) {
  // A direct getUserMedia call prompts for permission (must be in a user gesture for some setups)
  if (!navigator?.mediaDevices?.getUserMedia) throw new Error("getUserMedia_unavailable");
  if (requireGesture) {
    // Just call it; the user gesture is the click that triggered us
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const tr of stream.getTracks()) tr.stop();
}

// Permission state checker (Permissions API)
async function checkMicPermissionState() {
  try {
    if (navigator?.permissions?.query) {
      const s = await navigator.permissions.query({ name: "microphone" });
      return s?.state ?? "unknown"; // "granted" | "denied" | "prompt"
    } else {
      return "unknown";
    }
  } catch (e) {
    return "unknown";
  }
}

// Permission change subscription helper (optional enhancement)
async function subscribeMicPermission(onGranted) {
  try {
    if (!navigator?.permissions?.query) return () => {};
    const ps = await navigator.permissions.query({ name: "microphone" });
    if (!ps) return () => {};
    const handler = () => {
      if (ps.state === "granted") {
        try { onGranted?.(); } catch {}
      }
    };
    if (ps.addEventListener) {
      ps.addEventListener("change", handler);
    } else {
      ps.onchange = handler;
    }
    return () => {
      try {
        if (ps.removeEventListener) ps.removeEventListener("change", handler);
        else if (ps.onchange === handler) ps.onchange = null;
      } catch {}
    };
  } catch {
    return () => {};
  }
}

// Auto-retry helper: poll permission state and auto-start when granted
async function autoRetryMicAfterPermission({ timeoutMs = 10000, intervalMs = 600 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let state = "unknown";
    try {
      state = await checkMicPermissionState();
    } catch (_) {
      state = "unknown";
    }

    if (state === "granted") {
      const mic = $("#micBtn");
      status("Microphone enabled, starting…");
      if (mic && !mic.classList.contains("recording")) mic.classList.add("recording");
      if (mic) mic.disabled = true;

      try {
        // No gesture required now; user already granted via prompt/lock icon
        await ensureMicPermission(false);
      } catch (e) {
        // Unexpected: permission reads granted but capture failed; reset and stop retrying
        status("");
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
        return false;
      }

      // Persist setting
      try {
        await sendMessage({ type: "setSettings", settings: { micAllowed: true } });
      } catch (_) {}

      // Proceed exactly like successful path in onMicClick
      try {
        status("Listening…");
        await startListeningOnce();
      } catch (err) {
        status(`Voice error: ${err?.message || err}`);
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
      }
      return true;
    }

    await sleep(intervalMs);
  }
  return false;
}

async function startListeningOnce() {
  const mic = $("#micBtn");
  const transcript = await transcribeOnce();
  if (transcript) {
    $("#chatText").value = transcript;
    $("#chatForm").dispatchEvent(new Event("submit"));
  } else {
    status("No speech captured.");
  }
  mic?.classList.remove("recording");
  if (mic) mic.disabled = false;
}

// Prefer running SR in the page (content script) when the side panel (extension origin) is blocked
async function transcribeViaContent(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (chrome.runtime.lastError) {
          return reject(new Error("tabs_query_error:" + chrome.runtime.lastError.message));
        }
        const activeTab = tabs && tabs[0];
        const tabId = activeTab && activeTab.id;
        const url = activeTab && activeTab.url;
        if (!tabId) return reject(new Error("no_active_tab"));
        if (!url || !/^https?:/i.test(url)) return reject(new Error("unsupported_url_for_voice"));

        let settled = false;
        const done = (err, tx) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) return reject(err);
          resolve(tx || "");
        };

        // Ensure content scripts are present before messaging (mirrors SW injection path)
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["src/content/readability.js", "src/content/content.js"]
          });
        } catch (_) {
          // ignore; content script may already be present
        }

        const timer = setTimeout(() => done(new Error("content_timeout")), timeoutMs);

        chrome.tabs.sendMessage(tabId, { type: "clarity-start-voice" }, (resp) => {
          if (chrome.runtime.lastError) {
            return done(new Error("content_send_error:" + chrome.runtime.lastError.message));
          }
          if (resp && resp.ok) {
            return done(null, resp.transcript || "");
          } else {
            return done(new Error((resp && resp.error) || "content_error"));
          }
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

function transcribeOnce() {
  if (AI?.transcribeFromMic) return AI.transcribeFromMic();

  // When running from chrome-extension:// origin (side panel), prefer content-script SR to avoid mic blocks
  try {
    if (typeof location !== "undefined" && String(location.protocol || "").startsWith("chrome-extension")) {
      return transcribeViaContent();
    }
  } catch {}

  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      // If SR missing in panel, fallback to content
      transcribeViaContent().then(resolve).catch(reject);
      return;
    }
    let settled = false;

    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      settled = true;
      const tx = e.results?.[0]?.[0]?.transcript || "";
      const mic = $("#micBtn");
      mic?.classList.remove("recording");
      if (mic) mic.disabled = false;
      resolve(tx);
    };
    rec.onerror = (e) => {
      // If extension-origin SR errors with permission/device issues, fallback to content SR
      const errCode = e?.error || "";
      if (!settled && (errCode === "not-allowed" || errCode === "audio-capture")) {
        settled = true;
        transcribeViaContent().then(resolve).catch((fallbackErr) => {
          const mic = $("#micBtn");
          mic?.classList.remove("recording");
          if (mic) mic.disabled = false;
          reject(fallbackErr);
        });
        return;
      }
      settled = true;
      const mic = $("#micBtn");
      mic?.classList.remove("recording");
      if (mic) mic.disabled = false;
      reject(new Error(errCode || "speech_error"));
    };
    rec.onend = () => {
      const mic = $("#micBtn");
      mic?.classList.remove("recording");
      if (mic) mic.disabled = false;
      if (!settled) resolve("");
    };

    try {
      rec.start();
    } catch (e) {
      // If SR start throws (common on blocked extension origin), try content fallback
      transcribeViaContent().then(resolve).catch((fallbackErr) => {
        const mic = $("#micBtn");
        mic?.classList.remove("recording");
        if (mic) mic.disabled = false;
        reject(fallbackErr);
      });
    }
  });
}

// ----------------------------
// Diagnostics (built-in AI availability)
// ----------------------------
function diagnostics() {
  // Detect new Prompt API variants first
  const hasLanguageModel = !!(globalThis?.LanguageModel?.create || self?.ai?.languageModel?.create);
  // Fall back to earlier prototypes
  const hasWindowAI = !!(window?.ai && typeof window.ai.createTextSession === "function");
  const hasChromePrompt = !!(chrome?.ai?.prompt?.create);

  if (!(hasLanguageModel || hasWindowAI || hasChromePrompt)) {
    msg("assistant", "Built-in Prompt API not detected. I will operate with local heuristics. If you expect Chrome's built-in AI, ensure flags are enabled and the on-device model is available. See the help page for setup steps.");
  }
}

// ----------------------------
// Chat UI helpers
// ----------------------------
function msg(role, text) {
  const box = $("#chatHistory");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function status(text) {
  $("#chatStatus").textContent = text || "";
}

// ----------------------------
// UI haptics: Material ripple
// ----------------------------
function attachRipple(el) {
  if (!el) return;
  el.addEventListener("mousedown", (e) => {
    try { navigator.vibrate?.(10); } catch {}
    const rect = el.getBoundingClientRect();
    const span = document.createElement("span");
    span.className = "md-ripple";
    const size = Math.max(rect.width, rect.height);
    span.style.width = span.style.height = size + "px";
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    span.style.left = x + "px";
    span.style.top = y + "px";
    el.appendChild(span);
    span.addEventListener("animationend", () => { span.remove(); }, { once: true });
  });
}

// ----------------------------
// DOM helper
// ----------------------------
function $(sel) { return document.querySelector(sel); }

function urlFromString(str) {
  if (typeof str === "string" && str && /^https?:/i.test(str)) {
    try { return new URL(str); } catch { return null; }
  }
  return null;
}

function safeHostOf(url = "") {
  const u = urlFromString(url);
  return u?.host ? u.host.replace(/^www\./, "") : "";
}

export { addContextEntry, rebuildContextOverview, getContextEntriesSnapshot };