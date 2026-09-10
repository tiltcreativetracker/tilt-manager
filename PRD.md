# Tilt Creative Tracker — Product Requirements Document

> **Source of truth** for the single-file HTML app at `index.html`. This document describes the app *as built* and is intended to be the PRD for future work. When the code and this doc disagree, fix one of them — don't leave them out of sync.

---

## 1. Overview

**Tilt Creative Tracker** is a video-asset workflow tool for a creative team producing short-form videos across four markets (UK, IT, ES, US). It centralises:

- Asset tracking through an approval pipeline
- Editor workload scheduling
- Footage QC and category-head QC review
- Slack-based notifications, batched and routed per country / role / category
- Per-country campaign and sub-campaign management

It replaces a fragmented mix of spreadsheets, DM threads, and ad-hoc Slack pings with one shared queue that mirrors the team's actual workflow.

### Primary problem solved
Creative output for paid social is a high-throughput, multi-stakeholder pipeline (editor → footage QC → category-head QC → PM → release). Without a single tracker, work slips between editors, category heads miss reviews, and PMs cannot see what is ready to deploy. Tilt Creative Tracker gives every role one queue and pushes the right notification to the right Slack channel at the right time.

### Primary success metric
**200 approved UK Paid Ads videos per month** (10/day target, surfaced as a pace pill on the Today and Daily Log tabs).

---

## 2. Tech Stack & Architecture

| Layer | Choice |
|---|---|
| Frontend | Vanilla JS, single `index.html` (~10K lines, inline CSS + JS) |
| Auth | Firebase Auth (Google sign-in, restricted to `@tilt.app` domain; **SESSION persistence** — sign-in is required every time the app is opened) |
| Cloud sync | Firebase Firestore (`state/app` document + `state/app/assets/{id}` subcollection) |
| Local persistence | **None** — localStorage is not used. Firestore is the sole store. |
| Notifications | Slack Incoming Webhooks |
| External links | Google Drive + Notion URLs (stored as text, not embedded) |
| Fonts | Inter Tight + JetBrains Mono via Google Fonts |
| Build step | None |
| Backend code | None — all business logic runs in the browser |

### Architectural shape

- One global `STATE` object in memory.
- Every mutation re-renders the whole app (debounced for typing).
- Every mutation calls `saveState()` which schedules a debounced Firestore write (600ms). There is no localStorage write anywhere. Firestore is the sole authoritative store.
- Firestore writes use a **batch commit**: the main `state/app` document (campaigns, config, etc.) and any changed/deleted asset documents in the `state/app/assets` subcollection are written atomically in one batch. Only assets that have actually changed (diffed by JSON comparison) are included in the batch.
- A Firestore listener on `state/app` pulls remote snapshots back into `STATE` via `Fb.applySnapshot`. A second listener on the `state/app/assets` subcollection keeps `STATE.assets` in sync in real time. Both listeners reject `fromCache: true` snapshots (stale IndexedDB) — only server-confirmed data is ever applied. Incoming snapshots are deferred while a local upload is pending (up to 2s, 8 retries × 250ms) so in-flight edits are never overwritten by a simultaneous sync from another browser. **Conflict resolution is per-field, not blanket last-write-wins** — see §2.2 for the per-field merge rules that protect fresh additions from stale-tab overwrites.
- If the Firestore write fails, a red toast shows the error. Upload is retried with exponential backoff (3s → 8s → 20s → 60s cap). If the device is offline, the toast reads **"Upload failed: Offline"**.
- A **sync indicator** in the topbar shows real-time Firestore status. It transitions as follows: "Saving…" (spinner) appears immediately when any change is queued (before the 600ms debounce fires); "✓ All changes saved" (green) for 2.5s after Firestore confirms the write; "⚠ Save failed — retrying…" if Firestore is temporarily unreachable; "⚠ Save failed" on quota exhaustion or if the user is not signed in. If `uploadNow()` finds no diff (nothing actually changed), the indicator returns to idle without showing any status.
- An **offline indicator** in the topbar shows a persistent amber **⚡ Offline** chip when the device loses network (`window.offline` event). When the connection is restored, the chip is replaced by a green **✓ Back Online** chip that fades out after 3 seconds. On reconnect `scheduleUpload()` is called immediately to flush any pending changes.
- **Offline data safety**: when the connection drops mid-session, Firestore subscriptions go quiet — no new snapshots fire. `fromCache` snapshots are blocked. STATE stays untouched in memory. When reconnected, pending local changes are uploaded before any incoming remote snapshot can apply (`_pendingLocalJson` guard in `applySnapshot`).
- A **presence system** shows who else has the tracker open in real time (see §2.1).
- If Firestore is unreachable on initial load, the app shows a warning banner with the exact error. STATE stays as-is in memory — no data is deleted.

### 2.1 Presence system

Who's online is shown as a row of avatar circles in the topbar, matching the Google Sheets "collaborators" indicator.

- **Storage**: each signed-in user writes a `presence/{uid}` document to Firestore containing their display name, current tab, active campaign ID, and a `lastSeen` timestamp.
- **Heartbeat**: updated every 30 seconds and on every tab/campaign navigation. Deleted on `beforeunload`.
- **Stale threshold**: users not seen within 2 minutes are treated as offline and hidden from the stack.
- **Avatars**: up to 5 shown; any beyond 5 collapse into a "+N" chip. Each avatar is colour-coded deterministically from the user's UID (10 preset colours). Initials are first + last initial of the display name.
- **Tooltip**: hovering an avatar shows the person's name and their current location (e.g. "Today tab", "UK · Campaign Name").
- **DOM update**: the `.presence-stack` wrapper is always rendered in the topbar. The `Presence._updateDom()` method sets `innerHTML` directly — no full `render()` call — so presence updates never trigger a re-render loop.

### 2.2 Multi-tab & cross-device sync

Every open tab (yours in another window, a teammate in another city) is a live view onto the same Firestore doc. Local edit → mutate `STATE` → re-render → debounced upload (600ms; category adds flush immediately) → Firestore fans out → every other tab's `onSnapshot` fires → `applySnapshot` merges into their `STATE` → they re-render. End-to-end latency is typically **200–500ms globally**. Your own tab's echo is skipped via `hasPendingWrites`.

**The core race problem.** Every `saveState()` uploads the WHOLE `state/app` doc from that browser's in-memory `STATE`. When two tabs edit in parallel, the last writer's blob overwrites the first writer's blob field-by-field. A teammate saving a video edit could silently wipe a category, grade, or Slack channel URL you just set in a different tab — because their upload carried their stale copy of that field. The disappearing-categories bug (2026-09-07) was the most visible symptom.

**Per-field merge rules** (applied in `Fb.applySnapshot`, after the generic `STATE[k] = data[k]` overwrite pass, with the affected keys skipped in that pass):

