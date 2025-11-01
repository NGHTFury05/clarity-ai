// CLARITY AI - Background Service Worker (MV3, ESM)
// - Tracks tabs, performs debounced intent grouping
// - Generates temporary heuristic labels/summaries (AI client will replace)
// - Evaluates divergence for auto window split
// - Exposes messaging endpoints for the side panel UI
// - Wires keyboard commands and toolbar action to open side panel
//
// Imports are relative to extension root
import { clusterTabs, topDivergence, tokenize } from "../shared/grouping.js";

const LOG_PREFIX = "[CLARITY SW]";
function LOG(...args) {
  try { console.info(LOG_PREFIX, ...args); } catch {}
}

// ----------------------------
// State
// ----------------------------
const STORAGE_KEY = "clarity_state_v1";
const DEFAULT_SETTINGS = {
  autoWindowSplit: false,
  splitThreshold: 0.75,
  fallbackEnabled: true
};

const STATE = {
  tabs: new Map(), // tabId -> { id, title, url, host }
  groups: [],      // [{ id, label, summary, tabIds[], centroid, stats }]
  assignments: {}, // tabId -> groupId
  settings: { ...DEFAULT_SETTINGS },
  lastSplitAt: 0,
  summaryTokens: [],
  lastSummary: "",
  summarizerStatus: { available: false, reason: "not_checked", checkedAt: 0 },
  contentScriptTabs: new Set(),
  extractions: new Map() // tabId -> { url, data, options, capturedAt }
};

// ----------------------------
// Utils
// ----------------------------
function now() { return Date.now(); }

function debounce(fn, delay) {
  let t = 0;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

async function setTemporaryBadge(text, ms = 2000) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: "#2d6cdf" });
    setTimeout(() => { chrome.action.setBadgeText({ text: "" }); }, ms);
  } catch (e) {
    // ignore
  }
}

const CTX_OPEN_ID = "clarity_open_sidepanel";
const CTX_REGROUP_ID = "clarity_regroup_current";
const CTX_UNGROUP_ID = "clarity_ungroup_current";
let CTX_MENUS_READY = false;
let CTX_MENUS_PROMISE = null;

const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];

const SUMMARIZER_CHECK_TTL = 60000;

const EXTRACTION_TTL_MS = 5 * 60 * 1000;
const CONTENT_SCRIPT_FILES = [
  "src/content/readability.js",
  "src/content/content.js"
];

const EXTRACTION_TIMEOUT_MS = 9000;

function isInjectableUrl(url = "") {
  if (!url) return false;
  try {
    return /^https?:/i.test(url);
  } catch {
    return false;
  }
}

function urlFromString(str) {
  if (typeof str === "string" && str && /^https?:/i.test(str)) {
    try {
      return new URL(str);
    } catch {
      return null;
    }
  }
  return null;
}

// ----------------------------
// Local Prompt API (SW context) for AI-driven grouping
// ----------------------------
let swModelSession = null;

function hasLocalTextAPI_SW() {
  try {
    return !!(globalThis?.LanguageModel?.create || self?.ai?.languageModel?.create);
  } catch {
    return false;
  }
}

async function getSWTextSession() {
  if (swModelSession) return swModelSession;
  try {
    if (globalThis?.LanguageModel?.create) {
      const sess = await globalThis.LanguageModel.create({ temperature: 0.2, topK: 32 });
      swModelSession = {
        prompt: async (input) => {
          const res = await sess.prompt(input);
          return typeof res === "string" ? res : String(res ?? "");
        },
        close: () => sess.destroy?.()
      };
      return swModelSession;
    }
  } catch {}
  try {
    if (self?.ai?.languageModel?.create) {
      const sess = await self.ai.languageModel.create({ temperature: 0.2, topK: 32 });
      swModelSession = {
        prompt: async (input) => {
          const res = await sess.prompt(input);
          return typeof res === "string" ? res : String(res ?? "");
        },
        close: () => sess.destroy?.()
      };
      return swModelSession;
    }
  } catch {}
  return null;
}

async function localPromptSW(prompt) {
  const sess = await getSWTextSession();
  if (!sess) throw new Error("local_prompt_unavailable");
  return await sess.prompt(prompt);
}

function parseJsonObjectSW(text) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
  } catch {}
  return null;
}

/**
 * AI clusters tabs by intent and returns [{ label, summary, tabIds }]
 * Uses only titles/hosts/paths; no page content.
 */
