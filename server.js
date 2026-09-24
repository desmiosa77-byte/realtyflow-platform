import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- DATABASE ----------
const db = new Database('realtyflow.db');
db.exec(fs.readFileSync(path.join(process.cwd(), 'schema.sql'), 'utf-8'));

// ---------- HELPERS ----------
function getTenant(tenantId) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
}

function getProperties(tenantId) {
  return db.prepare('SELECT * FROM properties WHERE tenant_id = ? AND status = ?')
    .all(tenantId, 'available');
}

function propertiesAsText(props) {
  if (props.length === 0) return '(No properties uploaded yet — tell the lead new listings are coming soon.)';
  return props
    .map(p => `- ${p.type} in ${p.location} — ₦${p.price_naira?.toLocaleString() || 'price on request'} (${p.status}). ${p.notes || ''}`)
    .join('\n');
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

// Lightweight keyword-based status classifier for the MVP.
// (Upgrade path: replace with a small Claude classification call once volume justifies the cost.)
const HOT_KEYWORDS = ['ready to buy', 'i want to buy', 'inspection', 'inspect', 'payment', 'pay now', 'send account', 'yes let\'s do', 'book a viewing', 'come and see'];
const WARM_KEYWORDS = ['not now', 'no money', 'let me think', 'later', 'not sure', 'still deciding', 'budget is low', "can't afford"];

function classifyStatus(userMessage) {
  const lower = userMessage.toLowerCase();
  if (HOT_KEYWORDS.some(k => lower.includes(k))) return { status: 'Hot', reason: 'Signaled readiness to proceed' };
  if (WARM_KEYWORDS.some(k => lower.includes(k))) return { status: 'Warm', reason: 'Interested but not ready yet' };
  return null; // no change
}

// ---------- ROUTES ----------

// Onboard a new agency (the "training by form" step)
app.post('/api/onboard', (req, res) => {
  const { business_name, agent_name, agent_whatsapp, locations, specialties, tone_notes } = req.body;
  if (!business_name || !agent_name || !agent_whatsapp) {
    return res.status(400).json({ error: 'business_name, agent_name, and agent_whatsapp are required' });
  }
  const id = nanoid(8);
  db.prepare(`INSERT INTO tenants (id, business_name, agent_name, agent_whatsapp, locations, specialties, tone_notes)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, business_name, agent_name, agent_whatsapp, locations || '', specialties || '', tone_notes || '');
  res.json({ tenantId: id, widgetSnippet: `<script src="${req.protocol}://${req.get('host')}/widget.js" data-tenant="${id}"></script>` });
});

// Upload/replace an agency's property listings
app.post('/api/properties/:tenantId', (req, res) => {
  const { tenantId } = req.params;
  const tenant = getTenant(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Unknown tenant' });

  const { properties } = req.body; // array of { type, location, price_naira, status, notes }
  if (!Array.isArray(properties)) return res.status(400).json({ error: 'properties must be an array' });

  const insert = db.prepare(`INSERT INTO properties (tenant_id, type, location, price_naira, status, notes)
                              VALUES (?, ?, ?, ?, ?, ?)`);
  const insertMany = db.transaction((rows) => {
    for (const p of rows) {
      insert.run(tenantId, p.type, p.location, p.price_naira, p.status || 'available', p.notes || '');
    }
  });
  insertMany(properties);
  res.json({ inserted: properties.length });
});

// Main chat endpoint — the widget calls this
app.post('/api/chat', async (req, res) => {
  const { tenantId, leadId, message } = req.body;
  const tenant = getTenant(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Unknown tenant' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  let currentLeadId = leadId;
  if (!currentLeadId) {
    currentLeadId = nanoid(12);
    db.prepare('INSERT INTO leads (id, tenant_id) VALUES (?, ?)').run(currentLeadId, tenantId);
  }

  db.prepare('INSERT INTO messages (lead_id, role, content) VALUES (?, ?, ?)').run(currentLeadId, 'user', message);

  const history = db.prepare('SELECT role, content FROM messages WHERE lead_id = ? ORDER BY id ASC').all(currentLeadId);
  const props = getProperties(tenantId);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: buildSystemPrompt(tenant, props),
      messages: history.map(m => ({ role: m.role, content: m.content }))
    });

    const replyText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    db.prepare('INSERT INTO messages (lead_id, role, content) VALUES (?, ?, ?)').run(currentLeadId, 'assistant', replyText);
    db.prepare('UPDATE leads SET last_contacted_at = datetime(\'now\') WHERE id = ?').run(currentLeadId);

    // Status tagging + handoff check
    const classification = classifyStatus(message);
    let handoffMessage = null;
    if (classification) {
      db.prepare('UPDATE leads SET status = ?, status_reason = ? WHERE id = ?')
        .run(classification.status, classification.reason, currentLeadId);

      if (classification.status === 'Hot') {
        const waLink = `https://wa.me/${tenant.agent_whatsapp}`;
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

// Simple dashboard data — one agency's leads, newest first (build a real dashboard UI on top of this later)
app.get('/api/leads/:tenantId', (req, res) => {
  const { tenantId } = req.params;
  const leads = db.prepare('SELECT * FROM leads WHERE tenant_id = ? ORDER BY last_contacted_at DESC').all(tenantId);
  res.json(leads);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RealtyFlow platform running on http://localhost:${PORT}`));
