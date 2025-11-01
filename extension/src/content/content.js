(() => {
  if (window.__clarityContentScriptLoaded) return;
  window.__clarityContentScriptLoaded = true;

  const CLEAN_SELECTORS = [
    "script",
    "style",
    "noscript",
    "iframe",
    "footer",
    "header",
    "nav",
    "aside",
    "form",
    "input",
    "button",
    ".advertisement",
    ".ad",
    ".ads",
    ".promo",
    ".sidebar",
    ".menu",
    ".sticky",
    ".modal"
  ].join(",");

  const DEFAULT_MAX_SEGMENTS = 8;
  const DEFAULT_SEGMENT_CHAR_LIMIT = 700;
  const DEFAULT_MIN_SEGMENT_CHAR = 120;
  const MAX_SEGMENTS_CAP = 16;
  const MAX_SEGMENT_CHAR_CAP = 1600;
  const MAX_RAW_TEXT_LENGTH = 8000;

  let enabled = false;

  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return undefined;

    if (msg.type === "clarity-toggle-rag") {
      enabled = !!msg.enabled;
      sendResponse?.({ ok: true, enabled });
      return false;
    }

    if (msg.type === "clarity-rag-extract") {
      if (!enabled) {
        sendResponse?.({ ok: false, error: "rag_disabled" });
        return false;
      }
      const options = msg.options || {};
      extractPageContext(options)
        .then((data) => sendResponse?.({ ok: true, data }))
        .catch((error) => {
          sendResponse?.({ ok: false, error: normalizeError(error) });
        });
      return true;
    }

    // One-shot voice capture (runs in page context to avoid extension-origin mic blocks)
    if (msg.type === "clarity-start-voice") {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        sendResponse?.({ ok: false, error: "sr_unavailable" });
        return false;
      }
      let settled = false;
      const cleanup = () => {
        try { removeClarityVoiceOverlay(); } catch {}
      };

      try {
        createClarityVoiceOverlay();
      } catch {}

      try {
        const rec = new SR();
        const lang = document.documentElement?.lang || navigator.language || "en-US";
        rec.lang = lang || "en-US";
        rec.continuous = false;
        rec.interimResults = false;
        rec.maxAlternatives = 1;

        rec.onresult = (e) => {
          if (settled) return;
          settled = true;
          cleanup();
          const tx = e?.results?.[0]?.[0]?.transcript || "";
          sendResponse?.({ ok: true, transcript: tx });
        };
        rec.onerror = (e) => {
          if (settled) return;
          settled = true;
          cleanup();
          sendResponse?.({ ok: false, error: e?.error || "speech_error" });
        };
        rec.onend = () => {
          if (settled) return;
          settled = true;
          cleanup();
          // Resolve with empty transcript to match one-shot UX
          sendResponse?.({ ok: true, transcript: "" });
        };

        try {
          rec.start();
        } catch (err) {
          if (!settled) {
            settled = true;
            cleanup();
            sendResponse?.({ ok: false, error: String(err?.message || err) });
          }
        }
      } catch (outerErr) {
        if (!settled) {
          settled = true;
          cleanup();
          sendResponse?.({ ok: false, error: String(outerErr?.message || outerErr) });
        }
      }
      // Async response
      return true;
    }

    return undefined;
  });

  // Lightweight in-page "Listening…" indicator
  function createClarityVoiceOverlay() {
    if (document.getElementById("__clarityVoiceOverlay")) return;
    const el = document.createElement("div");
    el.id = "__clarityVoiceOverlay";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.position = "fixed";
    el.style.left = "50%";
    el.style.bottom = "24px";
    el.style.transform = "translateX(-50%)";
    el.style.zIndex = "2147483647";
    el.style.padding = "10px 14px";
    el.style.borderRadius = "999px";
    el.style.background = "rgba(0,0,0,0.75)";
    el.style.color = "#fff";
    el.style.font = "13px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
    el.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.gap = "8px";

    const dot = document.createElement("span");
    dot.style.width = "10px";
    dot.style.height = "10px";
    dot.style.borderRadius = "50%";
    dot.style.background = "#10b981"; // emerald
    dot.style.boxShadow = "0 0 0 0 rgba(16,185,129,0.7)";
    dot.style.animation = "clarityPulse 1.6s infinite";
    el.appendChild(dot);

    const text = document.createElement("span");
    text.textContent = "Listening…";
    el.appendChild(text);

    const style = document.createElement("style");
    style.textContent = `
@keyframes clarityPulse {
  0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.7); }
  70% { box-shadow: 0 0 0 10px rgba(16,185,129,0); }
  100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
}`;
    el.appendChild(style);

    document.documentElement.appendChild(el);
  }

  function removeClarityVoiceOverlay() {
    const el = document.getElementById("__clarityVoiceOverlay");
    if (el && el.parentNode) {
      try { el.parentNode.removeChild(el); } catch {}
    }
  }

  async function extractPageContext(rawOptions = {}) {
    const options = normalizeOptions(rawOptions);
    const readabilityResult = tryReadabilityExtraction(options);
    const payload = readabilityResult ?? basicExtraction(options);
    payload.segments = payload.segments.slice(0, options.maxSegments);
    payload.textContent = clipText(payload.textContent || "", MAX_RAW_TEXT_LENGTH);
    if (payload.excerpt) {
      payload.excerpt = clipText(payload.excerpt, Math.min(400, options.segmentCharLimit));
    }
    payload.signature = computeSignature(payload);
    payload.sourceUrl = location.href;
    payload.sourceHost = location.hostname;
    payload.capturedAt = Date.now();
    payload.options = {
      maxSegments: options.maxSegments,
      segmentCharLimit: options.segmentCharLimit,
      minSegmentCharLength: options.minSegmentCharLength
    };
    return payload;
  }

  function tryReadabilityExtraction(options) {
    if (!assertReadability()) return null;
    try {
      const docClone = document.cloneNode(true);
      scrubDocument(docClone);
      const reader = new Readability(docClone, { keepClasses: false });
      const article = reader.parse();
      if (!article || !article.textContent?.trim()) return null;
      const segments = segmentArticle(article.content, article.textContent, options);
      if (!segments.length) return null;
      return {
        title: safeText(article.title) || document.title || "",
        excerpt: options.includeExcerpt ? safeText(article.excerpt) : "",
        textContent: safeText(article.textContent),
        segments
      };
    } catch (error) {
      console.warn("[Clarity:RAG] Readability extraction failed:", error);
      return null;
    }
  }

  function basicExtraction(options) {
    const title = document.title || "";
    const text = normalizeWhitespace(document.body?.innerText || "");
    const segments = fallbackSegmentsFromText(text, options);
    return {
      title,
      excerpt: options.includeExcerpt ? segments[0] || text.slice(0, 280) : "",
      textContent: text,
      segments
    };
  }

  function normalizeOptions(raw) {
    const maxSegments = clamp(
      Number(raw.maxSegments) || DEFAULT_MAX_SEGMENTS,
      1,
      MAX_SEGMENTS_CAP
    );
    const segmentCharLimit = clamp(
      Number(raw.segmentCharLimit) || DEFAULT_SEGMENT_CHAR_LIMIT,
      200,
      MAX_SEGMENT_CHAR_CAP
    );
    const minSegmentCharLength = clamp(
      Number(raw.minSegmentCharLength) || DEFAULT_MIN_SEGMENT_CHAR,
      40,
      segmentCharLimit
    );
    return {
      maxSegments,
      segmentCharLimit,
      minSegmentCharLength,
      includeExcerpt: raw.includeExcerpt !== false
    };
  }

  function scrubDocument(docLike) {
    try {
      docLike.querySelectorAll(CLEAN_SELECTORS).forEach((el) => el.remove());
    } catch (error) {
      console.warn("[Clarity:RAG] scrubDocument warning:", error);
    }
  }

  function segmentArticle(html, rawText, options) {
    const container = document.createElement("div");
    try {
      container.innerHTML = html || "";
    } catch {
      container.textContent = rawText || "";
    }

    const nodes = container.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre"
    );
    const segments = [];
    let current = [];
    let charCount = 0;

    const push = (force = false) => {
      if (!current.length) {
        charCount = 0;
        return;
      }
      const combined = current.join("\n").trim();
      current = [];
      charCount = 0;
      if (!combined) return;

      const normalized = truncate(combined, options.segmentCharLimit);
      if (
        !force &&
        normalized.length < options.minSegmentCharLength &&
        segments.length
      ) {
        const last = segments.pop();
        segments.push(
          truncate(`${last}\n${normalized}`, options.segmentCharLimit)
        );
      } else {
        segments.push(normalized);
      }
    };

    for (const node of nodes) {
      if (segments.length >= options.maxSegments) break;
      const text = normalizeWhitespace(node.textContent || "");
      if (!text) continue;
      const isHeading = /^H[1-6]$/.test(node.tagName);
      if (isHeading) {
        push(true);
        current.push(text);
        charCount = text.length;
        continue;
      }
      current.push(text);
      charCount += text.length;
      if (charCount >= options.segmentCharLimit) {
        push();
      }
    }

    if (segments.length < options.maxSegments && current.length) {
      push(true);
    }

    if (!segments.length) {
      return fallbackSegmentsFromText(rawText, options);
    }

    return segments.slice(0, options.maxSegments);
  }

  function fallbackSegmentsFromText(text, options) {
    const paragraphs = (text || "")
      .split(/\n{2,}/)
      .map((p) => normalizeWhitespace(p))
      .filter(Boolean);

    const segments = [];
    let buffer = "";

    for (const paragraph of paragraphs) {
      if (segments.length >= options.maxSegments) break;
      if (!buffer) {
        buffer = paragraph;
      } else {
        buffer = `${buffer}\n${paragraph}`;
      }

      if (buffer.length >= options.segmentCharLimit) {
        segments.push(truncate(buffer, options.segmentCharLimit));
        buffer = "";
      }
    }

    if (buffer && segments.length < options.maxSegments) {
      segments.push(truncate(buffer, options.segmentCharLimit));
    }

    if (!segments.length && text) {
      segments.push(truncate(text, options.segmentCharLimit));
    }

    return segments.slice(0, options.maxSegments);
  }

  function truncate(value, limit) {
    if (!value) return "";
    if (value.length <= limit) return value;
    const slice = value.slice(0, limit - 1);
    const idx = slice.lastIndexOf(" ");
    const safeCut = idx > limit * 0.6 ? idx : slice.length;
    return `${slice.slice(0, safeCut).trim()}…`;
  }

  function clipText(value, limit) {
    if (!value) return "";
    if (value.length <= limit) return value;
    return `${value.slice(0, limit - 1).trim()}…`;
  }

  function normalizeWhitespace(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function safeText(value) {
    return typeof value === "string" ? normalizeWhitespace(value) : "";
  }

  function clamp(number, min, max) {
    return Math.min(Math.max(number, min), max);
  }

  function assertReadability() {
    return typeof Readability === "function";
  }

  function computeSignature(payload) {
    const base = [
      payload.title || "",
      payload.excerpt || "",
      ...(payload.segments || [])
    ].join("||");
    return hashString(base);
  }

  function hashString(input) {
    let hash = 0;
    const text = String(input || "");
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(16);
  }

  function normalizeError(error) {
    if (!error) return "unknown_error";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    return String(error);
  }

  // Overtab SR path: add support for { action: 'startVoiceCapture' } triggering in-page Web Speech
  try {
    chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== "object") return undefined;
      if (msg.action === "startVoiceCapture") {
        try {
          startVoiceCapture();
          sendResponse?.({ ok: true });
        } catch (e) {
          sendResponse?.({ ok: false, error: String(e?.message || e) });
        }
        return true;
      }
      return undefined;
    });
  } catch {}

  // Overtab SR path: mirrors Overtab startVoiceCapture() behavior for single-shot SR + Prompt API
  function startVoiceCapture() {
    // Feature detection (mirror Overtab)
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      alert("Voice recognition not supported.");
      return;
    }

    const pageTitle = document.title;
    const pageText = (document.body?.innerText || "").substring(0, 1000);
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();

    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    // Create Overtab-style inline indicator
    const indicator = document.createElement("div");
    indicator.id = "overtab-voice-indicator";
    indicator.innerHTML = `
      <div style="position: fixed; top: 20px; right: 20px; z-index: 9999999;
                  background: white; padding: 20px 28px; border-radius: 12px;
                  box-shadow: 0 4px 16px rgba(0,0,0,0.15); border: 2px solid #1a73e8;">
        <div style="font-size: 18px; font-weight: 600; color: #1a73e8; margin-bottom: 8px;">
          🎤 Listening...
        </div>
        <div style="font-size: 14px; color: #5f6368; margin-bottom: 4px;">
          Ask a question about this page
        </div>
        <div style="font-size: 12px; color: #80868b; font-style: italic;">
          "${(pageTitle || "").substring(0, 40)}${(pageTitle || "").length > 40 ? "..." : ""}"
        </div>
      </div>
    `;
    try { document.body.appendChild(indicator); } catch {}

    recognition.onresult = async function(event) {
      const transcript = event?.results?.[0]?.[0]?.transcript || "";

      // Remove indicator
      try {
        if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      } catch {}

      // Ensure side panel visibility first
      try { chrome.runtime.sendMessage({ action: "openSidebar" }); } catch {}

      // Show loading in sidepanel
      try {
        chrome.runtime.sendMessage({
          action: "showLoading",
          sourceText: `Q: "${transcript}"`
        });
      } catch {}

      try {
        const contextPrompt = `Page: "${pageTitle}"
        
Context: ${pageText}

Question: ${transcript}

Answer the question based on the page content above.`;

        const response = await chrome.runtime.sendMessage({
          action: "processAI",
          aiFunction: "prompt",
          text: contextPrompt
        });

        if (!response || response.success !== true) {
          const err = response?.error || "AI processing failed";
          chrome.runtime.sendMessage({ action: "showError", error: err });
          return;
        }

        const result = response.result;
        chrome.runtime.sendMessage({
          action: "showResult",
          sourceText: `Q: "${transcript}"`,
          resultType: "explanation",
          result
        });
      } catch (error) {
        chrome.runtime.sendMessage({
          action: "showError",
          error: error?.message || "Error processing voice question. Try again!"
        });
      }
    };

    recognition.onerror = function(event) {
      try {
        if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      } catch {}
      alert("Voice recognition error: " + (event?.error || "unknown"));
    };

    recognition.onend = function() {
      try {
        if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      } catch {}
    };

    try {
      recognition.start();
    } catch (error) {
      try {
        if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      } catch {}
    }
  }

})();