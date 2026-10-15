import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ---------- DATABASE ----------
const dbPath = fs.existsSync('/data') ? '/data/realtyflow.db' : 'realtyflow.db';
const db = new Database(dbPath);
db.exec(fs.readFileSync(path.join(process.cwd(), 'schema.sql'), 'utf-8'));

// New tables + columns (safe to run on every start)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);
function addColumn(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { /* already exists */ }
}
addColumn('tenants', 'owner_id', 'TEXT');
addColumn('tenants', 'trial_ends_at', 'TEXT');
addColumn('tenants', 'plan', 'TEXT');
addColumn('tenants', 'plan_expires_at', 'TEXT');

// ---------- AUTH HELPERS ----------
function getSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_secret');
  if (row) return row.value;
  const v = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('auth_secret', v);
  return v;
}
const SECRET = getSecret();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function signToken(uid) {
  const body = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 30 * 86400000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p.uid : null;
  } catch (e) { return null; }
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const uid = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!uid) return res.status(401).json({ error: 'Please log in again.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(401).json({ error: 'Please log in again.' });
  const tenant = getTenant(user.tenant_id);
  if (!tenant) return res.status(401).json({ error: 'Account not found.' });
  req.user = user;
  req.tenant = tenant;
  next();
}

// Simple in-memory limiter for signup/login (per IP, 20 tries per 15 minutes)
const attempts = new Map();
function limiter(req, res, next) {
  const now = Date.now();
  const rec = (attempts.get(req.ip) || []).filter(t => now - t < 15 * 60000);
  if (rec.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  rec.push(now);
  attempts.set(req.ip, rec);
  next();
}

// Optional lock for the old open routes: set ADMIN_KEY in Railway to turn it on
function adminGuard(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) return next();
  const given = req.headers['x-admin-key'] || req.query.key;
  if (given === key) return next();
  res.status(401).json({ error: 'Admin key required' });
}

// ---------- ACCOUNT STATE (trial / paid) ----------
const TRIAL_DAYS = 7;
function accountState(t) {
  const now = Date.now();
  if (t.plan && t.plan_expires_at && new Date(t.plan_expires_at).getTime() > now) {
    const daysLeft = Math.ceil((new Date(t.plan_expires_at).getTime() - now) / 86400000);
    return { state: 'paid', active: true, plan: t.plan, daysLeft };
  }
  if (t.trial_ends_at) {
    const ms = new Date(t.trial_ends_at).getTime() - now;
    if (ms > 0) return { state: 'trial', active: true, daysLeft: Math.ceil(ms / 86400000) };
    return { state: 'expired', active: false, daysLeft: 0 };
  }
  return { state: 'legacy', active: true, daysLeft: null }; // older tenants (e.g. KhashKads) are never locked
}

// ---------- DATA HELPERS ----------
function getTenant(tenantId) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
}
function getProperties(tenantId) {
  return db.prepare('SELECT * FROM properties WHERE tenant_id = ? AND status = ?').all(tenantId, 'available');
}
function propertiesAsText(props) {
  if (props.length === 0) return '(No properties uploaded yet — tell the lead new listings are coming soon.)';
  return props
    .map(p => `- ${p.type} in ${p.location} — ₦${p.price_naira?.toLocaleString() || 'price on request'} (${p.status}). ${p.notes || ''}`)
    .join('\n');
}
function normalizeWhatsapp(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = '234' + d.slice(1);
  return d;
}
function widgetSnippet(req, id) {
  return `<script src="${req.protocol}://${req.get('host')}/widget.js" data-tenant="${id}"></script>`;
}
function chatLink(req, id) {
  return `${req.protocol}://${req.get('host')}/c/${id}`;
}

function buildSystemPrompt(tenant, props) {
  return `You are the AI personal assistant for ${tenant.business_name}, a real estate agency.
Locations they serve: ${tenant.locations || 'not specified'}.
Specialties: ${tenant.specialties || 'not specified'}.
Tone: ${tenant.tone_notes || 'warm, direct, helpful — like a knowledgeable personal assistant.'}

Rules:
- Answer property questions ONLY using the listings below. Never invent a property, price, or availability.
- You cannot do physical things (inspections, key handovers, contracts). Be upfront about that.
- Naturally, over the conversation, learn the lead's name and phone/WhatsApp number — don't demand it up front, just ask when it fits naturally.
- Keep replies short: 2-4 sentences, conversational.
- When the lead is ready for a next step (viewing, payment, "yes let's do this"), tell them ${tenant.agent_name} will personally follow up, and keep it warm and short.

Available properties:
${propertiesAsText(props)}`;
}