async function aiClusterTabsWithTitles(tabsMeta = [], maxGroups = 6) {
  if (!tabsMeta?.length) throw new Error("no_tabs");
  const payload = tabsMeta.slice(0, 60).map(t => {
    const u = urlFromString(t.url || "");
    const host = u?.host || "";
    const path = u?.pathname || "";
    return {
      id: t.id,
      title: (t.title || "").slice(0, 128),
      host,
      path
    };
  });
  const sys = [
    "You are CLARITY AI. Cluster browser tabs by user intent.",
    `Return JSON ONLY: {"groups":[{"label":string,"summary":string,"tabIds":number[]}]}`,
    `Rules: Use at most ${maxGroups} groups. Use only provided tab IDs. Cover as many tabs as sensible.`,
    "Labels must be 1–3 words. Summaries one sentence. Do not invent URLs."
  ].join("\n");
  const prompt = sys + "\nTabs:\n" + JSON.stringify({ tabs: payload }, null, 2);
  const out = await localPromptSW(prompt);
  const obj = parseJsonObjectSW(out);
  if (!obj?.groups || !Array.isArray(obj.groups) || obj.groups.length === 0) throw new Error("ai_group_parse_failed");
  const validIds = new Set(payload.map(p => p.id));
  const groups = [];
  for (const g of obj.groups) {
    if (!g || !Array.isArray(g.tabIds)) continue;
    const tabIds = g.tabIds.filter((id) => validIds.has(id));
    if (!tabIds.length) continue;
    groups.push({
      label: (g.label || "").toString().slice(0, 24) || "Group",
      summary: (g.summary || "").toString().slice(0, 120),
      tabIds
    });
    if (groups.length >= maxGroups) break;
  }
  if (!groups.length) throw new Error("ai_group_empty");
  return groups;
}

function getCachedExtraction(tabId, url) {
  const entry = STATE.extractions.get(tabId);
  if (!entry) return null;
  if (entry.url !== url) {
    STATE.extractions.delete(tabId);
    return null;
  }
  if (now() - entry.capturedAt > EXTRACTION_TTL_MS) {
    STATE.extractions.delete(tabId);
    return null;
  }
  return entry;
}

function cacheExtraction(tabId, url, data, options = {}) {
  const capturedAt = now();
  const entry = { url, data, options, capturedAt };
  STATE.extractions.set(tabId, entry);
  return entry;
}

function invalidateExtraction(tabId) {
  STATE.extractions.delete(tabId);
}



function hasActiveGroups() {
  return Array.isArray(STATE.groups) && STATE.groups.some((g) => (g?.tabIds?.length || 0) > 0);
}

async function toggleGrouping(options = {}) {
  const requestedMode = typeof options.mode === "string" ? options.mode.toLowerCase() : "auto";
  const groupsExist = hasActiveGroups();
  const targetMode =
    requestedMode === "group" || requestedMode === "ungroup"
      ? requestedMode
      : (groupsExist ? "ungroup" : "group");

  if (targetMode === "group") {
    const result = await regroupTabsByIntent({
      scope: options.scope || "current-window",
      overwrite: options.overwrite || "ungroup-first",
      maxGroups: options.maxGroups ?? 6,
      windowId: options.windowId
    });
    return { mode: "group", details: result };
  }

  const windowId = options.windowId ?? await getLastFocusedWindowId();
  const cleared = await ungroupAllTabs(windowId);
  recluster();
  return { mode: "ungroup", details: { cleared } };
}

async function ensureContentScripts(tabId) {
  if (STATE.contentScriptTabs.has(tabId)) return;
  let tabInfo = STATE.tabs.get(tabId);
  if (!tabInfo) {
    try {
      tabInfo = await chrome.tabs.get(tabId);
    } catch {
      tabInfo = null;
    }
  }
  const url = tabInfo?.url || "";
  if (!isInjectableUrl(url)) {
    throw new Error("unsupported_url_for_extraction");
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });
    STATE.contentScriptTabs.add(tabId);
  } catch (error) {
    STATE.contentScriptTabs.delete(tabId);
    throw new Error(`content_script_injection_failed:${error?.message || error}`);
  }
}

async function sendTabMessage(tabId, payload, timeoutMs = EXTRACTION_TIMEOUT_MS) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("tab_message_timeout"));
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || "tab_message_failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function toggleRag(tabId, enabled) {
  const response = await sendTabMessage(tabId, { type: "clarity-toggle-rag", enabled }, 3000);
  if (!response?.ok) {
    throw new Error(response?.error || "rag_toggle_failed");
  }
  return response;
}

async function requestExtraction(tabId, options = {}) {
  const response = await sendTabMessage(tabId, { type: "clarity-rag-extract", options }, EXTRACTION_TIMEOUT_MS);
  if (!response?.ok) {
    throw new Error(response?.error || "extraction_failed");
  }
  return response.data || {};
}

