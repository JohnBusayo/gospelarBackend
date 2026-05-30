// routes/events.js
// Event registration backend for the gospelar registration webapp.
// Owns:
//   GET    /api/events                       — public list
//   GET    /api/events/:id                   — public read (with nested ticket types + accommodation)
//   POST   /api/admin/events                 — admin create
//   PUT    /api/admin/events/:id             — admin update (replaces ticket types + accommodation)
//   DELETE /api/admin/events/:id             — admin delete (cascades to tickets)
//   POST   /api/events/:id/register          — public register (transactional; bumps sold/taken counts)
//   GET    /api/events/:id/tickets           — admin/event-scoped ticket list
//   GET    /api/tickets?email=…              — tickets by attendee email
//   GET    /api/tickets/:code                — single ticket
//   PUT    /api/tickets/:code                — patch editable attendee fields
//   DELETE /api/tickets/:code                — attendee / registrant / event creator / admin
//   POST   /api/checkin/:code                — mark checked-in (idempotent)
//
// Persistence lives in events / event_ticket_types / event_accommodation /
// event_tickets (see db/initSchema.js). API responses use camelCase to match
// what the frontend already consumes from the localStorage shim.

const express = require('express');
const db = require('../db');
const { adminAuth, userAuth } = require('../middleware/auth');
const { isValidEmail } = require('../utils/helpers');
const { sendNow } = require('../services/notifications');
const { verify: verifyPaymentToken } = require('../services/eventPaymentToken');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Shape helpers — DB rows ↔ frontend objects.
// ─────────────────────────────────────────────────────────────────────────────

function eventRow(row, types = [], accommodation = []) {
  if (!row) return null;
  return {
    id:                    row.id,
    churchId:              row.church_id || null,
    title:                 row.title,
    tagline:               row.tagline || '',
    summary:               row.summary || '',
    startsAt:              row.starts_at,
    endsAt:                row.ends_at,
    registrationDeadline:  row.registration_deadline,
    location:              row.location || '',
    coverColor:            row.cover_color || '',
    bannerUrl:             row.banner_url || '',
    schedule:              row.schedule || [],
    status:                row.status || 'published',
    creatorEmail:          row.creator_email || null,
    requiresLogin:         !!row.requires_login,
    customQuestions:       row.custom_questions || null,
    templateId:            row.template_id || null,
    bankName:              row.bank_name || '',
    bankAccountNumber:     row.bank_account_number || '',
    bankAccountName:       row.bank_account_name || '',
    bankTransferInstructions: row.bank_transfer_instructions || '',
    // Seating grid — both fields default to 0 in the DB, so an event with no
    // auditorium layout sends rows: 0 / seatsPerRow: 0 and the front-end
    // skips the seat-picker step entirely.
    seating: {
      rows:        row.seating_rows  || 0,
      seatsPerRow: row.seats_per_row || 0,
    },
    ticketTypes:           types,
    accommodation:         accommodation,
    createdAt:             row.created_at,
    updatedAt:             row.updated_at,
  };
}

function ticketTypeRow(r) {
  return {
    id:          r.type_id,
    name:        r.name,
    description: r.description || '',
    priceCents:  r.price_cents || 0,
    capacity:    r.capacity   || 0,
    sold:        r.sold       || 0,
    role:        r.role       || 'attendee',
    sortOrder:   r.sort_order || 0,
  };
}

function accommodationRow(r) {
  return {
    id:           r.acc_id,
    name:         r.name,
    description:  r.description || '',
    type:         r.type || null,
    sharing:      r.sharing || null,
    bedsPerRoom:  r.beds_per_room || null,
    priceCents:   r.price_cents || 0,
    capacity:     r.capacity   || 0,
    taken:        r.taken      || 0,
    sortOrder:    r.sort_order || 0,
  };
}

function ticketRow(r) {
  if (!r) return null;
  return {
    code:              r.code,
    eventId:           r.event_id,
    eventTitle:        r.event_title || '',           // joined when available
    eventStartsAt:     r.event_starts_at || null,
    eventLocation:     r.event_location  || null,
    ticketTypeId:      r.ticket_type_id,
    ticketTypeName:    r.ticket_type_name || '',      // joined
    accommodationId:   r.accommodation_id,
    accommodationName: r.accommodation_name || null,  // joined
    groupId:           r.group_id,
    groupType:         r.group_type,
    groupName:         r.group_name,
    groupLeadEmail:    r.group_lead_email,
    attendeeName:      r.attendee_name,
    attendeeEmail:     r.attendee_email,
    attendeePhone:     r.attendee_phone || '',
    attendeeProfile:   r.attendee_profile || {},
    customAnswers:     r.custom_answers || null,
    // Promoted from attendee_profile.photo so callers (and email templates)
    // can read it as a flat field without knowing the JSON shape.
    attendeePhoto:     (r.attendee_profile && r.attendee_profile.photo) || null,
    ageGroup:          r.age_group || 'adult',
    dietary:           r.dietary || '',
    emergencyName:     r.emergency_name || '',
    emergencyPhone:    r.emergency_phone || '',
    roomLabel:         r.room_label || '',
    seatLabel:         r.seat_label || '',
    role:              r.role || 'attendee',
    referrer:          r.referrer || null,
    status:            r.status || 'confirmed',
    ticketUrl:         r.ticket_url || null,
    purchasedAt:       r.purchased_at,
    checkedInAt:       r.checked_in_at,
    updatedAt:         r.updated_at,
  };
}

function newTicketCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = 'TKT-';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function newGroupId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = 'GRP-';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public reads
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/events', async (req, res) => {
  try {
    const list = await db.query(
      `SELECT * FROM events WHERE status <> 'archived' ORDER BY starts_at NULLS LAST, created_at DESC`,
    );
    if (!list.rows.length) return res.json([]);

    const ids = list.rows.map((r) => r.id);
    const [tt, acc] = await Promise.all([
      db.query(`SELECT * FROM event_ticket_types  WHERE event_id = ANY($1::text[]) ORDER BY sort_order, name`, [ids]),
      db.query(`SELECT * FROM event_accommodation WHERE event_id = ANY($1::text[]) ORDER BY sort_order, name`, [ids]),
    ]);
    const tByEvent = new Map(); for (const r of tt.rows)  { (tByEvent.get(r.event_id) || tByEvent.set(r.event_id, []).get(r.event_id)).push(ticketTypeRow(r)); }
    const aByEvent = new Map(); for (const r of acc.rows) { (aByEvent.get(r.event_id) || aByEvent.set(r.event_id, []).get(r.event_id)).push(accommodationRow(r)); }
    res.json(list.rows.map((row) => eventRow(row, tByEvent.get(row.id) || [], aByEvent.get(row.id) || [])));
  } catch (e) {
    console.error('GET /api/events:', e.code, e.message);
    res.status(500).json({ error: 'Failed to list events.' });
  }
});

