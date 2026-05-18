# Tilt Creative Tracker — Product Requirements Document

> **Source of truth** for the single-file HTML app at `index.html`. This document describes the app *as built* and is intended to be the PRD for future work. When the code and this doc disagree, fix one of them — don't leave them out of sync.

---

## 1. Overview

**Tilt Creative Tracker** is a video-asset workflow tool for a creative team producing short-form videos across five markets (UK, IT, ES, US, PL). It centralises:

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
- A Firestore listener on `state/app` pulls remote snapshots back into `STATE` (last-write-wins). A second listener on the `state/app/assets` subcollection keeps `STATE.assets` in sync in real time. Both listeners reject `fromCache: true` snapshots (stale IndexedDB) — only server-confirmed data is ever applied. Incoming snapshots are deferred while a local upload is pending (up to 2s, 8 retries × 250ms) so in-flight edits are never overwritten by a simultaneous sync from another browser.
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

### Routing model
There is no router. Tabs in the topbar swap visible panels via state. Tab order is user-draggable and persisted in `STATE.tabOrder`.

### ID normalisation
Campaign and asset IDs are heterogeneous: seed records use plain integers, while records created or imported after initial load use prefixed strings (`c{n}` for campaigns, `a{n}` for assets). Two helper functions — `findCampaignById(id)` and `findAssetById(id)` — normalise both sides of every comparison with `String()`, so lookups are type-safe regardless of which ID format is stored. All HTML `onclick`/`onchange` handlers embed IDs as quoted strings (e.g. `App.selectCampaign('c7')`) to prevent JavaScript treating the ID as a variable reference. The `data-*` attributes on draggable elements (`data-asset-id`, `data-camp-id`) are read raw (no `parseInt`) for the same reason.

---

## 3. User Roles

Auth is gated to `@tilt.app` emails. Within that, roles are inferred by name/identity, not by ACL — every signed-in user technically sees the full UI, but the workflow is designed around these roles:

| Role | Members | Primary surfaces |
|---|---|---|
| Editors | **Zidni, Sharm, Patty, Elsa** | Campaigns tab, Today Kanban, their notification batch |
| Category Heads | **Anand** (Sneakers), **Hanyan** (TCG), **Nazy** (Stone Island, Vintage, Bags and Accessories, Y2K, Jewellery, Health and Beauty), **Cristian** (Luxury) | Category Head QC column, CHQ Slack route |
| PMs | One per country (UK, IT, ES, US, PL) | PM Slack route for "For Review" videos |
| Admin | Owner of the data | Config tab, Automations tab, all CRUD |

Auto-scheduling (the 3pm scheduler) treats **Zidni, Sharm, Patty** as auto-assigned and **Elsa** as manual-only (she receives reactive pings, not scheduled drops).

---

## 4. Data Model

All entities live as arrays/objects on the global `STATE`. Identifiers are local IDs generated client-side.

