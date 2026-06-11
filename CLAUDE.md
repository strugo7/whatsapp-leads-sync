# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Tampermonkey **userscript** that runs on WhatsApp Web, reads chats under manually-applied WhatsApp **labels (tags)** directly from WhatsApp's **IndexedDB** (READ-ONLY), and POSTs each lead to a **Base44 CRM** webhook via `GM_xmlhttpRequest`. The whole tool is `whatsapp-leads-sync.user.js` (one IIFE, ~1000 lines, Hebrew comments). `docs/base44-endpoint.md` is a reference for the server side the user adapts themselves.

There is no build, no package manager, no test runner. It is plain browser JS delivered as a `.user.js`.

## Commands

```bash
node --check whatsapp-leads-sync.user.js     # only "build"/lint available — syntax check
```

"Tests" are manual, in the browser: install in Tampermonkey, open web.whatsapp.com, use the panel. The script logs `[Leads Sync] vX.Y.Z נטען` on load — if that line is absent from the console, the script itself isn't running.

## Non-negotiable invariants

These define the product and must never be violated when editing:

- **READ-ONLY against WhatsApp.** The script never sends messages and never creates/modifies labels. It reads WhatsApp's **IndexedDB** directly — strictly read-only: `openIdb` does `indexedDB.open(name)` **without a version** (never creates/upgrades; `onupgradeneeded` aborts), `readonly` transactions only. `openWaModelDb` finds the DB holding `contact`+`label` stores (usually `model-storage`). Lead collection is **label-scoped**: `collectLabeledLeads` reads `label-association` (`{labelId, associationId, type}`), filters to the selected `labelId`s, skips groups (`@g.us`), then `get(contact, associationId)` per lead. **WhatsApp uses LID**: a contact's `id`/key is `…@lid` (not a phone) and the real phone is the separate `phoneNumber` field (`…@c.us`) — see `waPhoneFromJid`. Sync runs on **explicit click only**, with a human-paced delay between sends (`SEND_DELAY_MIN_MS`/`MAX_MS`).
- **No secrets in the repo.** All config (`WEBHOOK_URL`, the API key in `SHARED_SECRET`, selected labels, DRY_RUN) lives in `localStorage` (via the `store` wrapper, `wals_`-prefixed keys), set through the in-panel settings form. The repo is public; keep it secret-free.
- **No phone numbers persisted or leaked locally.** No client-side dedup storage; `localStorage` holds config only, never phones. No cookies/`sessionStorage`. Phones appear only masked (`maskPhone`) in console and the panel; the raw phone goes over the wire only inside the HTTPS POST body. Names rendered in the panel must go through `escapeHtml`. The response body is never read/logged (could echo PII).
  - **Documented exception — CSV export (`ui.exportContactsCsv`).** The user-triggered "ייצוא אנשי קשר ל-CSV" button downloads a CSV containing **full phone numbers** to the user's own disk, by explicit click. This is a deliberate, user-approved exception to "no phones persisted locally". The exception is scoped to the downloaded file only: the panel preview and all `console.*` output for this feature stay masked (`maskPhone`). Do not widen it (no auto-export, no phones in console/panel/`localStorage`).
- **`DRY_RUN` defaults to `true`** — never silently flip the default to live sending.
- **Manual lead selection is NOT local dedup.** When the panel lets the user pick which leads to send, nothing about "who was already sent" is **persisted** — the user decides each time. The server `upsert` (by phone) remains the only dedup. The panel does mark just-sent rows (gold, 50% opacity) via an **in-memory** `_sent` Set for the current loaded list only; it is never written to `localStorage` and is lost on refresh/reload — so this is not local dedup storage.
- **Panel position is persisted in `STORE`.** If the floating panel/button becomes draggable, its position is stored under a `STORE` key (viewport percentages), so "clear data" wipes it via `ALL_STORE_KEYS`.

When editing, after any change re-run the grep checks the session uses:
confirm no unmasked `lead.phone`/`l.phone` reaches `console.*` or `innerHTML`, and that `localStorage` is only touched by the `store` wrapper for config keys (never phones).

## Architecture (the big picture)

**The script runs with `@grant GM_xmlhttpRequest` + `@connect base44.app`.** `GM_xmlhttpRequest` is the deliberate, load-bearing choice: it **bypasses WhatsApp Web's CSP**, which blocks `fetch` to external domains like `base44.app`. The `@connect` directive must list the **host only** (`base44.app`, not a full URL) or Tampermonkey blocks the request. There are no Tampermonkey menu commands — the panel is the only entry point. IndexedDB reads work from the same origin regardless.

The IIFE is organized top-to-bottom as: storage/config → privacy helpers → diagnostics → IndexedDB read helpers → lead collection → POST → sync flow → GUI → init.

- **Config (`STORE`, `cfg`, `store`)** — `store` is a small `localStorage` wrapper (`wals_` prefix, JSON values); `cfg` is a getter object over it. Selected tags are stored as `cfg_labels` (JSON `[{id,name}]`); `cfg.selectedLabels` reads it and **migrates** from the legacy single `cfg_label_name` if present. `ALL_STORE_KEYS = Object.values(STORE)` powers the "clear data" command, so **any new key added to `STORE` is automatically wiped** — always add new persisted keys to `STORE`.
- **IndexedDB readers** — `openWaModelDb` locates the DB containing `contact`+`label`; `readIdbLabels` returns `[{id,name,color}]`; `collectLabeledLeads` joins `label-association` → `contact` and returns `{phone,name,labels,raw_id}`; `waPhoneFromJid` extracts a `+E164` phone from a `…@c.us` jid (returns null for `@lid`/`@g.us`). `runLabelDiagnostics` (the "בדיקה" button) prints stores + labels + a masked sample lead.
- **`collectLeads(labelsOverride)`** — resolves selected label ids (by id, falling back to name match), calls `collectLabeledLeads`, and returns leads with `{phone, wid, name, labels}`. `labelsOverride` lets the preview run on the currently-checked-but-unsaved selection.
- **`postLead(lead)`** — enforces HTTPS, builds the JSON body (`phone, name, labels, source, labeledAt`), and sends via `GM_xmlhttpRequest` with an **`x-api-key`** header carrying the configured secret. Auth is **api-key** (the secret is sent directly over HTTPS); there is no HMAC signing and no CORS/preflight (GM bypasses CORS). The response body is never read (could echo PII) — only the status code. Keep the body shape in sync with `docs/base44-endpoint.md`.
- **GUI (`ui` object)** — a floating launcher button + panel built inside a **Shadow DOM** (`UI_CSS` + `UI_HTML`), deliberately isolated so WhatsApp's CSS and our styles don't collide and we never touch WhatsApp's own DOM (robustness + low detection surface). All user actions route through `ui` methods (`syncLeads`, `runLabelDiagnostics`, `clearLocalData`, `loadLabels`, `previewLeads`, `exportContactsCsv`, `saveSettings`, `refresh`). `syncLeads` renders status/results into the panel via `showLeadsTable`.

## Conventions

- Comments and user-facing strings are in **Hebrew (RTL)**; match that when editing.
- Bump `@version` on every behavioral change and update the `vX.Y.Z נטען` startup log to match — Tampermonkey auto-update keys off `@version` via `@updateURL`/`@downloadURL` (raw GitHub `main`).
- The POST target is whatever `WEBHOOK_URL` the user configures; its host must be covered by `@connect`. Base44 auth is the `x-api-key` header; the endpoint validates it (see `docs/base44-endpoint.md`).
- Commit only when asked; the user drives `git push` to `strugo7/whatsapp-leads-sync` (public).
