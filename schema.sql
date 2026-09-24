-- One row per agency that signs up. This is the whole "no manual setup" idea:
-- an agency exists just by having a row here + some properties.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,                 -- short public id, used in the widget snippet
  business_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_whatsapp TEXT NOT NULL,        -- e.g. 2348012345678 (no + or spaces)
  locations TEXT,                      -- free text: "Lagos, Ogun, Oyo"
  specialties TEXT,                    -- free text: "residential, land, short-let"
  tone_notes TEXT,                     -- optional: "friendly but formal, no slang"
  created_at TEXT DEFAULT (datetime('now'))
);

-- Each agency's own listings. Uploaded/edited by them, never touched by Desmond.
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type TEXT,
  location TEXT,
  price_naira INTEGER,
  status TEXT DEFAULT 'available',
  notes TEXT
);

-- One row per lead (one specific person talking to one specific agency's assistant).
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,                 -- session id generated when chat starts
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT,
  phone TEXT,
  status TEXT DEFAULT 'New',           -- New / Warm / Hot / HandedOff
  status_reason TEXT,                  -- why: "budget too low", "just browsing", etc.
  handed_off INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_contacted_at TEXT DEFAULT (datetime('now'))
);

-- Full conversation history per lead — this is the "memory" piece.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL,                  -- 'user' or 'assistant'
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