async function captureTabContext(tabId, options = {}) {
  let tabInfo = STATE.tabs.get(tabId);
  if (!tabInfo) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        tabInfo = {
          id: tab.id,
          title: tab.title || "",
          url: tab.url || ""
        };
      }
    } catch {
      tabInfo = null;
    }
  }
  const url = tabInfo?.url || "";
  if (!isInjectableUrl(url)) {
    throw new Error("unsupported_url_for_extraction");
  }

  const cachedEntry = getCachedExtraction(tabId, url);
  if (cachedEntry) {
    const groupId = STATE.assignments?.[tabId];
    const group = typeof groupId === "number" ? STATE.groups.find(g => g.id === groupId) : null;
    return {
      tabId,
      url,
      extraction: cachedEntry.data,
      options: cachedEntry.options,
      groupId: group?.id ?? null,
      groupLabel: group?.label || "",
      groupSummary: group?.summary || "",
      capturedAt: cachedEntry.capturedAt
    };
  }

  await ensureContentScripts(tabId);

  try {
    await toggleRag(tabId, true);
  } catch {
    STATE.contentScriptTabs.delete(tabId);
    await ensureContentScripts(tabId);
    await toggleRag(tabId, true);
  }

  let extraction;
  try {
    extraction = await requestExtraction(tabId, options);
  } catch {
    STATE.contentScriptTabs.delete(tabId);
    await ensureContentScripts(tabId);
    extraction = await requestExtraction(tabId, options);
  }

  const entry = cacheExtraction(tabId, url, extraction, options);
  try { await persistState(); } catch {}

  const groupId = STATE.assignments?.[tabId];
  const group = typeof groupId === "number" ? STATE.groups.find(g => g.id === groupId) : null;
  return {
    tabId,
    url,
    extraction,
    options,
    groupId: group?.id ?? null,
    groupLabel: group?.label || "",
    groupSummary: group?.summary || "",
    capturedAt: entry.capturedAt
  };
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs?.[0]?.id;
}

async function logPermissionSnapshot(stage) {
  try {
    if (!chrome?.permissions?.getAll) {
      LOG("perm_snapshot_skip", { stage, reason: "getAll_unavailable" });
      return;
    }
    const perms = await chrome.permissions.getAll();
    LOG("perm_snapshot", { stage, perms });
  } catch (e) {
    LOG("perm_snapshot_error", { stage, error: e?.message || String(e) });
  }
}

async function ensureSummarizerStatus(options = {}) {
  const force = options.force === true;
  const status = STATE.summarizerStatus || { available: false, reason: "not_checked", checkedAt: 0 };
  const age = now() - (status.checkedAt || 0);
  if (!force && age < SUMMARIZER_CHECK_TTL) return status;
  const next = await probeSummarizerAvailability();
  STATE.summarizerStatus = next;
  broadcastSummarizerStatus(next);
  return next;
}

async function probeSummarizerAvailability() {
  const checkedAt = now();
  
  // DISABLED: chrome.ai.summarizer requires invalid 'ai' permission
  // Using Prompt API (LanguageModel) instead for all AI features
  const status = { available: false, reason: "disabled_using_prompt_api", checkedAt };
  debugSummarizerStatus("disabled", status);
  return status;
  
  /* ORIGINAL CODE - Disabled
  const summarizer = chrome?.ai?.summarizer;
  debugSummarizerStatus("probe_start", {
    available: !!summarizer,
    reason: summarizer ? "object_present" : "api_missing",
    checkedAt
  }, {
    summarizerKeys: summarizer ? Object.keys(summarizer) : []
  });
  if (!summarizer) {
    const status = { available: false, reason: "api_missing", checkedAt };
    debugSummarizerStatus("missing_object", status);
    return status;
  }
  */
  // Rest of function disabled - see above
}

function broadcastSummarizerStatus(status) {
  try {
    chrome.runtime.sendMessage({ type: "clarity-summarizer-status", payload: status }).catch(() => {});
  } catch {}
}

function debugSummarizerStatus(stage, status, extra = {}) {
  try {
    LOG("summarizer_probe_debug", {
      stage,
      status,
      extra,
      hasChromeAi: !!chrome?.ai,
      hasSummarizer: !!chrome?.ai?.summarizer
    });
  } catch {}
}

/**
 * Ensure right-click context menu entry exists for user-gesture opening of the side panel.
 * Handles duplicate-id races across worker restarts and onInstalled by:
 *  - Guard flag to avoid double-creation
 *  - Removing the specific id if present
 *  - Swallowing Duplicate id runtime.lastError in the create callback
 */
async function ensureContextMenus() {
  if (CTX_MENUS_READY) return;
  if (CTX_MENUS_PROMISE) return CTX_MENUS_PROMISE;

  CTX_MENUS_PROMISE = (async () => {
    await new Promise((resolve) => {
      chrome.contextMenus.removeAll(() => {
        // Ignore removeAll errors; we only care about recreating our entries
        const creations = [
          createContextMenu({
            id: CTX_OPEN_ID,
            title: "Open CLARITY AI side panel",
            contexts: ["action", "page", "tab"]
          }),
          createContextMenu({
            id: CTX_REGROUP_ID,
            title: "Regroup tabs by intent",
            contexts: ["action", "page", "tab"]
          }),
          createContextMenu({
            id: CTX_UNGROUP_ID,
            title: "Ungroup all tabs (current window)",
            contexts: ["action", "page", "tab"]
          })
        ];

        Promise.all(creations)
          .catch((e) => LOG("ctx_create_batch_err", String(e)))
          .finally(() => {
            CTX_MENUS_READY = true;
            resolve();
          });
      });
    });
  })();

  try {
    await CTX_MENUS_PROMISE;
  } finally {
    CTX_MENUS_PROMISE = null;
  }
}

