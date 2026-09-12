// =====================================================================
// Cloud Functions for Tilt Creative Tracker
// ---------------------------------------------------------------------
// Purpose: keep the Slack bot token (and later the Meta access token) OFF
// the client. The browser calls these functions; the functions hold the
// tokens server-side and forward the request to Slack / Meta.
//
// Tokens are set via the Firebase CLI, not committed to git:
//   firebase functions:secrets:set SLACK_BOT_TOKEN
//
// Auth: every function verifies the caller is a signed-in @tilt.app user.
// =====================================================================

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const SLACK_BOT_TOKEN = defineSecret('SLACK_BOT_TOKEN');
const LINEAR_API_KEY = defineSecret('LINEAR_API_KEY');
const DRIVE_SERVICE_ACCOUNT_JSON = defineSecret('DRIVE_SERVICE_ACCOUNT_JSON');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const FRAMEIO_TOKEN = defineSecret('FRAMEIO_TOKEN');

const ALLOWED_DOMAIN = 'tilt.app';

// Reject any call from a user who isn't signed in with @tilt.app.
function requireTiltUser(request) {
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!email || !email.toLowerCase().endsWith('@' + ALLOWED_DOMAIN)) {
    throw new HttpsError('permission-denied', 'Only @' + ALLOWED_DOMAIN + ' users may call this function.');
  }
}

// ── Slack: post as a bot ─────────────────────────────────────────────
// Client calls this instead of doing chat.postMessage itself. Client passes
// { channel, threadTs, text }; server adds the bot token and posts.
exports.sendSlackChatPostMessage = onCall(
  { secrets: [SLACK_BOT_TOKEN], region: 'us-central1' },
  async (request) => {
    requireTiltUser(request);

    const { channel, threadTs, text } = request.data || {};
    if (!channel || !text) {
      throw new HttpsError('invalid-argument', 'channel and text are required');
    }

    const body = new URLSearchParams({
      token: SLACK_BOT_TOKEN.value(),
      channel: String(channel),
      text: String(text),
      unfurl_links: 'false',
      unfurl_media: 'false',
    });
    if (threadTs) {
      body.set('thread_ts', String(threadTs));
      body.set('reply_broadcast', 'false');
    }

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await res.json();
    if (!json.ok) {
      console.log('[slack.postMessage] failed', JSON.stringify({
        channel: String(channel), threadTs: threadTs ? String(threadTs) : null,
        status: res.status, error: json.error || 'unknown', response_metadata: json.response_metadata || null,
      }));
    }
    // Return the same shape the client's postToSlackThread expects.
    return { ok: !!json.ok, body: json.error || (json.ok ? 'ok' : 'unknown'), status: res.status };
  }
);

// ── Slack: DM a scorecard image to an editor ─────────────────────────
// Client calls with { editorSlackId, imageBase64, filename?, initialComment? }.
// Server opens a DM with the editor and uploads the image via the v2 file API
// (files.upload was deprecated Mar 2025). Three steps: getUploadURLExternal →
// POST bytes → completeUploadExternal with the DM channel_id.
exports.sendSlackScorecardDm = onCall(
  { secrets: [SLACK_BOT_TOKEN], region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' },
  async (request) => {
    requireTiltUser(request);

    const { editorSlackId, imageBase64, filename, initialComment } = request.data || {};
    if (!editorSlackId || !imageBase64) {
      throw new HttpsError('invalid-argument', 'editorSlackId and imageBase64 are required');
    }
    const token = SLACK_BOT_TOKEN.value();
    const authHeader = 'Bearer ' + token;

    // 1. Open a DM with the editor.
    const openRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: authHeader },
      body: new URLSearchParams({ users: String(editorSlackId) }).toString(),
    });
    const openJson = await openRes.json();
    if (!openJson.ok) {
      return { ok: false, body: 'conversations.open failed: ' + (openJson.error || 'unknown') };
    }
    const channelId = openJson.channel.id;

    // 2. Reserve an upload URL for the image.
    const buffer = Buffer.from(imageBase64, 'base64');
    const uploadFilename = filename || 'scorecard.png';
    const getUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: authHeader },
      body: new URLSearchParams({ filename: uploadFilename, length: String(buffer.length) }).toString(),
    });
    const getUrlJson = await getUrlRes.json();
    if (!getUrlJson.ok) {
      return { ok: false, body: 'getUploadURLExternal failed: ' + (getUrlJson.error || 'unknown') };
    }
    const { upload_url: uploadUrl, file_id: fileId } = getUrlJson;

    // 3. POST the raw file bytes to the reserved URL.
    const putRes = await fetch(uploadUrl, { method: 'POST', body: buffer });
    if (!putRes.ok) {
      return { ok: false, body: 'file upload POST failed: ' + putRes.status };
    }

    // 4. Complete the upload and share it into the editor's DM.
    const completePayload = {
      files: [{ id: fileId, title: uploadFilename }],
      channel_id: channelId,
    };
    if (initialComment) completePayload.initial_comment = String(initialComment);
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify(completePayload),
    });
    const completeJson = await completeRes.json();
    if (!completeJson.ok) {
      return { ok: false, body: 'completeUploadExternal failed: ' + (completeJson.error || 'unknown') };
    }

    return { ok: true, body: 'ok', channel: channelId, fileId: fileId };
  }
);