### 4.1 Campaign (sub-campaign)
`STATE.campaigns[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string or number | Local UID. Seed data uses plain integers (`1`–`5`); campaigns created via the UI or imported from CSV use prefixed strings (`c7`, `c8`, …). All lookup functions normalise with `String()` so both forms work transparently. |
| `country` | string | One of UK/IT/ES/US/PL |
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
| `sparksCode` | string | Sparks promotion code — only surfaced in the UI for IT, ES, PL campaigns |
| `estDelivery` | string (YYYY-MM-DD) | ETA |
| `dateApproved` | string (YYYY-MM-DD) | Stamped on transition to Approved |
| `scheduledFor` | string (YYYY-MM-DD) | Stamped by the scheduler |
| `released` | boolean | Set when editor batch is sent |
| `version` | number | Bumped on each mutation |
| `assignedAt` | timestamp | Set when an editor is assigned |

### 4.3 Country
`STATE.countries[]` — 5 hardcoded entries (UK, IT, ES, US, PL) with flag styling.

### 4.4 Category
`STATE.categories[]` — user-managed. Seeded in this canonical display order: **Sneakers, TCG, Stone Island, Luxury, Vintage, Bags and Accessories, Y2K, Streetwear, Health and Beauty, Jewellery** (Essentials and BTS retained at the end for backward compatibility). Each has a colour pair (bg/fg). Each category resolves to a Category Head via the `CATEGORY_HEADS` map. On first load after this change, existing `STATE.categories` arrays are automatically reordered to match and Streetwear is added if missing.

### 4.5 Pending notification batches
`STATE.pendingBatches{}` — keyed by recipient:

- `Zidni` / `Sharm` / `Patty` / `Elsa` — editor batches
- `PM:UK` / `PM:IT` / `PM:ES` / `PM:US` / `PM:PL` — PM "For Review" queues
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
- `STATE.dailyThreads` — `{ Zidni, Sharm, Patty }` — per-editor daily thread `{ date, url, channelId, threadTs }`. Cleared at midnight.
- `STATE.dailyThreadHistory` — last 7 archived thread URLs per editor.
- `STATE.catHeadDailyThreads` — per-category daily thread, keyed by category name. Same shape as `dailyThreads`.
- `STATE.catHeadDailyThreadHistory` — last 7 archived thread URLs per category.

---

## 5. Screens / Tabs

All six tabs are drag-reorderable in the topbar; order is persisted.

### 5.1 Campaigns (default)
- **Sidebar**: countries grouped, sub-campaigns underneath. Compact toggle (110px / 280px). A **global search bar** at the top of the sidebar searches asset names across all campaigns — results show the flag, asset name, and campaign name; clicking a result navigates to the campaign and flashes the asset row. Month filter dropdown filters campaigns by whether any of their assets has `estDelivery` in that month. Campaigns with `done = true` display with a **green left accent border**, light green background tint, and dimmed name text. Below each country section (in full mode), two side-by-side buttons: **+ Add Campaign** and **⬇ Import** — both always visible regardless of whether the country is expanded.
- **Header**: campaign title, brief, rank, asset count, approval %, Drive/Brief/Finals link pills, month chip, Slack override warning (if any). A **Mark Done / ✓ Done** button toggles the campaign's `done` state; when done the button turns green. A **✓ Approve All Assigned (N)** button appears when the campaign has one or more `Assigned` assets — clicking it bulk-approves all of them, stamps `dateApproved = today`, and fires the normal Slack notifications.
- **Asset table**: `# | Name | Category | Difficulty | Raw | Brief | Editor | Video | [Sparks Code] | ETA | Date Approved | QC | Status | Category Head QC | CH Date Approved | Actions`. Inline editing on most cells. The **Sparks Code** column is only shown for IT, ES, and PL campaigns. The **Video** cell shows a copy button (⧉) when a Final Video URL is set — clicking it copies `Video name: URL` to the clipboard. **For IT, ES, and PL campaigns**, the **Category Head QC** and **CH Date Approved** columns are hidden from the asset table, and the **"All CH QC Approved"** and **"Sync CH Date"** toolbar buttons are also hidden.
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
- **Monthly tally panel**: sits above the board. Shows video count vs 200 target, pace indicator, progress bar with expected-pace marker, and per-week chips (Friday-ending). Cancelled assets (status = Cancelled or categoryHeadQc = Cancelled) are excluded from total counts for all progress calculations — a campaign where every non-cancelled video is CH-approved shows 100%. The count is based on **campaign `monthYear` tag** — any video added to a campaign tagged to a given month counts toward that month's tally, regardless of approval status or when it was approved. Includes a **month dropdown** populated from the `monthYear` fields of existing campaigns — selecting a past month shows its final count and goal-met/not-met status instead of live pace. Organic videos are tracked separately in a sub-tally with no target. Month selection is transient (not persisted).

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
- **Routing.** Editor batches deliver to that editor's daily Slack thread (webhook + `thread_ts`, `reply_broadcast: false`) when a thread is set. CHQ batches route to the category's daily thread when set. Falls back to the webhook when no thread is configured or the post fails.
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
- One **daily thread URL** per editor (Zidni / Sharm / Patty) and per category (Sneakers, TCG, etc.), pasted at the start of each day. URL is parsed for `channelId` + `threadTs`.
- Sends use the incoming webhook with `thread_ts` + `reply_broadcast: false` so the reply lands in the thread only (no channel broadcast).
- A sweep at midnight archives stale thread entries (last 7 per editor/category retained).
- On thread post failure, the message automatically falls back to the webhook.

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

---

## 10. Known Gaps (as-built)

These are flagged so future work can address them — they are **not** broken, they are intentional simplifications.

- No analytics / reporting dashboard (no monthly burn chart, no editor utilisation chart).
- Search within the campaign toolbar is scoped to the current campaign; the sidebar global search covers all campaigns but is limited to asset name matching (no status/editor filtering).
- Firestore conflict resolution is last-write-wins — no CRDT, no merge UI.
- No file uploads — Drive / Brief / Final Video are URL fields only.
- QC-report send is manual; there is no auto-send when a campaign hits 100% approval.
- Activity log is text-only; no query, filter, or export UI.
- No server-side scheduled jobs — the 3pm scheduler runs in the open browser.
- Slack-only notifications — no email, no in-app inbox.
- Categories are flat; no sub-categories.
- No role-based UI gating at the cell level (everyone signed in sees everything).
- Weekend toggle is per-run, not a recurring rule.
- CSV import is one-way (Google Sheets → app); no automated two-way sync.

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

### 11.5 Role → Slack route map

| Event | Recipient batch | Header | Channel |
|---|---|---|---|
| Assigned / In Progress | editor | `<@editor> — <Status>` | editor's daily thread → webhook |
| For Review | editor | `<@PM> — For Review from <@editor>` | editor's daily thread → webhook |
| Needs Revisions | editor | `<@editor> — Needs Revisions from <@PM>` | editor's daily thread → webhook |
| Approved | editor | `<@editor> — Approved from <@PM>` | editor's daily thread → webhook |
| CHQ: For Review | `CHQ:<category>` | `<@CategoryHead> — FOR REVIEW from <@editor>` | category's daily thread → webhook |
| CHQ: Needs Revisions / Approved | editor | `<@editor> — <STATUS> from <@CategoryHead>` | editor's daily thread → webhook |
| QC report (manual) | `qcWebhooks[CC]` | n/a | webhook only |
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
| PL | Poland |

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