function createContextMenu(item) {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.create(item, () => {
        const err = chrome.runtime.lastError;
        if (err && !/duplicate id/i.test(err.message || "")) {
          LOG("ctx_create_err", err.message || String(err));
        }
        resolve();
      });
    } catch (e) {
      LOG("ctx_create_throw", String(e));
      resolve();
    }
  });
}

async function persistState() {
  // Persist minimal serializable state (omit centroid Maps and extraction metadata)
  const serialGroups = STATE.groups.map(g => ({
    id: g.id,
    label: g.label || "",
    summary: g.summary || "",
    tabIds: g.tabIds.slice(),
    stats: { ...g.stats }
  }));
  const serialTabs = Array.from(STATE.tabs.values());

  const payload = {
    groups: serialGroups,
    assignments: STATE.assignments,
    tabs: serialTabs,
    settings: STATE.settings,
    lastSplitAt: STATE.lastSplitAt,
    summarizerStatus: STATE.summarizerStatus
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: payload });
  try { chrome.runtime.sendMessage({ type: "state-updated", payload }).catch(() => {}); } catch {}
}

async function loadState() {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const stored = res?.[STORAGE_KEY];
  if (!stored) return;
  // Restore tabs map
  STATE.tabs = new Map();
  for (const t of stored.tabs || []) {
    STATE.tabs.set(t.id, t);
  }
  // Restore groups (without centroid; regrouping will rebuild)
  STATE.groups = (stored.groups || []).map(g => ({
    id: g.id,
    label: g.label || "",
    summary: g.summary || "",
    tabIds: g.tabIds || [],
    centroid: new Map(),
    stats: g.stats || { size: g.tabIds?.length || 0, lastUpdated: now() }
  }));
  STATE.assignments = stored.assignments || {};
  STATE.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  STATE.lastSplitAt = stored.lastSplitAt || 0;
  if (stored.summarizerStatus) {
    STATE.summarizerStatus = {
      available: !!stored.summarizerStatus.available,
      reason: stored.summarizerStatus.reason || "restored",
      checkedAt: stored.summarizerStatus.checkedAt || 0
    };
  }
  STATE.contentScriptTabs = new Set();
  STATE.extractions = new Map();
}

