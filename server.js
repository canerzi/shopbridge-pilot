// server.js — serves the frontend and the /api/v4/ask matcher endpoint.
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolve, resolveForced, MODEL } = require('./matcher');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || '';
const LOG_DIR = process.env.LOG_DIR || __dirname;   // point at a mounted Render Disk (e.g. /var/data) for durable storage on a paid plan
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
const LOG_FILE = path.join(LOG_DIR, 'logs.jsonl');

// --- Per-participant quota + completion guard (anti refresh/restart reset) ---
// Enforced ONLY for real Qualtrics response IDs (pid starts with "R_"); test/random
// pids ("p_...", "E2E_TEST...") bypass so demo/QA isn't blocked. Rebuilt from the
// durable log on startup so a Render restart can't reopen the quota.
const HARD_CAP = 9;                 // max /ask sends per participant (mirrors client HARD_CAP)
const pidStats = new Map();         // pid -> { sends, completed }
const isRealPid = pid => typeof pid === 'string' && /^R_/.test(pid);
function statFor(pid) { let s = pidStats.get(pid); if (!s) { s = { sends: 0, completed: false }; pidStats.set(pid, s); } return s; }
function rebuildStats() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.type === 'completion') { if (o.pid && !o.duplicate) statFor(o.pid).completed = true; }
      else if (o.type === 'feedback') { /* ratings don't consume quota */ }
      else if (o.participant_id) { statFor(o.participant_id).sends++; }
    }
    console.log('[stats] rebuilt quota state for', pidStats.size, 'participants');
  } catch (e) { console.warn('rebuildStats failed:', e.message); }
}
rebuildStats();

// Write a log record to the durable file AND, if a webhook is configured, mirror it there.
// On a paid Render plan, point LOG_DIR at a mounted Disk so logs survive restarts/redeploys.
// (On free tier the disk is ephemeral; the optional webhook is the fallback.) Fire-and-forget.
function persist(obj) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n'); } catch (_) {}
  if (LOG_WEBHOOK_URL && typeof fetch === 'function') {
    try { fetch(LOG_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }).catch(() => {}); } catch (_) {}
  }
}

app.get('/health', (req, res) => res.json({ ok: true, model: MODEL }));

app.post('/api/v4/ask', async (req, res) => {
  const { question, arm, turnNumber, participant_id, forced_id } = req.body || {};
  if (!question && !forced_id) return res.status(400).json({ error: 'no_question' });
  if (isRealPid(participant_id)) {
    const s = statFor(participant_id);
    if (s.completed) return res.status(403).json({ error: 'already_completed' });
    if (s.sends >= HARD_CAP) return res.status(429).json({ error: 'cap_reached' });
  }
  try {
    // forced_id = participant clicked a disambiguation button -> deterministic by-ID fetch, no model call.
    const out = forced_id ? resolveForced(forced_id) : await resolve(question);
    const log = {
      ts: new Date().toISOString(),
      participant_id: participant_id || null,
      arm: arm || null,
      turn: turnNumber ?? null,
      question: question || null,
      forced_id: forced_id || null,
      matched_id: out.matched_id,
      band: out.band,
      refusal_tier: out.refusal_tier,
      wrapper_variant: out.wrapper_variant,
      clarifier: out.clarifier || '',
      action: out.action,
      options: out.options || null
    };
    persist(log);
    if (isRealPid(participant_id)) statFor(participant_id).sends++;
    console.log('[ask]', out.action, 'band', out.band, (out.matched_id || 'REFUSE'), '|', String(forced_id || question).slice(0, 70));
    res.json({ answer: out.answer, matched_id: out.matched_id, band: out.band, confidence: out.band, action: out.action, options: out.options || null, disambig_q: out.disambig_q || null });
  } catch (e) {
    console.error('ask error:', e.message);
    res.status(500).json({ error: 'matcher_failed', detail: e.message });
  }
});

app.post('/api/v4/feedback', (req, res) => {
  const rec = { type: 'feedback', ts: new Date().toISOString(), ...(req.body || {}) };
  persist(rec);
  console.log('[rate]', rec.rating, rec.matched_id || '-', 'turn', rec.turn);
  res.json({ ok: true });
});

// --- Qualtrics return integration ---
const RETURN_BASE = process.env.QUALTRICS_RETURN_URL || 'https://sabancimanagement.qualtrics.com/jfe/form/SV_7OjA7M4G45YyGge';
const HMAC_SECRET = process.env.QUALTRICS_HMAC_SECRET || '';

// Completion: persist the full per-participant payload (keyed by Qualtrics pid),
// mint a tamper-evident HMAC token, and build the Qualtrics return URL.
app.post('/api/v4/complete', (req, res) => {
  const { pid, arm, nonce, allocation_summary, engagement_summary, analytics } = req.body || {};
  // First completion per real pid is authoritative; later ones are flagged duplicate
  // (still routed back to Qualtrics, but excluded from analysis).
  const duplicate = isRealPid(pid) && statFor(pid).completed;
  // Derive the "used the assistant at least once" flag server-side from the analytics payload.
  // '1'/'0' for the AI arms; '' for No-AI (so Qualtrics branches on arm and skips the AI blocks).
  const ana = analytics || {};
  const engaged = (ana.chat_turns_used > 0)
    || (Array.isArray(ana.topic_chip_clicks) && ana.topic_chip_clicks.length > 0)
    || (Array.isArray(ana.open_text_questions) && ana.open_text_questions.length > 0);
  const used_ai = (arm === 'noai') ? '' : (engaged ? '1' : '0');
  const canonical = [pid || '', arm || '', nonce || '', allocation_summary || '', engagement_summary || '', used_ai].join('|');
  const token = HMAC_SECRET ? crypto.createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex') : '';
  const rec = {
    type: 'completion', ts: new Date().toISOString(),
    pid: pid || null, arm: arm || null, used_ai: used_ai, nonce: nonce || null,
    allocation_summary: allocation_summary || null, engagement_summary: engagement_summary || null,
    completion_token: token || null, analytics: analytics || null,
    duplicate: duplicate || undefined
  };
  persist(rec);
  if (isRealPid(pid)) statFor(pid).completed = true;
  let return_url = null;
  if (RETURN_BASE) {
    const sep = RETURN_BASE.includes('?') ? '&' : '?';
    const q = [
      'pid=' + encodeURIComponent(pid || ''),
      'arm=' + encodeURIComponent(arm || ''),
      'used_ai=' + encodeURIComponent(used_ai),
      'nonce=' + encodeURIComponent(nonce || ''),
      'allocation_summary=' + encodeURIComponent(allocation_summary || ''),
      'engagement_summary=' + encodeURIComponent(engagement_summary || '')
    ];
    if (token) q.push('completion_token=' + encodeURIComponent(token));
    return_url = RETURN_BASE + sep + q.join('&');
  }
  console.log('[complete]', pid, arm, 'used_ai=' + (used_ai === '' ? 'NA' : used_ai), token ? '(token minted)' : '(NO HMAC secret set)', duplicate ? '(DUPLICATE)' : '');
  res.json({ ok: true, completion_token: token || null, return_url, duplicate: duplicate || false });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`ShopBridge pilot listening on :${PORT} (model=${MODEL})`));