| Field | Merge rule |
|---|---|
| `categories`, `categoriesOrganic` | Union by lowercase name; incoming order preserved, local-only entries appended after |
| `sellers`, `products` | Union by lowercase string; incoming first, local-only appended |
| `countries` | Union by `code`; incoming first, local-only appended |
| `campaigns` | Union by `id` when `nextCampaignId` isn't stale; incoming wins on same-id (edits still last-write-wins per campaign, but fresh CREATIONS never disappear) |
| `grades` | Union by `id`; on same-id conflict newer `updatedAt` wins |
| `scorecardMeta` | Per-editor, per-field merge; local overrides on conflict (protects a just-set target from a stale echo) |
| `editorSlackChannels`, `editorSlackIds`, `categoryHeadSlackIds`, `pmSlackIds`, `categoryHeadOverrides`, `qcWebhooks`, `countryWebhooks` | Per-key: non-empty local beats empty incoming; otherwise incoming (last-writer for intentional edits) |
| `metaAdAccountIds` | Fixed 4-slot array; per-slot non-empty local beats empty incoming |
| `qcDismissed` | Union of `true` flags (a stale save can't un-dismiss a video another tab just dismissed) |
| `gradingStreak` | `best = max(local, incoming)`; `last`/`count` pair whichever side has the more recent `last` date |
| `pendingBatches` | Per-recipient union of items by id; batch metadata (`firstQueuedAt`, `sendingSince`) prefers incoming |
| `nextAssetId`, `nextCampaignId`, `nextBatchItemId` | `Math.max` (monotonic — a stale writer's lower counter never rolls ours back) |
| `deletedCampaignIds` | `{id: ts}` tombstone ledger, unioned and pruned to a 24h window. `campaigns` merge drops any id in the ledger before returning — so a stale tab that still has a just-deleted campaign in its local STATE can't resurrect it on next upload. |
| `recentNotifKeys` | Union by `key` keeping newest `ts`, pruned to the recency window |
| `dailyThreads`, `catHeadDailyThreads`, `intlDailyThread`, `organicDailyThread`, `contentLeadDailyThreads` | Per-slot reconcile by `setAt` timestamp — the most-recently-set thread wins |
| `assets`, `assetCount` | Never applied from the main doc — the `state/app/assets/{id}` subcollection is the sole source of truth |
| `broll` | Never applied from the main doc — the `state/app/broll/{id}` subcollection is the sole source of truth |
| everything else | Direct overwrite (`STATE[k] = data[k]`) — matches every stored snapshot's existing shape |

**Trade-off:** because the merges are union-based, deleting an unused entry (category, seller, country) can be resurrected briefly if another still-open tab hadn't yet seen the delete when it uploaded. The user just deletes again. This is deliberate — silently losing ADDS was the far worse failure mode and is what the fix targets. **Exception**: campaign deletes have a dedicated 24h tombstone ledger (`deletedCampaignIds`) so they don't resurrect at all — same-day fix after the resurrection was reported on a very visible surface.

**Cross-tab update pill.** Every upload is stamped with a per-tab random UUID (`Fb._tabId`) in `_lastEditedByTab`. When an incoming snapshot arrives with a *different* tab id — meaning it came from another tab (yours in another window OR a teammate's) — a persistent pill appears top-right: **"N updates from [name] · Reload · ×"**. Data has already synced via `onSnapshot` (no reload needed to see it), so the pill is a comfort signal + one-click reload for anyone who wants a hard refresh. Rapid consecutive cross-tab writes batch into a single pill with a counter. Stays visible until you click Reload or ×; own-tab echoes never trigger it. Clicking Reload routes through `reloadPreservingView()` (see the reload-preserves-view row below), so the hard refresh lands back on the same tab and campaign rather than the Campaigns default.

**Category-add toast.** In addition to the pill, remote category additions get a specific bottom-right toast: *"New category added by [name]: [category]"*. Own adds are pre-marked as seen via `Fb._seenCategories` so this doesn't fire for your own writes.

**Per-user UI state is intentionally isolated** so a teammate's view doesn't hijack yours. Never uploaded to Firestore (kept in memory only, some in `localStorage` under the tracker key). Full list mirrored in both `buildSnapshot` (exclusion) and `applySnapshot`'s `PER_USER_UI_FIELDS` guard:
- Selection: current tab, active campaign, expanded countries, sidebar collapse/month filter, per-country type/month expand state (`sidebarTypeExpanded`, `sidebarMonthExpanded`), per-country type priority order (`sidebarTypeOrder`)
- Filters: status, editor, QC, search, date-approved / est-delivery, cat-review window, video weekly group
- Reporting choices: period, month, week offset, quarter, country, type, category, view, approval
- Editor Stats view: selected peer, badges collapsed, group collapse map
- Grading view: period, editor filter, custom entry, campaign, year, month, show-dismissed, type, week
- Clips tab UI: search, type/category/seller/product/tagged filters, show-archived / show-dismissed, done-strip height, right-panel width, selected clip, bulk selection, last sync stats

**Reload preserves the view** (`reloadPreservingView()`). Because per-user UI fields aren't in the Firestore snapshot, a plain `location.reload()` used to drop you back on the Campaigns tab / campaign #1 — losing whichever tab, campaign, and calendar month you were on. Both in-app reload paths (the cross-tab pill's Reload button and the auto-update version refresh) now call `reloadPreservingView()`, which stashes `{tab, activeSubCampaignId, calendarMonth, scrollY}` to `localStorage['tilt-view-prefs']` immediately before reloading. On boot, `hydratePersistedView()` reads the entry back before the first render (URL hash deep-links like `#campaign=…` still win) and then consumes it, so later navigation doesn't replay a stale view. Uses `localStorage` because the fields are deliberately excluded from the Firestore snapshot to protect a teammate's active view from yours — per-device is the right scope.

**Failure modes:**
- **Offline mid-edit** — writes queue locally, `⚡ Offline` chip appears. On reconnect: `scheduleUpload()` fires immediately; incoming remote snapshots are blocked until the local write completes (`_pendingLocalJson` guard).
- **Firestore unreachable on boot** — warning banner shown, STATE stays in-memory only, no writes accepted. `Fb._ready` is never set, so no data corruption.
- **Stale tab on old code** — the auto-update checker polls `index.html` every minute, detects a new content-hash on `app.js`, and auto-reloads once the tab is idle (no focused input, no open modal). Nobody sits on an outdated build for more than ~1 minute.

### Routing model
There is no router. Tabs in the topbar swap visible panels via state. Tab order is user-draggable and persisted in `STATE.tabOrder`.

### ID normalisation
Campaign and asset IDs are heterogeneous: seed records use plain integers, while records created or imported after initial load use prefixed strings (`c{n}` for campaigns, `a{n}` for assets). Two helper functions — `findCampaignById(id)` and `findAssetById(id)` — normalise both sides of every comparison with `String()`, so lookups are type-safe regardless of which ID format is stored. All HTML `onclick`/`onchange` handlers embed IDs as quoted strings (e.g. `App.selectCampaign('c7')`) to prevent JavaScript treating the ID as a variable reference. The `data-*` attributes on draggable elements (`data-asset-id`, `data-camp-id`) are read raw (no `parseInt`) for the same reason.

---

## 3. User Roles

Auth is gated to `@tilt.app` emails. Each user's role lives in Firestore at `users/<uid>.role` and is enforced client-side by `roleAtLeast()` (destructive controls) and `tabsForRole()` (which tabs render in the nav). Firestore rules re-enforce it server-side.

### 3.1 Role matrix

| Role | Chip colour | Rank | Sees these tabs | Purpose |
|---|---|---|---|---|
| **Viewer** | Neutral grey | 1 | Campaigns, Board, Cat Heads Review, Editing Calendar, Daily Log, Notifications, Reporting, Content | Default for first sign-ins. Read-mostly. Excluded from Grading, Automations, Config, Editor Stats. An admin promotes them from the Config → Team panel. |
| **Editor** | Green | 3 | Viewer tabs + Grading + **Editor Stats** (personal view only, gated by email) | The internal video editors (Zidni, Sharm, Patty). Bumped to rank 3 so `roleAtLeast('admin')` passes — they can edit anything on the tabs they see, no admin-only gates block them. |
| **PM** | Amber | 2 | Editor tabs minus Editor Stats | Project managers per country. |
| **Cat Head** | Accent purple | 2 | Every tab except Editor Stats | Category heads reviewing videos through the CH QC column. |
| **Content Lead** | Blue | 2 | Every tab except Editor Stats | Cross-category content lead (view-heavy). |
| **Admin** | Accent purple | 3 | Every tab including Editor Stats (with peer picker, when their email is in `EDITOR_STATS_VIEWERS`) | Founding admin owns Config / Automations / destructive controls. The bootstrap admin (`elsa@tilt.app`) can never be demoted. |

### 3.2 People currently in each role

| Role | People |
|---|---|
| Editors | **Zidni, Sharm, Patty** (Elsa is admin) |
| Category Heads | **Anand** (Sneakers), **Hanyan** (TCG), **Nazy** (Stone Island, Vintage, Bags and Accessories, Y2K, Jewellery, Health and Beauty), **Cristian** (Luxury) |
| PMs | One per country (UK, IT, ES, US) |
| Admin | **Elsa** (bootstrap admin; auto-promoted on sign-in via `Fb.BOOTSTRAP_ADMIN_EMAILS`) |

Auto-scheduling (the 3pm scheduler) treats **Zidni, Sharm, Patty** as auto-assigned and **Elsa** as manual-only (she receives reactive pings, not scheduled drops).

### 3.3 First-sign-in default

New profiles land as **Viewer** (was `editor` until 2026-07-30). `Fb.ensureUserDoc` writes `role: 'viewer'` on first upsert unless the email is in `BOOTSTRAP_ADMIN_EMAILS`. Admins promote from Config → Team panel — the dropdown saves immediately and the affected user's tabs update on their next render (no refresh needed).

### 3.4 Editor Stats access model (special-cased)

Two orthogonal lists gate the Editor Stats tab, on top of role visibility:

- `EDITOR_STATS_EDITORS` — names in the roster (currently `DAILY_LOG_EDITORS`: Zidni, Sharm, Patty). If your sign-in email maps here via `emailToEditor`, you see the tab with your own personal wrap card + badges, no picker, no peers.
- `EDITOR_STATS_VIEWERS` — email prefixes (currently `['elsa']`). Peer viewers get the tab with a picker to flip between rostered editors' cards. Non-viewer admins don't see the tab at all.

Both lookups require the `@tilt.app` domain (see `EDITOR_EMAIL_DOMAIN` guard); a same-prefix email from another domain won't slip through the impersonation gate.

---

## 4. Data Model

All entities live as arrays/objects on the global `STATE`. Identifiers are local IDs generated client-side.

### 4.1 Campaign (sub-campaign)
`STATE.campaigns[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string or number | Local UID. Seed data uses plain integers (`1`–`5`); campaigns created via the UI or imported from CSV use prefixed strings (`c7`, `c8`, …). All lookup functions normalise with `String()` so both forms work transparently. |
| `country` | string | One of UK/IT/ES/US |
| `rank` | number | Order within its country |
| `name` | string | e.g. "Privilege Supply – Luxury" |
| `brief` | string | Free text |
| `driveId` | string (URL) | Raw footage Drive link |
| `category` | string | Default category for new assets in this campaign |
| `type` | enum | "Paid Ads" \| "Organic" |
| `slackOverride` | string (URL) | Optional per-campaign webhook override |
| `monthYear` | string | Display tag |
| `hideAssetLinkCols` | boolean | Hides Drive/Brief columns in the asset table for this campaign |
| `finalVideos` | string (URL) | Campaign-level final videos folder/playlist link (e.g. Frame.io or Drive) |
| `igLink` | string (URL) | Instagram link — **Organic-only**. Field is hidden in the campaign modal when Type is Paid Ads, cleared on save if Type flips away from Organic, and the header pill is guarded by the same type check so a stale value can never render on a Paid Ads campaign. |
| `done` | boolean | Manually marked as done; shown with green left border and dimmed name in sidebar |

### 4.2 Asset (video)
`STATE.assets[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string or number | Local UID. Seed data uses plain integers (`1`–`20`); assets created via the UI or imported from CSV use prefixed strings (`a21`, `a22`, …). All lookup functions normalise with `String()` so both forms work transparently. |
| `pn` | number | Display number within campaign |
| `campaignId` | string | FK → Campaign |
| `name` | string | Asset/video name |
| `category` | string | One of `STATE.categories` |
| `difficulty` | enum | "Low" \| "Moderate" \| "High" \| "Max" |
| `editor` | string | One of Zidni/Sharm/Patty/Elsa, or empty |
| `status` | enum | Draft \| Assigned \| In Progress \| For Review \| Needs Revisions \| Approved \| Cancelled |
| `qc` | enum | Footage QC: Draft \| Missing files \| Missing prices \| Ready |
| `categoryHeadQc` | enum | Category head verdict: Draft \| For Review \| Needs Revisions \| Approved \| Cancelled |
| `chDateApproved` | string (YYYY-MM-DD) | Stamped when `categoryHeadQc` → Approved; cleared when it moves away |
| `rawVideo` | string (URL) | Drive link |
| `editingBrief` | string (URL) | Notion link |
| `finalVideo` | string (URL) | Final cut link |
| `sparksCode` | string | Sparks promotion code — only surfaced in the UI for IT, ES campaigns |
| `igLink` | string (URL) | Per-video Instagram post link. Column shows on every campaign regardless of country/type (was IT-only during the initial pilot). |
| `estDelivery` | string (YYYY-MM-DD) | ETA |
| `dateApproved` | string (YYYY-MM-DD) | Stamped on transition to Approved |
| `scheduledFor` | string (YYYY-MM-DD) | Stamped by the scheduler |
| `released` | boolean | Set when editor batch is sent |
| `version` | number | Bumped on each mutation |
| `assignedAt` | timestamp | Set when an editor is assigned |

### 4.3 Country
`STATE.countries[]` — 4 entries (UK, IT, ES, US) with flag styling. Poland was removed 2026-09-07; a one-shot migration in `applySnapshot` strips any lingering `PL` entry from live Firestore state on next load.

### 4.4 Category
`STATE.categories[]` — user-managed. Seeded in this canonical display order: **Sneakers, TCG, Stone Island, Luxury, Vintage, Bags and Accessories, Y2K, Streetwear, Health and Beauty, Jewellery** (Essentials and BTS retained at the end for backward compatibility). Each has a colour pair (bg/fg). Each category resolves to a Category Head via the `CATEGORY_HEADS` map. On first load after this change, existing `STATE.categories` arrays are automatically reordered to match and Streetwear is added if missing.

### 4.5 Pending notification batches
`STATE.pendingBatches{}` — keyed by recipient:

- `Zidni` / `Sharm` / `Patty` / `Elsa` — editor batches
- `PM:UK` / `PM:IT` / `PM:ES` / `PM:US` — PM "For Review" queues
- `CHQ:<category>` — Category Head QC batches
- `CHA:<country>` — Category Head Approved batches

Each value: `{ items: [...], firstQueuedAt: timestamp | null }`.

### 4.6 Brief entry
`STATE.briefs[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Prefixed string `b{n}` |
| `notionUrl` | string (URL) | Notion brief link (required) |
| `rawFileUrl` | string (URL) | Drive / Dropbox raw file link (optional) |
| `notes` | string | Free-text context (optional) |
| `submittedBy` | string | Display name or email of submitter |
| `submittedAt` | timestamp | `Date.now()` at submission |
| `acknowledged` | boolean | Set by admin via "Mark seen" |

`STATE.nextBriefId` — integer counter for generating `b{n}` IDs.
`STATE.briefsWebhookUrl` — Slack webhook for brief-ready alerts (falls back to global `webhookUrl`).

### 4.7 Other state
- `STATE.sentNotifications[]` — history, capped at **20**.
- `STATE.activityLog[]` — actor / tag / message / timestamp, capped at **200**.
- `STATE.editorSlackIds`, `STATE.categoryHeadSlackIds`, `STATE.pmSlackIds` — `{ name: 'U…' }` maps for @-mentions.
- `STATE.briefsWebhookUrl` — Slack webhook for brief-ready alerts; falls back to `webhookUrl`. Configured in the Automations tab.
- `STATE.webhookUrl` — global fallback Slack webhook.
- `STATE.countryWebhooks` — per-country editor/PM routing.
- `STATE.categoryHeadWebhook` — single unified CHQ route.
- `STATE.qcWebhooks` — per-country QC report routing.
- `STATE.tabOrder` — user-draggable tab order.
- `STATE.sidebarMonthFilter` — `'all'` \| `'YYYY-MM'` \| `'none'`.
- `STATE.dailyThreads` — `{ Zidni, Sharm, Patty, Elsa }` — per-editor daily thread `{ date, url, channelId, threadTs, setAt }`. Cleared at midnight.
- `STATE.dailyThreadHistory` — last 7 archived thread URLs per editor.
- `STATE.catHeadDailyThreads` — per-category daily thread, keyed by category name. Same shape as `dailyThreads`.
- `STATE.catHeadDailyThreadHistory` — last 7 archived thread URLs per category.
- `STATE.intlDailyThread` — single shared thread for IT/ES/US traffic. Same shape.
- `STATE.intlDailyThreadHistory` — last 7 archived intl thread URLs.
- `STATE.organicDailyThread` — single shared thread for **UK Organic** traffic (Millie + Rivers both watch). Same shape. Not used for intl Organic.
- `STATE.organicDailyThreadHistory` — last 7 archived Organic thread URLs.
- `STATE.contentLeadDailyThreads` — legacy per-lead (Millie/Rivers) map, kept in the schema so old snapshots load cleanly. Any today-dated slot is auto-migrated into `organicDailyThread` on load; the sweep archives the stale entries at UK midnight.
- `STATE.grades[]` — one grade row per graded asset (§5.8). Shape: `{ id, assetId, video, editor, date, contentType ('Net New' | 'Maintenance'), brandPass, qaClean, newIdea, revisionRounds, roundsManual, dismissed, createdAt/By, updatedAt }`. Persisted to Firestore.
- `STATE.scorecardMeta` — `{ editor: { avgVideosPerDay, targetPerDay } }` for the scorecard's Output pillar. Persisted.
- `STATE.gradingStreak` — `{ last (UK date), count, best }` shared grading streak. Persisted.
- Grading UI filters (per-user, **not** synced): `gradingYear`, `gradingMonth`, `gradingCampaignId`, `gradingType` (`'all' | 'Paid Ads' | 'Organic'`), `gradingWeek` (Monday ISO or null), `gradingShowDismissed`.

---

## 5. Screens / Tabs

All tabs are drag-reorderable in the topbar; order is persisted.

### 5.1 Campaigns (default)
- **Sidebar**: countries grouped, sub-campaigns underneath. Compact toggle (110px / 280px). A **global search bar** at the top of the sidebar searches asset names across all campaigns — results show the flag, asset name, and campaign name; clicking a result navigates to the campaign and flashes the asset row. Month filter dropdown filters campaigns by whether any of their assets has `estDelivery` in that month. Campaigns with `done = true` display with a **green left accent border**, light green background tint, and dimmed name text. Below each country section (in full mode), two side-by-side buttons: **+ Add Campaign** and **⬇ Import** — both always visible regardless of whether the country is expanded.
- **Per-country type + month grouping (2026-09-07)**: inside each country group, campaigns split into **Paid Ads** and **Organic** sub-sections, and each type further splits by `monthYear` (`Sep 2026`, `Aug 2026`, …, `No date` for undated campaigns). Current month opens by default, others collapse. State keys: `sidebarTypeExpanded['<COUNTRY>|paid'|'organic']` and `sidebarMonthExpanded['<COUNTRY>|<type>|YYYY-MM']`. Per-user (excluded from the Firestore snapshot). Compact mode skips the grouping — the strip is too narrow for the extra depth.
- **Drag-to-reorder priority**: the two type headers (Paid Ads / Organic) are draggable within a country. Dropping one on the other swaps the pair — `STATE.sidebarTypeOrder[<COUNTRY>]` stores `['paid','organic']` or `['organic','paid']`. Each country's order is independent. A grip appears on hover; the click that would fire right after a drop is suppressed (via `TypeDragState.justDropped`) so releasing on the other section doesn't accidentally collapse it.
- **Activity badges**: every type header and every month row carries a badge summarising how many campaigns inside are *active* (`!done && !killedDate`). **Amber `N active`** when work is still open — the month label also goes bold to stand out even when collapsed. **Green ✓ all done** when every campaign in the group is done or killed. Empty groups render no badge. `isCampActive()` is the shared predicate.
- **Header**: campaign title, brief, rank, asset count, approval %, Drive/Brief/Finals link pills, month chip, Slack override warning (if any). A **Mark Done / ✓ Done** button toggles the campaign's `done` state; when done the button turns green. A **✓ Approve All Assigned (N)** button appears when the campaign has one or more `Assigned` assets — clicking it bulk-approves all of them, stamps `dateApproved = today`, and fires the normal Slack notifications.
- **Asset table**: `# | Name | Category | Difficulty | Raw | Brief | Editor | Video | [Sparks Code] | ETA | Date Approved | QC | Status | Category Head QC | CH Date Approved | Actions`. Inline editing on most cells. The **Sparks Code** column is only shown for IT and ES campaigns. The **Video** cell shows a copy button (⧉) when a Final Video URL is set — clicking it copies `Video name: URL` to the clipboard. **For IT and ES campaigns**, the **Category Head QC** and **CH Date Approved** columns are hidden from the asset table, and the **"All CH QC Approved"** and **"Sync CH Date"** toolbar buttons are also hidden.
- **Filters**: search (scoped to current campaign), Status, QC, Editor.
- **Actions**: + Add Video, edit, duplicate, delete (admin), version history.

### 5.2 Today (Board)
7-column Kanban: **To Do Today | In Progress | Revision | PM Review | PM Approved | CH Review | CH Approved**.
- Drag a card between columns to transition status. Dropping into **Revision** sets `status = 'Needs Revisions'`; **PM Review** sets `For Review`. The CH columns drive `categoryHeadQc`.
- **To Do Today** shows only `status === 'Assigned'` videos where `estDelivery === today` (strict — assigned-date alone no longer qualifies).
- **PM Approved** and **CH Approved** both show today only (`dateApproved === today`) so neither column balloons over time.
- Daily pace pill: UK Paid Ads approved today vs **10/day** target.
- Per-country approval tally for the day.
- "This Week" section: campaign cards aggregated by status; weekly pace pill (workdays × 10).
- **Monthly tally panel** (2026-09-07: flipped from UK Paid Ads to Organic): sits above the board. Now tracks **Organic** approvals against a **1 video per workday** goal — the monthly target scales with the month (e.g. Sep 2026 has 22 workdays → 22-video goal). Shows video count vs. that target, pace indicator (Ahead / On pace / Behind / At risk), progress bar with expected-pace marker, and per-week chips (Friday-ending). Weekly chips also count organic approvals. Cancelled-by-QC aside is scoped to Organic campaigns (matches the primary tally). UK Paid Ads is no longer displayed here — the daily pace pill on the Today view still tracks the 10/day UK Paid target for reference. Month dropdown unchanged (populated from `monthYear` fields). Month selection is transient (not persisted).

### 5.3 Daily Log
Accountability grid for **Zidni, Sharm, Patty** (Elsa excluded — she is manual-only).
- **Week picker dropdown** — navigate to any of the past 8 weeks. Defaults to the current week. Selection is per-user and not shared via Firestore.
- Editor selector dropdown (persists across sessions).
- Per-editor: one day-card per Mon–Fri workday showing videos approved that day, colour-coded by the editor's daily target (3/day minimum).
- Summary bar: total approved, days hit/missed.
- **Export CSV button** — downloads a CSV of the selected week's approved videos for all editors. Filename: `daily-log-YYYY-WNN.csv` (ISO week number). Columns: Editor, Day, Date, Video, Version, Campaign, Country, Category, Difficulty, Status, CH Head, CH QC, Final Video. Empty rows are included for days with no approvals; a blank separator row is added between editors.
- **Copy for Slack button** — opens a modal with a Slack-formatted weekly summary for the currently selected editor. Shows per-day approved counts with ✅/⚠️/❌ icons, numbered video list with campaign tags, and a week total. Editor can be switched inside the modal. Message is editable before copying. "Open Slack" button opens the editor's configured Slack channel directly.

### ~~5.4 Scheduler~~ *(removed)*
The Scheduler tab has been removed. Editor and ETA assignment is done inline in the Campaigns table or via the Board Kanban. The `schedulerDate` and `schedulerIncludeWeekends` state fields are retained for backwards compatibility but are no longer surfaced in the UI.

### 5.4 Notifications
- One card per recipient with pending items.
- Each card: items list, dismiss-per-item, send-now button, webhook readiness dot, **10s** auto-fire countdown bar (warns amber at <1.67s remaining).
- Auto-split toggle for mixed-country editor batches.
- Sent notifications history (most recent 20).
- **QC report cards**: one card per campaign with any QC activity (Missing files, Missing prices, or Ready). Send (🚀) is enabled whenever there is at least one QC-active video — including campaigns where all videos are Ready and none are flagged missing. Copy (📋) and Dismiss (✕) buttons appear on every card. Dismissing a card hides it for the current session; refreshing the page resets dismissed state so the card reappears.

### 5.5 Automations
- Seven cards: reorder, daily scheduler, editor notifications, global webhook, CHQ webhook, per-country webhooks, QC webhooks.
- Each webhook input: status dot (green = valid, red = invalid format, dim = empty), Test button.
- **Live Activity Log** — every mutation/notification, with timestamp, actor, tag, message.

### 5.6 Briefs
A lightweight brief-intake form for content leads to hand off work to the creative team.

- **Submit a Brief** form (visible to pm + admin): two fields — **Notion Brief URL** (required) and **Raw File Link** (Drive, Dropbox, etc., optional) — plus an optional **Notes** textarea with placeholder `Seller Name - Categories`. On submit, the entry is saved to `STATE.briefs[]` and a Slack message is posted to `STATE.briefsWebhookUrl` (falling back to the global webhook). The webhook is validated with `webhookValid()` before firing; the toast reads "Brief submitted — Slack notified!" on success or shows an error with the HTTP status on failure.
- **Submitted briefs list** (visible to pm + admin): briefs sorted newest-first. Each card shows submitter name, timestamp, Brief link pill (with a ⎘ copy-URL button), Raw files link pill (with a ⎘ copy-URL button), and notes. Admin sees a **Mark seen** button (on unacknowledged briefs) and a **Clear** button (on all briefs); clicking Clear removes the entry from `STATE.briefs` permanently and shows a "Brief cleared" toast. Acknowledged briefs show a grey "seen" chip; unacknowledged show an amber "new" chip.
- **Copy link button**: a `🔗 Copy link` button in the Briefs tab header copies a direct deep link (`#tab=briefs`) to the app. Opening that URL navigates straight to the Briefs tab. Boot logic in `attachAuthListener` checks for `#tab=briefs` on first load and sets `STATE.tab = 'briefs'` before rendering.
- **Badge**: the Briefs tab shows a count badge equal to the number of unacknowledged entries.
- **Slack message format**: `:memo: *Campaign ready*\nSubmitted by <name>\nBrief: <url|Open in Notion>  ·  Raw files: <url|Open files>\n<notes>`
- **Webhook config**: Automations tab → "Slack Webhook — Brief Alerts". Falls back to global webhook if blank. Uses `webhookValid()` (same validation as all other webhooks) — the `hooks.slack.com` inline check has been removed.

### 5.7 Config
- Editor cards: difficulty matrix, daily mix rule, country priority, current asset count.
- Slack member-ID inputs for editors / category heads / PMs.
- Category management: add, edit colour, delete (blocked while in use).
- Schema reference (field descriptions).
- **Export backup** — downloads a full JSON snapshot serialised from live `STATE` (not from any cache).
- **Restore from backup** — picks a previously exported JSON file, applies it directly to `STATE`, and uploads to Firestore immediately. No page reload required.
- Firestore migration helpers.

### 5.8 Grading (Editor KPI Scorecard)
Implements the Notion "Editing Team KPI Framework": every delivered video is graded across four pillars and each editor rolls up to one composite **/100** plus a rating band. Grade rows live in `STATE.grades` (one per asset); the scorecard aggregates them per editor. Editors graded: **Zidni, Sharm, Patty** (same set as the Daily Log; Elsa/Seller excluded). `renderGradingView()`.

- **Header**: title, a scope subline (`campaign · month · type · week · N/M graded`), a **📘 How to grade** guide modal, and a **↗ Framework** link to the Notion rubric.
- **Progress hero** — the "make it fun" surface:
  - A **completion ring** for the current campaign+week list (graded / total) with an encouraging message that shifts with progress.
  - A **shared grading streak** — 🔥 consecutive UK days on which grading happened (current + best); the flame is lit when today counts, dimmed as a nudge otherwise (`bumpGradingStreak`).
  - A month-wide **Month N/M** mini-stat for the current filter.
  - At 100% the hero turns green ("All caught up!") and fires a **confetti burst + toast** — once, on the false→true edge only (guarded by `GradingFx`), never on a plain re-render or when navigating to an already-complete list.
- **Filters** (all per-user, not synced): **Month · Year · Campaign**, plus a **Paid/Organic segmented control** (All · Paid · Organic) and a **Week dropdown** (Whole month + one option per week that has videos in scope). Type and Week scope the campaign list, grade table, and scorecard. The Week filter also **narrows the Campaign dropdown** to campaigns with videos in the chosen week. Changing the Type filter clears the selected campaign so it re-resolves to the first match.
  - **★ All campaigns** (sentinel value `'all'`, sits at the top of the Campaigns dropdown, added 2026-07-31): switches the Grade Videos table + progress ring into a **cross-campaign** view — every campaign's videos in the current month + type + week scope, grouped and sorted by campaign name then video name, with a small `Country · Campaign` chip on each row so the origin stays obvious. Header/hero subtitles and the section note swap to "All campaigns"; the grade-completion celebration keys off a distinct `'all'` signature so switching into or out of the mode never false-fires the 100% burst.
- **Grade Videos table** (selected campaign's videos for the month/week): `Video | Editor | Type | Brand | QA | Rounds | Cap | Idea | Actions`. Section header is **collapsible** (chevron on the title, `STATE.gradingVideosCollapsed`, persisted per-user); collapsed state still shows the `N / M graded` progress pill in the header so completeness stays visible while folded. The "Show dismissed" toggle sits inside a `stopPropagation` wrapper so clicking it doesn't accidentally fold the section.
  - **Type** (Net New / Maintenance) is **auto-detected from the file name** via `detectContentType()`: the marker token `…_1N_…`/`…_2N_…` → **Net New**, `…_OP_…`/`…_IOP_…`/`…_2OP_…` → **Maintenance**. Shows an "auto" tag; overridable in the dropdown. This sets the revision cap.
  - **Rounds** auto-fills live from the asset's `revisionRounds` (Needs-Revisions kickbacks); type to override (pins manual), ↺ reverts to auto.
  - **Cap** pill ✓/✗ vs the content-type cap (Net New ≤ 4, Maintenance ≤ 2).
  - **Brand / QA / Idea** are the three judgment-call checkboxes. Ticking any one lazily creates the grade (`ensureGradeForAsset`) with the auto-detected type. Owners: Brand (Avy), QA + Idea (Elsa).
  - **Actions**: ▶ preview (opens the in-tracker video modal), ⊘ dismiss / ↩ restore (exclude/include from the scorecard), 🗑 clear grade.
- **Editor Scorecard** (rolls up all in-scope grades): per editor — videos count, pillar points (**Brand 25 / QA 30 / Innovation 15 / Output 15 / Revisions 15**), Avg/Day + Target/Day inputs, composite **/100**, and a rating band (🟢 Excellent ≥90 · 🟡 Solid ≥75 · 🟠 Needs Work ≥60 · 🔴 At Risk <60).
  - **Output** = `min(15, avgPerDay ÷ targetPerDay × 15)`. **Target/Day auto-fills from the Paid/Organic filter**: **Organic → 1** (a Net New is ~a day's work), **Paid → 3.5** (3–4/day for OP or N). Shown as an "auto" placeholder/pill; a typed value overrides it, clearing reverts to auto. `computeScorecard(editor, grades, suggestedTarget)`.
  - **Rollup columns — This Week / This Month** (added 2026-07-31): two extra columns at the end of every scorecard row surface each editor's composite **for the current calendar week (Mon–Sun containing today) and current calendar month**, independent of the Month/Year/Week selectors. Each cell shows `NN.N /100` + rating dot + N videos; a 0-video week shows `—` + `0 vids` rather than a misleading "At Risk" red pill. The rollup still respects the **Paid/Organic** filter — flip to Paid and the columns re-score against paid grades only, matching the rest of the scorecard's type-filter behaviour. Header subtitle labels the exact date range (`27 Jul – 2 Aug 2026`, `July 2026`) so it reads clearly no matter which month is being viewed. Same `computeScorecard()` under the hood; the grade list is just sliced to today's rolling week / month.
  - **Recommendation column** (added 2026-07-31, far right of the scorecard): a coaching note per editor generated by `gradeRecommendation(primaryCard, monthCard)`. Renders **three explicit beats** in the cell, stacked with visual hierarchy: (1) **Focus** — bold, names the one pillar to push on ("Push on brand alignment."); (2) **Evidence** — muted, cites the exact numbers ("Composite 72.5/100. Brand pass rate at 50% across 4 videos this cycle."); (3) **Why** — regular weight, business consequence ("Off-brand cuts bounce back to Avy, which slows every approval on the campaign."). Written to the project's human-tone rules (contractions, physical verbs, no em dashes, no negation-flips). Innovation here means **edit-style innovation** (structure, pacing, hook, transitions) — something the editor controls at the timeline, so its coaching copy stays on the editor ("Push on edit-style innovation. Distinctive edit style is what separates Solid editors from Excellent ones."). Special cases: **Excellent** → "Anchor level"; **Solid across the board** (weakest pillar ≥ 85% fill) → "Reliable across every pillar"; **missing Avg/Day** with everything else strong → "Set Avg/Day for this editor" (the fix is data entry, not coaching). Uses the current-filter composite when it has data; falls back to the This Month rollup so a filter with no data still gets a useful note. Tone chip (`CURRENT SCOPE` / `THIS MONTH`) colour-matches the rating band.
  - **Team composite strip** (added 2026-07-31): a two-card row sits between the "Editor Scorecard" section title and the per-editor table, showing the team-wide composite `/100` for **This Week** and **This Month** — one number pooled across every editor, every campaign, for the period. Uses `computeTeamComposite()` which back-computes pooled brand/qa/idea/cap counts from the per-editor scorecards' rates × video counts, then applies the same pillar formula as `computeScorecard()`. **Output** is a video-weighted average of per-editor `ptsOut` (editors without an Avg/Day set drop out of the denominator so a missing input doesn't crater the team score). Same 4-band rating dots as the individual rows; empty periods render `—/100 · no graded videos yet` instead of red "At Risk". Respects Paid/Organic; ignores Month/Year/Week selectors so the snapshot stays stable while you drill.
- **Game feel** — a lightweight, dependency-free "juicy clicks" layer (`GameFx`), all disabled under `prefers-reduced-motion`: ticking a pass floats a colour-coded **reward label + sparkle burst** from the checkbox; grading several videos in quick succession chains a **Combo ×N** chip (🔥 at ×5+); the prominent buttons get a **click ripple** + **tactile depress**; the hero **lifts on hover**. All FX render into a fixed body-level `#fx-layer` so they survive the tab's `render()`.

Bucketing: a grade's period = the video's delivery month (`estDelivery || dateApproved`); its week = `isoWeekStart` of that date. Helpers: `gradeRounds`, `gradeWithinCap`, `gradeRating`, `gradeCampaignType`, `suggestedTargetForType`.

### 5.9 Editor Stats

Strava-style personal page per editor. Added 2026-07-30. **Content gated to admin only as of 2026-09-07**: the tab is still visible in the nav for anyone who previously had access (editors + admin + Elsa the viewer), but only `Auth.user.role === 'admin'` renders the wrap card / badges / scorecard. Everyone else sees a 🚧 **Under Construction** card ("Editor Stats is being rebuilt. Check back soon."). The gate lives at the very top of `renderEditorStatsView` — flip the check to re-enable for editors when the rebuild ships. Access is otherwise doubly gated (see §3.4): role must be `editor` (or `admin` for Elsa), AND the sign-in email must resolve via `emailToEditor` to a name in `EDITOR_STATS_EDITORS`, OR the email prefix must be in `EDITOR_STATS_VIEWERS`. Both lookups require the `@tilt.app` domain.

Two access lanes:

- **Editor** (Zidni / Sharm / Patty) — personal-only view. No picker, no leaderboard, no rank chip, no peer data visible. The tab computes stats over the signed-in editor's own approvals only.
- **Viewer** (Elsa) — peer picker at the top listing the three editors (defaults to persisted `STATE.editorStatsSelected`, else the first roster editor). A purple `VIEWER` chip next to the picker signals read-only peer access. Selection persists across sessions via the state snap.

Sections (top to bottom):

- **Wrap card** (`renderEditorStatsView` → hero block, reuses `.gr-hero` classes from Grading):
  - Big ring: this-week approvals vs. a personal-pace target (`max(lastWeek, dailyTarget × 5, 1)`).
  - Delta chip vs. last week (▲ N · ▼ N · → same).
  - Streak block: 🔥 workday-consecutive approvals with weekend-skip (`computeEditorStreak`), current + best. Lit when today counts; dim when dormant.
  - Personal best week (highest one-week approval count ever, with the Mon–Sun range).
  - Month pace mini-stat: `monthApprovals / (dailyTarget × workdays) · pace <expected>`.
  - **Composite score block** (added 2026-07-31, sits below the hero card): twin cards — **This week** and **This month** — showing the editor's composite `/100` + rating pill + video count for today's rolling ISO week and today's calendar month. Uses the same `computeScorecard()` and rating bands as the Grading Scorecard, so the two views agree exactly. Empty state renders `—/100` with `no graded videos yet` instead of a red "At Risk" pill. Editor Stats has no paid/organic filter, so this pulls across all grade types.

- **Badges shelf** (`computeEditorBadges`) — 19 auto-computed badges grouped into five pursuits so each editor sees which "story" they're closest to completing. All pure functions over `STATE.assets` + `STATE.grades` — no persistence, no drift, no migration when the roster changes.
  - **Milestones** (5) — lifetime tier badges: First Cut (1), In the Rhythm (10), Half-Century (50), Century (100), Legend (250).
  - **Craft** (5) — 🎯 **No Notes** (a single approval with 0 revision rounds) · 🔒 **On a Roll** (5 consecutive 0-revision approvals in chronological order, tiebroken by asset id for determinism across Firestore load ordering) · ✨ **Flawless Week** (every approval in an ISO week had 0 rounds) · 💎 Perfect Grade · 🏆 Excellent Month.
  - **Momentum** (4) — 3-Day Streak · Working Week (5) · Fortnight (10) · Marathoner (20). Workday-anchored, weekend-skip.
  - **Range** (4) — 🚀 **Same-Day Ship** (`assignedAt === dateApproved`) · ⚡ Speed Demon (5+ approvals in one UK day) · 🎨 Category Sampler (3+ categories in one week) · 🌍 **World Tour** (3+ countries lifetime, resolved via each asset's campaign).
  - **Consistency** (1) — 🎯 On Target (month-to-date ≥ daily-target × workdays).
  - Locked badges show current progress vs. target (e.g., `10 / 50`) — Strava's "keep me going" pattern. Earned badges show an `Earned` pill; earnable-date is derived from the earliest satisfying record (Nth-earliest `dateApproved` for tier badges) and shown in the tooltip.

- **Collapsible shelf, two levels**:
  - The whole shelf toggles via the `▼ BADGES` header (`STATE.editorStatsBadgesCollapsed`, persisted). Per-group tally chips (`Milestones 3/7 · Craft 4/7 · …`) stay visible even when folded, so the tab stays informative in its collapsed state.
  - Each group inside (Milestones · Craft · Momentum · Range · Consistency) has its own click/keyboard chevron header (`STATE.editorStatsGroupCollapsed[<key>]`, persisted). Group counts (`4 / 7`) stay in the header when folded, so an editor can hide the groups they've already cleared and focus on the ones still in progress.
  - Hovering (or focusing) any of the header's group tally chips reveals a right-anchored **CSS-only tooltip** listing every badge in that group with earned/locked state, emoji, one-line criterion, and progress bar.

Game-feel plumbing (see §11) already fires reward pops + confetti on Approved transitions across every tab — so an editor's numbers update AND their badge shelf lights up in real time as they approve videos.

Wrap-card `.gr-hero` visual grammar and `.confetti-burst` / `.fx-*` animation layer are shared with the Grading hero — reused verbatim, not forked.

---

## 6. Core Workflows

### 6.1 Asset CRUD
- **Create**: + Add Video opens a modal (name, category dropdown, difficulty, editor, ETA, Drive, Brief, Final Video). Generates ID, sets initial status (Draft, or Assigned if an editor is picked).
- **Edit**: inline cell click on the table, or full modal via Edit button. Each mutation captures a version snapshot first.
- **Duplicate**: clones fields, fresh ID.
- **Delete**: admin-only.

### 6.2 Status pipeline
`Draft → Assigned → In Progress → For Review → Needs Revisions → Approved` (also `Cancelled` — may be applied at any stage to mark an asset as no longer needed)

Triggers:
- Set via Status dropdown or Today-tab drag.
- Transition to **For Review** queues a PM batch.
- Transition to **Approved** stamps `dateApproved = today` and feeds the daily pace pill.

### 6.3 Parallel QC tracks
- **Footage QC** (`qc`): Draft / Missing files / Missing prices / Ready — owned by editor or producer.
- **Category Head QC** (`categoryHeadQc`): Draft / For Review / Needs Revisions / Approved — owned by the category's head (auto-resolved via `CATEGORY_HEADS`).
Both can change independently of the main `status` field and both feed batched notifications.

### 6.4 Editor assignment
The Scheduler tab has been removed. All editor and ETA assignment is done inline:
- **Campaigns table** — click the Editor or ETA cell to edit inline.
- **Board Kanban** — drag a card to a different column to change status.

Editor changes always go through `setAssetEditor` (Slack notification, version snapshot). Difficulty caps and country priorities (Editor Rules) are still defined in Config for human reference.

### 6.5 Batch notifications
- Window: **10 seconds** (`BATCH_TIME_LIMIT_MS = 10000`) before auto-fire.
- Items can be dismissed before send to cancel inclusion.
- Editor batches that span multiple countries auto-split per country (toggleable per editor via `noSplit`).
- **Grouped message format.** Items with the same header (same recipient + status + sender) are grouped under one header block. Header format: `<@Recipient> — STATUS [from <@Sender>]` (status is UPPERCASE; mentions resolve to Slack member IDs).
  - Every item is numbered: `N. AssetName` followed by links indented on separate lines (`    <url|label>`).
  - Link set per status: Assigned/In Progress → Raw + Brief; For Review → Video + Brief; CHQ For Review → Video + Brief + Raw; Needs Revisions/Approved/CHQ others → Video only. A `Tracker ↗` deep-link (opens the app scrolled and flashed to the exact asset row) is appended to **every** notification regardless of status.
  - Recipient/sender are derived from the status:
    - Assigned / In Progress → recipient = editor (no sender)
    - For Review → recipient = country PM (Elsa for UK), sender = editor
    - Needs Revisions / Approved → recipient = editor, sender = country PM
    - CHQ For Review → recipient = category head, sender = editor
    - CHQ Needs Revisions / Approved → recipient = editor, sender = category head
- **Routing.** Organic-only, UK-only batches (editor or CHQ) deliver to the shared **Organic (UK) daily thread** when set. Otherwise: editor batches deliver to that editor's daily Slack thread (or the intl thread when every item is IT/ES/US) via `chat.postMessage` on `channelId` + `threadTs`; CHQ batches route to the category's daily thread when set. Falls back to the webhook when no thread is configured or the post fails.
- **Dual-thread posting.** Every CHQ-related notification is silently mirrored to the *other* party's thread after the primary send succeeds: CHQ For Review batches (primary → CH thread) also post to each item's editor's daily thread; CHQ Approved / Needs Revisions batches (primary → editor thread) also post to the relevant category head's daily thread. Secondary posts are fire-and-forget — failures are silent and do not affect the primary send or the UI.

### 6.6 Campaign management
- Add / edit / delete sub-campaigns.
- Right-click a sidebar item to rename.
- Duplicate copies the campaign shell only — assets do not follow.
- Drag in sidebar to reorder within a country, or move across countries — dropping onto a campaign in a different country's section moves the campaign to that country and re-ranks both countries.
- **New campaigns are inserted above the first `done` campaign** for their country, so active work always sits at the top. If no done campaigns exist, the new campaign appends to the end as before.
- Sidebar month filter narrows the visible list to campaigns with at least one asset whose `estDelivery` is in that month (`'none'` = no ETA set).
- **Campaign edit modal** fields: Name, Country, Type, Category, Month/Year, Raw Files (`driveId`), Campaign Brief (`brief`), Final Videos (`finalVideos`), hide-link-cols checkbox, Slack webhook override. All three link fields have an inline `open ↗` button that enables only when a valid URL is entered.
- **Mark Done**: the campaign header has a "Mark Done" button that sets `camp.done = true` (green accent) and shows "✓ Done"; clicking again reopens it. Visual state is reflected immediately in the sidebar.

### ~~6.7 Version history~~ *(removed)*
Version history has been removed. Asset mutations no longer capture snapshots. The `versionHistory` field no longer exists on assets.

---

## 7. Slack Integration

### 7.0 Daily threads (editor + category head)
Notifications post as **replies in a daily Slack thread** when one is configured. Set in Automations:
- One **daily thread URL** per editor (Zidni / Sharm / Patty / Elsa), per category head (Sneakers, TCG, etc.), a single **shared Organic (UK) thread** watched jointly by Millie and Rivers, and a single **shared International thread** for IT/ES/US traffic. URLs are parsed for `channelId` + `threadTs` at save time.
- Sends use the `sendSlackChatPostMessage` Cloud Function (bot-token backed `chat.postMessage`) so the reply lands in the thread only, without the `reply_broadcast` fan-out that plain webhooks force.
- A sweep at midnight archives stale thread entries (last 7 per editor / category retained; single history array for the intl and Organic slots).
- On thread post failure we **do not** silently fall back to the webhook — a webhook thread-reply broadcasts to the main channel, which is worse than a missed post. The toast surfaces the error and the batch stays pending for a retry.

**Destination priority for an editor batch** (resolved by `resolveRouteForItems`):
1. **Organic (UK) thread** if `STATE.organicDailyThread` is set for today AND every item in the batch is UK Organic (each item's `country === 'UK'` and its campaign's `type === 'Organic'`). Intl Organic is deliberately excluded — it falls through to the intl thread.
2. **Intl thread** if every item in the batch is IT/ES/US and `STATE.intlDailyThread` is set for today.
3. Otherwise the **editor's own daily thread** if set for today.
4. Otherwise the country/global **webhook** chain from §7.1.

The same organic-first rule also applies to **CHQ batches** (a UK Organic-only CHQ batch posts to the Organic thread instead of the category thread) and to **Organic QC reports** — for a UK Organic sub-campaign, `resolveQcThreadForCampaign` returns the shared Organic thread; intl Organic QC reports skip the thread and use the ORG webhook chain. The Content Lead field on Organic sub-campaigns (`camp.contentLead`, Millie / Rivers / '') is preserved as an **ownership tag only** — it no longer selects a destination.

Route resolution runs **twice per send** — once for the pre-flight webhook-valid check and once **after** `claimSendSlot()` returns — because the slot claim is a ~200-500ms Firestore transaction during which items can be added/removed by another status change or a remote snapshot from another tab. Resolving only up-front let a batch that flipped from all-intl to mixed still land in the pre-claim thread (or vice versa). The `notified` activity-log entry records the route tag it actually took (`organic thread` / `intl thread` / `editor thread` / `category thread` / `webhook`) so misroutes are diagnosable from the log alone.

### 7.1 Webhook fallback chain

| Recipient | Primary route | Fallback |
|---|---|---|
| Editor batch (single country) | `countryWebhooks[CC].editor` | `webhookUrl` (global) |
| Editor batch (multi-country, split on) | each country's editor webhook | global |
| Editor batch (multi-country, split off) | global | (none) |
| PM batch | `countryWebhooks[CC].pm` | global |
| Category Head QC | `categoryHeadWebhook` (unified) | global |
| QC report | `qcWebhooks[CC]` | global |
| Per-campaign override | `campaign.slackOverride` | normal route |

### 7.2 Validation
Webhook URLs are validated against `https://hooks.slack.com/...`. Invalid → red dot in Automations; empty → dim; valid → green.

### 7.3 Mentions
Editors / category heads / PMs are @-mentioned via Slack Member IDs (the `U…` form), configured in Config.

---

## 7.4 CSV Import/Export (Google Sheets)

**Import**: Batch import campaigns and assets from Google Sheets.

### Import Workflow
1. **Export from Google Sheets**: Right-click each sheet tab → Download as CSV
2. **Filename format**: `Month Year - [Category] Name.csv` (e.g., `Apr '26 Videos - [TCG] CardHalo.csv`)
3. **Upload**: Automations tab → "Import Google Sheet Campaigns (UK)" → select multiple CSV files
4. **Parse**: System extracts campaign name from filename, parses all assets
5. **Merge**: Skips duplicates (by campaign name + asset name), auto-creates categories

### Column Mapping
**Imported columns** (matching is case-insensitive and prefix-based — e.g. `Final Video (Frame.io Link)` matches `Final Video`):
- `PN #` → asset position number
- `Video Name` → asset name (required)
- `Editing Brief` or `Brief` → Notion brief link
- `Editor` → assigned editor (Zidni, Sharm, Patty, Elsa)
- `Final Video …` or `Video` → final video link; accepts any column whose name starts with "Final Video" (e.g. `Final Video (Frame.io Link)`) or equals "Video" — first non-empty match wins
- `Date Approved` → approval date (ISO or locale format, auto-converted)
- `Status` → "Approved" detected; otherwise defaults based on editor

**Skipped columns** (not imported):
- Concepts
- Variations
- Raw Video File
- Ad Status

### Campaign Creation
- **Country**: Always `UK`
- **Name**: Extracted from filename `[Category] Name` (e.g., `[TCG] CardHalo`)
- **Category**: Extracted from brackets (e.g., `TCG`)
- **Month/Year**: Extracted from filename prefix (e.g., `Apr '26`)
- **Type**: Always `Paid Ads`

### Asset Creation
- **Status**: `Assigned` if editor set, `Approved` if "Approved" in Status column, otherwise `Draft`
- **QC**: Always `Draft` on import
- **Category Head QC**: Always `Draft` on import
- **ETA**: Left blank (set via Scheduler or inline)

### Dedup Logic
- **Campaigns**: Skipped if campaign with same name already exists in UK
- **Assets**: Skipped if asset with same name already exists in that campaign — **except** if the existing asset has no `finalVideo`, the import will fill it in from the `Final Video` / `Video` column
- **Partial overwrites**: Only the `finalVideo` field is backfilled on duplicates; all other fields are left unchanged

### CSV Format Handling
- **Parses Google Sheets exports**: Automatically skips empty rows and Google Sheets section headers (like "Overview", "Editing Space", etc.)
- **Finds real header row**: Scans for row containing "PN #" or "Video Name"
- **Robust parsing**: Handles quoted fields, commas in values, multi-line quoted fields (e.g. `Final Video (Frame.io Link)`)
- **Import preview**: Before confirming, shows detected column names. Displays green confirmation with link count if a video link column is found, or amber warning with the actual column list if not — so mismatches are visible before clicking Import All

### Imported record IDs
Imported campaigns receive IDs in the format `c{n}` (e.g. `c7`) and imported assets receive `a{n}` (e.g. `a21`). These are string IDs and are handled transparently by `findCampaignById` / `findAssetById` — clicking, editing, dragging, and deleting imported records works identically to seed records.

### Italy CSV Import

A separate import modal handles Italy-specific CSV files, which use a different column layout and duplicate header names.

**Trigger**: sidebar ⬇ Import button for an IT campaign, or Automations tab → "🇮🇹 Import Italy" button.

**Column layout** (positional — not matched by name, because the source sheet has duplicate headers):

| Position | Source column | Maps to |
|---|---|---|
| 0 | PN# | `pn` |
| 1 | Video Concept/Idea | fallback asset name |
| 2 | Raw Video File | asset name (primary) |
| 3 | Date Submitted | `dateApproved` (when AD Status is Live) |
| 4 | Sparkcodes | `sparksCode` |
| 5 | IG link | (ignored) |
| 6 | Meta Ads code | (ignored) |
| 7 | Extra Notes | (ignored) |
| 8 | Editor | `editor` |
| 9 | Final Video (editor) | `finalVideo` (fallback) |
| 10 | Status (edit) | (ignored) |
| 11 | Final Video (QC) | `finalVideo` (primary) |
| 12 | Status (QC) | (ignored) |
| 13 | Status (AD) | AD status — see rules below |
| 14 | Platform | (ignored) |

**Asset name**: Raw Video File (col 2), falling back to Video Concept/Idea (col 1) if empty.

**Final video**: QC Final Video (col 11), falling back to editor's Final Video (col 9) if empty.

**Status rules**:
- AD Status "Live" → `status = Approved`, `dateApproved = Date Submitted`
- Editor set (and not Live) → `status = Assigned`
- Otherwise → `status = Draft`

**Campaign fields**: country and campaign always set to IT.

**Modal inputs**: campaign name (required, pre-filled from filename), month/year, category dropdown.

**Preview**: a table of all parsed rows is shown before the user confirms import.

**Dedup**: same logic as UK import — skip by asset name match; backfill `finalVideo` and `sparksCode` if the existing asset has them empty.

### Export
- **Automations tab**: "Export Campaigns & Assets" button
- **Filename**: `tilt-export-YYYY-MM-DD.csv` (timestamped)
- **Contents**: Two sections:
  - Campaigns: all fields (country, name, brief, driveId, category, type, monthYear)
  - Assets: linked by campaign name, includes status, QC, dates, links
- **Purpose**: Backup, reporting, sync back to Google Sheets

---

## 8. Persistence

**Auth persistence**: Firebase Auth is set to `SESSION` mode — the sign-in token is held for the current browser session only and cleared when the tab or window is closed. Users must sign in every time they open the app. This guarantees Firestore is always the active data source.

**localStorage is not used.** There are no `localStorage.setItem`, `getItem`, or `removeItem` calls anywhere in the codebase. All persistence goes through Firestore.

| Store | Trigger | Notes |
|---|---|---|
| Firestore `state/app` | Debounced 600ms | Main document — campaigns, config, pendingBatches, activityLog, sentNotifications. Does **not** include assets. `sentNotifications` capped at **5** and `activityLog` capped at **50** entries; if the snapshot still exceeds 900 KB these are trimmed further (to 20, then 0) before writing. |
| Firestore `state/app/assets/{id}` | Debounced 600ms (batched) | One document per asset. Only changed assets are written per batch commit. Deleted assets are removed. A real-time subcollection listener (with `fromCache` guard) keeps `STATE.assets` in sync. |
| Firestore failure / offline | — | Upload retried with exponential backoff. "Upload failed: Offline" toast shown when `window._isOffline`. STATE stays in memory unchanged — no data deleted on disconnect. |
| JSON backup (manual) | User-triggered | Config tab → "Export backup" serialises live `STATE` to a JSON file. "Restore from backup" applies the JSON to `STATE` and uploads to Firestore directly — no page reload. |

**Transient (not persisted):**
- `noSplit` per-editor batch override
- `window._isOffline` / `window._isBackOnline` — offline chip visibility
- inline edit / context-menu UI state

---

## 9. Business Rules

1. **Approval target**: 200 UK Paid Ads videos / month → 10/day → workdays × 10 weekly.
2. **Editor difficulty matrix**: see §6.4. Auto-scheduler must respect both daily cap and difficulty mix; overflow flows to Zidni.
3. **Category → Head mapping**: Sneakers → Anand, TCG → Hanyan, Stone Island / Vintage / Bags and Accessories / Y2K / Jewellery / Health and Beauty → Nazy, Luxury → Cristian. Unmapped categories (Essentials, BTS, Streetwear, user-added) show "—" but still allow status entry.
4. **Weekend skip**: scheduler defaults to Mon–Fri, with an explicit override toggle.
5. **Batch auto-fire**: 10 seconds after first item queued; size gate effectively disabled (limit 999).
6. **Activity log cap**: 200 entries in memory; 50 entries synced to Firestore (trimmed to 20 or 0 if doc exceeds 900 KB).
7. **Sent notifications cap**: 20 most recent in memory; 5 synced to Firestore (trimmed to 0 if doc exceeds 900 KB).
8. **Status side-effects**: `Approved` stamps `dateApproved=today`; `For Review` queues a PM batch.
9. **Domain gate**: only `@tilt.app` Google accounts can sign in. Firebase Auth persistence is set to `SESSION` — sign-in is required on every new browser session (closing the tab/window clears the token). Refreshing the page within an open session keeps the user signed in.
10. **Date storage**: ISO `YYYY-MM-DD` internally; locale-formatted for display (e.g. "22 Apr 2026").
11. **Inline editing**: editing a cell is saved immediately; no version snapshot is taken.

---

## 9.5 Bug Fixes Log

- **Organic daily-thread routing — collapsed per-lead → one shared UK-only thread (2026-09-10)**: Previously every Organic sub-campaign carried a `contentLead` field (Millie / Rivers / '') and each lead had their own daily Slack thread (`STATE.contentLeadDailyThreads`), consulted only for Organic QC reports; editor batches and CHQ batches on Organic sub-campaigns still routed through the per-editor / per-category / intl threads. Elsa asked to simplify: one shared Slack thread for **all** Organic work — Millie and Rivers both watch — used for editor batches, CHQ batches, AND QC reports; then narrowed further to **UK Organic only** so intl Organic keeps flowing through the intl thread. Implementation: added `STATE.organicDailyThread` (single slot) + `organicDailyThreadHistory` (last 7). New resolver `resolveDailyThreadForOrganic(items)` returns the thread iff it's set today AND `itemsAllOrganicUK(items)` — every item has `country === 'UK'` and its campaign's `type === 'Organic'`. Wired as the highest-priority branch in `resolveRouteForItems` (before intl/editor/category); reason tag `'organic'` is stamped into the `notified` activity log. `resolveQcThreadForCampaign` was rewritten to require `camp.country === 'UK'` and route to the shared thread regardless of `contentLead`. UI: the two per-lead cards in Automations were replaced by a single "Daily Slack thread (Organic · UK)" card with handlers `App.saveOrganicDailyThread` / `App.clearOrganicDailyThread`; the QC card's Content Lead dropdown was relabeled `Owner:` (ownership tag only, no routing effect). Any today-dated per-lead thread already set is auto-migrated into the shared slot on first load; the legacy `contentLeadDailyThreads` map is kept in the schema for cross-version compat and the midnight sweep archives its stale entries. Verified: `itemsAllOrganicUK([UK Organic])` → thread; `[UK Organic + UK Paid]` → null (falls to paid routing); `[IT Organic]` → null (falls to intl thread); `[UK Paid]` → null (unchanged).

- **International PM names updated (2026-09-10)**: `COUNTRY_PMS.IT` changed from `'Anasstassiya'` → `'Gian'`; `COUNTRY_PMS.ES` from `'Laura'` → `'Marcel'`. Drives the auto-mention on For Review / CHQ Approved batches for IT and ES campaigns.

- **"★ All campaigns" option — Grading tab** (§5.8, added 2026-07-31): the Campaigns dropdown previously forced a one-campaign-at-a-time view of the Grade Videos table, so grading a whole week across every country meant opening each campaign individually. Added a sentinel `'all'` option pinned to the top of the dropdown: when picked, `monthCampAssets` becomes the union of every campaign's videos in the current month/week/type scope, sorted by campaign → video, with a `Country · Campaign` chip under each video name. The progress hero, section title, and header subtitle all switch to "All campaigns · N/M graded" language; the celebration signature includes the sentinel so switching modes doesn't false-fire the completion burst. Scorecard rollup and Team Composite strip are unchanged — they were already cross-campaign.

- **Team composite strip — Grading tab** (§5.8, added 2026-07-31): the per-editor weekly/monthly rollup shipped earlier the same day only answered "how is each editor doing?" — it didn't tell you how the WHOLE team was tracking that week or month at a glance. Fixed by adding a two-card team-composite strip between the section title and the scorecard table: pooled brand/qa/idea/cap counts across every editor + every campaign, run through the same pillar formula as per-editor composite, with Output as a video-weighted average of per-editor `ptsOut`. New helper `computeTeamComposite(scorecards)` — takes the exact same `weekByEditor` / `monthByEditor` arrays the scorecard already builds, so the team number always agrees with the individual rows. Respects Paid/Organic; empty state renders `—/100 · no graded videos yet` rather than red At Risk.

- **Weekly + monthly composite rollup — Grading + Editor Stats** (§5.8, §5.9, added 2026-07-31): the composite score was previously locked to whatever Month/Year/Week you had selected on the Grading tab, so you could not see an editor's *current* weekly and monthly health at a glance without wiping filters. Fixed by (1) adding two rollup columns (`This Week`, `This Month`) at the end of the Editor Scorecard that always compute against today's rolling ISO week and calendar month, independent of the filter, but still respecting Paid/Organic to match the rest of the scorecard; (2) adding a composite block to the Editor Stats hero — same weekly + monthly cards, personal-scope only, no type filter; (3) sharing `computeScorecard()` between the two so the numbers never disagree. Empty cells render `—` + `0 vids` rather than the misleading 0.0/100 "At Risk" that the primary composite column still shows when there are no in-filter grades (pre-existing behaviour, out of scope for this change).

- **Grading tab — filters, auto-detection, and game feel** (§5.8): (1) Added a **Paid/Organic** segmented filter (`gradingType`) and a **weekly** filter (`gradingWeek`) that scope the campaign dropdown, grade table, and scorecard; the week filter also narrows the Campaign dropdown to campaigns with videos in that week. (2) **Auto-detects content type** from the file name via `detectContentType()` — the `N` marker → Net New, the `OP`/`IOP` marker → Maintenance — used as the row default and when creating a grade; overridable, with an "auto" tag. (3) **Target/Day auto-fills** from the filter (Organic 1/day · Paid 3.5/day for OP or N) via `suggestedTargetForType()`, feeding the Output pillar; a manual value overrides, clearing reverts to auto. (4) A **progress hero** (completion ring + encouraging copy), a **shared grading streak** (`STATE.gradingStreak`, persisted), a month-wide mini-stat, and a **confetti + toast celebration** at 100% (fires only on the false→true edge, guarded by `GradingFx`). (5) A **game-feel layer** (`GameFx`) — reward pops + sparkle bursts on ticking a pass, a rapid-grade combo counter, button click ripples + tactile press, and a hero hover-lift — rendered into a body-level `#fx-layer` and fully gated behind `prefers-reduced-motion`. (6) A **▶ video-preview button** was added to each grading row (opens the in-tracker modal) and **removed** from the Campaigns asset-row actions.

- **Category color crash on import**: Categories auto-created by CSV import were missing the `color` sub-object (`{ bg, fg }`) required by `categoryColor()` and `renderConfigView`. Fixed in three places: `findOrCreateCategory` now sets `color`, `categoryColor()` falls back to top-level `bg`/`fg`, and both `loadState` and `applySnapshot` (Firestore sync path) backfill `color` on any legacy categories that lack it.
- **CSV video link not imported**: The `Video` column was parsed but silently ignored. Fixed by adding `getCol()` — a case-insensitive, prefix-matching column lookup helper — used for `Final Video`/`Video` and `Editing Brief`/`Brief` across all import paths. Prefix matching means `Final Video (Frame.io Link)` correctly resolves to `finalVideo`. Duplicate assets now also backfill `finalVideo` if the field was previously empty. Import preview now shows a green/amber indicator confirming whether a video link column was detected before the user clicks Import.
- **Monthly tally timezone mismatch**: The month range dates were calculated in local time but compared against asset approval dates in UTC, causing the dropdown to show 0 for all months. Fixed by using `Date.UTC()` and `getUTC*()` methods consistently in `getMonthRange()` to ensure all dates are in UTC for proper comparison.
- **Monthly tally dropdown font size mismatch**: The month dropdown had font-size 17px while the "MONTHLY TALLY" label was 12px. Updated `.tally-month-select` to match at 12px for visual consistency.
- **Scheduler tab removed**: The Scheduler tab (§5.4) has been removed from all tab definitions, role visibility maps, and the render switch. `renderSchedulerView()` has been deleted. The `schedulerDate` / `schedulerIncludeWeekends` state fields are retained for backwards compatibility.
- **"To Do Today" filter tightened**: The Board's "To Do Today" column previously included `Assigned` videos where either `assignedAt === today` OR `estDelivery === today`. It now requires `estDelivery === today` only, so cards only surface when their estimated delivery date is today.
- **Status change revert bug fixed**: Drag-drop status changes on the Board (`applyStatusChangeThenReorder`) were missing `recordUndo()` and `pushVersion()` calls that the direct setter (`setAssetStatus`) always made. This left version-history gaps that caused incoming Firestore snapshots to win over the local optimistic update, requiring multiple clicks to make a status change stick. Both calls are now present in `applyStatusChangeThenReorder` to match the setter's behaviour.
- **Daily Log week picker**: Added a week-picker dropdown to the Daily Log tab. Defaults to the current week; can navigate back up to 8 weeks. Selection stored in `STATE.logWeekOffset` (per-user, not synced to Firestore).
- **Daily Log CSV export**: Added an "Export CSV" button to the Daily Log header. Downloads all editors' approved videos for the selected week as `daily-log-YYYY-WNN.csv`. Uses `computeDailyLog` + `getWorkdaysForOffset` — consistent with what the tab displays.
- **Daily Log Copy for Slack**: Added a "Copy for Slack" button to the Daily Log header. Opens a modal (`showDailyLogSlackModal`) with an editable Slack-formatted weekly summary for the selected editor — per-day counts, ✅/⚠️/❌ targets, numbered video list with campaign context, and a week total. Editor is switchable inside the modal without closing it.
- **Unquoted campaign ID in duplicate modal**: The `duplicateSubcamp` function built three inline `onclick` strings that injected `subcampId` (a string like `c33`) without surrounding quotes. The browser parsed `App.performDuplicateSubcamp(c33, false)` and threw `ReferenceError: Can't find variable: c33`. Fixed by wrapping `subcampId` in escaped single quotes in all three button `onclick` attributes.
- **Unquoted item ID in pending-notification dismiss**: The `dismissPendingItem` dismiss button built its `onclick` with `it.id` injected bare (same root cause as above). Fixed by wrapping `it.id` in escaped single quotes so the rendered handler reads `App.dismissPendingItem('recipient', 'c33')` instead of treating the ID as a variable.
- **Multi-browser edit race condition (edits lost / notifications fire after cancel)**: When multiple browser tabs had the tracker open, an incoming Firestore snapshot could arrive within the 600ms upload debounce window and wholesale-overwrite `STATE`, discarding the pending local change before it was ever uploaded. This affected both asset edits (video links, status changes) and notification dismissals (batch re-appearing after cancel). Fixed by extending the existing snapshot-deferral guard in `Fb.applySnapshot` to also defer when `Fb._uploadTimer` is set (i.e. a local upload is pending). The snapshot retries every 250ms for up to 2 seconds; by then the local write has completed and the snapshot applies cleanly on top. Code change: one additional condition (`|| Fb._uploadTimer`) in `applySnapshot` line ~1548.

- **Presence avatars not updating**: `Presence._html()` returned the full wrapper div, so `_updateDom()` tried to swap the element itself — but the element reference was stale after each `render()`. Fixed by: (a) renaming `_html()` to `_avatarsHtml()` which returns only the avatar elements (no wrapper), (b) always rendering `<div class="presence-stack">` in the topbar via `renderTopbar`, and (c) having `_updateDom()` set `el.innerHTML` on the existing wrapper instead of replacing it.
- **Notification sends after dismissal**: `windowItems` and the Slack message were built before the async `claimSendSlot` Firestore transaction resolved. If the user dismissed items during that gap, the already-built message still sent. Fixed by re-reading `batch.items` inside the `.then()` callback after the claim is won, and aborting if the window is now empty.
- **Firestore 1 MB document size limit exceeded (save failed on CH QC status change)**: As assets accumulated edits, the Firestore document grew past the 1,048,576-byte hard limit, causing every save to fail with "Save failed". Root causes: (1) `versionHistory` — per-asset snapshot arrays — was included in the Firestore document and grew unbounded across many assets; (2) `activityLog` (200 entries) and `sentNotifications` (20 entries, each containing full Slack payloads) added further bulk. Fixed by: removing the version history feature entirely (no more per-mutation snapshots or version timeline UI), and capping `activityLog` at 100 entries and `sentNotifications` at 10 entries in `Fb.buildSnapshot()` — full history is still kept in `localStorage`, only the Firestore snapshot is trimmed.
- **Campaign import silently failing to save to Firebase**: Importing campaigns via the Import button wrote to `STATE` and `localStorage` but the Firestore write failed silently — only a small sync indicator turned red, with no user-facing error. Fixed by: (1) adding a red toast in `Fb.uploadNow`'s catch block that shows the exact Firebase error code/message; (2) chaining a `.catch` on the `Fb.uploadNow()` call in `executeSheetImport` to schedule a retry if the initial write fails.
- **Firestore 1 MB limit hit again on import (assets array too large)**: With all campaigns and assets embedded in the single `state/app` document, the document reached 1.04 MB and every write was rejected. Fixed by: (1) reducing `activityLog` to 50 entries and `sentNotifications` to 5 entries in `buildSnapshot`, with a dynamic safety net that trims further to 20 / 0 if the snapshot still exceeds 900 KB; (2) migrating all assets out of `state/app` into a `state/app/assets/{id}` Firestore subcollection — assets are now written individually (only changed ones per batch) and synced via a separate real-time listener. The main `state/app` document now stays well under 100 KB regardless of how many assets exist.
- **Sync indicator wrapping to two lines**: On full-size screens the "✓ All changes saved" text wrapped onto a second line. Fixed by adding `white-space: nowrap` to `.sync-indicator`.
- **Data loss from localStorage being cleared**: When users weren't signed in, all data lived in `localStorage` only and was lost whenever the browser cleared site data (or on Safari after 7 days of inactivity). Fixed in two parts: (1) Firebase Auth persistence changed from `LOCAL` to `SESSION` so sign-in is required every open — guaranteeing Firestore is always active and localStorage is just a cache; (2) added `importLocalBackup()` function and "Restore from backup" button in Config so users can restore a previously exported JSON snapshot. The button appears in all three states of the Config data-storage section (offline, migration-needed, and synced).
- **Config tab showing misleading "Synced" status for non-signed-in users**: When a user wasn't signed in, the Config tab still showed the green "Synced" Firebase banner. Fixed by adding a dedicated amber "Local storage only" warning branch for `!Auth.user` that explains the risk and surfaces both Export and Restore buttons.
- **Sync indicator showing stale/silent status**: The "Saving…" indicator only appeared after the 600ms Firestore debounce fired, leaving a silent gap immediately after every edit. Additionally, if `uploadNow()` found no diff and returned early, the indicator could get stuck on "Saving…" indefinitely. Fixed by: (1) setting `_syncStatus = 'saving'` immediately in `scheduleUpload()` when a write is queued; (2) resetting to `'idle'` in `uploadNow()`'s early-return path when nothing changed. The indicator now reflects Firestore state only — never localStorage.

- **Random data wipes / reset to old test campaign (localStorage race conditions)**: Three related bugs caused the app to occasionally reset to a blank state or to a very old state (e.g. the first test campaign ever created). (1) Firebase Firestore fires `onSnapshot` twice on page load — first with a stale copy from its own IndexedDB browser cache (`fromCache: true`), then with fresh server data. The code treated the first snapshot as authoritative, so stale cache data was applied to STATE and written to localStorage before the real data arrived. Fixed by checking `snap.metadata.fromCache` in both the first-snapshot and subsequent-snapshot handlers and returning early when true — only server-confirmed data is ever applied. (2) The assets subcollection listener (`subscribeAssets`) called `render()` → `saveState()` before the main Firestore doc had arrived, writing `campaigns: []` to localStorage during the boot window. Fixed by adding `&& Fb._ready` to the render guard so the assets listener never triggers a save before the main doc is loaded. (3) `loadState()` (reading localStorage back into STATE) was called in two places — the boot path when Firestore was empty, and the Firestore error fallback. Both calls removed; localStorage is now write-only. Firestore is always the source of truth and the app never bootstraps from localStorage.

- **Editor Stats — six-fix roll-up post-launch review**: (1) `maybeFireCampaignComplete` false-fired a "🎉 all approved" toast + confetti on a fresh session's first status change against an already-completed campaign, because `CampaignFx.done` was in-memory only. Fixed by seeding `wasDone := allApproved` on the first encounter with a campaign (instead of defaulting to `false`), and by calling `maybeFireCampaignComplete` on EVERY status transition (not just Approved) so drops below 100% correctly reset the flag — real re-completions still fire, phantom completions don't. (2) `STATE.editorStatsSelected` and `STATE.editorStatsBadgesCollapsed` mutated with `saveState()` but were absent from the Firestore snap object at `Fb.buildSnapshot()`, so the peer picker choice and the shelf collapse state never survived a refresh. Both added to the snap. (3) `emailToEditor` and `isEditorStatsViewer` matched on email local-part alone — any Google-auth user whose prefix matched `zidni`/`sharm`/`patty`/`elsa`, regardless of domain, would have been treated as that identity. Both now require `@tilt.app` (see `EDITOR_EMAIL_DOMAIN`), case-insensitive. (4) Badge "On a Roll" (5 consecutive 0-revision approvals) was order-dependent for same-day approvals — Firestore load order changed which pattern the walk saw and could flip the badge earned/locked. Fixed with a stable secondary sort on asset id inside `computeEditorBadges`. (5) 22 dead `.es-lb-*` CSS selectors from the removed leaderboard were still in `styles.css`; removed. (6) The Config → Team panel role description hard-coded "Editor = Zidni/Sharm/Patty"; softened to "the internal video editors" with an inline note that the Editor Stats tab is gated by `EDITOR_EMAILS`.

- **localStorage fully removed**: All `localStorage.setItem`, `getItem`, and `removeItem` calls were removed. `saveState()` now only triggers `Fb.scheduleUpload()`. `loadState()` is a no-op stub. `exportLocalBackup()` serialises live `STATE` directly. `importLocalBackup()` applies the parsed JSON to `STATE` and calls `Fb.uploadNow()` — no page reload. Tally date coordination uses Firestore only; `claimTallyLocalOnly()` returns `false` when Firestore is unavailable. All UI text referencing "local storage" updated to reflect Firestore-only persistence. Config "not signed in" banner updated to say changes will not be saved rather than implying localStorage fallback.

- **Offline detection and indicators**: `window._isOffline` is initialised from `navigator.onLine` on load. `window` `offline`/`online` events set `_isOffline` and `_isBackOnline` flags. A persistent amber **⚡ Offline** chip appears in the topbar on disconnect and clears on reconnect. A green **✓ Back Online** chip appears for 3 seconds (0.5s CSS fade-out) when reconnected. On reconnect `scheduleUpload()` is called immediately to flush pending changes. Upload failure while offline shows a **"Upload failed: Offline"** toast instead of the generic retry message.

- **`subscribeAssets` fromCache guard missing**: The assets subcollection `onSnapshot` handler lacked the `fromCache` guard present on the main doc listener. A stale IndexedDB cache snapshot could overwrite `STATE.assets` with empty or outdated data during page load or reconnect. Fixed by adding `if (snapshot.metadata.fromCache) return;` to match the main doc handler.

- **Briefs tab sub-campaign field removed**: The "Sub-Campaign" dropdown was removed from the Submit a Brief form. `submitBrief()` no longer reads or validates `subcampId`. The Slack message and submitted-briefs list cards no longer reference a campaign name. The `entry` object no longer stores `subcampId`.

- **Spurious double notifications on simultaneous editor + status change**: When an asset's editor and status were both changed in the same modal save (or inline editor change that auto-flipped status), `emitAssetChangeNotifications` fired two pings instead of one: the `justAssigned` block (which was too broadly conditioned — it fired on any `editorChanged` regardless of the target status) plus the status-specific rule (e.g. `for-review`, `needs-revisions`). This also caused Patty and Sharm to appear to "always generate 3 notifications" — their scheduler cap of 3 meant they regularly had exactly 3 Assigned assets, making the double-fire pattern consistently visible. Fixed by tightening all three `justAssigned` sub-conditions to require `newStatus === 'Assigned'`, so the `'assigned'` ping only fires when the asset actually lands in `Assigned` status and the status-specific rules handle every other destination.

- **Duplicate Slack notifications (batch firing 2–3× after send)**: After a batch was sent, the same notification could fire again one or more times. Root cause: when `sendPendingBatch` succeeded, `markSent` cleared `batch.items` in memory and `render()` immediately queued a Firestore write (setting `Fb._uploadTimer`). Any Firestore snapshot that arrived from another browser during the upload was correctly deferred into `_pendingSnapshotData`. However, when the upload completed and `_uploadTimer` was cleared, `_pendingSnapshotData` was never discarded — so the stale pre-send snapshot (still carrying the original batch items) was replayed 250ms later. This restored `batch.items` and `firstQueuedAt` in STATE, causing the 5s auto-fire ticker to see an expired batch and re-send. Fixed by adding a discard step in `Fb.uploadNow`'s success handler: if `_pendingSnapshotData` is set when an upload commits, it is cleared (along with `_snapshotRetryTimer` and `_snapshotRetries`) so the stale snapshot is never replayed. Post-commit Firestore snapshots reflect the freshly written state (empty batch) and apply cleanly.

- **Monthly tally counting wrong month**: The monthly tally counted videos by their `dateApproved` date, so approving a video from an April campaign in May added to May's tally instead of April's. Fixed by changing the count source to use the campaign's `monthYear` field — any video in a campaign tagged to a given month now counts toward that month regardless of status or approval date. The month dropdown is also now populated from campaign `monthYear` fields rather than from the oldest `dateApproved` date. Introduced `countVideosByMonthYear(monthKey, filterFn)` as the new count function for the tally panel.

- **This Week campaign cards clipped on the right**: The `.week-camp-grid` lacked an explicit width in the flex-column context of `.today-wrap`, so `repeat(auto-fill, minmax(240px, 1fr))` could not resolve a definite container width — the grid overflowed and was clipped by `.main { overflow: hidden }`. Fixed by adding `width: 100%; min-width: 0; box-sizing: border-box` to `.week-camp-grid`.

- **CSV import creates duplicate campaign instead of merging into existing**: When importing a CSV whose campaign name matches an existing campaign, the importer creates a new campaign with a fresh ID instead of adding assets to the existing one. Workaround: after import, move assets from the new campaign ID to the correct existing one via console, then delete the empty duplicate from the sidebar.

- **Bulk QC Approved button**: Added "✓ All QC Approved (N)" button to the campaign toolbar. Sets `qc = 'Ready'` on all assets in the current campaign that are not already Ready. Only visible when at least one asset is not Ready. Supports undo and logs each change.

- **Bulk CH QC Approved button**: Added "✓ All CH QC Approved (N)" button to the campaign toolbar. Sets `categoryHeadQc = 'Approved'` and stamps `chDateApproved = today` on all assets in the current campaign not already Approved. Only visible when at least one asset is not CH QC Approved. Supports undo and logs each change.

- **Sync CH Date Approved button**: Added "⇄ Sync CH Date (N)" button to the campaign toolbar. Copies `dateApproved` → `chDateApproved` for all assets in the current campaign where the two dates differ (and `dateApproved` is set). Only visible when at least one asset has a mismatch. Supports undo and logs each change.

- **Quarterly reporting dropdown order wrong**: The quarter picker in the Reporting tab listed quarters in reverse-chronological order (Q2 2026, Q1 2026, Q4 2025…), making it hard to locate a specific quarter. Fixed by collecting all 8 options into an array and sorting by year descending then quarter ascending (Q1→Q4) within each year, so the dropdown reads e.g. Q1 2026, Q2 2026, Q1 2025, Q2 2025, Q3 2025, Q4 2025, Q3 2024, Q4 2024.

- **Reporting tab undercounting videos and missing campaigns**: Three related bugs in the Reporting tab caused incorrect totals, wrong completion percentages, and campaigns/videos being invisible in certain periods. (1) `assetInRange` used `estDelivery || dateApproved` (single-date, AND logic) — if `estDelivery` was set to a date outside the selected period the video was silently dropped even if `dateApproved` or `chDateApproved` fell within it. Fixed by switching to OR logic across all three date fields (`estDelivery`, `dateApproved`, `chDateApproved`) so a video is "in range" if any of its dates falls in the period. (2) The `approved` count in `campRow` was filtered to `rangeAssets` (date-filtered subset), so CH-approved videos with an off-period `estDelivery` were excluded from the approved tally. Fixed by scanning `allAssets` for the approved count. (3) `total` and `approved` in `campRow` were both date-filtered, causing false 100% (in-progress videos with no dates were invisible) and false 0% (approvals from a prior period were dropped). Fixed by making both counts span the full campaign — `total = allAssets.length`, `approved = allAssets.filter(chApproved).length` — so the period filter controls which campaigns appear, while the stats reflect the whole campaign's completion. `isFull` (the 100% Done trigger) changed from `pct === 100` to strict `approved === total` to prevent rounding to 100% before all videos are done.

- **Reporting tab status chip not auto-marking Done at 100%**: Campaigns that reached 100% CH-approval were still shown as "Active" in the Status column unless manually marked done via the campaign header button. Fixed by changing the status chip condition to `r.c.done || r.isFull` so any campaign where every video is CH-approved automatically renders the green "Done" chip in the Reporting table.

- **Reporting table column changes**: Category column removed. Column order is now: Campaign → Country → Approved This Week/Month/Quarter → Total → Progress → Revisions → Editors → Status. The approved column header adapts to the selected period.

- **Approved This Week/Month/Quarter column**: The approved count in the reporting table now shows only videos where `chDateApproved` falls within the selected period (not all-time CH-approved). Total and Progress % still use all-time counts so overall campaign completion remains accurate.

- **Reporting pace bar re-added with conditional logic**: The Reporting tab now shows a context-sensitive pace bar above the campaign table. When the market filter is **UK** and the type filter is **Paid Ads**, it shows the full UK Paid Media pace pill — CH-approved count vs the target (200/month, pro-rated for weekly/quarterly using elapsed workdays), a progress fill bar, and an on-pace/ahead/behind/at-risk status dot. For any other filter combination (All markets + All types, Organic only, a specific non-UK market, etc.), it shows a simple CH-approved video count for the selected period and filter scope, with no fixed target. The pace bar was previously removed entirely; this re-addition scopes the target-bearing pace pill strictly to the UK Paid Ads combination.

- **Streetwear category head**: Jacob added as the category head for Streetwear in `CATEGORY_HEADS`.

- **Orphaned assets from deleted campaigns**: 291 assets had `campaignId` values (c75–c101) referencing campaigns that had been deleted and recreated with new IDs (c7–c32). Assets showed as `(no campaign)` on the Editing Calendar because `findCampaignById` returned null for those stale IDs. Root cause: campaigns were deleted and recreated, but the old asset documents in the `state/app/assets` subcollection retained the old campaign IDs and were not remapped. Fixed by bulk-reassigning all 291 assets to their correct current campaigns via a console mapping script. Two assets with suffix `_MB` (Moda Brand) remain unassigned pending the creation of a Moda Brand campaign. Additional manual corrections applied after reassignment: `_KC` assets moved to UK Ads; AirMaxDay assets moved to Barcelona; ProfitandLoss moved to Cardy Boys 2; Stone Island assets without `_DD` moved to Heat From the Spire; Sneakers `_RStreetwear` assets moved from RS Streetwear to RS Kicks; Footwear assets remain in RS Streetwear. Duplicates cleaned up campaign-by-campaign after each move.

- **Cancelled status added**: `STATUSES` and `CATEGORY_HEAD_QC_VALUES` now include `'Cancelled'`. Cancelled assets are excluded from all progress/total counts in the Reporting tab and elsewhere — a campaign where every non-cancelled video is CH-approved shows 100%.

- **IT/ES/PL: Category Head QC columns and buttons hidden**: For campaigns with country IT, ES, or PL, the Category Head QC and CH Date Approved columns are hidden from the asset table, and the "All CH QC Approved" and "Sync CH Date" toolbar buttons are not rendered.

- **Italy CSV import**: Added a dedicated Italy import modal and parser. Handles the Italy-specific positional column layout (duplicate headers), maps AD Status "Live" to Approved + date, derives asset name from Raw Video File with fallback to Video Concept/Idea, and uses the QC Final Video column as the primary final video link. Triggered from the IT sidebar import button or Automations tab "🇮🇹 Import Italy" button.

- **Reporting tab: cancelled assets excluded from progress %**: Cancelled assets (status = Cancelled or categoryHeadQc = Cancelled) are excluded from the `total` denominator in all reporting progress calculations. A campaign where every non-cancelled video is CH-approved now correctly shows 100% rather than less due to cancelled entries inflating the denominator.

- **QC report send blocked when no missing files**: The 🚀 Send button on QC report cards was gated behind `totalMissing > 0`, making it impossible to send a report for a campaign where all videos were marked Ready. Fixed by changing the condition to `totalMissing > 0 || ready.length > 0` so the button enables whenever there is any QC activity.

- **QC report dismiss button**: Added a ✕ Dismiss button to each QC report card in the Notifications tab. Clicking it sets `STATE.qcDismissed[campId]` (same mechanism used after a successful send), hiding the card permanently. `qcDismissed` is persisted to Firestore so dismissals survive page reloads and sync across browsers.

- **Category order and Streetwear**: `DEFAULT_CATEGORIES` reordered to the canonical team order (Sneakers, TCG, Stone Island, Luxury, Vintage, Bags and Accessories, Y2K, Streetwear, Health and Beauty, Jewellery; Essentials and BTS kept at end for backward compat). Streetwear added as a new category. On `applySnapshot`, existing `STATE.categories` arrays are automatically reordered to match and Streetwear is injected if absent, so existing users pick up the change without a data reset. The **Category field** in the Add/Edit Video Asset modal changed from a free-text `<input>` to a `<select>` dropdown populated from `STATE.categories`, preventing typos and ensuring new assets always get a valid category. Category Head assignments also updated to reflect the current team: Sneakers → Anand, TCG → Hanyan, Stone Island/Vintage/Bags and Accessories/Y2K/Jewellery/Health and Beauty → Nazy, Luxury → Cristian.

- **UK sidebar redesign + activity badges + Poland removal + Monthly Tally flip (2026-09-07)**: several UX cleanups shipped together the same day the stale-tab merge fix landed.
  (1) **Per-country type + month grouping (§5.1)** — every country's campaigns now split into Paid Ads / Organic sub-sections, and each type further groups by `monthYear`. Current month opens by default. State keys: `sidebarTypeExpanded['<COUNTRY>|<type>']` and `sidebarMonthExpanded['<COUNTRY>|<type>|YYYY-MM']`, both per-user. Compact mode keeps the old flat layout.
  (2) **Drag-to-reorder priority** — the two type headers inside a country are draggable; swapping them writes `STATE.sidebarTypeOrder[<COUNTRY>]` (`['paid','organic']` by default, or `['organic','paid']` after a swap). Each country's order is independent. A one-shot `TypeDragState.justDropped` flag suppresses the click that would otherwise fire right after a drop.
  (3) **Activity badges** — every type header and month row carries an amber `N active` pill when any campaigns in the group are not done and not killed, or a green `✓ all done` pill when all wrapped. The month label goes bold when the group has active work so collapsed months still signal work. `isCampActive()` is the shared predicate.
  (4) **Poland removed** — dropped from `CANONICAL_COUNTRIES`, seed state, all hard-coded country lists (`INTL_COUNTRIES`, IT/ES/PL simple-approval filter, ad-account meta labels, PRD text, etc.). Added a one-shot migration in `applySnapshot` that strips any stored `PL` entry from `STATE.countries` and `STATE.expandedCountries` on next load, so live Firestore state auto-cleans without a manual op. Idempotent — no-op after the first migration.
  (5) **Board Monthly Tally scope flip** — was UK Paid Ads (200/month goal), now Organic (1/workday goal, so target scales with the month). Weekly chips + Cancelled-by-QC aside also scoped to Organic. UK Paid Ads reference card removed the same day. The Today view's daily-pace pill still tracks the 10/day UK Paid target for reference.
  (6) **Editor Stats gated to admin only** — the tab still shows in the nav for anyone who previously had access, but only `Auth.user.role === 'admin'` renders the wrap card / badges / scorecard. Everyone else lands on a 🚧 Under Construction card. Flip the check at the top of `renderEditorStatsView` to re-enable for editors when the rebuild ships.
  (7) **Clips atomic tag ops** — `addBrollTag` and `removeBrollTag` used to write the full `tags` array in a set-merge patch. Two tabs concurrently adding different tags would race and one add would be lost (last writer's array won). Fixed by switching to `firebase.firestore.FieldValue.arrayUnion(v)` / `arrayRemove(toRemove)` so Firestore applies each op atomically on the server. Local optimistic mutation still runs so the UI is instant. Verified with 6 unit tests + confirmed `FieldValue` sentinel on the wire.
  (8) **Campaign delete tombstones** — a corollary to the union-merge fix: because merged snapshots preserve local-only entries by design, a stale tab's routine save could resurrect a campaign you had just deleted. Added a shared `STATE.deletedCampaignIds` ledger (`{id: ts}`), synced through Firestore and union-merged in `applySnapshot`, with a 24-hour TTL. `mergeCampaigns` now filters incoming (and local) campaigns by the tombstone set before returning; assets pointing at a tombstoned campaign are also purged from `STATE.assets` on apply. Two delete paths (`deleteCampaign` and `App.deleteSubcamp`) both call `tombstoneCampaign(id)`.

- **Edits lost when reloading inside the 600ms save debounce (2026-09-08)**: Every `saveState()` schedules the Firestore upload via `Fb.scheduleUpload` with a 600ms debounce (`Fb._uploadTimer = setTimeout(Fb.uploadNow, 600)` at ~app.js:1262) so rapid consecutive mutations batch into one write. The `beforeunload` handler warned the user with the browser's "changes may not be saved" dialog but did not flush the pending timer — so if you edited a campaign and immediately hit Ctrl-R (dismissing the warning or before it appeared), the timer was killed with the page and the write never left the browser. Firestore kept the OLD value and on the next reload the edit looked lost. Fixed by calling `Fb.uploadNow()` synchronously inside the `beforeunload` handler when `_uploadTimer` is set — the Firestore SDK dispatches the batch to the network immediately and the request completes during the unload window. The unsaved-changes dialog now only fires when `_pendingLocalJson` is set (an in-flight retry that hasn't landed yet). Verified: edit a campaign, refresh immediately without waiting for the "saved" indicator — change persists.

- **Video NO. is continuous across the month bucket (2026-09-09)**: The NO. column in the campaign table used to show the per-campaign `pn` (1..N inside each campaign), so opening campaign 2 in April showed videos numbered 1, 2, 3 even if campaign 1 already had 5 videos above it. The team wanted a single running number across the month — campaign 1's videos = 1–5, campaign 2's videos = 6–8, etc. Kept the underlying `pn` field per-campaign (so `getNextPn`, drag-reorder renumbering, sort, dedupe, and priority key all keep working) and added a display-only offset: `getMonthlyPnOffset(camp)` sums the video count of every campaign in the same (`country`, `type`, `monthYear`) bucket that sits ABOVE `camp` in sidebar order (`rank < camp.rank`), and `renderCampaignsView` adds that offset to each row's `a.pn` when building the `NO.` cell. Undated campaigns bucket together under an empty month. The Add/Edit Video modal keeps the `NO.` input labelled "(within campaign)" and shows a live "Table shows this as #X" hint so a user typing `1` isn't surprised when the table renders `6`. The tooltip on the badge shows the local `#pn within this campaign` for the same reason. The PDF export (`exportCampaignPdf`) still numbers rows 1..N because it's a per-campaign printout — flip the `i + 1` there to use the offset if the team wants those to match. 6 unit tests cover the offset helper (first campaign, second campaign, cross-type isolation, cross-month isolation, undated bucketing, cross-country isolation).

- **Sidebar campaign badge restarts per month bucket (2026-09-09)**: The rank badge on each sidebar row (`<div class="rank-badge">`) rendered `s.rank`, the per-country rank. Because the sidebar filters campaigns into (country, type, month) groups but rank is country-wide, badges skipped through the country's used rank slots — Sep 2026 Organic would read 1, 2, 4 (rank 3 sits in Aug), Aug 2026 Organic would read 3, 6, 14, 16, 24. The team wanted each visible month bucket to restart at 1 to match how the list is grouped and filtered on screen. Kept the `rank` field per-country (so `priorityKey`/`getSubCampaignsForCountry`/`moveCampaignWithinCountry`/`getMonthlyPnOffset` all keep working) and added a display-only lookup at the top of `renderSidebar`: `bucketIdxByCampId` walks every campaign sorted by (country, rank asc), then assigns a 1-based index per (`country`, `type`, `monthYear`) bucket. All three badge sites — grouped-with-month, non-grouped full row, and compact single-flag pill — read from that map instead of `s.rank`. Every badge's hover tooltip still reveals the underlying `Campaign #<rank> in <COUNTRY>` so drag-drop / scheduler debugging isn't blind. Undated campaigns bucket together under a shared 'none' month; ties fall back to `s.rank` via `(bucketIdxByCampId[s.id] || s.rank)` so a first-render race never renders a blank pill.

- **Sidebar Paid/Organic reorder resetting on reload (2026-09-08)**: The drag-to-reorder priority feature (shipped 2026-09-07, see §5.1 point 2) wrote to `STATE.sidebarTypeOrder`, but that field is listed in `PER_USER_UI_FIELDS` (~app.js:495) so `Fb.buildSnapshot` deliberately excludes it from Firestore and `applySnapshot` refuses to accept it inbound. `saveState()` only calls `Fb.scheduleUpload()` — there is no localStorage backing for any per-user UI field. Net effect: the reorder lived in memory only and reset to the default `['paid','organic']` order on every reload. Fixed by adding localStorage backing specifically for this field — the STATE initializer hydrates from `localStorage.getItem('tilt-sidebar-type-order')` on boot (~app.js:2117), and `onTypeDrop` writes the updated map to the same key on every drop (~app.js:15825). Trade-off: preference is per-device (a different laptop starts from the default) rather than per-user across devices. If cross-device sync is later wanted, promote the field out of `PER_USER_UI_FIELDS` into a merged per-user Firestore doc — same shape the config maps use.

- **Cross-tab pill: persistent + reload preserves the view (2026-09-10)**: The cross-tab update pill (§2.2) had a 20-second auto-hide, so a teammate's edit that arrived while you were heads-down in another window could disappear before you saw it. And its Reload button did a plain `location.reload()`, which — because `STATE.tab` / `STATE.activeSubCampaignId` / `STATE.calendarMonth` are excluded from the Firestore snapshot (see §2.2 Per-user UI state) and were never mirrored anywhere else — dropped you back on Campaigns tab / campaign #1 no matter where you had been. Fixed in two parts: (1) dropped the pill's auto-hide timer so it stays visible until Reload or × is clicked; (2) added `reloadPreservingView()` which stashes `{tab, activeSubCampaignId, calendarMonth, scrollY}` to `localStorage['tilt-view-prefs']` immediately before `location.reload()`, plus `hydratePersistedView()` at boot which restores those fields before the first render (URL hash deep-links still win) and then consumes the entry so later navigation doesn't replay stale state. The auto-update version refresh (§2.2 "Stale tab on old code") also routes through the same helper, so a new-build refresh mid-work no longer yanks you to the default view.

- **Intl daily-thread misroute — race between route resolve and send-slot claim (2026-09-10)**: Elsa reported that a status update on an international video posted to the editor's own daily thread instead of the shared International thread, even though the intl thread was green-dotted for today and the batch was purely IT/ES/US. Root cause: `sendPendingBatch` resolved `thread` / `useThread` / `url` up-front, then called `claimSendSlot(slotKey)` — a Firestore transaction that takes ~200-500ms. `windowItems` and `msg` were re-read after the claim resolved, but the routing decision was not. So a batch that was all-intl at resolve time but mixed at send time (or vice versa) still routed to whichever thread was picked pre-claim. Similarly, if `STATE.intlDailyThread` flipped set/unset during the claim window, the pre-claim decision was stuck. Fixed by extracting the resolution into `resolveRouteForItems(items) → {thread, useThread, url, reason}` and calling it **twice** — once for the pre-flight webhook-valid check, once with the fresh `windowItems` right before the `postToThreadPreferred` / `postToSlack` call. Also stamped the route tag ('intl thread' / 'editor thread' / 'category thread' / 'webhook') into the `notified` activity-log entry so any future misroute is diagnosable from the log alone without re-deriving from the item mix. Verified: `resolveDailyThreadForIntl(all-IT/ES/US)` → intl channel; `resolveDailyThreadForIntl(mixed)` → null → falls back to editor thread.

- **Stale-tab overwrite wiping fresh data across every tab (2026-09-07)**: Every `saveState()` uploaded the WHOLE `state/app` document from that browser's in-memory `STATE`. When two tabs edited in parallel (yours in another window, or a teammate elsewhere), the last writer's blob overwrote the first writer's field-by-field. Most visibly, an admin-added organic category disappeared on next reload — but the same race silently wiped `grades`, `scorecardMeta`, `campaigns` (newly created), `countries`, `sellers`, `products`, every Slack channel/ID map, `qcWebhooks`, `countryWebhooks`, `metaAdAccountIds`, `qcDismissed`, `gradingStreak`, and `pendingBatches` under the right timing. Reproduced with `applySnapshot(staleBlob)` for each field. Fixed by adding **per-field merge rules** in `Fb.applySnapshot` (see §2.2 for the full table) that skip the generic overwrite for these keys and apply a tailored merge instead — union by name/id for growing lists, "non-empty local beats empty incoming" for string maps, `Math.max` for `best` streaks, and so on. Category adds now also flush immediately (bypass the 600ms debounce). Also added: **per-tab UUID** stamped as `_lastEditedByTab` on every upload, and a **cross-tab update pill** top-right ("N updates from [name] · Reload · ×") that appears whenever a snapshot arrives from a different tab. Own-tab echoes never trigger the pill; rapid consecutive writes batch into a single pill with a counter. A category-specific bottom-right toast ("New category added by [name]: X") fires when the picker's list changes. Verified with **40 stress tests** — 8 categories, 5 pill, 7 grading, 20 every-tab, plus a 1000-op chaotic all-tabs stress — 0 losses. Trade-off documented: deleting an unused entry can resurrect briefly if another tab hasn't seen the delete yet; user just deletes again. Silently losing ADDS was the far worse failure mode.

---

## 10. Known Gaps (as-built)

These are flagged so future work can address them — they are **not** broken, they are intentional simplifications.

- No analytics / reporting dashboard (no monthly burn chart, no editor utilisation chart).
- Search within the campaign toolbar is scoped to the current campaign; the sidebar global search covers all campaigns but is limited to asset name matching (no status/editor filtering).
- Firestore conflict resolution is **per-field merge** (see §2.2), not a full CRDT and not blanket last-write-wins. Growing lists (categories, grades, campaigns, sellers, etc.) union — safe for concurrent adds; edits to existing campaign fields are still last-write-wins per campaign since campaigns lack a per-object `updatedAt`. Deletes of unused entries can resurrect briefly if another tab hadn't synced the delete yet — user simply deletes again.
- No file uploads — Drive / Brief / Final Video are URL fields only.
- QC-report send is manual; there is no auto-send when a campaign hits 100% approval.
- Activity log is text-only; no query, filter, or export UI.
- No server-side scheduled jobs — the 3pm scheduler runs in the open browser.
- Slack-only notifications — no email, no in-app inbox.
- Categories are flat; no sub-categories.
- ~~No role-based UI gating at the cell level (everyone signed in sees everything).~~ **Resolved 2026-07-30**: Roles now gate tab visibility (`ROLE_TAB_VISIBILITY`), destructive mutations (`roleAtLeast()`), and first-sign-in defaults (new users land as Viewer). See §3.
- Weekend toggle is per-run, not a recurring rule.
- CSV import is one-way (Google Sheets → app); no automated two-way sync.

---

## 10a. Game-feel layer (`GameFx`)

Cross-tab "juicy clicks" system, dependency-free, rendered into a body-level `#fx-layer` so effects survive the tab's `render()`. Everything is disabled under `prefers-reduced-motion: reduce`.

- **Reward pops + sparkle bursts** — floating labels (colour-coded to `brand` / `qa` / `idea` / `approved`) with a radial dot burst. Fired on grading-pass checkboxes AND on status transitions to Approved / Delivered (in `setAssetStatus`), and on Category Head QC transitions to Approved / Needs Revisions (in `setAssetCategoryHeadQc`).
- **Combo counter** — chains while you keep triggering rewards within a 2.6s window; renders `Combo ×N` (🔥 at ×5+). Cross-tab: grading a video + approving another on the Board keeps the same chain going.
- **Ripple + tactile press** — Material-style ripple + a 1px depress on `.run-btn`, `.submit-btn`, `.gr-seg-btn`, `.grading-play-btn`, `.action-btn`, `.edit-btn`, `.batch-*-btn` — the small buttons across every tab.
- **Pointer position tracking** — `GameFx.trigger(label, kind)` reads the last `pointerdown`/`pointermove` position so setters (inline `<select>` `onchange`, deferred CH-card slide-out, drag-drop reorders) can fire a reward at the user's finger without threading events through.
- **Campaign 100% confetti** (`maybeFireCampaignComplete`) — fires the shared `.confetti-burst` animation + a "🎉 all approved" toast on the false→true edge of a campaign's completion. Called after every status transition (not just Approved), so demotes correctly reset the flag and re-completions fire cleanly. Seeds on first encounter to avoid false-firing on a fresh session viewing an already-completed campaign.
- **CH queue empty confetti** (`maybeFireCatQueueEmpty`) — same treatment when `catReviewPendingCount()` transitions from >0 to 0, plus a big burst on the bulk `✓ All CH QC Approved` button in the Campaigns toolbar.

The Editor Stats wrap card (see §5.9) and the Grading progress hero (§5.8) both hook into these effects — reward pops fire on approvals AND update the numbers those cards show, so an editor can watch their streak / rank / badge progress advance in real time as they work.

---

## 11. Reference Tables

### 11.1 Status values
`Draft, Assigned, In Progress, For Review, Needs Revisions, Approved, Cancelled`

### 11.2 Footage QC values
`Draft, Missing files, Missing prices, Ready`

### 11.3 Category Head QC values
`Draft, For Review, Needs Revisions, Approved, Cancelled`

### 11.4 Difficulty values
`Low, Moderate, High, Max`

### 11.4a Roles

`viewer, editor, pm, catHead, contentLead, admin` — see §3 for the rank matrix, tab visibility, and Editor Stats access gates.

### 11.4b Editor Stats badges

28 badges across 5 groups. All auto-computed from `STATE.assets` + `STATE.grades`; no persistence, no migration when the roster changes. Stretch tiers (Iron, GOAT, Untouchable, Flawless Fortnight, 30-Day Grind, Machine, All-Rounder, Globetrotter, Quarterly Champion) added 2026-07-30 after editors cleared most of the original set within a week.

| Group | Badge | Criterion |
|---|---|---|
| Milestones (7) | First Cut · In the Rhythm · Half-Century · Century · Legend · Iron · GOAT | 1 · 10 · 50 · 100 · 250 · 500 · 1000 lifetime approvals |
| Craft (7) | No Notes · On a Roll · Untouchable · Flawless Week · Flawless Fortnight · Perfect Grade · Excellent Month | 0-rev approval · 5 consecutive 0-rev · 10 consecutive 0-rev · full ISO week with 0-rev only · two consecutive 0-rev weeks · brand+qa+idea+within-cap grade · month with composite ≥ 90 |
| Momentum (5) | 3-Day Streak · Working Week · Fortnight · Marathoner · 30-Day Grind | 3 · 5 · 10 · 20 · 30 consecutive workdays with ≥1 approval |
| Range (7) | Same-Day Ship · Speed Demon · Machine · Category Sampler · All-Rounder · World Tour · Globetrotter | `assignedAt === dateApproved` · 5+ approvals in one UK day · 10+ approvals in one UK day · 3+ categories in one week · 5+ categories in one week · 3+ countries lifetime · 5 countries lifetime |
| Consistency (2) | On Target · Quarterly Champion | Current-month approvals ≥ `dailyTarget × workdays` · 3 consecutive months hitting that target |

Descriptions are written in the app in a conversational voice (contractions, punchy), not clinical spec-speak, so the shelf reads like a coach, not a KPI sheet.

### 11.5 Role → Slack route map

| Event | Recipient batch | Header | Channel |
|---|---|---|---|
| Assigned / In Progress | editor | `<@editor> — <Status>` | editor's daily thread → webhook |
| For Review | editor | `<@PM> — For Review from <@editor>` | editor's daily thread → webhook |
| Needs Revisions | editor | `<@editor> — Needs Revisions from <@PM>` | editor's daily thread → webhook |
| Approved | editor | `<@editor> — Approved from <@PM>` | editor's daily thread → webhook |
| CHQ: For Review | `CHQ:<category>` | `<@CategoryHead> — FOR REVIEW from <@editor>` | category's daily thread → webhook |
| CHQ: Needs Revisions / Approved | editor | `<@editor> — <STATUS> from <@CategoryHead>` | editor's daily thread → webhook |
| **UK Organic-only editor or CHQ batch** (overrides the two rows above) | editor / `CHQ:<category>` | as above | **Organic (UK) daily thread** → falls through to the row above when unset/stale |
| **UK Organic QC report (manual)** | shared Organic thread | n/a | Organic (UK) daily thread → ORG webhook chain |
| QC report (manual, all others) | `qcWebhooks[CC]` | n/a | webhook only |
| Per-campaign override | `campaign.slackOverride` | n/a | webhook |

### 11.6 Key constants

| Constant | Value | Purpose |
|---|---|---|
| `BATCH_TIME_LIMIT_MS` | 10000 | Auto-fire window for pending Slack batches |
| Activity log cap (memory) | 200 | In-memory ring buffer |
| Activity log cap (Firestore) | 50 (trimmed to 20 or 0 if doc >900 KB) | Sliced in `buildSnapshot` to respect 1 MB doc limit |
| Sent notifications cap (memory) | 20 | Recent history shown in Notifications tab |
| Sent notifications cap (Firestore) | 5 (trimmed to 0 if doc >900 KB) | Sliced in `buildSnapshot` to respect 1 MB doc limit |
| Daily approval target | 10 | UK Paid Ads only |
| Monthly approval target | 200 | UK Paid Ads only |
| Firestore main doc | `state/app` | Campaigns, config, history — no assets |
| Firestore assets subcollection | `state/app/assets/{id}` | One document per asset |
| Firestore debounce | 600ms | Write throttle; batch commits assets + main doc together |
| Upload retry backoff | 3s → 8s → 20s → 60s cap | Exponential, resets to 3s on success |
| Back Online chip display | 3s + 0.5s fade | Transient topbar chip on reconnect |
| Auth domain | `@tilt.app` | Sign-in whitelist |

### 11.7 Countries

| Code | Name |
|---|---|
| UK | United Kingdom |
| IT | Italy |
| ES | Spain |
| US | United States |

### 11.8 Editors

Auto-scheduling has been removed; all assignments are manual. Capacity guidance below is reference-only.

| Editor | Suggested daily cap | Country priority |
|---|---|---|
| Zidni | 4 | ES › IT › UK |
| Sharm | 3 | UK |
| Patty | 3 | UK |
| Elsa | n/a | n/a |

### 11.9 Category Heads

| Category | Head |
|---|---|
| Sneakers | Anand |
| TCG | Hanyan |
| Stone Island | Nazy |
| Luxury | Cristian |
| Vintage | Nazy |
| Bags and Accessories | Nazy |
| Y2K | Nazy |
| Jewellery | Nazy |
| Health and Beauty | Nazy |
| Streetwear | Jacob |

---

*End of PRD.*