// Keyword-based status classifier
const HOT_KEYWORDS = ['how do i pay', 'how can i pay', 'i will take it', 'account number', 'ready to buy', 'i want to buy', 'inspection', 'inspect', 'payment', 'pay now', 'send account', "yes let's do", 'book a viewing', 'come and see'];
const WARM_KEYWORDS = ['not now', 'no money', 'let me think', 'later', 'not sure', 'still deciding', 'budget is low', "can't afford"];

function classifyStatus(userMessage) {
  const lower = userMessage.toLowerCase();
  if (HOT_KEYWORDS.some(k => lower.includes(k))) return { status: 'Hot', reason: 'Signaled readiness to proceed' };
  if (WARM_KEYWORDS.some(k => lower.includes(k))) return { status: 'Warm', reason: 'Interested but not ready yet' };
  return null;
}

// Pull a name / Nigerian phone number out of what the lead typed
const PHONE_RE = /(?:\+?234|0)[\s-]?[789][01]\d[\s-]?\d{3}[\s-]?\d{4}/;
const NAME_RE = /\b(?:my name is|my name's|call me|name:)\s+([A-Za-z][A-Za-z'-]{1,20}(?:\s+[A-Za-z][A-Za-z'-]{1,20})?)/i;
function titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }
function extractContact(text, hasName) {
  const out = {};
  const p = text.match(PHONE_RE);
  if (p) out.phone = p[0].replace(/[\s-]/g, '');
  const n = text.match(NAME_RE);
  if (n) out.name = titleCase(n[1].trim());
  else if (p && !hasName) {
    // e.g. "John, 0803 123 4567"
    const rest = text.replace(PHONE_RE, '').replace(/[^A-Za-z\s'-]/g, ' ').trim();
    const words = rest.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 3) out.name = titleCase(words.join(' '));
  }
  return out;
}

// ---------- PUBLIC / OLD ROUTES (still work as before) ----------

app.post('/api/onboard', adminGuard, (req, res) => {
  const { business_name, agent_name, agent_whatsapp, locations, specialties, tone_notes } = req.body;
  if (!business_name || !agent_name || !agent_whatsapp) {
    return res.status(400).json({ error: 'business_name, agent_name, and agent_whatsapp are required' });
  }
  const id = nanoid(8);
  db.prepare(`INSERT INTO tenants (id, business_name, agent_name, agent_whatsapp, locations, specialties, tone_notes)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, business_name, agent_name, agent_whatsapp, locations || '', specialties || '', tone_notes || '');
  res.json({ tenantId: id, widgetSnippet: widgetSnippet(req, id) });
});

app.post('/api/properties/:tenantId', adminGuard, (req, res) => {
  const { tenantId } = req.params;
  if (!getTenant(tenantId)) return res.status(404).json({ error: 'Unknown tenant' });
  const { properties } = req.body;
  if (!Array.isArray(properties)) return res.status(400).json({ error: 'properties must be an array' });
  const insert = db.prepare(`INSERT INTO properties (tenant_id, type, location, price_naira, status, notes) VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction((rows) => {
    for (const p of rows) insert.run(tenantId, p.type, p.location, p.price_naira, p.status || 'available', p.notes || '');
  })(properties);
  res.json({ inserted: properties.length });
});

app.get('/api/leads/:tenantId', adminGuard, (req, res) => {
  const leads = db.prepare('SELECT * FROM leads WHERE tenant_id = ? ORDER BY last_contacted_at DESC').all(req.params.tenantId);
  res.json(leads);
});

// Public: just the agency name (used by the hosted chat page)
app.get('/api/public/:tenantId', (req, res) => {
  const t = getTenant(req.params.tenantId);
  if (!t) return res.status(404).json({ error: 'Unknown agency' });
  res.json({ business_name: t.business_name });
});

// Hosted chat page: realtyflow.../c/<tenantId>  (for agencies with no website)
app.get('/c/:tenantId', (req, res) => {
  res.sendFile(path.resolve('public/chat.html'));
});

// ---------- CHAT (the widget calls this) ----------
app.post('/api/chat', async (req, res) => {
  const { tenantId, leadId, message } = req.body;
  const tenant = getTenant(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Unknown tenant' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  // Trial ended and not paid: pause the assistant politely
  const acct = accountState(tenant);
  if (!acct.active) {
    const wa = `https://wa.me/${normalizeWhatsapp(tenant.agent_whatsapp)}`;
    return res.json({
      leadId: leadId || null,
      reply: `Thanks for reaching out to ${tenant.business_name}! Please chat with ${tenant.agent_name} directly on WhatsApp: ${wa}`,
      handoffMessage: null
    });
  }

  let currentLeadId = leadId;
  if (!currentLeadId) {
    currentLeadId = nanoid(12);
    db.prepare('INSERT INTO leads (id, tenant_id) VALUES (?, ?)').run(currentLeadId, tenantId);
  }

  try {
    db.prepare('INSERT INTO messages (lead_id, role, content) VALUES (?, ?, ?)').run(currentLeadId, 'user', message);

    // Save name / phone if the lead gave them
    const leadRow = db.prepare('SELECT name FROM leads WHERE id = ?').get(currentLeadId);
    const contact = extractContact(message, !!(leadRow && leadRow.name));
    if (contact.name || contact.phone) {
      db.prepare('UPDATE leads SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?')
        .run(contact.name || null, contact.phone || null, currentLeadId);
    }

    const history = db.prepare('SELECT role, content FROM messages WHERE lead_id = ? ORDER BY id ASC').all(currentLeadId);
    const props = getProperties(tenantId);

    let replyText;
    try {
      const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          max_tokens: 1000,
          reasoning_effort: 'low',
          messages: [
            { role: 'system', content: buildSystemPrompt(tenant, props) },
            ...history.map(m => ({ role: m.role, content: m.content }))
          ]
        })
      });
      const groqData = await groqResponse.json();
      if (!groqResponse.ok) {
        console.error('GROQ ERROR', groqResponse.status, JSON.stringify(groqData));
        throw new Error('groq failed');
      }
      replyText = groqData.choices[0].message.content;
    } catch (err) {
      console.error('CHAT ERROR', err.message);
      replyText = "Thanks for your message! Let me connect you with our agent on WhatsApp so you get a quick answer.";
    }

    db.prepare('INSERT INTO messages (lead_id, role, content) VALUES (?, ?, ?)').run(currentLeadId, 'assistant', replyText);
    db.prepare("UPDATE leads SET last_contacted_at = datetime('now') WHERE id = ?").run(currentLeadId);

    const classification = classifyStatus(message);
    let handoffMessage = null;
    if (classification) {
      db.prepare('UPDATE leads SET status = ?, status_reason = ? WHERE id = ?')
        .run(classification.status, classification.reason, currentLeadId);
      if (classification.status === 'Hot') {
        const waLink = `https://wa.me/${normalizeWhatsapp(tenant.agent_whatsapp)}`;
        handoffMessage = `Let's continue on WhatsApp — click here to chat with ${tenant.agent_name} directly: ${waLink}`;
        db.prepare('UPDATE leads SET handed_off = 1 WHERE id = ?').run(currentLeadId);
      }
    }

    res.json({ leadId: currentLeadId, reply: replyText, handoffMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI reply failed', detail: err.message });
  }
});

// ---------- ACCOUNTS ----------

app.post('/api/signup', limiter, (req, res) => {
  const { email, password, business_name, agent_name, agent_whatsapp, locations, specialties, tone_notes } = req.body;
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!business_name || !agent_name || !agent_whatsapp) {
    return res.status(400).json({ error: 'Agency name, agent name and WhatsApp number are required.' });
  }
  const wa = normalizeWhatsapp(agent_whatsapp);
  if (wa.length < 10 || wa.length > 15) return res.status(400).json({ error: 'Enter a valid WhatsApp number, e.g. 0803 123 4567.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) {
    return res.status(409).json({ error: 'That email already has an account. Log in instead.' });
  }

  const tenantId = nanoid(8);
  const userId = nanoid(12);
  const salt = crypto.randomBytes(16).toString('hex');
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();

  db.transaction(() => {
    db.prepare(`INSERT INTO tenants (id, business_name, agent_name, agent_whatsapp, locations, specialties, tone_notes, owner_id, trial_ends_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tenantId, business_name.trim(), agent_name.trim(), wa, locations || '', specialties || '', tone_notes || '', userId, trialEnds);
    db.prepare('INSERT INTO users (id, email, password_hash, salt, tenant_id) VALUES (?, ?, ?, ?, ?)')
      .run(userId, mail, hashPassword(password, salt), salt, tenantId);
  })();

  res.json({ token: signToken(userId) });
});

app.post('/api/login', limiter, (req, res) => {
  const mail = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
  const ok = user && crypto.timingSafeEqual(
    Buffer.from(hashPassword(String(req.body.password || ''), user.salt), 'hex'),
    Buffer.from(user.password_hash, 'hex')
  );
  if (!ok) return res.status(401).json({ error: 'Email or password is wrong.' });
  res.json({ token: signToken(user.id) });
});

function publicTenant(t) {
  return {
    id: t.id, business_name: t.business_name, agent_name: t.agent_name, agent_whatsapp: t.agent_whatsapp,
    locations: t.locations, specialties: t.specialties, tone_notes: t.tone_notes
  };
}

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    email: req.user.email,
    tenant: publicTenant(req.tenant),
    account: accountState(req.tenant),
    widgetSnippet: widgetSnippet(req, req.tenant.id),
    chatLink: chatLink(req, req.tenant.id)
  });
});

app.put('/api/me/settings', requireAuth, (req, res) => {
  const { business_name, agent_name, agent_whatsapp, locations, specialties, tone_notes } = req.body;
  if (!business_name || !agent_name || !agent_whatsapp) {
    return res.status(400).json({ error: 'Agency name, agent name and WhatsApp number are required.' });
  }
  const wa = normalizeWhatsapp(agent_whatsapp);
  if (wa.length < 10 || wa.length > 15) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
  db.prepare(`UPDATE tenants SET business_name = ?, agent_name = ?, agent_whatsapp = ?, locations = ?, specialties = ?, tone_notes = ? WHERE id = ?`)
    .run(business_name.trim(), agent_name.trim(), wa, locations || '', specialties || '', tone_notes || '', req.tenant.id);
  res.json({ ok: true });
});

app.get('/api/me/properties', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT rowid AS rid, * FROM properties WHERE tenant_id = ? ORDER BY rowid DESC').all(req.tenant.id));
});

app.post('/api/me/properties', requireAuth, (req, res) => {
  const rows = Array.isArray(req.body.properties) ? req.body.properties : [req.body];
  const insert = db.prepare(`INSERT INTO properties (tenant_id, type, location, price_naira, status, notes) VALUES (?, ?, ?, ?, ?, ?)`);
  let n = 0;
  db.transaction(() => {
    for (const p of rows.slice(0, 200)) {
      if (!p.type || !p.location) continue;
      const price = Number(String(p.price_naira ?? '').replace(/[^\d.]/g, '')) || null;
      insert.run(req.tenant.id, String(p.type).trim(), String(p.location).trim(), price, 'available', String(p.notes || '').trim());
      n++;
    }
  })();
  if (!n) return res.status(400).json({ error: 'Each listing needs a type and a location.' });
  res.json({ inserted: n });
});

app.delete('/api/me/properties/:rid', requireAuth, (req, res) => {
  db.prepare('DELETE FROM properties WHERE rowid = ? AND tenant_id = ?').run(Number(req.params.rid), req.tenant.id);
  res.json({ ok: true });
});

app.get('/api/me/leads', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM leads WHERE tenant_id = ? ORDER BY last_contacted_at DESC').all(req.tenant.id));
});

app.get('/api/me/leads/:id/messages', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenant.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(db.prepare('SELECT role, content FROM messages WHERE lead_id = ? ORDER BY id ASC').all(req.params.id));
});

app.patch('/api/me/leads/:id', requireAuth, (req, res) => {
  const status = req.body.status;
  if (!['New', 'Warm', 'Hot', 'Closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE leads SET status = ?, status_reason = ? WHERE id = ? AND tenant_id = ?')
    .run(status, 'Set by agent', req.params.id, req.tenant.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RealtyFlow platform running on http://localhost:${PORT}`));