// ----------------------------
// Heuristic labels/summaries (temporary until ai-client is added)
// ----------------------------
function labelFromTokens(tokens, hosts) {
  // Prefer meaningful tokens, fallback to host or 'Group'
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  const meaningful = [...freq.entries()]
    .filter(([t]) => t.length >= 3 && !t.startsWith("host:"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  if (meaningful.length) {
    return meaningful.slice(0, 2).map(s => s[0].toUpperCase() + s.slice(1)).join(" ");
  }
  if (hosts.length) return hosts[0].replace(/^www\./, "");
  return "Group";
}

function summarizeGroup(tabMetas) {
  const n = tabMetas.length;
  const hosts = Array.from(new Set(tabMetas.map(t => {
    const u = urlFromString(t.url || "");
    return u?.host || "";
  }).filter(Boolean)));
  const hostStr = hosts.slice(0, 3).join(", ");
  return `${n} tab${n > 1 ? "s" : ""}${hostStr ? ` · Hosts: ${hostStr}` : ""}`;
}

function ensureHeuristicLabelsAndSummaries(groups) {
  for (const g of groups) {
    if (!g.label || !g.summary) {
      const tabs = g.tabIds.map(id => STATE.tabs.get(id)).filter(Boolean);
      const tokens = [];
      const hosts = [];
      for (const t of tabs) {
        tokens.push(...tokenize(t.title || ""));
        if (t?.url) {
          const urlObj = urlFromString(t.url);
          if (urlObj) {
            tokens.push(...tokenize(urlObj.pathname.replace(/\//g, " ")));
            if (urlObj.host) hosts.push(urlObj.host);
          }
        }
      }
      if (!g.label) g.label = labelFromTokens(tokens, hosts);
      if (!g.summary) g.summary = summarizeGroup(tabs);
    }
  }
}

async function getLastFocusedWindowId() {
  try {
    const win = await chrome.windows.getLastFocused();
    return win?.id;
  } catch (e) {
    LOG("window_last_focused_err", e?.message || String(e));
    return undefined;
  }
}

async function ungroupAllTabs(windowId) {
  if (windowId === undefined) return 0;
  let groupsCleared = 0;
  const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  for (const group of groups) {
    try {
      const groupedTabs = await chrome.tabs.query({ groupId: group.id });
      if (groupedTabs.length) {
        await chrome.tabs.ungroup(groupedTabs.map(t => t.id));
        groupsCleared += 1;
      }
    } catch (e) {
      LOG("ungroup_failed", e?.message || String(e));
    }
  }
  return groupsCleared;
}

async function regroupTabsByIntent(options = {}) {
  const scope = options.scope || "current-window";
  const overwrite = options.overwrite || "ungroup-first";
  const maxGroups = Math.max(1, options.maxGroups || 6);

  let targetWindowId = options.windowId;
  if (targetWindowId === undefined) {
    if (scope === "current-window" || scope === undefined) {
      targetWindowId = await getLastFocusedWindowId();
    }
  }
  if (targetWindowId === undefined) throw new Error("No focused window to regroup.");

  const tabs = await chrome.tabs.query({ windowId: targetWindowId });
  const candidateTabs = tabs.filter(t => typeof t.id === "number" && !t.discarded);

  if (candidateTabs.length <= 1) throw new Error("Need at least two tabs to regroup.");

  if (overwrite === "ungroup-first") {
    await ungroupAllTabs(targetWindowId);
  }
// Prefer AI-driven grouping when local Prompt API is available
// This block replaces heuristic clustering when the local model is ready.
{
  // Refresh STATE.tabs snapshot for candidate tabs
  for (const t of candidateTabs) {
    const meta = { id: t.id, title: t.title || "", url: t.url || "", host: "" };
    {
      const u = urlFromString(meta.url);
      meta.host = u?.host || "";
    }
    STATE.tabs.set(t.id, meta);
  }

  let groupsCreated = 0;

  if (hasLocalTextAPI_SW()) {
    try {
      const tabMetas = candidateTabs.map((tab) => ({
        id: tab.id,
        title: tab.title || "",
        url: tab.url || ""
      }));

      const aiGroups = await aiClusterTabsWithTitles(tabMetas, maxGroups);
      const created = [];

      for (let i = 0; i < aiGroups.length; i++) {
        const g = aiGroups[i];
        const tabIds = g.tabIds.filter(id => candidateTabs.some(t => t.id === id));
        if (!tabIds.length) continue;

        try {
          const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: targetWindowId } });
          await chrome.tabGroups.update(groupId, { title: g.label, color: pickGroupColor(g.label, i) });
          groupsCreated += 1;

          // Build STATE group entry for persistence/UI
          const tabMetasForSummary = tabIds.map(id => STATE.tabs.get(id)).filter(Boolean);
          created.push({
            id: groupId,
            label: g.label,
            summary: (g.summary || summarizeGroup(tabMetasForSummary)),
            tabIds,
            centroid: new Map(),
            stats: { size: tabIds.length, lastUpdated: now() }
          });
        } catch (e) {
          LOG("ai_group_create_failed", e?.message || String(e));
        }
      }

      if (created.length) {
        // Replace STATE with AI-created grouping and persist. Avoid heuristic recluster override by returning early.
        STATE.groups = created.sort((a, b) => b.stats.size - a.stats.size);
        STATE.assignments = {};
        for (const g of STATE.groups) {
          for (const id of g.tabIds) STATE.assignments[id] = g.id;
        }
        await persistState();
        return { ok: true, groupsCreated };
      }
    } catch (e) {
      LOG("ai_grouping_failed", e?.message || String(e));
      // Fall through to heuristic fallback below
    }
  }
}

  const tabMetas = candidateTabs.map((tab) => {
    const meta = {
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      host: "",
      pathTokens: []
    };
    {
      const u = urlFromString(meta.url);
      if (u) {
        meta.host = u.host;
        meta.pathTokens = tokenize(u.pathname.replace(/\//g, " "));
      }
      // else leave defaults for invalid/non-http URLs
    }
    return meta;
  });

  const { groups } = clusterTabs(tabMetas, [], { similarityThreshold: 0.6 });
  const sorted = groups
    .filter(g => g.tabIds?.length)
    .sort((a, b) => b.tabIds.length - a.tabIds.length);

  if (!sorted.length) throw new Error("No meaningful clusters detected.");

  const limit = Math.min(sorted.length, maxGroups);
  const selected = sorted.slice(0, limit);

  const metaMap = new Map(tabMetas.map(m => [m.id, m]));
  let groupsCreated = 0;

  for (let i = 0; i < selected.length; i++) {
    const cluster = selected[i];
    const tabIds = cluster.tabIds.filter(id => metaMap.has(id));
    if (!tabIds.length) continue;

    const { label, color } = buildLabelAndColor(cluster, metaMap, i);

    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: targetWindowId } });
      await chrome.tabGroups.update(groupId, { title: label, color });
      groupsCreated += 1;
    } catch (e) {
      LOG("group_create_failed", e?.message || String(e));
    }
  }

  // Trigger state refresh asynchronously
  recluster();

  return { ok: true, groupsCreated };
}

