# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Tampermonkey **userscript** that runs on WhatsApp Web, reads chats under manually-applied WhatsApp **labels (tags)**, and POSTs each lead to a **Base44 CRM** webhook. The whole tool is `whatsapp-leads-sync.user.js` (one IIFE, ~800 lines, Hebrew comments). `docs/base44-endpoint.md` is a reference for the server side the user adapts themselves.

There is no build, no package manager, no test runner. It is plain browser JS delivered as a `.user.js`.

## Commands

```bash
node --check whatsapp-leads-sync.user.js     # only "build"/lint available — syntax check
```

"Tests" are manual, in the browser: install in Tampermonkey, open web.whatsapp.com, use the panel. The script logs `[Leads Sync] vX.Y.Z נטען` on load — if that line is absent from the console, the script itself isn't running (usually a failed `@require`).

## Non-negotiable invariants

These define the product and must never be violated when editing:

- **READ-ONLY against WhatsApp.** Only `WPP.labels.getAllLabels()` and `WPP.chat.list()` are allowed. Never send messages, never create/modify labels. This is what keeps the user's number from being banned. Sync runs on explicit click only, with a human-paced delay between sends (`SEND_DELAY_MIN_MS`/`MAX_MS`).
- **No secrets in the repo.** All config (`WEBHOOK_URL`, `SHARED_SECRET`, selected labels, DRY_RUN) lives in GM storage, set via the in-panel settings form. The repo is public; keep it secret-free.
- **No phone numbers persisted or leaked locally.** No client-side dedup storage, no `localStorage`/`sessionStorage`/cookies. Phones appear only masked (`maskPhone`) in console and the panel; the raw phone goes over the wire only inside the HTTPS POST body. Names rendered in the panel must go through `escapeHtml`. The response body is never logged (could echo PII).
- **`DRY_RUN` defaults to `true`** — never silently flip the default to live sending.

When editing, after any change re-run the grep checks the session uses:
`grep -nE "document\.cookie|localStorage|sessionStorage"` (expect none) and confirm no unmasked `lead.phone`/`l.phone` reaches `console.*` or `innerHTML`.

## Architecture (the big picture)

The IIFE is organized top-to-bottom as: storage/config → privacy helpers → menu commands → `waitForWPP` → lead collection → POST → sync flow → GUI → init.

- **Config (`STORE`, `cfg`)** — `cfg` is a getter object over GM storage. Selected tags are stored as `cfg_labels` (JSON `[{id,name}]`); `cfg.selectedLabels` reads it and **migrates** from the legacy single `cfg_label_name` if present. `ALL_STORE_KEYS = Object.values(STORE)` powers the "clear data" command, so any new key added to `STORE` is automatically wiped.
- **`waitForWPP()`** — polls `window.WPP.isReady`. `WPP` comes from the `@require`d wa-js bundle. Because the script runs with `@grant`, it lives in Tampermonkey's sandbox, so `WPP` is **not** visible from the page DevTools console — diagnostics must run inside the script (the "בדיקת תגיות" / `runLabelDiagnostics` command exists for exactly this).
- **`collectLeads(WPP, labelsOverride)`** — resolves selected label ids (by id, falling back to name match), unions all chats carrying any selected label, dedups by phone, and attaches the matched label name(s). `labelsOverride` lets the preview run on the currently-checked-but-unsaved selection. Phone = `chat.id.user` + `+` (already canonical international, no manual normalization); groups (`g.us`) are skipped.
- **`chatHasLabel(chat, labelId)`** — ⚠️ the fragile spot. How a chat exposes its labels varies between wa-js versions; this function normalizes several shapes and is marked with a `TODO`. If sync/preview returns 0 leads, this is the first suspect — run `runLabelDiagnostics` and inspect the logged `chat.labels` shape.
- **`postLead(lead)`** — enforces HTTPS, builds the JSON body (`phone, name, labels, source, synced_at`), signs `timestamp + "." + body` with **HMAC-SHA256** (`hmacSignHex`), and sends via `GM_xmlhttpRequest` with `X-Timestamp`/`X-Signature` headers. The shared secret is the HMAC key and is **never transmitted**. Keep the signed string and body byte-identical to what `docs/base44-endpoint.md` documents, or server verification breaks.
- **GUI (`ui` object)** — a floating launcher button + panel built inside a **Shadow DOM** (`UI_CSS` + `UI_HTML`), deliberately isolated so WhatsApp's CSS and our styles don't collide and we never touch WhatsApp's own DOM (robustness + low detection surface). All user actions route through `ui` methods (`syncLeads`, `runLabelDiagnostics`, `clearLocalData`, `loadLabels`, `previewLeads`, `saveSettings`, `refresh`). `syncLeads` renders status/results into the panel. Tampermonkey menu commands are thin fallbacks that mostly open the panel.

## Conventions

- Comments and user-facing strings are in **Hebrew (RTL)**; match that when editing.
- Bump `@version` on every behavioral change and update the `vX.Y.Z נטען` startup log to match — Tampermonkey auto-update keys off `@version` via `@updateURL`/`@downloadURL` (raw GitHub `main`).
- `@require` points at the **jsDelivr** mirror of wa-js (redirect-free); avoid the GitHub release download URL, whose S3 redirect can make Tampermonkey fail to load the require (which aborts the whole script).
- `@connect base44.app` gates the POST host; changing the CRM domain requires updating it.
- Commit only when asked; the user drives `git push` to `strugo7/whatsapp-leads-sync` (public).
