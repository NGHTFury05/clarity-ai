// Lightweight intent grouping heuristics for CLARITY AI (MV3, ESM)
// Groups tabs using token similarity from titles and URL path segments.
// Labels and summaries are filled by AI elsewhere.
//
// Public API:
// - clusterTabs(tabMetas, prevGroups?, options?) => { groups, assignments }
//   tabMetas: Array<{ id:number, title:string, url:string, host?:string }>
//   returns groups: Array<{ id:string, label:string, summary:string, tabIds:number[], centroid:Map, stats:{size:number,lastUpdated:number} }>
//           assignments: Map<tabId, groupId>
//
// Notes:
// - No DOM access; pure functions only.
// - Thresholds tuned for hackathon MVP performance across 20–50 tabs.

export const DEFAULT_SIM_THRESHOLD = 0.6;
export const HOST_BONUS = 0.08; // slight bias to same-host grouping
export const NEW_GROUP_PENALTY = 0.02; // nudge against over-fragmentation

const STOPWORDS = new Set([
  "the","a","an","and","or","for","to","in","of","on","at","by","with","from","as","is","are",
  "be","was","were","it","this","that","these","those","you","your","my","we","our","they",
  "how","what","why","when","where","which","can","could","should","would","vs","v","amp"
]);

const TOKEN_MIN_LEN = 2;

/**
 * Normalize and tokenize a string into lowercase alphanumeric tokens.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text = "") {
  return (text || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t && t.length >= TOKEN_MIN_LEN && !STOPWORDS.has(t));
}

/**
 * Extract host and path tokens from a URL string.
 * @param {string} url
 * @returns {{ host: string, pathTokens: string[] }}
 */

// Safe URL helper limited to http(s)
function urlFromString(str) {
  if (typeof str === "string" && str && /^https?:/i.test(str)) {
    try { return new URL(str); } catch { return null; }
  }
  return null;
}