function buildLabelAndColor(cluster, metaMap, index) {
  const tokens = [];
  const hosts = [];
  for (const tabId of cluster.tabIds) {
    const meta = metaMap.get(tabId);
    if (!meta) continue;
    tokens.push(...tokenize(meta.title || ""), ...meta.pathTokens);
    if (meta.host) hosts.push(meta.host);
  }
  let label = labelFromTokens(tokens, hosts);
  if (!label || !label.trim()) label = `Group ${index + 1}`;
  const color = pickGroupColor(label, index);
  return { label, color };
}

function pickGroupColor(label, index) {
  const hash = hashLabel(label);
  const idx = Math.abs(hash + index) % GROUP_COLORS.length;
  return GROUP_COLORS[idx] || "grey";
}

function hashLabel(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash) + label.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
// ----------------------------
// Grouping pipeline
// ----------------------------
const recluster = debounce(async function regroup() {
  // Build a fresh tab list from Chrome (authoritative)
  const allTabs = await chrome.tabs.query({});
  // Track in STATE.tabs
  const metas = [];
  for (const t of allTabs) {
    const meta = {
      id: t.id,
      title: t.title || "",
      url: t.url || ""
    };
    { const u = urlFromString(meta.url); meta.host = u?.host || ""; }
    metas.push(meta);
    STATE.tabs.set(meta.id, meta);
  }

  // Run clustering using previous groups as a hint (centroid rebuilt incrementally)
  const prev = STATE.groups;
  const { groups, assignments } = clusterTabs(metas, prev, { similarityThreshold: 0.6 });

  // Temporary heuristics to label/summarize
  ensureHeuristicLabelsAndSummaries(groups);

  // Update state
  STATE.groups = groups;
  STATE.assignments = Object.fromEntries(assignments);

  await persistState();

  // Auto window split evaluation
  maybeAutoSplit();
}, 700);

// ----------------------------
// Auto window split
// ----------------------------
async function maybeAutoSplit() {
  // Auto window split disabled per updated MVP scope
  return;
}

// ----------------------------
// Tab event listeners
// ----------------------------
chrome.tabs.onCreated.addListener((tab) => {
  const meta = { id: tab.id, title: tab.title || "", url: tab.url || "", host: "" };
  { const u = urlFromString(meta.url); meta.host = u?.host || ""; }
  STATE.tabs.set(tab.id, meta);
  recluster();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    STATE.contentScriptTabs.delete(tabId);
    invalidateExtraction(tabId);
  }
  let changed = false;
  const meta = STATE.tabs.get(tabId) || { id: tabId, title: "", url: "", host: "" };
  if (typeof changeInfo.title === "string") {
    meta.title = changeInfo.title;
    changed = true;
  }
  if (typeof changeInfo.url === "string") {
    meta.url = changeInfo.url;
    { const u = urlFromString(meta.url); meta.host = u?.host || ""; }
    changed = true;
  }
  STATE.tabs.set(tabId, meta);
  if (changed) recluster();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  STATE.contentScriptTabs.delete(tabId);
  invalidateExtraction(tabId);
  STATE.tabs.delete(tabId);
  // Remove from groups
  let touched = false;
  for (const g of STATE.groups) {
    const idx = g.tabIds.indexOf(tabId);
    if (idx >= 0) {
      g.tabIds.splice(idx, 1);
      g.stats.size = g.tabIds.length;
      touched = true;
    }
  }
  if (STATE.assignments[tabId]) {
    delete STATE.assignments[tabId];
    touched = true;
  }
  if (touched) recluster();
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  STATE.contentScriptTabs.delete(removedTabId);
  invalidateExtraction(removedTabId);
  STATE.contentScriptTabs.delete(addedTabId);
  invalidateExtraction(addedTabId);
  // Transfer metadata when tab process is replaced
  const oldMeta = STATE.tabs.get(removedTabId);
  if (oldMeta) {
    oldMeta.id = addedTabId;
    STATE.tabs.delete(removedTabId);
    STATE.tabs.set(addedTabId, oldMeta);
  }
  recluster();
});

// ----------------------------
// Commands and action
// ----------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-side-panel") {
    LOG("onCommand", command);
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) {
        // Ensure options set; cannot programmatically open due to user gesture requirement
        await chrome.sidePanel.setOptions({
          tabId: activeTab.id,
          path: "sidepanel/panel.html",
          enabled: true
        });
        // Hint the user to click the action to open the panel
        await setTemporaryBadge("OPEN", 2000);
      }
    } catch (e) {
      console.warn("Side panel setup from command failed:", e);
    }
  } else if (command === "move-group-to-new-window") {
    // Pick the second-largest group to move (heuristic)
    const sorted = STATE.groups.slice().sort((a, b) => b.stats.size - a.stats.size);
    if (sorted.length >= 2) {
      await moveGroupToNewWindow(sorted[1].id);
    }
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  LOG("action_click", { tabId: tab?.id });
  try {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel/panel.html", enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn("Side panel open via action failed:", e);
  }
});