// ── Linear: push completed campaigns as issues ───────────────────────
// Client clicks a button; server reads Firestore state, computes each
// completed campaign's KPI + a team-wide snapshot, and creates (or
// updates, if already pushed) one Linear issue per completed campaign.
// Config lives in Firestore config/linear = { teamKey, projectId }.
// Push history lives in state/app/linearPushes/{campaignId} so we
// never race the main state/app doc.
exports.pushCompletedCampaignsToLinear = onCall(
  { secrets: [LINEAR_API_KEY], region: 'us-central1', timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    requireTiltUser(request);

    // Reporting filter passed from the client (Reporting tab's current selection).
    // Falls back to "no filter" — pushes every completed campaign.
    const filter = (request.data && request.data.filter) || {};
    const range = filter.range && filter.range.start && filter.range.end ? filter.range : null;
    const wantCountry  = filter.country  && filter.country  !== 'all' ? filter.country  : null;
    const wantType     = filter.type     && filter.type     !== 'all' ? filter.type     : null;
    const wantCategory = filter.category && filter.category !== 'all' ? filter.category : null;

    // 1. Load config.
    const cfgSnap = await db.doc('config/linear').get();
    if (!cfgSnap.exists) {
      throw new HttpsError('failed-precondition', 'config/linear document is missing. Create it with { teamKey, projectId }.');
    }
    const cfg = cfgSnap.data() || {};
    const teamKey = cfg.teamKey;
    const projectId = cfg.projectId || null;
    const assigneeEmail = cfg.assigneeEmail || 'elsa@tilt.app';
    if (!teamKey) {
      throw new HttpsError('failed-precondition', 'config/linear.teamKey is required.');
    }

    // 2. Resolve team key → team id (Linear needs the id, not the key).
    const teamId = await linearGetTeamId(teamKey);

    // 2b. Resolve projectId. Accepts a full UUID, the URL-slug tail
    // (the last 12 hex chars Linear appends to `.../project/name-<hex>`),
    // or a project name — resolves to a real UUID by searching every
    // project in the workspace. Fails loudly with the available project
    // names so the config error is diagnosable.
    const resolvedProject = projectId ? await linearResolveProject(teamId, projectId) : null;
    const resolvedProjectId = resolvedProject ? resolvedProject.id : null;
    console.log('[Linear] Config projectId:', JSON.stringify(projectId), '→ resolved:', JSON.stringify(resolvedProject));

    // 2c. Resolve assignee email → Linear user id (once per invocation).
    const assigneeId = assigneeEmail ? await linearResolveUserId(assigneeEmail) : null;
    console.log('[Linear] Assignee:', assigneeEmail, '→', assigneeId);

    // 3. Load workspace state + assets subcollection + existing push history.
    const [stateSnap, assetsSnap, pushesSnap] = await Promise.all([
      db.doc('state/app').get(),
      db.collection('state/app/assets').get(),
      db.collection('state/app/linearPushes').get(),
    ]);
    if (!stateSnap.exists) {
      throw new HttpsError('failed-precondition', 'state/app document is missing.');
    }
    const state = stateSnap.data() || {};
    const campaigns = Array.isArray(state.campaigns) ? state.campaigns : [];
    const grades = Array.isArray(state.grades) ? state.grades : [];
    const assets = [];
    assetsSnap.forEach((d) => assets.push(d.data()));
    const pushes = {};
    pushesSnap.forEach((d) => { pushes[d.id] = d.data(); });

    // 4. Determine which campaigns to push: completed OR ongoing (has at least
    // one non-cancelled asset). Completed uses the Reporting-tab signal
    // (c.done OR every non-cancelled asset Approved).
    const SIMPLE = new Set(['IT', 'ES', 'PL']);
    const campAssets = (cid) => assets.filter((a) => String(a.campaignId) === String(cid));
    const isCompleted = (c) => {
      if (c.done) return true;
      const active = campAssets(c.id).filter((a) => a.status !== 'Cancelled' && a.categoryHeadQc !== 'Cancelled');
      if (active.length === 0) return false;
      return active.every((a) => SIMPLE.has(c.country) ? a.status === 'Approved' : a.categoryHeadQc === 'Approved');
    };
    const hasActive = (c) => campAssets(c.id).some((a) => a.status !== 'Cancelled' && a.categoryHeadQc !== 'Cancelled');
    // Finish date = latest dateApproved across the campaign's assets. Used
    // for the title's Month token and to date-filter completed campaigns.
    const finishOf = (c) => campAssets(c.id).reduce((max, a) => (a.dateApproved && a.dateApproved > max) ? a.dateApproved : max, '');
    // Start date = campaign.goneLive if set, else earliest estDelivery on its
    // assets. Used to date-filter ongoing campaigns.
    const startOf = (c) => {
      if (c.goneLive) return c.goneLive;
      return campAssets(c.id).reduce((min, a) => {
        const d = a.estDelivery || '';
        if (!d) return min;
        return (!min || d < min) ? d : min;
      }, '');
    };
    // Country/type/category filters mirror the Reporting UI. Date-filter is
    // applied differently for completed vs ongoing:
    //   completed: finishDate ∈ [start, end]
    //   ongoing:   started on/before end (i.e., in-flight during the period)
    const matchesFilter = (c) => {
      if (wantCountry  && c.country !== wantCountry) return false;
      if (wantType     && (c.type || 'Paid Ads') !== wantType) return false;
      if (wantCategory && (c.category || 'Uncategorised') !== wantCategory) return false;
      if (!range) return true;
      if (isCompleted(c)) {
        const f = finishOf(c);
        return f && f >= range.start && f <= range.end;
      }
      const s = startOf(c);
      return s ? s <= range.end : true;
    };
    const completed = campaigns.filter((c) => (isCompleted(c) || hasActive(c)) && matchesFilter(c));

    // 5. Push each campaign — parallel with a concurrency cap so 100+
    // campaigns don't serialise into a 60s+ callable timeout, while staying
    // under Linear's per-second burst limits. Idempotent: campaigns that
    // already have a live Linear issue are left untouched (no update).
    const created = [];
    const skipped = [];
    const errors = [];
    const CONCURRENCY = 8;
    async function pushOne(c) {
      try {
        const existing = pushes[String(c.id)];
        // Linear "delete" is a soft-delete: issueUpdate on a trashed issue
        // still returns success:true, so a stored id may point at a tombstone.
        // Verify the stored issue is alive; if it is, skip. If not, fall
        // through to create a fresh issue and overwrite the push-history doc.
        const alive = existing && existing.issueId ? await linearIsIssueAlive(existing.issueId) : false;
        if (alive) {
          skipped.push({ campaignId: c.id, issueId: existing.issueId, url: existing.url || null, identifier: existing.identifier || null });
          return;
        }
        const campMetrics = computeCampaignMetrics(c, campAssets(c.id), grades);
        const title = buildIssueTitle(c, finishOf(c));
        const body = buildIssueBody(c, campAssets(c.id), campMetrics);
        const res = await linearCreateIssue({ teamId, projectId: resolvedProjectId, title, description: body, assigneeId });
        await db.doc('state/app/linearPushes/' + String(c.id)).set({
          issueId: res.id,
          url: res.url,
          identifier: res.identifier,
          pushedAt: admin.firestore.FieldValue.serverTimestamp(),
          title, campaignId: String(c.id),
        });
        created.push({ campaignId: c.id, issueId: res.id, url: res.url, identifier: res.identifier });
      } catch (e) {
        errors.push({ campaignId: c.id, name: c.name, error: (e && e.message) || String(e) });
      }
    }
    for (let i = 0; i < completed.length; i += CONCURRENCY) {
      await Promise.all(completed.slice(i, i + CONCURRENCY).map(pushOne));
    }

    return {
      ok: errors.length === 0,
      created: created.length,
      updated: 0,
      skipped: skipped.length,
      completedTotal: completed.length,
      project: resolvedProject,
      errors,
      details: { created, skipped },
    };
  }
);

