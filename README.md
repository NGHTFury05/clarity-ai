# CLARITY AI — Chrome Extension (MVP)

Auto-group tabs by intent, label groups, summarize, show connections/suggestions, and chat via side panel. Uses Chrome’s built‑in AI Prompt API when available; otherwise falls back to Firebase Gemini 1.5 Flash (asia-south1).

Key files
- [manifest.json](extension/manifest.json)
- Background: [service-worker.js](extension/src/background/service-worker.js)
- Grouping: [grouping.js](extension/src/shared/grouping.js)
- AI client (local-first + fallback): [ai-client.js](extension/src/shared/ai-client.js)
- Side panel: [panel.html](extension/sidepanel/panel.html), [panel.css](extension/sidepanel/panel.css), [panel.js](extension/sidepanel/panel.js)
- RAG stub (off by default): [content.js](extension/src/content/content.js)
- Firebase fallback (Gemini 1.5 Flash, asia-south1): [firebase.json](firebase/firebase.json), [index.ts](firebase/functions/index.ts), [package.json](firebase/functions/package.json), [tsconfig.json](firebase/functions/tsconfig.json)

What’s in the MVP
- Auto grouping by intent using tab titles + URL path tokens
- AI labels + summaries (local Prompt API first; fallback to Firebase)
- Connections and suggestions (generic next steps)
- Side panel chat (text + voice). Voice via Web Speech API by default
- Auto window split when two major intents diverge (threshold 0.75). Manual “move group to new window” action included
- Privacy: no content reading in MVP. RAG is gated for later

Requirements
- Chrome stable (no flags required)
- If fallback is needed: a Firebase project and Gemini API key

Load the extension (Chrome stable)
1) Open chrome://extensions
2) Enable “Developer mode”
3) Click “Load unpacked”
4) Select the extension directory: clarity-ai/extension
5) Click the toolbar icon or use the command Ctrl+Shift+Y to open the side panel

Permissions explained
- tabs, tabGroups: to read titles/URLs and manage groups
- sidePanel: to show the UI
- storage: to persist groups/settings
- activeTab, scripting: minor actions and future RAG ability (disabled)
- host_permissions: "<all_urls>" so we can organize any tab; MVP does NOT read page contents

Prompt API fallback (Firebase)
If Chrome’s local Prompt API is unavailable, the AI client will POST to this Cloud Function:
- Endpoint: https://asia-south1-chrome-built-in-ai-chall-592d2.cloudfunctions.net/clarityAiPrompt
- Model: gemini-1.5-flash (fast + cost-effective)
- Payload: minimal metadata (titles, host, path tokens). No full URLs, no query strings

Setup Firebase fallback
You only need this if the local model isn’t available.

1) Install tools
- Node.js 20+
- Firebase CLI: npm i -g firebase-tools

2) Initialize and install deps
- cd clarity-ai/firebase/functions
- npm install

3) Provide Gemini API Key
- Production: set the functions env var
  firebase functions:config:set gemini.key="YOUR_GEMINI_API_KEY"
  (or use Secret Manager if preferred)
- Local emulation (Windows PowerShell):
  $env:GEMINI_API_KEY="YOUR_GEMINI_API_KEY"; npm run serve
- Local emulation (Windows cmd.exe):
  set GEMINI_API_KEY=YOUR_GEMINI_API_KEY && npm run serve
- Local emulation (macOS/Linux bash):
  export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"; npm run serve

4) Deploy (optional, if not using emulator)
- cd clarity-ai/firebase/functions
- npm run deploy
- Ensure your default project is set to chrome-built-in-ai-chall-592d2 or create a .firebaserc mapping that project. If you deploy to a different project/region, update the endpoint in [ai-client.js](extension/src/shared/ai-client.js:1)

Using the side panel
- Groups auto-update after tab churn (debounced ~700ms)
- Click a group to see its summary, connections, and suggestions
- Chat understands your current group context (labels/summaries/titles only)
- Use the mic to dictate; the panel uses Web Speech API by default

Keyboard shortcuts
- Toggle side panel: Ctrl+Shift+Y
- Move selected group to a new window: Ctrl+Shift+M

Notes on voice
- Web Speech API is used by default for speech-to-text. No extra extension permission is required for this path
- If a future Prompt API speech path is available in your Chrome version, the AI client will use it when possible

Privacy posture
- MVP does not read page content. Future RAG will be opt-in per-site and gated
- Fallback requests do not include full URLs or query strings; titles/hosts/path tokens only
- No telemetry or analytics

Troubleshooting
- Side panel doesn’t open: confirm side panel permission is enabled and the action was clicked at least once
- No grouping happening: open a few tabs and wait ~1–2s. Check background logs: chrome://extensions → Inspect views (Service Worker)
- Prompt API errors: check if local Prompt API is exposed (window.ai or chrome.ai). If not, ensure Firebase fallback is deployed and reachable
- Function 500/timeout: verify GEMINI_API_KEY is set and your project region is asia-south1 (or update the endpoint in [ai-client.js](extension/src/shared/ai-client.js:1))

Roadmap (post-MVP)
- RAG: gated content script extraction and per-site consent
- Richer suggestion actions (merge groups, pin, rename)
- Settings UI for per-site RAG opt-in and fallback toggles
- Streaming responses and partial UI updates