// ----------------------------
// Context menu (user gesture path)
// ----------------------------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CTX_OPEN_ID && tab?.id) {
    try {
      await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel/panel.html", enabled: true });
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {
      console.warn("Side panel open via context menu failed:", e);
    }
    return;
  }

  if (info.menuItemId === CTX_REGROUP_ID) {
    try {
      const res = await regroupTabsByIntent({
        scope: "current-window",
        overwrite: "ungroup-first",
        maxGroups: 6
      });
      LOG("ctx_regroup", res);
    } catch (e) {
      LOG("ctx_regroup_err", e?.message || String(e));
    }
    return;
  }

  if (info.menuItemId === CTX_UNGROUP_ID) {
    try {
      const winId = await getLastFocusedWindowId();
      const cleared = await ungroupAllTabs(winId);
      LOG("ctx_ungroup", { windowId: winId, cleared });
      recluster();
    } catch (e) {
      LOG("ctx_ungroup_err", e?.message || String(e));
    }
  }
});

// Recreate menus on install/update
chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenus();
});

// Also ensure context menu on browser startup (cold start)
chrome.runtime.onStartup?.addListener(() => {
  ensureContextMenus();
});

// ----------------------------
// Messaging API
// ----------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "getState") {
      await ensureSummarizerStatus({ force: msg?.forceSummarizer === true });
      const serialGroups = STATE.groups.map(g => ({
        id: g.id, label: g.label, summary: g.summary, tabIds: g.tabIds, stats: g.stats
      }));
      const serialTabs = Array.from(STATE.tabs.values());
      sendResponse({
        ok: true,
        data: {
          groups: serialGroups,
          tabs: serialTabs,
          assignments: { ...STATE.assignments },
          settings: STATE.settings,
          summarizer: STATE.summarizerStatus
        }
      });
    } else if (msg?.type === "regroupByIntent") {
      try {
        const result = await regroupTabsByIntent({
          scope: msg.scope,
          overwrite: msg.overwrite,
          maxGroups: msg.maxGroups,
          windowId: msg.windowId
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    } else if (msg?.type === "checkSummarizerAvailability") {
      const status = await ensureSummarizerStatus({ force: true });
      sendResponse({ ok: true, data: status });
    } else if (msg?.type === "moveGroupToNewWindow" && msg.groupId) {
      await moveGroupToNewWindow(msg.groupId);
      sendResponse({ ok: true });
    } else if (msg?.type === "getSettings") {
      sendResponse({ ok: true, data: STATE.settings });
    } else if (msg?.type === "setSettings" && msg.settings) {
      STATE.settings = { ...STATE.settings, ...msg.settings };
      await persistState();
      sendResponse({ ok: true });
    } else if (msg?.type === "refresh") {
      recluster();
      sendResponse({ ok: true });
    } else if (msg?.type === "captureActiveTabContext") {
      const tabId = typeof msg.tabId === "number" ? msg.tabId : await getActiveTabId();
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, error: "no_active_tab" });
        return;
      }
      try {
        const data = await captureTabContext(tabId, msg.options || {});
        sendResponse({ ok: true, data });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    } else if (msg?.type === "getActiveContext") {
      const tabId = typeof msg.tabId === "number" ? msg.tabId : await getActiveTabId();
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, error: "no_active_tab" });
        return;
      }
      let meta = STATE.tabs.get(tabId);
      if (!meta) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab) {
            meta = { id: tab.id, title: tab.title || "", url: tab.url || "" };
            STATE.tabs.set(tab.id, meta);
          }
        } catch {
          meta = null;
        }
      }
      const groupId = STATE.assignments?.[tabId];
      const group = typeof groupId === "number" ? STATE.groups.find((g) => g.id === groupId) : null;
      const extractionEntry = STATE.extractions.get(tabId);
      sendResponse({
        ok: true,
        data: {
          tabId,
          title: meta?.title || "",
          url: meta?.url || "",
          groupId: group?.id ?? null,
          groupLabel: group?.label || "",
          groupSummary: group?.summary || "",
          hasExtraction: !!extractionEntry,
          extractionCapturedAt: extractionEntry?.capturedAt || null,
          extractionSignature: extractionEntry?.signature || extractionEntry?.data?.signature || ""
        }
      });
    } else if (msg?.type === "startVoiceInActiveTab") {
      const tabId = typeof msg.tabId === "number" ? msg.tabId : await getActiveTabId();
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, error: "no_active_tab" });
        return;
      }
      let tabInfo = STATE.tabs.get(tabId);
      if (!tabInfo) {
        try {
          const t = await chrome.tabs.get(tabId);
          if (t) {
            tabInfo = { id: t.id, title: t.title || "", url: t.url || "" };
            STATE.tabs.set(t.id, tabInfo);
          }
        } catch {
          tabInfo = null;
        }
      }
      const url = tabInfo?.url || "";
      if (!isInjectableUrl(url)) {
        sendResponse({ ok: false, error: "unsupported_url_for_voice" });
        return;
      }
      try {
        await ensureContentScripts(tabId);
      } catch (_) {
        try {
          await ensureContentScripts(tabId);
        } catch (injErr2) {
          sendResponse({ ok: false, error: "content_script_injection_failed" });
          return;
        }
      }
      try {
        const resp = await sendTabMessage(tabId, { type: "clarity-start-voice" }, 15000);
        if (resp && resp.ok) {
          sendResponse({ ok: true, transcript: resp.transcript || "" });
        } else {
          sendResponse({ ok: false, error: resp?.error || "content_error" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    } else if (msg?.type === "toggleGrouping") {
      try {
        const data = await toggleGrouping(msg);
        sendResponse({ ok: true, data });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    } else if (msg?.type === "applyLabels" && Array.isArray(msg.payload)) {
      // payload: [{ id, label?, summary? }]
      const updates = msg.payload;
      const map = new Map(STATE.groups.map(g => [g.id, g]));
      let touched = false;
      for (const u of updates) {
        const g = map.get(u.id);
        if (!g) continue;
        if (typeof u.label === "string" && u.label && g.label !== u.label) {
          g.label = u.label;
          touched = true;
        }
        if (typeof u.summary === "string" && u.summary && g.summary !== u.summary) {
          g.summary = u.summary;
          touched = true;
        }
      }
      if (touched) await persistState();
      sendResponse({ ok: true, updated: touched });
    } else if (msg?.action === "openSidebar") {
      // Overtab SR path: open side panel for current tab
      try {
        const tabId = sender?.tab?.id ?? (await getActiveTabId());
        if (typeof tabId !== "number") {
          sendResponse({ success: false, error: "no_active_tab" });
        } else {
          try {
            await chrome.sidePanel.setOptions({ tabId, path: "sidepanel/panel.html", enabled: true });
          } catch {}
          await chrome.sidePanel.open({ tabId });
          sendResponse({ success: true });
        }
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    } else if (msg?.action === "processAI") {
      // Overtab SR path: process Prompt API requests (local on-device only)
      try {
        const fn = msg.aiFunction;
        if (fn === "prompt") {
          const out = await localPromptSW(String(msg.text || ""));
          sendResponse({ success: true, result: out });
        } else {
          sendResponse({ success: false, error: "unknown_ai_function" });
        }
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    } else if (msg?.action === "showLoading" || msg?.action === "showResult" || msg?.action === "showError") {
      // Overtab SR path: prevent duplicate UI events; content/sidepanel already receive the original message.
      // Do NOT re-broadcast from SW to avoid duplicate renders in the panel.
      sendResponse({ success: true, forwarded: false });
    } else {
      sendResponse({ ok: false, error: "unknown_message" });
    }
  })();
  // Keep channel open for async response
  return true;
});

async function moveGroupToNewWindow(groupId) {
  const g = STATE.groups.find(x => x.id === groupId);
  if (!g) return;
  const tabIds = g.tabIds.filter(id => STATE.tabs.has(id));
  if (tabIds.length === 0) return;
  try {
    const firstTabId = tabIds[0];
    const created = await chrome.windows.create({ tabId: firstTabId, focused: true });
    const rest = tabIds.slice(1);
    if (rest.length) {
      await chrome.tabs.move(rest, { windowId: created.id, index: -1 });
    }
    STATE.lastSplitAt = now();
    await persistState();
  } catch (e) {
    console.warn("Manual move to new window failed:", e);
  }
}

// ----------------------------
// Boot
// ----------------------------
(async function boot() {
  await loadState();
  await logPermissionSnapshot("boot_start");
  await ensureSummarizerStatus({ force: true });
  try { await chrome.sidePanel.setPanelBehavior?.({ openPanelOnActionClick: true }); } catch (e) { /* not supported on older Chrome */ }
  LOG("boot", { panelBehavior: true });
  try {
    const cmds = await chrome.commands.getAll();
    LOG("commands", cmds.map(c => ({ name: c.name, shortcut: c.shortcut })));
  } catch (e) {
    LOG("commands_get_error", String(e));
  }
  // ensureContextMenus() handled via onInstalled/onStartup to avoid duplicate creation
  setTemporaryBadge("RDY", 1200);
  await logPermissionSnapshot("boot_after_status");
  // Initial populate
  const allTabs = await chrome.tabs.query({});
  for (const t of allTabs) {
    const meta = { id: t.id, title: t.title || "", url: t.url || "", host: "" };
    { const u = urlFromString(meta.url); meta.host = u?.host || ""; }
    STATE.tabs.set(t.id, meta);
  }
  recluster();
})();