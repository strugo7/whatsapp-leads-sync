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

- **READ-ONLY against WhatsApp.** Only `WPP.labels.getAllLabels()` and `WPP.chat.list()` are allowed. Never send messages, never create/modify labels. This is what keeps the user's number from being banned. Sync runs on explicit click only, with a human-paced delay between sends (`SEND_DELAY_MIN_MS`/`MAX_MS`). The CSV export reads WhatsApp's **IndexedDB** directly as a wa-js-independent fallback — strictly read-only: `openIdb` does `indexedDB.open(name)` **without a version** (never creates/upgrades; `onupgradeneeded` aborts), `readonly` transactions only. `openWaModelDb` finds the DB holding `contact`+`label` stores (usually `model-storage`). The export is **label-scoped**: `collectLabeledLeads` reads `label-association` (`{labelId, associationId, type}`), filters to the selected `labelId`s, skips groups (`@g.us`), then `get(contact, associationId)` per lead. **WhatsApp now uses LID**: a contact's `id`/key is `…@lid` (not a phone) and the real phone is the separate `phoneNumber` field (`…@c.us`) — see `waPhoneFromJid`. `loadLabels` also falls back to `readIdbLabels` when wa-js can't reach ready, so labels remain selectable.
- **No secrets in the repo.** All config (`WEBHOOK_URL`, `SHARED_SECRET`, selected labels, DRY_RUN) lives in `localStorage` (via the `store` wrapper, `wals_`-prefixed keys), set through the in-panel settings form. The repo is public; keep it secret-free.
- **No phone numbers persisted or leaked locally.** No client-side dedup storage; `localStorage` holds config only, never phones. No cookies/`sessionStorage`. Phones appear only masked (`maskPhone`) in console and the panel; the raw phone goes over the wire only inside the HTTPS POST body. Names rendered in the panel must go through `escapeHtml`. The response body is never read/logged (could echo PII).
  - **Documented exception — CSV export (`ui.exportContactsCsv`).** The user-triggered "ייצוא אנשי קשר ל-CSV" button downloads a CSV containing **full phone numbers** to the user's own disk, by explicit click. This is a deliberate, user-approved exception to "no phones persisted locally" — it exists to verify contact data when wa-js can't reach `ready`. The exception is scoped to the downloaded file only: the panel preview and all `console.*` output for this feature stay masked (`maskPhone`). Do not widen it (no auto-export, no phones in console/panel/`localStorage`).
- **`DRY_RUN` defaults to `true`** — never silently flip the default to live sending.

When editing, after any change re-run the grep checks the session uses:
confirm no unmasked `lead.phone`/`l.phone` reaches `console.*` or `innerHTML`, and that `localStorage` is only touched by the `store` wrapper for config keys (never phones).

## Architecture (the big picture)

**Critical: the script runs with `@grant none`** so that wa-js initializes in the **page's main world**. Under `@grant` (Tampermonkey sandbox) on modern Chrome/MV3, wa-js cannot hook WhatsApp's webpack and `WPP.isReady` never flips — the tool silently fails. `@grant none` is the deliberate, load-bearing choice and must not be reverted to add GM APIs. Consequences baked into the architecture: no GM_* (so storage is `localStorage`, POST is `fetch`, no menu commands), and `@connect` is gone.

The IIFE is organized top-to-bottom as: storage/config → privacy helpers → diagnostics → `waitForWPP` → lead collection → POST → sync flow → GUI → init.

- **Config (`STORE`, `cfg`, `store`)** — `store` is a small `localStorage` wrapper (`wals_` prefix, JSON values); `cfg` is a getter object over it. Selected tags are stored as `cfg_labels` (JSON `[{id,name}]`); `cfg.selectedLabels` reads it and **migrates** from the legacy single `cfg_label_name` if present. `ALL_STORE_KEYS = Object.values(STORE)` powers the "clear data" command, so any new key added to `STORE` is automatically wiped.
- **`waitForWPP()`** — waits for `window.WPP` (page-world, from the `@require`d wa-js bundle) then resolves via the official `WPP.onReady(cb)` (wa-js 4.x has **no** `waitReady`), falling back to `isReady` polling. It distinguishes "WPP never appeared (require/context failure)" from "loaded but not ready in time". Under `@grant none`, `WPP` is directly usable from the page DevTools console too.
- **`collectLeads(WPP, labelsOverride)`** — resolves selected label ids (by id, falling back to name match), unions all chats carrying any selected label, dedups by phone, and attaches the matched label name(s). `labelsOverride` lets the preview run on the currently-checked-but-unsaved selection. Phone = `chat.id.user` + `+` (already canonical international, no manual normalization); groups (`g.us`) are skipped.
- **`chatHasLabel(chat, labelId)`** — ⚠️ the fragile spot. How a chat exposes its labels varies between wa-js versions; this function normalizes several shapes and is marked with a `TODO`. If sync/preview returns 0 leads, this is the first suspect — run `runLabelDiagnostics` and inspect the logged `chat.labels` shape.
- **`postLead(lead)`** — enforces HTTPS, builds the JSON body (`phone, name, labels, source, synced_at`), signs `timestamp + "." + body` with **HMAC-SHA256** (`hmacSignHex`), and sends via `fetch` (`mode: cors`) with `X-Timestamp`/`X-Signature` headers. The shared secret is the HMAC key and is **never transmitted**. Because it's a browser `fetch`, the Base44 endpoint **must return CORS headers and handle the OPTIONS preflight** (the custom headers force one) — documented in `docs/base44-endpoint.md`. Keep the signed string/body byte-identical to that doc or verification breaks.
- **GUI (`ui` object)** — a floating launcher button + panel built inside a **Shadow DOM** (`UI_CSS` + `UI_HTML`), deliberately isolated so WhatsApp's CSS and our styles don't collide and we never touch WhatsApp's own DOM (robustness + low detection surface). All user actions route through `ui` methods (`syncLeads`, `runLabelDiagnostics`, `clearLocalData`, `loadLabels`, `previewLeads`, `saveSettings`, `refresh`). `syncLeads` renders status/results into the panel. There are no Tampermonkey menu commands (no GM under `@grant none`) — the panel is the only entry point.

## Conventions

- Comments and user-facing strings are in **Hebrew (RTL)**; match that when editing.
- Bump `@version` on every behavioral change and update the `vX.Y.Z נטען` startup log to match — Tampermonkey auto-update keys off `@version` via `@updateURL`/`@downloadURL` (raw GitHub `main`).
- `@require` points at the **jsDelivr** mirror of wa-js (redirect-free); avoid the GitHub release download URL, whose S3 redirect can make Tampermonkey fail to load the require (which aborts the whole script).
- The POST target is whatever `WEBHOOK_URL` the user configures; there is no `@connect` (none needed under `fetch`/`@grant none`). The CRM domain only matters for the endpoint's CORS `Access-Control-Allow-Origin`.
- Commit only when asked; the user drives `git push` to `strugo7/whatsapp-leads-sync` (public).