router.get('/api/events/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Event id is required.' });
  try {
    const ev = await db.query(`SELECT * FROM events WHERE id = $1`, [id]);
    if (!ev.rows.length) return res.status(404).json({ error: 'Event not found.' });
    const [tt, acc] = await Promise.all([
      db.query(`SELECT * FROM event_ticket_types  WHERE event_id = $1 ORDER BY sort_order, name`, [id]),
      db.query(`SELECT * FROM event_accommodation WHERE event_id = $1 ORDER BY sort_order, name`, [id]),
    ]);
    res.json(eventRow(ev.rows[0], tt.rows.map(ticketTypeRow), acc.rows.map(accommodationRow)));
  } catch (e) {
    console.error('GET /api/events/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load event.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin write paths — events
// PUT replaces the entire ticket-types + accommodation arrays. We diff
// against the existing rows so the admin's "Standard / Student" tiers keep
// their sold counts even when the admin renames "Standard" → "General".
// ─────────────────────────────────────────────────────────────────────────────

async function upsertEvent(ev) {
  const ins = await db.query(
    `INSERT INTO events
       (id, church_id, title, tagline, summary, starts_at, ends_at,
        registration_deadline, location, cover_color, banner_url, schedule,
        status, creator_email, requires_login, custom_questions, template_id,
        bank_name, bank_account_number, bank_account_name, bank_transfer_instructions,
        seating_rows, seats_per_row)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (id) DO UPDATE SET
       church_id                  = EXCLUDED.church_id,
       title                      = EXCLUDED.title,
       tagline                    = EXCLUDED.tagline,
       summary                    = EXCLUDED.summary,
       starts_at                  = EXCLUDED.starts_at,
       ends_at                    = EXCLUDED.ends_at,
       registration_deadline      = EXCLUDED.registration_deadline,
       location                   = EXCLUDED.location,
       cover_color                = EXCLUDED.cover_color,
       banner_url                 = EXCLUDED.banner_url,
       schedule                   = EXCLUDED.schedule,
       status                     = EXCLUDED.status,
       requires_login             = EXCLUDED.requires_login,
       custom_questions           = EXCLUDED.custom_questions,
       template_id                = COALESCE(events.template_id, EXCLUDED.template_id),
       bank_name                  = EXCLUDED.bank_name,
       bank_account_number        = EXCLUDED.bank_account_number,
       bank_account_name          = EXCLUDED.bank_account_name,
       bank_transfer_instructions = EXCLUDED.bank_transfer_instructions,
       seating_rows               = EXCLUDED.seating_rows,
       seats_per_row              = EXCLUDED.seats_per_row,
       -- template_id is sticky once set (an event's "type" shouldn't change
       -- mid-life), and creator_email is set once on insert; later edits
       -- don't reassign either so a super-admin editing doesn't relabel.
       updated_at                 = NOW()
     RETURNING *`,
    [
      ev.id, ev.churchId || null, ev.title, ev.tagline || '', ev.summary || '',
      ev.startsAt || null, ev.endsAt || null, ev.registrationDeadline || null,
      ev.location || '', ev.coverColor || '', ev.bannerUrl || '',
      JSON.stringify(ev.schedule || []),
      ev.status || 'published',
      ev.creatorEmail || null,
      !!ev.requiresLogin,
      ev.customQuestions && Array.isArray(ev.customQuestions) && ev.customQuestions.length
        ? JSON.stringify(ev.customQuestions)
        : null,
      ev.templateId || null,
      ev.bankName || null,
      ev.bankAccountNumber || null,
      ev.bankAccountName || null,
      ev.bankTransferInstructions || null,
      Math.max(0, parseInt(ev.seating?.rows || 0, 10) || 0),
      Math.max(0, parseInt(ev.seating?.seatsPerRow || 0, 10) || 0),
    ],
  );
  const eventId = ins.rows[0].id;

  // Replace ticket types — DELETE the ones the admin dropped, UPSERT the rest.
  const keepTT = (ev.ticketTypes || []).map((t) => t.id);
  if (keepTT.length) {
    await db.query(
      `DELETE FROM event_ticket_types WHERE event_id = $1 AND NOT (type_id = ANY($2::text[]))`,
      [eventId, keepTT],
    );
  } else {
    await db.query(`DELETE FROM event_ticket_types WHERE event_id = $1`, [eventId]);
  }
  for (let i = 0; i < (ev.ticketTypes || []).length; i++) {
    const t = ev.ticketTypes[i];
    await db.query(
      `INSERT INTO event_ticket_types
         (event_id, type_id, name, description, price_cents, capacity, sold, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (event_id, type_id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         price_cents=EXCLUDED.price_cents, capacity=EXCLUDED.capacity,
         role=EXCLUDED.role, sort_order=EXCLUDED.sort_order`,
      [eventId, t.id, t.name, t.description || '', t.priceCents || 0, t.capacity || 0, t.sold || 0, t.role || 'attendee', i],
    );
  }

  const keepAcc = (ev.accommodation || []).map((a) => a.id);
  if (keepAcc.length) {
    await db.query(
      `DELETE FROM event_accommodation WHERE event_id = $1 AND NOT (acc_id = ANY($2::text[]))`,
      [eventId, keepAcc],
    );
  } else {
    await db.query(`DELETE FROM event_accommodation WHERE event_id = $1`, [eventId]);
  }
  for (let i = 0; i < (ev.accommodation || []).length; i++) {
    const a = ev.accommodation[i];
    await db.query(
      `INSERT INTO event_accommodation
         (event_id, acc_id, name, description, type, sharing, beds_per_room, price_cents, capacity, taken, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (event_id, acc_id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         type=EXCLUDED.type, sharing=EXCLUDED.sharing,
         beds_per_room=EXCLUDED.beds_per_room,
         price_cents=EXCLUDED.price_cents, capacity=EXCLUDED.capacity,
         sort_order=EXCLUDED.sort_order`,
      [eventId, a.id, a.name, a.description || '', a.type || null, a.sharing || null, a.bedsPerRoom || null, a.priceCents || 0, a.capacity || 0, a.taken || 0, i],
    );
  }

  const [tt, acc] = await Promise.all([
    db.query(`SELECT * FROM event_ticket_types  WHERE event_id = $1 ORDER BY sort_order, name`, [eventId]),
    db.query(`SELECT * FROM event_accommodation WHERE event_id = $1 ORDER BY sort_order, name`, [eventId]),
  ]);
  return eventRow(ins.rows[0], tt.rows.map(ticketTypeRow), acc.rows.map(accommodationRow));
}

router.post('/api/admin/events', adminAuth, async (req, res) => {
  const ev = req.body || {};
  if (!ev.id || !ev.title) return res.status(400).json({ error: 'id and title are required.' });
  try {
    res.json(await upsertEvent(ev));
  } catch (e) {
    console.error('POST /api/admin/events:', e.code, e.message);
    res.status(500).json({ error: 'Failed to save event.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// User-facing write paths — any signed-in user can create/edit their OWN
// events (Google-Form-style). Super admins can edit anyone's event via the
// existing /api/admin/events/* routes; normal users are scoped to events
// where creator_email = their email.
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/events — create. Stamps creator_email from the session and
// rejects payloads that try to override it. The frontend slugifies a title
// into an id, which we use as the primary key (matches the localStorage
// shim and existing admin form).
//
// Slug collisions used to 409 and force the user to pick a different
// title. We now auto-suffix instead — "youth-camp" → "youth-camp-2",
// "-3", … — so two events with the same title from different creators
// both succeed and each gets a unique share link.
router.post('/api/events', userAuth, async (req, res) => {
  const ev = req.body || {};
  if (!ev.id || !ev.title) return res.status(400).json({ error: 'id and title are required.' });

  try {
    const baseId = String(ev.id).trim();
    let id = baseId;
    // Find the first free variant. Cap at 100 attempts so a runaway
    // collision storm can't loop forever; 100 events sharing one base
    // slug is well past anything a real user would type.
    for (let i = 2; i <= 100; i++) {
      const dup = await db.query(`SELECT 1 FROM events WHERE id = $1`, [id]);
      if (!dup.rows.length) break;
      id = `${baseId}-${i}`;
      if (i === 100) {
        return res.status(409).json({ error: 'Too many events share that title. Try a different one.' });
      }
    }
    const saved = await upsertEvent({ ...ev, id, creatorEmail: req.user.email });
    res.json(saved);
  } catch (e) {
    console.error('POST /api/events:', e.code, e.message);
    res.status(500).json({ error: 'Failed to create event.' });
  }
});

// PUT /api/events/:id — update. Allowed when the authenticated user is the
// event's original creator OR has role='admin'. Other users get 403.
router.put('/api/events/:id', userAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Event id is required.' });
  try {
    const own = await db.query(`SELECT creator_email FROM events WHERE id = $1`, [id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Event not found.' });
    const creator = String(own.rows[0].creator_email || '').toLowerCase();
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && creator !== String(req.user.email).toLowerCase()) {
      return res.status(403).json({ error: 'Only the event creator (or a super-admin) can edit this event.' });
    }
    const ev = { ...req.body, id };
    if (!ev.title) return res.status(400).json({ error: 'title is required.' });
    res.json(await upsertEvent(ev));
  } catch (e) {
    console.error('PUT /api/events/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to save event.' });
  }
});

// DELETE /api/events/:id — same ownership rule as PUT.
router.delete('/api/events/:id', userAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  try {
    const own = await db.query(`SELECT creator_email FROM events WHERE id = $1`, [id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Event not found.' });
    const creator = String(own.rows[0].creator_email || '').toLowerCase();
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && creator !== String(req.user.email).toLowerCase()) {
      return res.status(403).json({ error: 'Only the event creator (or a super-admin) can delete this event.' });
    }
    const r = await db.query(`DELETE FROM events WHERE id = $1`, [id]);
    res.json({ ok: r.rowCount > 0 });
  } catch (e) {
    console.error('DELETE /api/events/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete event.' });
  }
});

// GET /api/me/events — the signed-in user's own events. Used by the
// "My events" panel on the user's dashboard.
router.get('/api/me/events', userAuth, async (req, res) => {
  try {
    const list = await db.query(
      `SELECT * FROM events WHERE LOWER(creator_email) = LOWER($1) ORDER BY created_at DESC`,
      [req.user.email],
    );
    if (!list.rows.length) return res.json([]);
    const ids = list.rows.map((r) => r.id);
    const [tt, acc] = await Promise.all([
      db.query(`SELECT * FROM event_ticket_types  WHERE event_id = ANY($1::text[]) ORDER BY sort_order, name`, [ids]),
      db.query(`SELECT * FROM event_accommodation WHERE event_id = ANY($1::text[]) ORDER BY sort_order, name`, [ids]),
    ]);
    const tByEvent = new Map(); for (const r of tt.rows)  { (tByEvent.get(r.event_id) || tByEvent.set(r.event_id, []).get(r.event_id)).push(ticketTypeRow(r)); }
    const aByEvent = new Map(); for (const r of acc.rows) { (aByEvent.get(r.event_id) || aByEvent.set(r.event_id, []).get(r.event_id)).push(accommodationRow(r)); }
    res.json(list.rows.map((row) => eventRow(row, tByEvent.get(row.id) || [], aByEvent.get(row.id) || [])));
  } catch (e) {
    console.error('GET /api/me/events:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load your events.' });
  }
});

router.put('/api/admin/events/:id', adminAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  const ev = { ...req.body, id };
  if (!ev.title) return res.status(400).json({ error: 'title is required.' });
  try {
    res.json(await upsertEvent(ev));
  } catch (e) {
    console.error('PUT /api/admin/events/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to save event.' });
  }
});

router.delete('/api/admin/events/:id', adminAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  try {
    const r = await db.query(`DELETE FROM events WHERE id = $1`, [id]);
    res.json({ ok: r.rowCount > 0 });
  } catch (e) {
    console.error('DELETE /api/admin/events/:id:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete event.' });
  }
});