export function parseUrl(url = "") {
  const u = urlFromString(url);
  if (!u) return { host: "", pathTokens: [] };
  const host = (u.host || "").toLowerCase();
  const pathTokens = tokenize(u.pathname.replace(/\//g, " "));
  return { host, pathTokens };
}

/**
 * Turn tokens into a sparse frequency map (Map<string, number>).
 * Applies sqrt tf scaling to reduce dominance of repeated tokens.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
export function vectorize(tokens) {
  const m = new Map();
  for (const t of tokens) {
    m.set(t, (m.get(t) || 0) + 1);
  }
  for (const [k, v] of m) {
    m.set(k, Math.sqrt(v));
  }
  return m;
}

/**
 * Cosine similarity for sparse maps.
 * @param {Map<string, number>} a
 * @param {Map<string, number>} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  // Compute dot
  let dot = 0;
  // Iterate smaller map
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, va] of smaller) {
    const vb = larger.get(k);
    if (vb) dot += va * vb;
  }
  // Norms
  const norm = (m) => Math.sqrt(Array.from(m.values()).reduce((s, x) => s + x * x, 0));
  const denom = norm(a) * norm(b);
  return denom ? dot / denom : 0;
}

/**
 * Merge centroid with a new vector (incremental mean).
 * @param {Map<string, number>} centroid
 * @param {Map<string, number>} vec
 * @param {number} n existing size before adding vec
 * @returns {Map<string, number>}
 */
function mergeCentroid(centroid, vec, n) {
  const out = new Map(centroid);
  for (const [k, v] of vec) {
    const prev = out.get(k) || 0;
    // new mean = (prev * n + v) / (n + 1)
    out.set(k, (prev * n + v) / (n + 1));
  }
  // Slight decay on tokens not present in new vector
  for (const [k, v] of out) {
    if (!vec.has(k)) out.set(k, (v * n) / (n + 1));
  }
  return out;
}

/**
 * Compute a simple divergence metric between two groups based on centroid similarity and size dominance.
 * Returns higher score when groups are large and dissimilar.
 * @param {{centroid: Map, stats:{size:number}}} g1
 * @param {{centroid: Map, stats:{size:number}}} g2
 * @returns {number}
 */
export function divergenceScore(g1, g2) {
  const sim = cosine(g1.centroid, g2.centroid);
  const sizeFactor = Math.min(g1.stats.size, g2.stats.size) / Math.max(1, (g1.stats.size + g2.stats.size) / 2);
  // Low similarity and comparable sizes -> higher divergence
  return (1 - sim) * (0.5 + 0.5 * sizeFactor);
}

/**
 * Create a stable group id from seed tokens.
 * @param {string[]} seedTokens
 * @returns {string}
 */
function groupIdFrom(seedTokens) {
  const base = seedTokens.slice(0, 3).join("-") || "group";
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base}-${rand}`;
}

/**
 * Build a feature vector for a tab.
 * @param {{title:string, url:string}} tab
 * @returns {{ vec: Map<string, number>, host:string, allTokens:string[] }}
 */
export function tabVector(tab) {
  const titleTokens = tokenize(tab.title || "");
  const { host, pathTokens } = parseUrl(tab.url || "");
  const contextTokens = Array.isArray(tab.contextTokens) ? tab.contextTokens : [];
  const contextScaled = contextTokens.slice(0, 120).map(t => `ctx:${t}`);
  const allTokens = [...titleTokens, ...pathTokens, ...contextScaled];
  const vec = vectorize(allTokens);
  // host bias as an added pseudo-token
  if (host) {
    const hostToken = `host:${host.split(".").slice(-2).join(".")}`; // e.g., stackoverflow.com -> stackoverflow.com
    vec.set(hostToken, (vec.get(hostToken) || 0) + Math.SQRT2);
  }
  return { vec, host, allTokens };
}

/**
 * Assign tabs to groups incrementally using cosine similarity with a slight host bonus.
 * @param {Array<{id:number,title:string,url:string,host?:string}>} tabMetas
 * @param {Array<{id:string,label:string,summary:string,tabIds:number[],centroid:Map,stats:{size:number,lastUpdated:number}}>} prevGroups
 * @param {{ similarityThreshold?:number }} options
 * @returns {{ groups: Array, assignments: Map<number,string> }}
 */
export function clusterTabs(tabMetas, prevGroups = [], options = {}) {
  const threshold = options.similarityThreshold ?? DEFAULT_SIM_THRESHOLD;
  const now = Date.now();

  // Clone previous groups structure (drop labels/summaries; AI will refresh)
  const groups = prevGroups.map(g => ({
    id: g.id,
    label: g.label || "",
    summary: g.summary || "",
    tabIds: [],
    centroid: new Map(g.centroid || []),
    stats: { size: 0, lastUpdated: now }
  }));

  const assignments = new Map();

  // Precompute vectors
  const vecs = new Map(); // tabId -> {vec,host,allTokens}
  for (const t of tabMetas) {
    vecs.set(t.id, tabVector(t));
  }

  for (const t of tabMetas) {
    const fv = vecs.get(t.id);
    let bestIdx = -1;
    let bestScore = threshold - NEW_GROUP_PENALTY;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      let score = cosine(fv.vec, g.centroid);
      // host bonus if many tabs in group share host
      if (fv.host && g.stats.size >= 2) {
        // approximate host overlap by centroid presence of host pseudo-token
        const hostToken = `host:${fv.host.split(".").slice(-2).join(".")}`;
        if (g.centroid.has(hostToken)) score += HOST_BONUS;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      // New group
      const id = groupIdFrom(fv.allTokens);
      const newG = {
        id,
        label: "",
        summary: "",
        tabIds: [t.id],
        centroid: new Map(fv.vec),
        stats: { size: 1, lastUpdated: now }
      };
      groups.push(newG);
      assignments.set(t.id, id);
    } else {
      // Assign to best existing group
      const g = groups[bestIdx];
      g.tabIds.push(t.id);
      g.centroid = mergeCentroid(g.centroid, fv.vec, g.stats.size);
      g.stats.size += 1;
      g.stats.lastUpdated = now;
      assignments.set(t.id, g.id);
    }
  }

  // Drop empty groups and sort by size desc
  const filtered = groups.filter(g => g.tabIds.length > 0).sort((a, b) => b.stats.size - a.stats.size);

  return { groups: filtered, assignments };
}

/**
 * Pick top 2 groups and compute their divergence, helpful for auto window split decisions.
 * @param {Array} groups
 * @returns {{pair:[any,any]|null, score:number}}
 */
export function topDivergence(groups) {
  if (!groups || groups.length < 2) return { pair: null, score: 0 };
  const [g1, g2] = groups.slice(0, 2);
  return { pair: [g1, g2], score: divergenceScore(g1, g2) };
}