// ─── Linear GraphQL helpers ──────────────────────────────────────────

async function linearGraphQL(query, variables) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: LINEAR_API_KEY.value(),
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors && json.errors.length) {
    // Surface field-level detail (Linear tucks it into extensions.userPresentableMessage
    // or extensions.errors[]) so config bugs don't just say "Argument Validation Error".
    const parts = json.errors.map((e) => {
      const ext = e.extensions || {};
      const detail = ext.userPresentableMessage || (Array.isArray(ext.errors) && ext.errors.map((x) => x.message || JSON.stringify(x)).join(', '));
      return detail && detail !== e.message ? (e.message + ' — ' + detail) : e.message;
    });
    throw new Error('Linear API: ' + parts.join('; '));
  }
  return json.data;
}

// Linear project IDs are UUIDs. Users often paste the URL-slug tail
// (last 12 hex chars, no hyphens) or the project name instead. Resolve
// any of those to the real UUID by listing ALL workspace projects (not
// just team.projects — projects can be workspace-scoped and still valid
// on the team). Returns { id, name } or throws with the projects seen.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function linearResolveProject(teamId, raw) {
  const value = String(raw).trim();
  // Fast path: Linear's project(id:) accepts either a full UUID or the URL
  // slug-tail (the 12 hex chars Linear appends to /project/name-<hex>), and
  // works even when the API token's user can't see the project via the
  // workspace-wide projects() listing.
  const trySlugs = [value];
  const urlMatch = value.match(/\/project\/([^\/?#]+)/i);
  if (urlMatch) trySlugs.push(urlMatch[1]);
  const tailMatch = value.match(/([0-9a-f]{12})(?:\/|$)/i);
  if (tailMatch) trySlugs.push(tailMatch[1]);
  for (const slug of trySlugs) {
    try {
      const d = await linearGraphQL('query($id:String!){ project(id:$id){ id name } }', { id: slug });
      if (d && d.project && d.project.id) return { id: d.project.id, name: d.project.name };
    } catch (_) { /* fall through to listing */ }
  }
  // Fallback: paginate every workspace project the API token can see and
  // match by UUID, name, or slug-tail.
  const nodes = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await linearGraphQL(
      'query($after:String){ projects(first:250, after:$after, includeArchived:false){ pageInfo{ hasNextPage endCursor } nodes{ id name } } }',
      { after }
    );
    const chunk = (data && data.projects && data.projects.nodes) || [];
    nodes.push(...chunk);
    const info = (data && data.projects && data.projects.pageInfo) || {};
    if (!info.hasNextPage) break;
    after = info.endCursor;
  }
  // If a full UUID was given, look it up directly (returns name for logging).
  if (UUID_RE.test(value)) {
    const byId = nodes.find((p) => String(p.id).toLowerCase() === value.toLowerCase());
    return byId || { id: value, name: '(unknown — UUID not in workspace listing)' };
  }
  const lower = value.toLowerCase();
  // Match by name (case-insensitive), then by URL-slug tail (id ends with the value).
  const byName = nodes.find((p) => String(p.name || '').toLowerCase() === lower);
  if (byName) return { id: byName.id, name: byName.name };
  const byTail = nodes.find((p) => String(p.id).replace(/-/g, '').toLowerCase().endsWith(lower.replace(/-/g, '')));
  if (byTail) return { id: byTail.id, name: byTail.name };
  const sample = nodes.slice(0, 20).map((p) => p.name + ' (' + p.id + ')').join(', ');
  throw new Error('config/linear.projectId "' + value + '" did not match any project in the workspace. Paste the full UUID or the project name. Workspace projects: ' + (sample || 'none'));
}

async function linearGetTeamId(teamKey) {
  const data = await linearGraphQL(
    'query($key:String!){ teams(filter:{key:{eq:$key}}){ nodes{ id key name } } }',
    { key: String(teamKey).toUpperCase() }
  );
  const node = data && data.teams && data.teams.nodes && data.teams.nodes[0];
  if (!node) throw new Error('Linear team not found for key "' + teamKey + '".');
  return node.id;
}

async function linearCreateIssue({ teamId, projectId, title, description, assigneeId }) {
  const input = { teamId, title, description };
  if (projectId) input.projectId = projectId;
  if (assigneeId) input.assigneeId = assigneeId;
  const data = await linearGraphQL(
    'mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }',
    { input }
  );
  if (!data.issueCreate || !data.issueCreate.success) {
    throw new Error('Linear issueCreate returned success=false.');
  }
  return data.issueCreate.issue;
}

// Returns true iff the issue still exists and hasn't been trashed. Any query
// error (e.g. "Entity not found") is treated as not-alive so the caller falls
// back to creating a fresh issue instead of updating a tombstone.
async function linearIsIssueAlive(issueId) {
  try {
    const data = await linearGraphQL(
      'query($id:String!){ issue(id:$id){ id trashed } }',
      { id: issueId }
    );
    const iss = data && data.issue;
    return !!(iss && iss.id && !iss.trashed);
  } catch (_) {
    return false;
  }
}

async function linearUpdateIssue(issueId, { title, description, projectId, assigneeId }) {
  const input = { title, description };
  if (projectId) input.projectId = projectId;
  if (assigneeId) input.assigneeId = assigneeId;
  const data = await linearGraphQL(
    'mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success } }',
    { id: issueId, input }
  );
  if (!data.issueUpdate || !data.issueUpdate.success) {
    throw new Error('Linear issueUpdate returned success=false.');
  }
}

// Resolve a workspace-member email to a Linear user id (used for assignee).
// Falls back to null if not found — the caller then omits the field.
async function linearResolveUserId(email) {
  const data = await linearGraphQL(
    'query($email:String!){ users(filter:{email:{eq:$email}}){ nodes{ id email } } }',
    { email: String(email).trim().toLowerCase() }
  );
  const nodes = (data && data.users && data.users.nodes) || [];
  return nodes[0] ? nodes[0].id : null;
}

// Title template: "Creative Production | <Category> - <Campaign Name> | <Month YYYY>".
// Month prefers the campaign's user-set monthYear (matches how the tracker groups
// campaigns in the sidebar / Reporting tab), falling back to the campaign's finish
// date (latest asset approval) when monthYear is unset.
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function buildIssueTitle(c, finishDate) {
  const cat  = c.category || 'Uncategorised';
  const name = c.name || 'Untitled';
  const iso  = (c.monthYear && /^\d{4}-\d{2}/.test(c.monthYear)) ? c.monthYear : (finishDate || '');
  let monthLbl = '';
  if (/^\d{4}-\d{2}/.test(iso)) {
    const yr = iso.slice(0, 4);
    const mi = parseInt(iso.slice(5, 7), 10) - 1;
    if (mi >= 0 && mi < 12) monthLbl = MONTH_NAMES[mi] + ' ' + yr;
  }
  return 'Creative Production | ' + cat + ' - ' + name + (monthLbl ? ' | ' + monthLbl : '');
}

function pctRate(num, den) { return den > 0 ? (num / den * 100) : 0; }

// Detect Net New vs Maintenance from a video's file name (Tilt naming code).
// Port of detectContentType in app.js:6020 — OP family → Maintenance, N family → Net New.
function detectContentType(name) {
  if (!name) return null;
  const tokens = String(name).split(/[_\s]+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toUpperCase();
    if (/^\d*I?OP$/.test(t)) return 'Maintenance';
    if (/^\d*N$/.test(t)) return 'Net New';
  }
  return null;
}

// Countries whose completion signal is Status (not Cat. Head QC) — mirrors the
// SIMPLE set in the callable above.
const SIMPLE_COUNTRIES = new Set(['IT', 'ES', 'PL']);

// Per-campaign metrics: all grades linked to this campaign's assets, no date filter.
function computeCampaignMetrics(campaign, campaignAssets, grades) {
  const assetIds = new Set(campaignAssets.map((a) => String(a.id)));
  const rows = grades.filter((g) => assetIds.has(String(g.assetId)) && !g.dismissed);
  const total = rows.length;
  const qaN = rows.filter((g) => g.qaClean).length;
  const brandN = rows.filter((g) => g.brandPass).length;
  const ideasN = rows.filter((g) => g.newIdea).length;
  const revisionRounds = campaignAssets.map((a) => Number(a.revisionRounds) || 0);
  const avgRounds = revisionRounds.length ? revisionRounds.reduce((s, x) => s + x, 0) / revisionRounds.length : null;
  const isSimple = SIMPLE_COUNTRIES.has(campaign.country);
  const catHeadApproved = campaignAssets.filter((a) => isSimple ? a.status === 'Approved' : a.categoryHeadQc === 'Approved').length;
  let newCount = 0, optimizedCount = 0;
  campaignAssets.forEach((a) => {
    const ct = detectContentType(a.name);
    if (ct === 'Net New') newCount++;
    else if (ct === 'Maintenance') optimizedCount++;
  });
  return {
    total,
    qaRate: pctRate(qaN, total),
    brandRate: pctRate(brandN, total),
    innovationRate: pctRate(ideasN, total),
    avgRevisionRounds: avgRounds,
    editors: Array.from(new Set(campaignAssets.map((a) => a.editor).filter(Boolean))),
    logged: campaignAssets.length,
    catHeadApproved,
    newCount,
    optimizedCount,
  };
}

function fmtPct(v) { return v == null ? '—' : (Math.round(v * 10) / 10) + '%'; }
function fmtNum(v, digits) { if (v == null) return '—'; const p = Math.pow(10, digits || 1); return String(Math.round(v * p) / p); }

// Where each asset sits in the production funnel. Simple countries (IT/ES/PL)
// stop at PM Approved; the rest also pass through Cat. Head QC after that.
// Order matches the stage order the summary reports.
const FUNNEL_STAGES = ['Draft', 'Editing', 'PM QC', 'PM revisions', 'Awaiting Cat. Head QC', 'Cat. Head QC', 'Cat. Head revisions', 'Approved', 'Cancelled'];
function funnelStage(a, isSimple) {
  if (a.status === 'Cancelled' || a.categoryHeadQc === 'Cancelled') return 'Cancelled';
  if (isSimple) {
    if (a.status === 'Approved') return 'Approved';
    if (a.status === 'Needs Revisions') return 'PM revisions';
    if (a.status === 'For Review') return 'PM QC';
    if (a.status === 'In Progress' || a.status === 'Assigned') return 'Editing';
    return 'Draft';
  }
  if (a.categoryHeadQc === 'Approved') return 'Approved';
  if (a.status === 'Approved') {
    if (a.categoryHeadQc === 'Needs Revisions') return 'Cat. Head revisions';
    if (a.categoryHeadQc === 'For Review') return 'Cat. Head QC';
    return 'Awaiting Cat. Head QC';
  }
  if (a.status === 'Needs Revisions') return 'PM revisions';
  if (a.status === 'For Review') return 'PM QC';
  if (a.status === 'In Progress' || a.status === 'Assigned') return 'Editing';
  return 'Draft';
}

function buildIssueBody(c, campaignAssets, camp) {
  const finishDate = campaignAssets.reduce((max, a) => (a.dateApproved && a.dateApproved > max) ? a.dateApproved : max, '');
  // Started = campaign's on-platform go-live date if set, otherwise the earliest
  // estDelivery across the campaign's assets (proxy for production start).
  let startDate = c.goneLive || '';
  if (!startDate) {
    startDate = campaignAssets.reduce((min, a) => {
      const d = a.estDelivery || '';
      if (!d) return min;
      return (!min || d < min) ? d : min;
    }, '');
  }
  const editorsList = camp.editors.length ? camp.editors.join(', ') : '—';

  // ── Funnel breakdown ──
  // Per-stage counts across every asset on the campaign, plus a row per
  // still-in-flight asset (anything not Approved and not Cancelled) so the
  // issue shows exactly where the video is sitting.
  const isSimple = SIMPLE_COUNTRIES.has(c.country);
  const stageCounts = Object.create(null);
  const inflightRows = [];
  campaignAssets.forEach((a) => {
    const stage = funnelStage(a, isSimple);
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;
    if (stage !== 'Approved' && stage !== 'Cancelled') {
      inflightRows.push({ name: a.name || '(untitled)', editor: a.editor || '—', stage });
    }
  });
  const activeAssets = campaignAssets.filter((a) => a.status !== 'Cancelled' && a.categoryHeadQc !== 'Cancelled');
  const isComplete = activeAssets.length > 0 && activeAssets.every((a) => isSimple ? a.status === 'Approved' : a.categoryHeadQc === 'Approved');
  const stageSummary = FUNNEL_STAGES.filter((s) => stageCounts[s]).map((s) => stageCounts[s] + ' ' + s).join(' · ');
  const funnelLines = ['## Funnel', '- **Status:** ' + (isComplete ? 'Completed' : 'Ongoing'), '- **Stages:** ' + (stageSummary || '—')];
  if (inflightRows.length) {
    funnelLines.push('', '| Asset | Editor | Stage |', '| --- | --- | --- |');
    inflightRows.forEach((r) => funnelLines.push('| ' + r.name + ' | ' + r.editor + ' | ' + r.stage + ' |'));
  }

  return [
    '## Campaign',
    '- **Country:** ' + (c.country || '—'),
    '- **Category:** ' + (c.category || '—'),
    '- **Type:** ' + (c.type || '—'),
    '- **Editors:** ' + editorsList,
    '- **Assets:** ' + camp.logged + ' Logged / ' + camp.catHeadApproved + ' Approved by Cat. Head',
    '- **Content mix:** ' + camp.newCount + ' New / ' + camp.optimizedCount + ' Optimized',
    startDate ? '- **Started:** ' + startDate : '',
    finishDate ? '- **Completed:** ' + finishDate : '',
    '',
    funnelLines.join('\n'),
    '',
    '## This campaign\'s KPI',
    'Across the campaign\'s ' + camp.total + ' graded asset(s):',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    '| QA | ' + fmtPct(camp.qaRate) + ' |',
    '| Brand | ' + fmtPct(camp.brandRate) + ' |',
    '| Innovation | ' + fmtPct(camp.innovationRate) + ' |',
    '| Speed — Avg revision rounds | ' + (camp.avgRevisionRounds == null ? '—' : String(Math.round(camp.avgRevisionRounds))) + ' |',
  ].filter(Boolean).join('\n');
}

// =====================================================================
// Drive sync: index video files from Google Drive folders into the
// broll subcollection. Files stay in Drive; we only mirror metadata +
// thumbnail so the frontend can search/filter/tag.
// ---------------------------------------------------------------------
// Setup (one-off):
//   1. Create a service account in GCP console (any name, e.g.
//      broll-sync@tilt-project-tracker.iam.gserviceaccount.com).
//   2. Create a JSON key for it and store it as a Firebase secret:
//        firebase functions:secrets:set DRIVE_SERVICE_ACCOUNT_JSON
//      (paste the full JSON contents when prompted).
//   3. Grant the service-account email at least VIEWER on the Shared
//      Drive(s) or folder(s) it needs to read.
//   4. Write config/broll = { folderIds: ['<parent1>','<parent2>'] }
//      via the Config UI in the tracker.
// ---------------------------------------------------------------------
// Called from client:
//   firebase.functions().httpsCallable('syncDriveClips')({ dry: false })
// Scheduled nightly by syncDriveClipsScheduled below.
// =====================================================================

const DRIVE_VIDEO_QUERY = "mimeType contains 'video/' and trashed=false";
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
// Fields we want Drive to return per file. Kept tight so page requests stay small.
const DRIVE_FILE_FIELDS = 'files(id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,webViewLink,parents,hasThumbnail),nextPageToken';
const DRIVE_FOLDER_FIELDS = 'files(id,name),nextPageToken';
// Cap recursion so a misconfigured root can't infinitely spider.
const DRIVE_MAX_FOLDERS = 5000;
const DRIVE_MAX_FILES = 20000;

// Load a Google Auth client for Drive using the service-account secret.
// The secret value is the full JSON of the key file (single-line pasted in
// via `firebase functions:secrets:set DRIVE_SERVICE_ACCOUNT_JSON`).
function driveClient() {
  const { google } = require('googleapis');
  let keyJson;
  try {
    keyJson = JSON.parse(DRIVE_SERVICE_ACCOUNT_JSON.value());
  } catch (e) {
    throw new HttpsError('failed-precondition', 'DRIVE_SERVICE_ACCOUNT_JSON secret is missing or malformed JSON.');
  }
  const auth = new google.auth.JWT({
    email: keyJson.client_email,
    key: keyJson.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

// Walk a set of parent folder IDs, breadth-first, collecting every video
// file found in any descendant folder. Skips inaccessible root folders and
// records them as errors — a single mis-shared folder must NOT abort the
// entire sync. Returns { files, folders, errors }.
async function driveWalkFolders(drive, rootFolderIds) {
  const visited = new Set();
  const files = [];
  const errors = []; // { folderId, reason }
  // Try to resolve each root's name up front. Inaccessible roots go into
  // the errors list and are dropped from the queue — the sync continues
  // with everything else instead of throwing.
  const rootNames = {};
  const validRoots = [];
  await Promise.all(rootFolderIds.map(async (id) => {
    try {
      const res = await drive.files.get({
        fileId: id,
        fields: 'id,name,mimeType',
        supportsAllDrives: true,
      });
      if (res.data && res.data.id) {
        rootNames[res.data.id] = res.data.name || res.data.id;
        validRoots.push(id);
      }
    } catch (e) {
      errors.push({
        folderId: id,
        reason: (e && e.message ? e.message : String(e)),
      });
    }
  }));

  let queue = validRoots.map((id) => ({ id, path: rootNames[id] || id }));
  while (queue.length && visited.size < DRIVE_MAX_FOLDERS && files.length < DRIVE_MAX_FILES) {
    const { id: folderId, path } = queue.shift();
    if (visited.has(folderId)) continue;
    visited.add(folderId);

    try {
      // 1. List all video files in this folder.
      let pageToken = null;
      do {
        const res = await drive.files.list({
          q: `'${folderId}' in parents and ${DRIVE_VIDEO_QUERY}`,
          fields: DRIVE_FILE_FIELDS,
          pageSize: 1000,
          pageToken: pageToken || undefined,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: 'allDrives',
        });
        (res.data.files || []).forEach((f) => {
          f.folderPath = path;
          files.push(f);
        });
        pageToken = res.data.nextPageToken || null;
        if (files.length >= DRIVE_MAX_FILES) break;
      } while (pageToken);

      // 2. List subfolders and enqueue them.
      pageToken = null;
      do {
        const res = await drive.files.list({
          q: `'${folderId}' in parents and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`,
          fields: DRIVE_FOLDER_FIELDS,
          pageSize: 1000,
          pageToken: pageToken || undefined,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: 'allDrives',
        });
        (res.data.files || []).forEach((sub) => {
          if (!visited.has(sub.id)) {
            queue.push({ id: sub.id, path: path + ' / ' + (sub.name || sub.id) });
          }
        });
        pageToken = res.data.nextPageToken || null;
      } while (pageToken);
    } catch (e) {
      // Skip this subfolder and keep going. The overall sync stays resilient
      // to per-folder issues (permissions, deletions, transient API errors).
      errors.push({
        folderId,
        path,
        reason: (e && e.message ? e.message : String(e)),
      });
    }
  }
  return { files, folders: visited, errors };
}

// Turn a Drive file resource into the doc we store in state/app/broll/{id}.
// Only Drive-owned fields — user-tagged fields are preserved separately.
function brollDocFromDriveFile(f) {
  return {
    id: f.id,
    name: f.name || '(untitled)',
    mimeType: f.mimeType || '',
    size: f.size ? Number(f.size) : null,
    createdTime: f.createdTime || null,
    modifiedTime: f.modifiedTime || null,
    // Public thumbnail URL that works when the viewer is signed in to a
    // Google account with access to the file. Small (~w400) for grid speed.
    thumbnailUrl: 'https://drive.google.com/thumbnail?id=' + f.id + '&sz=w400',
    driveUrl: f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view'),
    folderPath: f.folderPath || '',
    hasThumbnail: !!f.hasThumbnail,
  };
}

// Shared implementation — called both by the callable and the scheduler.
// Returns { scanned, added, updated, archived, unarchived, foldersVisited }.
async function runDriveSync({ trigger, byEmail }) {
  // 1. Load config.
  const cfgSnap = await db.doc('config/broll').get();
  if (!cfgSnap.exists) {
    throw new HttpsError('failed-precondition',
      'config/broll document is missing. Create it with { folderIds: [<driveFolderId>, ...] }.');
  }
  const cfg = cfgSnap.data() || {};
  const folderIds = Array.isArray(cfg.folderIds) ? cfg.folderIds.filter(Boolean).map(String) : [];
  if (!folderIds.length) {
    throw new HttpsError('failed-precondition',
      'config/broll.folderIds is empty. Add at least one Google Drive folder ID.');
  }

  // 2. Walk Drive.
  const drive = driveClient();
  const { files: driveFiles, folders: foldersVisited, errors: walkErrors } = await driveWalkFolders(drive, folderIds);

  // 3. Load current broll subcollection so we can diff.
  const existingSnap = await db.collection('state/app/broll').get();
  const existing = {};
  existingSnap.forEach((d) => { existing[d.id] = d.data() || {}; });

  const seen = new Set();
  const writes = []; // { id, data, kind: 'added' | 'updated' | 'unarchived' }
  driveFiles.forEach((f) => {
    seen.add(f.id);
    const driveDoc = brollDocFromDriveFile(f);
    const prev = existing[f.id];
    if (!prev) {
      // New clip — full record, no tags yet.
      writes.push({
        id: f.id,
        kind: 'added',
        data: Object.assign({}, driveDoc, {
          type: null,
          category: null,
          seller: null,
          product: null,
          tags: [],
          notes: '',
          taggedBy: null,
          taggedAt: null,
          archived: false,
          discoveredAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
      });
      return;
    }
    // Existing clip — refresh Drive-owned fields, keep user tags. Only write
    // if a Drive-owned field actually changed (avoid touching taggedAt).
    const changed =
      prev.name !== driveDoc.name ||
      prev.size !== driveDoc.size ||
      prev.modifiedTime !== driveDoc.modifiedTime ||
      prev.folderPath !== driveDoc.folderPath ||
      prev.thumbnailUrl !== driveDoc.thumbnailUrl ||
      prev.driveUrl !== driveDoc.driveUrl ||
      prev.archived === true;
    if (changed) {
      writes.push({
        id: f.id,
        kind: prev.archived ? 'unarchived' : 'updated',
        data: Object.assign({}, prev, driveDoc, { archived: false }),
      });
    }
  });

  // Anything in Firestore that we didn't see in Drive → archive (don't delete).
  const archiveIds = Object.keys(existing).filter((id) => !seen.has(id) && !existing[id].archived);

  // 4. Write in batches (Firestore cap = 500 ops per batch).
  const BATCH_MAX = 400;
  let cursor = 0;
  async function flushWrites(items, transform) {
    while (cursor < items.length) {
      const batch = db.batch();
      const end = Math.min(cursor + BATCH_MAX, items.length);
      for (let i = cursor; i < end; i++) transform(batch, items[i]);
      await batch.commit();
      cursor = end;
    }
    cursor = 0;
  }
  await flushWrites(writes, (batch, w) => {
    batch.set(db.doc('state/app/broll/' + w.id), w.data, { merge: false });
  });
  await flushWrites(archiveIds, (batch, id) => {
    batch.update(db.doc('state/app/broll/' + id), {
      archived: true,
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  const added = writes.filter((w) => w.kind === 'added').length;
  const updated = writes.filter((w) => w.kind === 'updated').length;
  const unarchived = writes.filter((w) => w.kind === 'unarchived').length;
  const stats = {
    scanned: driveFiles.length,
    added,
    updated,
    unarchived,
    archived: archiveIds.length,
    foldersVisited: foldersVisited.size,
    errorCount: walkErrors.length,
  };

  // 5. Stamp last-sync marker on config/broll so the UI can show it.
  // Keep the first ~20 errors so the UI can show which folders need fixing
  // without blowing up the doc size on a very-wrong config.
  await db.doc('config/broll').set({
    lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSyncStats: stats,
    lastSyncErrors: (walkErrors || []).slice(0, 20),
    lastSyncTrigger: trigger || 'manual',
    lastSyncBy: byEmail || null,
  }, { merge: true });

  return Object.assign({}, stats, { errors: walkErrors });
}

// Read config/broll (folder IDs + last-sync stats). Callable so it works even
// when Firestore rules restrict client reads to config/*.
exports.getBrollConfig = onCall(
  { region: 'us-central1' },
  async (request) => {
    requireTiltUser(request);
    const snap = await db.doc('config/broll').get();
    if (!snap.exists) return { folderIds: [], lastSyncAt: null, lastSyncStats: null, lastSyncTrigger: null, lastSyncBy: null };
    const data = snap.data() || {};
    // Firestore Timestamps aren't JSON-serialisable — convert to ISO string.
    if (data.lastSyncAt && data.lastSyncAt.toDate) data.lastSyncAt = data.lastSyncAt.toDate().toISOString();
    return data;
  }
);

// Add one or many folder IDs to config/broll (arrayUnion — de-dupes).
exports.addBrollFolders = onCall(
  { region: 'us-central1' },
  async (request) => {
    requireTiltUser(request);
    const ids = Array.isArray(request.data && request.data.folderIds) ? request.data.folderIds : [];
    const clean = ids.map((s) => String(s || '').trim()).filter(Boolean);
    if (!clean.length) throw new HttpsError('invalid-argument', 'folderIds is required and must contain at least one id.');
    await db.doc('config/broll').set({
      folderIds: admin.firestore.FieldValue.arrayUnion.apply(null, clean),
    }, { merge: true });
    const after = await db.doc('config/broll').get();
    const data = after.data() || {};
    return { ok: true, folderIds: data.folderIds || [] };
  }
);

// Remove one folder ID from config/broll.
exports.removeBrollFolder = onCall(
  { region: 'us-central1' },
  async (request) => {
    requireTiltUser(request);
    const id = String((request.data && request.data.folderId) || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'folderId is required.');
    await db.doc('config/broll').set({
      folderIds: admin.firestore.FieldValue.arrayRemove(id),
    }, { merge: true });
    const after = await db.doc('config/broll').get();
    const data = after.data() || {};
    return { ok: true, folderIds: data.folderIds || [] };
  }
);

// Manual sync — called from the "Sync now" button in the Clips tab.
exports.syncDriveClips = onCall(
  { secrets: [DRIVE_SERVICE_ACCOUNT_JSON], region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    requireTiltUser(request);
    const email = request.auth && request.auth.token && request.auth.token.email;
    const stats = await runDriveSync({ trigger: 'manual', byEmail: email });
    return { ok: true, stats };
  }
);

// Nightly scheduled sync — same work, no auth (scheduler-triggered).
exports.syncDriveClipsScheduled = onSchedule(
  {
    schedule: 'every day 03:00',
    timeZone: 'Europe/London',
    secrets: [DRIVE_SERVICE_ACCOUNT_JSON],
    region: 'us-central1',
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async () => {
    try {
      const stats = await runDriveSync({ trigger: 'scheduled', byEmail: null });
      console.log('[syncDriveClipsScheduled] ok', JSON.stringify(stats));
    } catch (e) {
      console.error('[syncDriveClipsScheduled] failed:', e && e.message ? e.message : e);
      throw e;
    }
  }
);

// ── Claude: generate 10 caption drafts for an approved video ─────────
// Phase A of the auto-post feature. No Meta calls yet — this returns 10
// stylistically-different caption drafts to the client so Elsa can pick +
// edit before we ship the Meta posting side. Text-only for the first pass;
// multimodal (Frame.io still frames) added once URL→asset-id parsing is
// tested end-to-end with a real Frame.io token.
//
// Client: { assetId, styleHint? }  →  { ok, drafts: [{style, caption}], usage, ms, model }
// Requires: config/meta doc with { captionStyleGuide, enabled }
//           ANTHROPIC_API_KEY set as a functions secret
const CAPTION_MODEL = 'claude-opus-5';
const CAPTION_STYLES = [
  { key: 'hook',           label: 'Hook',           note: 'first line stops the scroll' },
  { key: 'product',        label: 'Product-focused', note: 'names the item, brand, era, condition' },
  { key: 'conversational', label: 'Conversational', note: 'like you\'re texting a mate' },
  { key: 'meme',           label: 'Meme-y',         note: 'internet-native, playful' },
  { key: 'question',       label: 'Question',       note: 'opens with a question' },
  { key: 'list',           label: 'List',           note: 'short bulleted or comma list' },
  { key: 'oneliner',       label: 'One-liner',      note: 'single punchy sentence' },
  { key: 'hype',           label: 'Hype',           note: 'high energy, urgency' },
  { key: 'deadpan',        label: 'Deadpan',        note: 'dry, understated' },
  { key: 'story',          label: 'Story-tease',    note: 'sets up a narrative hook' },
];

exports.generateCaptionsForAsset = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' },
  async (request) => {
    requireTiltUser(request);
    const t0 = Date.now();

    const { assetId, styleHint } = request.data || {};
    if (!assetId) throw new HttpsError('invalid-argument', 'assetId is required');

    // 1. Config check — feature must be enabled + we need a style guide.
    const metaSnap = await db.doc('config/meta').get();
    if (!metaSnap.exists) {
      throw new HttpsError('failed-precondition', 'config/meta missing — save an Anthropic key + caption style guide in the Config tab first.');
    }
    const meta = metaSnap.data() || {};
    if (meta.enabled === false) {
      throw new HttpsError('failed-precondition', 'Auto-post is disabled in Config.');
    }
    const styleGuide = String(meta.captionStyleGuide || '').trim();
    if (!styleGuide) {
      throw new HttpsError('failed-precondition', 'config/meta.captionStyleGuide is empty — set it in the Config tab.');
    }

    // 2. Load asset + parent campaign for prompt context.
    const assetSnap = await db.doc('state/app/assets/' + assetId).get();
    if (!assetSnap.exists) throw new HttpsError('not-found', 'asset not found: ' + assetId);
    const asset = assetSnap.data() || {};

    // Defense in depth — the UI already hides the button on unapproved
    // assets, but a direct callable shouldn't bypass the approval gate.
    // (This currently gates on categoryHeadQc === 'Approved' — confirm
    // this maps to "Content Lead approved" or add a separate check.)
    if (asset.status !== 'Approved' || asset.categoryHeadQc !== 'Approved') {
      throw new HttpsError('failed-precondition',
        'asset not fully approved (status=' + asset.status + ', categoryHeadQc=' + asset.categoryHeadQc + ')');
    }

    let campaign = null;
    if (asset.campaignId) {
      const stateSnap = await db.doc('state/app').get();
      if (stateSnap.exists) {
        const campaigns = (stateSnap.data() || {}).campaigns || [];
        campaign = campaigns.find((c) => String(c.id) === String(asset.campaignId)) || null;
      }
    }

    // 3. Build the metadata block Claude sees.
    const context = {
      campaign: campaign && campaign.name || asset.campaignName || null,
      seller: campaign && campaign.seller || asset.seller || null,
      category: campaign && campaign.category || asset.category || null,
      country: campaign && campaign.country || asset.country || null,
      editor: asset.editor || null,
      brief: asset.brief || asset.notes || null,
      frameIoUrl: asset.finalVideo || null,
    };

    // 4. Call Claude — one request, structured JSON output with 10 drafts.
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    const styleList = CAPTION_STYLES
      .map((s, i) => (i + 1) + '. ' + s.key + ' — ' + s.note)
      .join('\n');

    const system = [
      'You write Instagram Reel + Facebook captions for Tilt, a livestream auction marketplace for fashion and collectibles.',
      '',
      '# Tilt brand voice',
      styleGuide,
      '',
      '# Task',
      'Given the video metadata, return exactly 10 caption drafts. Each draft must be a genuinely different style — do not paraphrase the same idea 10 ways.',
      '',
      '# The 10 required styles (in order):',
      styleList,
      styleHint ? '\n# Extra direction from the user: ' + styleHint : '',
      '',
      '# Output',
      'Return ONLY a JSON object matching this shape, nothing else:',
      '{"drafts":[{"style":"hook","caption":"..."},{"style":"product","caption":"..."}, ... 10 entries in the exact order above]}',
      'No prose, no markdown fences, no leading/trailing text — just the JSON object.',
    ].filter(Boolean).join('\n');

    const userMsg = [
      'Video metadata:',
      '```json',
      JSON.stringify(context, null, 2),
      '```',
      '',
      'Return 10 captions as specified.',
    ].join('\n');

    const resp = await client.messages.create({
      model: CAPTION_MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: userMsg }],
    });

    // 5. Parse. Claude returns content blocks; the last text block is the JSON.
    const textBlock = (resp.content || []).slice().reverse().find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      throw new HttpsError('internal', 'Claude returned no text block');
    }
    const raw = textBlock.text.trim();
    // Tolerate a stray fence, just in case.
    const jsonStr = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error('[generateCaptionsForAsset] JSON parse failed. Raw:', raw.slice(0, 500));
      throw new HttpsError('internal', 'Claude returned invalid JSON: ' + (e.message || 'parse error'));
    }
    const drafts = Array.isArray(parsed && parsed.drafts) ? parsed.drafts : [];
    if (drafts.length === 0) {
      throw new HttpsError('internal', 'Claude returned zero drafts');
    }

    // 6. Log for later eval / iteration.
    const ms = Date.now() - t0;
    const usage = resp.usage || {};
    const logDoc = {
      assetId,
      styleHint: styleHint || null,
      context,
      drafts,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
      model: CAPTION_MODEL,
      ms,
      byEmail: (request.auth && request.auth.token && request.auth.token.email) || null,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    };
    try {
      await db.collection('captionGenerations').add(logDoc);
    } catch (e) {
      // Don't fail the request if logging fails — the caption is what matters.
      console.warn('[generateCaptionsForAsset] log write failed:', e && e.message);
    }

    return {
      ok: true,
      drafts,
      usage: logDoc.usage,
      model: CAPTION_MODEL,
      ms,
    };
  }
);