// Admin convenience read — same shape as public list, but ignores status
// filter so archived events show up.
router.get('/api/admin/events', adminAuth, async (req, res) => {
  try {
    const list = await db.query(`SELECT * FROM events ORDER BY created_at DESC`);
    if (!list.rows.length) return res.json([]);
    const ids = list.rows.map((r) => r.id);
    const [tt, acc] = await Promise.all([
      db.query(`SELECT * FROM event_ticket_types  WHERE event_id = ANY($1::text[]) ORDER BY sort_order, name`, [ids]),
      db.query(`SELECT * FROM event_accommodation WHERE event_id = ANY($1::text[]) ORDER BY sort_order, name`, [ids]),
    ]);
    const tByEvent = new Map(); for (const r of tt.rows)  { (tByEvent.get(r.event_id) || tByEvent.set(r.event_id, []).get(r.event_id)).push(ticketTypeRow(r)); }
    const aByEvent = new Map(); for (const r of acc.rows) { (aByEvent.get(r.event_id) || aByEvent.set(r.event_id, []).get(r.event_id)).push(accommodationRow(r)); }
    res.json(list.rows.map((row) => eventRow(row, tByEvent.get(row.id) || [], aByEvent.get(row.id) || [])));
  } catch (e) {
    console.error('GET /api/admin/events:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load events.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Registration — POST /api/events/:id/register
// Body: { ticketTypeId, accommodationId?, attendees: [...], group?, referrer? }
// Returns: { tickets: Ticket[], primaryCode, groupId? }
//
// Wrapped in a transaction so capacity bumps + ticket inserts can't drift.
// We SELECT … FOR UPDATE on the ticket-type and accommodation rows so two
// concurrent registrants can't both buy the last seat.
// ─────────────────────────────────────────────────────────────────────────────

const { Pool } = require('pg');
// Reuse the same connection pool the db.query wrapper opens. We need raw
// client access for BEGIN/COMMIT; db.js exports a query function only, so
// we create one pool here using the same connection rules.
const txPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER, host: process.env.DB_HOST,
      database: process.env.DB_NAME, password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
    });

router.post('/api/events/:id/register', async (req, res) => {
  const eventId       = String(req.params.id || '').trim();
  const ticketTypeId  = String(req.body?.ticketTypeId || '').trim();
  const accommodationId = req.body?.accommodationId ? String(req.body.accommodationId) : null;
  const attendees     = Array.isArray(req.body?.attendees) ? req.body.attendees : [];
  const group         = req.body?.group || null;
  const referrer      = req.body?.referrer ? String(req.body.referrer).slice(0, 80) : null;
  // Optional seat picks — index aligns with attendees[]. Empty string means
  // "let the system auto-assign". Length must match attendees.length when
  // provided; we reject malformed payloads up front so the transaction
  // doesn't open just to roll back.
  const seatLabels    = Array.isArray(req.body?.seatLabels)
    ? req.body.seatLabels.map((s) => (s == null ? '' : String(s).trim()))
    : null;
  if (seatLabels && seatLabels.length !== attendees.length) {
    return res.status(400).json({ error: 'seatLabels length must match attendees length.' });
  }

  if (!eventId)      return res.status(400).json({ error: 'Event id is required.' });
  if (!ticketTypeId) return res.status(400).json({ error: 'ticketTypeId is required.' });
  if (!attendees.length) return res.status(400).json({ error: 'At least one attendee is required.' });
  if (attendees.length > 50) return res.status(400).json({ error: 'Maximum 50 attendees per registration.' });

  // Soft-auth: resolve the caller from a Bearer token when present so we
  // can stamp `registered_by_*` on each ticket and surface them on the
  // Tickets page even when the attendee_email differs. The requires_login
  // gate below piggybacks on this — when the event creator marked the
  // event as login-only, we reject anon callers up front so they fail fast
  // and don't tie up a tx connection. Frontend sees 401 + error code and
  // bounces the user to /login?redirect=/r/:id.
  let actor = null;
  try {
    const gate = await db.query(`SELECT requires_login FROM events WHERE id = $1`, [eventId]);
    if (!gate.rows.length) return res.status(404).json({ error: 'Event not found.' });
    const hdr = String(req.headers.authorization || '');
    const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
    if (bearer) {
      const sess = await db.query(
        `SELECT id, email FROM users WHERE session_token = $1`,
        [bearer],
      );
      if (sess.rows.length) actor = { id: sess.rows[0].id, email: sess.rows[0].email };
    }
    if (gate.rows[0].requires_login && !actor) {
      return res.status(401).json({
        error: 'login_required',
        message: bearer
          ? 'Your sign-in session has expired. Sign in again.'
          : 'Sign in to register for this event.',
      });
    }
  } catch (e) {
    console.error('register requires_login gate:', e.code, e.message);
    return res.status(500).json({ error: 'Could not check registration access.' });
  }

  const client = await txPool.connect();
  try {
    await client.query('BEGIN');

    // Lock the event so it can't be deleted mid-registration.
    const ev = await client.query(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
    if (!ev.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found.' }); }

    const tt = await client.query(
      `SELECT * FROM event_ticket_types WHERE event_id = $1 AND type_id = $2 FOR UPDATE`,
      [eventId, ticketTypeId],
    );
    if (!tt.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Ticket type not found.' }); }
    const ttRow   = tt.rows[0];
    const ttLeft  = (ttRow.capacity || 0) - (ttRow.sold || 0);
    if (ttRow.capacity > 0 && attendees.length > ttLeft) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${ttLeft} of that ticket left.` });
    }

    // Paid-ticket gate — when the ticket type carries a price the caller
    // must present a paymentProofToken minted by /api/events/payments/verify
    // covering this exact (eventId, ticketTypeId, quantity). The token is
    // HMAC-signed by the same backend, so a forged or stolen token is
    // detectable. Free tiers bypass entirely so unpriced events stay simple.
    if ((ttRow.price_cents || 0) > 0) {
      const proofToken = String(req.body?.paymentProofToken || '').trim();
      if (!proofToken) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: 'payment_required',
          message: 'This ticket type requires payment. Pay first, then submit the registration with the paymentProofToken.',
        });
      }
      const check = verifyPaymentToken(proofToken);
      if (!check.ok) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: `payment_proof_${check.error}`,
          message: `Payment proof token ${check.error}. Re-verify the payment.`,
        });
      }
      const proof = check.payload;
      if (
        proof.kind !== 'event_payment_proof'
        || proof.eventId !== eventId
        || proof.ticketTypeId !== ticketTypeId
        || proof.quantity !== attendees.length
      ) {
        await client.query('ROLLBACK');
        return res.status(402).json({
          error: 'payment_proof_mismatch',
          message: 'Payment proof does not cover this exact ticket / quantity.',
        });
      }
    }

    let accRow = null;
    if (accommodationId) {
      const ar = await client.query(
        `SELECT * FROM event_accommodation WHERE event_id = $1 AND acc_id = $2 FOR UPDATE`,
        [eventId, accommodationId],
      );
      if (!ar.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Accommodation not found.' }); }
      accRow = ar.rows[0];
      const accLeft = (accRow.capacity || 0) - (accRow.taken || 0);
      if (accRow.capacity > 0 && attendees.length > accLeft) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Only ${accLeft} of that accommodation left.` });
      }
    }

    // Mint group id once for the whole batch when present.
    const groupId = group ? newGroupId() : null;
    const groupLeadEmail = group
      ? (group.leadEmail || attendees[0]?.email || null)
      : null;

    const ticketUrlOrigin = String(req.body?.origin || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
    const tickets = [];
    for (let aIdx = 0; aIdx < attendees.length; aIdx++) {
      const a = attendees[aIdx];
      const pickedSeat = (seatLabels && seatLabels[aIdx]) ? seatLabels[aIdx] : null;
      let code; let attempts = 0;
      // Vanishingly small odds of collision but loop on the unique violation
      // anyway — six-char codes have ~887M permutations.
      while (true) {
        code = newTicketCode();
        try {
          const row = await client.query(
            `INSERT INTO event_tickets
               (code, event_id, ticket_type_id, accommodation_id,
                group_id, group_type, group_name, group_lead_email,
                attendee_name, attendee_email, attendee_phone, attendee_profile,
                age_group, dietary, emergency_name, emergency_phone,
                role, referrer, status, ticket_url, seat_label,
                registered_by_user_id, registered_by_email,
                custom_answers)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb)
             RETURNING *`,
            [
              code, eventId, ticketTypeId, accommodationId,
              groupId, group?.type || null, group?.name || null, groupLeadEmail,
              `${a.firstName || ''} ${a.lastName || ''}`.trim() || (a.firstName || a.lastName || 'Guest'),
              a.email ? String(a.email).toLowerCase() : null,
              a.phone || null,
              JSON.stringify({
                // Identity fields — duplicated here (also on flat columns)
                // so the filled-form PDF can render labelled values without
                // a second join. Source of truth stays the flat columns.
                firstName: a.firstName || '', lastName: a.lastName || '',
                email: a.email || '', phone: a.phone || '',
                title: a.title, sex: a.sex, maritalStatus: a.maritalStatus,
                city: a.city, country: a.country,
                region: a.region, district: a.district, assembly: a.assembly,
                ageBracket: a.ageBracket, conventionLocation: a.conventionLocation,
                dietary: a.dietary || '',
                emergencyName: a.emergencyName || '',
                emergencyPhone: a.emergencyPhone || '',
                otherInfo: a.otherInfo || '',
                // Headshot for the badge / ticket PDFs. Accepts a data-URL or
                // raw base64; stored verbatim so renderers (web + email + PDF)
                // can use it directly.
                photo: a.photo || null,
              }),
              a.ageGroup || 'adult',
              a.dietary || '',
              a.emergencyName || '',
              a.emergencyPhone || '',
              ttRow.role || 'attendee',
              referrer,
              'confirmed',
              ticketUrlOrigin ? `${ticketUrlOrigin}/tickets/${code}` : `/tickets/${code}`,
              pickedSeat || null,
              actor?.id || null,
              actor?.email ? actor.email.toLowerCase() : null,
              // customAnswers is the registrant's responses to event.custom_questions.
              // Shared by every attendee in the batch (same submission), or per-
              // attendee if the frontend chose to vary it (e.g. plus-one details).
              (a.customAnswers && typeof a.customAnswers === 'object')
                ? JSON.stringify(a.customAnswers)
                : (req.body?.customAnswers && typeof req.body.customAnswers === 'object'
                    ? JSON.stringify(req.body.customAnswers)
                    : null),
            ],
          );
          tickets.push(row.rows[0]);
          break;
        } catch (err) {
          if (err.code === '23505' && ++attempts < 5) continue; // unique violation on code — try again
          throw err;
        }
      }
    }

    // Bump capacity counters.
    await client.query(
      `UPDATE event_ticket_types SET sold = sold + $1 WHERE event_id = $2 AND type_id = $3`,
      [attendees.length, eventId, ticketTypeId],
    );
    if (accRow) {
      await client.query(
        `UPDATE event_accommodation SET taken = taken + $1 WHERE event_id = $2 AND acc_id = $3`,
        [attendees.length, eventId, accommodationId],
      );
    }

    await client.query('COMMIT');

    // Decorate the response with event title + ticket type name so the
    // frontend can render the confirmation card without a second fetch.
    const ticketTypeName    = ttRow.name;
    const accommodationName = accRow?.name || null;
    const eventRow          = ev.rows[0];
    const eventTitle        = eventRow.title;
    const eventStartsAt     = eventRow.starts_at;
    const eventLocation     = eventRow.location;
    const decorated = tickets.map((t) => ticketRow({
      ...t,
      event_title: eventTitle, event_starts_at: eventStartsAt, event_location: eventLocation,
      ticket_type_name: ticketTypeName,
      accommodation_name: accommodationName,
    }));

    // Authoritative confirmation send — runs after the tx commits so we
    // never email about a ticket that doesn't exist. The frontend also
    // calls /api/notifications/email-ticket as a best-effort fallback;
    // notification_log dedupes both paths via the same key shape used by
    // that route (`ticket:<code>:email:confirmation:<recipient>`), so the
    // attendee gets exactly one copy. Fire-and-forget — failures are
    // logged to notification_log and don't block the response.
    // Pulled once outside the loop so every email in the batch reads the
    // same template + price (and so the email theme matches the event).
    const eventTemplateId = eventRow.template_id || null;
    const ticketPriceCents = ttRow.price_cents || 0;

    // Event fields shared by every confirmation email in this batch.
    const eventEmailFields = {
      eventTitle,
      eventStartsAt,
      eventLocation,
      eventTagline:              eventRow.tagline || null,
      eventSummary:              eventRow.summary || null,
      eventEndsAt:               eventRow.ends_at || null,
      eventRegistrationDeadline: eventRow.registration_deadline || null,
      eventBannerUrl:            eventRow.banner_url || null,
      organizerEmail:            eventRow.creator_email || null,
      templateId:                eventTemplateId,
      priceCents:                ticketPriceCents,
    };

    if (group) {
      // GROUP registration → one summary email to the group's contact listing
      // every member + the shared contact/emergency/other info. The contact
      // gets the whole batch in a single message (with each member's ticket +
      // badge PDF attached) instead of one email per member. The shared
      // contact/emergency/other fields prefer explicit values from the group
      // payload, falling back to the first attendee's profile (every member in
      // group mode carries the same merged shared values).
      const lead = decorated[0] || {};
      const leadProfile = lead.attendeeProfile || {};
      const contactEmail = String(
        groupLeadEmail || lead.attendeeEmail || '',
      ).toLowerCase();

      const members = decorated.map((t) => {
        const prof = t.attendeeProfile || {};
        return {
          name:            t.attendeeName,
          title:           prof.title || '',
          sex:             prof.sex || '',
          ageBracket:      prof.ageBracket || '',
          status:          prof.maritalStatus || '',
          ticketCode:      t.code,
          seatLabel:       t.seatLabel || null,
          role:            t.role || 'attendee',
          ticketUrl:       t.ticketUrl || null,
          ticketTypeName:  t.ticketTypeName || null,
          attendeeProfile: t.attendeeProfile || null,
        };
      });

      if (contactEmail) {
        sendNow({
          kind:      'group.confirmation',
          channel:   'email',
          recipient: contactEmail,
          payload: {
            ...eventEmailFields,
            groupName: group.name || null,
            groupType: group.type || null,
            contact: {
              phone: group.contactPhone || lead.attendeePhone || leadProfile.phone || '',
              email: contactEmail,
            },
            emergency: {
              name:  group.emergencyName  || leadProfile.emergencyName  || '',
              phone: group.emergencyPhone || leadProfile.emergencyPhone || '',
            },
            otherInfo: group.otherInfo || leadProfile.otherInfo || '',
            members,
            ticketUrl: lead.ticketUrl || null,
          },
          dedupeKey: `group:${groupId}:email:confirmation:${contactEmail}`,
          metadata:  { groupId, eventId, source: 'register-handler', memberCount: members.length },
        }).catch((e) => console.warn('register group confirm-email failed', groupId, e.message));
      }
    } else {
      // Individual registration → one ticket.confirmation per attendee.
      Promise.all(decorated.map((t) => {
        const to = (t.attendeeEmail || '').toLowerCase();
        if (!to) return null;
        return sendNow({
          kind:      'ticket.confirmation',
          channel:   'email',
          recipient: to,
          payload: {
            ...eventEmailFields,
            attendeeName:      t.attendeeName,
            attendeeEmail:     t.attendeeEmail,
            attendeePhone:     t.attendeePhone,
            attendeePhoto:     t.attendeePhoto,
            attendeeProfile:   t.attendeeProfile,
            ticketCode:        t.code,
            role:              t.role,
            ticketUrl:         t.ticketUrl,
            ticketTypeName:    t.ticketTypeName,
            accommodationName: t.accommodationName,
            roomLabel:         t.roomLabel,
            seatLabel:         t.seatLabel,
            groupName:         t.groupName,
            groupType:         t.groupType,
          },
          dedupeKey: `ticket:${t.code}:email:confirmation:${to}`,
          metadata:  { ticketCode: t.code, eventId: t.eventId, groupId: t.groupId || null, source: 'register-handler' },
        }).catch((e) => console.warn('register confirm-email failed', t.code, e.message));
      })).catch(() => {});
    }

    res.json({ tickets: decorated, primaryCode: decorated[0]?.code || null, groupId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/events/:id/register:', e.code, e.message, e.stack);
    res.status(500).json({ error: 'Failed to register.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ticket reads
// ─────────────────────────────────────────────────────────────────────────────

const TICKET_SELECT = `
  SELECT t.*,
         e.title    AS event_title,
         e.starts_at AS event_starts_at,
         e.location AS event_location,
         tt.name    AS ticket_type_name,
         acc.name   AS accommodation_name
    FROM event_tickets t
    LEFT JOIN events e
      ON e.id = t.event_id
    LEFT JOIN event_ticket_types tt
      ON tt.event_id = t.event_id AND tt.type_id = t.ticket_type_id
    LEFT JOIN event_accommodation acc
      ON acc.event_id = t.event_id AND acc.acc_id = t.accommodation_id
`;

router.get('/api/tickets/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  try {
    const r = await db.query(`${TICKET_SELECT} WHERE t.code = $1`, [code]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    res.json(ticketRow(r.rows[0]));
  } catch (e) {
    console.error('GET /api/tickets/:code:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load ticket.' });
  }
});

// Returns every ticket the caller has any claim to: tickets where they
// are the attendee (attendee_email match), tickets they bought for someone
// else (registered_by_email or registered_by_user_id match), or — for
// admins only — any ticket matched by the ?email= override (used by the
// kiosk / staff lookup form on the Tickets page).
router.get('/api/tickets', userAuth, async (req, res) => {
  const isAdmin    = req.user.role === 'admin';
  const override   = String(req.query.email || '').trim().toLowerCase();
  const lookupEmail = (isAdmin && override) ? override : String(req.user.email || '').toLowerCase();
  if (!lookupEmail) return res.json([]);
  try {
    // Admin override searches only attendee_email — staff are looking up
    // someone else's tickets by email, not by who registered them.
    const sql = (isAdmin && override)
      ? `${TICKET_SELECT}
           WHERE LOWER(t.attendee_email) = $1
           ORDER BY t.purchased_at DESC`
      : `${TICKET_SELECT}
           WHERE LOWER(t.attendee_email)      = $1
              OR LOWER(t.registered_by_email) = $1
              OR t.registered_by_user_id      = $2
           ORDER BY t.purchased_at DESC`;
    const params = (isAdmin && override) ? [lookupEmail] : [lookupEmail, req.user.id];
    const r = await db.query(sql, params);
    res.json(r.rows.map(ticketRow));
  } catch (e) {
    console.error('GET /api/tickets:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load tickets.' });
  }
});

router.get('/api/events/:id/tickets', async (req, res) => {
  const id = String(req.params.id || '').trim();
  try {
    const r = await db.query(
      `${TICKET_SELECT} WHERE t.event_id = $1 ORDER BY t.purchased_at DESC`,
      [id],
    );
    res.json(r.rows.map(ticketRow));
  } catch (e) {
    console.error('GET /api/events/:id/tickets:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load event tickets.' });
  }
});

// Editable: name, email, phone, dietary, emergency contact, age group.
// Everything else (status, code, group, capacity-affecting fields) stays
// admin-only or system-managed.
// Delete a ticket. Allowed for: the attendee themselves, the person who
// registered them, the event's creator, or a super-admin. Anyone else gets
// 403 — the unguessable code alone is not enough authority to delete.
router.delete('/api/tickets/:code', userAuth, async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const callerEmail = String(req.user.email || '').toLowerCase();
  const isAdmin = req.user.role === 'admin';
  try {
    const r = await db.query(
      `SELECT t.code, t.event_id, LOWER(t.attendee_email) AS att,
              LOWER(t.registered_by_email) AS reg, t.registered_by_user_id AS reg_uid,
              LOWER(e.creator_email) AS creator
         FROM event_tickets t
         LEFT JOIN events e ON e.id = t.event_id
        WHERE t.code = $1`,
      [code],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    const t = r.rows[0];
    const owns = isAdmin
      || t.att === callerEmail
      || t.reg === callerEmail
      || (t.reg_uid && t.reg_uid === req.user.id)
      || t.creator === callerEmail;
    if (!owns) {
      return res.status(403).json({ error: 'Only the attendee, the person who registered them, or the event creator can delete this ticket.' });
    }
    const del = await db.query(`DELETE FROM event_tickets WHERE code = $1`, [code]);
    res.json({ ok: del.rowCount > 0 });
  } catch (e) {
    console.error('DELETE /api/tickets/:code:', e.code, e.message);
    res.status(500).json({ error: 'Failed to delete ticket.' });
  }
});

router.put('/api/tickets/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const patch = req.body || {};
  const sets = []; const params = [];
  function push(col, val) { params.push(val); sets.push(`${col} = $${params.length}`); }
  if (typeof patch.attendeeName  === 'string') push('attendee_name',  patch.attendeeName);
  if (typeof patch.attendeeEmail === 'string') push('attendee_email', patch.attendeeEmail.toLowerCase() || null);
  if (typeof patch.attendeePhone === 'string') push('attendee_phone', patch.attendeePhone);
  if (typeof patch.dietary       === 'string') push('dietary',        patch.dietary);
  if (typeof patch.emergencyName === 'string') push('emergency_name', patch.emergencyName);
  if (typeof patch.emergencyPhone=== 'string') push('emergency_phone',patch.emergencyPhone);
  if (typeof patch.ageGroup      === 'string') push('age_group',      patch.ageGroup);
  if (!sets.length) return res.status(400).json({ error: 'No editable fields supplied.' });
  params.push(code);
  try {
    const r = await db.query(
      `UPDATE event_tickets SET ${sets.join(', ')}, updated_at = NOW() WHERE code = $${params.length} RETURNING code`,
      params,
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    const full = await db.query(`${TICKET_SELECT} WHERE t.code = $1`, [code]);
    res.json(ticketRow(full.rows[0]));
  } catch (e) {
    console.error('PUT /api/tickets/:code:', e.code, e.message);
    res.status(500).json({ error: 'Failed to update ticket.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Check-in — idempotent. First call stamps `checked_in_at`; subsequent calls
// return the existing timestamp instead of overwriting it.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/checkin/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  try {
    const r = await db.query(
      `UPDATE event_tickets
          SET status = 'checked-in',
              checked_in_at = COALESCE(checked_in_at, NOW()),
              updated_at = NOW()
        WHERE code = $1
        RETURNING code, attendee_name, event_id, checked_in_at`,
      [code],
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Ticket not found' });
    const t = r.rows[0];
    // Pull the event title in for a friendlier scanner UI.
    const ev = await db.query(`SELECT title FROM events WHERE id = $1`, [t.event_id]);
    res.json({
      ok: true,
      ticketCode:   t.code,
      attendeeName: t.attendee_name,
      eventTitle:   ev.rows[0]?.title || '',
      checkedInAt:  t.checked_in_at,
    });
  } catch (e) {
    console.error('POST /api/checkin/:code:', e.code, e.message);
    res.status(500).json({ ok: false, error: 'Failed to check in.' });
  }
});

module.exports = router;
