#!/usr/bin/env node
/*
 * simulate-captions.js — Phase A caption-quality dry run
 * -----------------------------------------------------
 * Not a Cloud Function. Runs locally against Firestore via the admin SDK.
 * Pulls the last N approved assets, runs each through Claude Opus 5, writes
 * an HTML report Elsa can open to review the 10 drafts side-by-side and
 * tune the caption style guide before we ship anything to real Meta.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node functions/scripts/simulate-captions.js [--limit 50] [--out report.html]
 *
 * To get GOOGLE_APPLICATION_CREDENTIALS:
 *   1. Firebase console → Project settings → Service accounts → Generate new private key
 *   2. Save the JSON somewhere outside the repo
 *   3. Export the path (never commit the file — it's in .gitignore territory)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
}
const LIMIT = parseInt(arg('limit', '50'), 10);
const OUT_PATH = path.resolve(arg('out', 'captions-report.html'));
const STYLE_GUIDE_PATH = arg('styleGuide', null);
const STYLE_HINT = arg('styleHint', null);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY before running.');
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account JSON path.');
  process.exit(1);
}

admin.initializeApp();
const db = admin.firestore();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

async function loadStyleGuide() {
  if (STYLE_GUIDE_PATH) {
    return fs.readFileSync(path.resolve(STYLE_GUIDE_PATH), 'utf8');
  }
  const snap = await db.doc('config/meta').get();
  const guide = snap.exists ? (snap.data() || {}).captionStyleGuide : null;
  if (!guide) {
    console.error('No style guide found. Either save one to config/meta.captionStyleGuide or pass --styleGuide path/to/guide.txt');
    process.exit(1);
  }
  return guide;
}

async function loadApprovedAssets(limit) {
  const snap = await db.collection('state/app/assets').get();
  const all = [];
  snap.forEach((d) => all.push(Object.assign({ id: d.id }, d.data())));
  const approved = all
    .filter((a) => a.status === 'Approved' && a.categoryHeadQc === 'Approved')
    .sort((a, b) => String(b.chDateApproved || b.dateApproved || '').localeCompare(String(a.chDateApproved || a.dateApproved || '')))
    .slice(0, limit);
  return approved;
}

async function loadCampaigns() {
  const snap = await db.doc('state/app').get();
  const map = new Map();
  if (snap.exists) {
    for (const c of ((snap.data() || {}).campaigns || [])) map.set(String(c.id), c);
  }
  return map;
}

function contextFor(asset, campaigns) {
  const c = campaigns.get(String(asset.campaignId));
  return {
    campaign: (c && c.name) || asset.campaignName || null,
    seller: (c && c.seller) || asset.seller || null,
    category: (c && c.category) || asset.category || null,
    country: (c && c.country) || asset.country || null,
    editor: asset.editor || null,
    brief: asset.brief || asset.notes || null,
    frameIoUrl: asset.finalVideo || null,
  };
}

async function generateFor(asset, campaigns, styleGuide) {
  const context = contextFor(asset, campaigns);
  const styleList = CAPTION_STYLES.map((s, i) => (i + 1) + '. ' + s.key + ' — ' + s.note).join('\n');
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
    STYLE_HINT ? '\n# Extra direction from the user: ' + STYLE_HINT : '',
    '',
    '# Output',
    'Return ONLY a JSON object matching this shape, nothing else:',
    '{"drafts":[{"style":"hook","caption":"..."},{"style":"product","caption":"..."}, ... 10 entries in the exact order above]}',
    'No prose, no markdown fences, no leading/trailing text — just the JSON object.',
  ].filter(Boolean).join('\n');
  const userMsg = 'Video metadata:\n```json\n' + JSON.stringify(context, null, 2) + '\n```\n\nReturn 10 captions as specified.';

  const t0 = Date.now();
  let resp;
  try {
    resp = await client.messages.create({
      model: CAPTION_MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: userMsg }],
    });
  } catch (e) {
    return { asset, context, error: (e && e.message) || String(e), ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;

  const textBlock = (resp.content || []).slice().reverse().find((b) => b.type === 'text');
  const raw = (textBlock && textBlock.text || '').trim();
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let drafts = [];
  let parseError = null;
  try {
    const parsed = JSON.parse(jsonStr);
    drafts = Array.isArray(parsed && parsed.drafts) ? parsed.drafts : [];
  } catch (e) {
    parseError = e.message;
  }
  return { asset, context, drafts, parseError, raw, ms, usage: resp.usage || {} };
}

function costFor(usage) {
  // Opus 5 pricing: $5/MTok input, $25/MTok output
  const inputCost = ((usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0)) * 5 / 1_000_000;
  const cachedCost = (usage.cache_read_input_tokens || 0) * 0.5 / 1_000_000;
  const outputCost = (usage.output_tokens || 0) * 25 / 1_000_000;
  return inputCost + cachedCost + outputCost;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderReport(results) {
  const totalCost = results.reduce((s, r) => s + (r.usage ? costFor(r.usage) : 0), 0);
  const okCount = results.filter((r) => !r.error && !r.parseError && r.drafts && r.drafts.length).length;
  const avgMs = Math.round(results.reduce((s, r) => s + (r.ms || 0), 0) / Math.max(1, results.length));

  const rows = results.map((r, i) => {
    const a = r.asset;
    const ctx = r.context || {};
    const header = '<div class="asset-h"><span class="idx">#' + (i + 1) + '</span>' +
      '<span class="camp">' + esc(ctx.campaign || '—') + '</span>' +
      '<span class="meta">' + esc(ctx.seller || '') + ' · ' + esc(ctx.category || '') + ' · ' + esc(ctx.country || '') + ' · editor ' + esc(ctx.editor || '') + '</span>' +
      (a.finalVideo ? '<a class="ext" href="' + esc(a.finalVideo) + '" target="_blank">Frame.io ↗</a>' : '') +
      '<span class="ms">' + esc(r.ms || 0) + ' ms · $' + (r.usage ? costFor(r.usage).toFixed(4) : '0.0000') + '</span>' +
    '</div>';
    if (r.error) return '<section class="asset err">' + header + '<div class="err-msg">ERROR: ' + esc(r.error) + '</div></section>';
    if (r.parseError) return '<section class="asset err">' + header + '<div class="err-msg">JSON parse: ' + esc(r.parseError) + '<pre>' + esc((r.raw || '').slice(0, 800)) + '</pre></div></section>';
    const cards = (r.drafts || []).map((d, di) =>
      '<div class="draft"><div class="style">' + (di + 1) + '. ' + esc(d.style) + '</div>' +
      '<div class="cap">' + esc(d.caption) + '</div></div>'
    ).join('');
    return '<section class="asset">' + header + '<div class="drafts">' + cards + '</div></section>';
  }).join('\n');

  return '<!doctype html><html><head><meta charset="utf-8"><title>Captions dry-run · ' + results.length + ' assets</title>' +
    '<style>' +
    'body{font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:#0f1114;color:#e6e6e6;margin:0;padding:24px;}' +
    'h1{margin:0 0 4px;font-size:20px;}' +
    '.summary{color:#9aa;margin-bottom:24px;font-size:13px;}' +
    '.asset{border:1px solid #2a2f38;border-radius:10px;padding:14px 18px;margin-bottom:16px;background:#151820;}' +
    '.asset.err{border-color:#663;}.err-msg{color:#f88;font-family:monospace;font-size:12px;white-space:pre-wrap;}' +
    '.asset-h{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin-bottom:12px;}' +
    '.idx{color:#556;font-weight:600;}' +
    '.camp{font-weight:600;font-size:15px;}' +
    '.meta{color:#89a;font-size:12px;}' +
    '.ms{color:#556;font-size:11px;margin-left:auto;}' +
    '.ext{color:#7af;text-decoration:none;font-size:12px;}' +
    '.drafts{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}' +
    '.draft{border:1px solid #2a2f38;border-radius:6px;padding:10px 12px;background:#0f1218;}' +
    '.style{color:#7bc4a0;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}' +
    '.cap{white-space:pre-wrap;font-size:13.5px;}' +
    'pre{background:#0a0c10;padding:8px;border-radius:4px;overflow:auto;}' +
    '</style></head><body>' +
    '<h1>Captions dry-run</h1>' +
    '<div class="summary">' + results.length + ' assets · ' + okCount + ' generated ok · avg ' + avgMs + 'ms · total cost $' + totalCost.toFixed(4) + ' · model ' + CAPTION_MODEL + '</div>' +
    rows +
    '</body></html>';
}

(async () => {
  console.log('Loading style guide + last', LIMIT, 'approved assets…');
  const [styleGuide, assets, campaigns] = await Promise.all([
    loadStyleGuide(), loadApprovedAssets(LIMIT), loadCampaigns(),
  ]);
  console.log('Style guide chars:', styleGuide.length, '· approved assets:', assets.length, '· campaigns:', campaigns.size);
  if (!assets.length) { console.error('No approved assets found.'); process.exit(1); }

  const results = [];
  for (let i = 0; i < assets.length; i++) {
    process.stdout.write((i + 1) + '/' + assets.length + ' ' + (assets[i].campaignName || assets[i].id) + '… ');
    const r = await generateFor(assets[i], campaigns, styleGuide);
    if (r.error) console.log('ERROR', r.error);
    else if (r.parseError) console.log('parseError', r.parseError);
    else console.log(r.drafts.length + ' drafts · ' + r.ms + 'ms · $' + costFor(r.usage).toFixed(4));
    results.push(r);
  }

  fs.writeFileSync(OUT_PATH, renderReport(results));
  const totalCost = results.reduce((s, r) => s + (r.usage ? costFor(r.usage) : 0), 0);
  console.log('\nWrote report to', OUT_PATH);
  console.log('Total cost: $' + totalCost.toFixed(4));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
