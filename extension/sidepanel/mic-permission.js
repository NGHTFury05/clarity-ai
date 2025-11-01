/* CLARITY AI - Microphone permission primer */
(() => {
  "use strict";

  const qs = (sel) => document.querySelector(sel);

  function setStatus(text, cls) {
    const el = qs("#status");
    if (el) {
      el.textContent = text;
      el.className = cls || "";
    }
  }

  function setHint(text) {
    const el = qs("#hint");
    if (el) el.textContent = text || "";
  }

  async function requestMic() {
    // Defensive checks for mediaDevices and getUserMedia
    if (!("mediaDevices" in navigator) || typeof navigator.mediaDevices.getUserMedia !== "function") {
      setStatus("Microphone API not available in this context.", "err");
      setHint("Try allowing the microphone from the site’s lock icon and then retry.");
      return;
    }

    try {
      setStatus("Requesting microphone access…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Immediately stop; we just needed permission
      try {
        stream.getTracks().forEach(t => t.stop());
      } catch (_) {
        // no-op
      }

      setStatus("Microphone permission granted.", "ok");
      setHint("You can close this popup. Listening will work immediately in the side panel.");

      // Attempt to auto-close shortly after success (best effort)
      setTimeout(() => {
        try { window.close(); } catch (_) { /* ignore */ }
      }, 800);
    } catch (err) {
      // Handle denial or errors
      console.warn("getUserMedia error:", err);
      const msg = (err && err.name === "NotAllowedError")
        ? "Microphone permission was denied."
        : "Unable to access the microphone.";
      setStatus(msg, "err");
      setHint("Use the lock icon in the address bar to allow the microphone for this site, then retry.");
    }
  }

  // Run on popup open (user-gesture context via clicking the extension action)
  window.addEventListener("DOMContentLoaded", requestMic, { once: true });
})();