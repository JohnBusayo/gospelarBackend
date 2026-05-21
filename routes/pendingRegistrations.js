// routes/pendingRegistrations.js
// ─────────────────────────────────────────────────────────────────────────────
// Bank-transfer payment fallback for paid event tickets.
//
// Flow:
//   1. POST /api/events/:eventId/registrations/pending  — attendee submits the
//      registration with a screenshot of their bank transfer; we soft-reserve
//      ticket / accommodation capacity via the `held` columns and leave the
//      row at status='pending'.
//   2. GET /api/admin/pending-registrations              — event creator (or
//      super-admin) lists pending rows for events they own. Sweeps stale
//      rows (> 48h) to status='expired' first, releasing held capacity.
//   3. POST .../:id/approve                              — verifies the
//      transfer, mints tickets (same INSERT shape as POST /api/events/:id/
//      register), moves the held count into sold, fires the same
//      ticket-confirmation email pipeline the standard register flow uses.
//   4. POST .../:id/reject                               — admin types a
//      reason; we release held capacity and email the attendee with the
//      reason + a link to re-submit.
//
// Why a separate file: keeps the /register handler focused on the synchronous
// happy path. The pending flow has a different state machine (held → sold or
// expired) and its own admin UI surface; mixing them would balloon
// routes/events.js.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { Pool } = require('pg');
const db = require('../db');
const { userAuth } = require('../middleware/auth');
const { sendNow } = require('../services/notifications');

const router = express.Router();

// Reuse the same connection rules as routes/events.js — keep this pool for
// the multi-statement transactions in approve / reject / submit.
const txPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      user: process.env.DB_USER, host: process.env.DB_HOST,
      database: process.env.DB_NAME, password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
    });

// Pending rows older than this are lazy-swept to status='expired' and have
// their held seats released back to capacity. 48h gives the admin two
// business days to verify a transfer before the seat opens up again.
const PENDING_TTL_HOURS = 48;

// Shared char set for ticket / group codes — mirrors routes/events.js so a
// ticket minted via the pending flow looks identical to one minted directly.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newTicketCode() {
  let out = 'TKT-';
  for (let i = 0; i < 6; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}
function newGroupId() {
  let out = 'GRP-';
  for (let i = 0; i < 6; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

// Lazy expiry — runs inside whatever transaction the caller is in (or via a
// dedicated short tx when not). For every pending row past TTL, decrement
// the soft-reserve counters and flip the row to status='expired'. Avoids
// needing an external cron for v1.
async function sweepExpiredPending(client) {
  // Lock candidate rows so concurrent approves can't double-decrement.
  const stale = await client.query(
    `SELECT id, event_id, ticket_type_id, accommodation_id, quantity
       FROM pending_registrations
      WHERE status = 'pending'
        AND created_at < NOW() - INTERVAL '${PENDING_TTL_HOURS} hours'
      FOR UPDATE`,
  );
  for (const r of stale.rows) {
    await client.query(
      `UPDATE event_ticket_types SET held = GREATEST(held - $1, 0)
        WHERE event_id = $2 AND type_id = $3`,
      [r.quantity, r.event_id, r.ticket_type_id],
    );
    if (r.accommodation_id) {
      await client.query(
        `UPDATE event_accommodation SET held = GREATEST(held - $1, 0)
          WHERE event_id = $2 AND acc_id = $3`,
        [r.quantity, r.event_id, r.accommodation_id],
      );
    }
    await client.query(
      `UPDATE pending_registrations
          SET status = 'expired', updated_at = NOW()
        WHERE id = $1`,
      [r.id],
    );
  }
  return stale.rowCount;
}

// Wraps sweep in its own short tx — used by GET endpoints that don't already
// own a transaction.
async function sweepStandalone() {
  const client = await txPool.connect();
  try {
    await client.query('BEGIN');
    await sweepExpiredPending(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn('[pending] sweep failed:', e.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapper — DB shape → frontend shape.
// ─────────────────────────────────────────────────────────────────────────────
function pendingRow(r) {
  if (!r) return null;
  return {
    id:                 r.id,
    eventId:            r.event_id,
    eventTitle:         r.event_title || '',          // joined when available
    eventStartsAt:      r.event_starts_at || null,
    eventLocation:      r.event_location  || null,
    eventCoverColor:    r.event_cover_color || null,
    eventBannerUrl:     r.event_banner_url || null,
    ticketTypeId:       r.ticket_type_id,
    ticketTypeName:     r.ticket_type_name || '',     // joined
    accommodationId:    r.accommodation_id,
    accommodationName:  r.accommodation_name || null, // joined
    quantity:           r.quantity,
    amountCents:        r.amount_cents,
    attendees:          r.attendees || [],
    groupInfo:          r.group_info || null,
    seatLabels:         r.seat_labels || null,
    customAnswers:      r.custom_answers || null,
    proofImage:         r.proof_image,
    transferReference:  r.transfer_reference || '',
    registrantEmail:    r.registrant_email,
    status:             r.status,
    rejectionReason:    r.rejection_reason || '',
    reviewedAt:         r.reviewed_at,
    reviewedByEmail:    r.reviewed_by_email,
    ticketCodes:        r.ticket_codes || [],
    createdAt:          r.created_at,
    updatedAt:          r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Submit a pending registration (public — no auth required, just like
//    POST /api/events/:id/register).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/events/:eventId/registrations/pending', async (req, res) => {
  const eventId        = String(req.params.eventId || '').trim();
  const ticketTypeId   = String(req.body?.ticketTypeId || '').trim();
  const accommodationId = req.body?.accommodationId ? String(req.body.accommodationId) : null;
  const attendees      = Array.isArray(req.body?.attendees) ? req.body.attendees : [];
  const group          = req.body?.group || null;
  const customAnswers  = req.body?.customAnswers && typeof req.body.customAnswers === 'object'
    ? req.body.customAnswers : null;
  const seatLabels     = Array.isArray(req.body?.seatLabels)
    ? req.body.seatLabels.map((s) => (s == null ? '' : String(s).trim()))
    : null;
  const proofImage     = String(req.body?.proofImage || '').trim();
  const transferReference = req.body?.transferReference
    ? String(req.body.transferReference).slice(0, 120)
    : null;

  if (!eventId)           return res.status(400).json({ error: 'Event id is required.' });
  if (!ticketTypeId)      return res.status(400).json({ error: 'ticketTypeId is required.' });
  if (!attendees.length)  return res.status(400).json({ error: 'At least one attendee is required.' });
  if (attendees.length > 50) return res.status(400).json({ error: 'Maximum 50 attendees per registration.' });
  if (!proofImage)        return res.status(400).json({ error: 'proofImage (screenshot of the transfer) is required.' });
  if (proofImage.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'Screenshot is too large. Compress it and try again.' });
  }
  if (seatLabels && seatLabels.length !== attendees.length) {
    return res.status(400).json({ error: 'seatLabels length must match attendees length.' });
  }

  const registrantEmail = (attendees[0]?.email || '').toLowerCase();
  if (!registrantEmail) {
    return res.status(400).json({ error: 'Lead attendee needs an email so we can notify them.' });
  }

  const client = await txPool.connect();
  try {
    await client.query('BEGIN');

    // Sweep first so a long-stale row's held seats are released before we
    // check capacity for this submission. Prevents "sold out" false-positives
    // when expired pending rows haven't been cleaned up yet.
    await sweepExpiredPending(client);

    // Pull the event so we can confirm bank fields are set + grab amount.
    const ev = await client.query(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
    if (!ev.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found.' }); }
    if (!ev.rows[0].bank_account_number) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'bank_transfer_unavailable',
        message: 'The organizer hasn’t set up bank-transfer for this event. Use one of the online payment options instead.',
      });
    }

    // Lock ticket type — we'll bump `held` shortly. Available = capacity - sold - held.
    const tt = await client.query(
      `SELECT * FROM event_ticket_types WHERE event_id = $1 AND type_id = $2 FOR UPDATE`,
      [eventId, ticketTypeId],
    );
    if (!tt.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Ticket type not found.' }); }
    const ttRow = tt.rows[0];
    if (!(ttRow.price_cents > 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'free_ticket',
        message: 'This is a free ticket — register directly instead of via bank transfer.',
      });
    }
    const ttAvail = (ttRow.capacity || 0) - (ttRow.sold || 0) - (ttRow.held || 0);
    if (ttRow.capacity > 0 && attendees.length > ttAvail) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only ${Math.max(0, ttAvail)} of that ticket left (some are awaiting verification).` });
    }

    // Lock accommodation if requested.
    if (accommodationId) {
      const ar = await client.query(
        `SELECT * FROM event_accommodation WHERE event_id = $1 AND acc_id = $2 FOR UPDATE`,
        [eventId, accommodationId],
      );
      if (!ar.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Accommodation not found.' }); }
      const accRow = ar.rows[0];
      const accAvail = (accRow.capacity || 0) - (accRow.taken || 0) - (accRow.held || 0);
      if (accRow.capacity > 0 && attendees.length > accAvail) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Only ${Math.max(0, accAvail)} of that accommodation left.` });
      }
    }

    // Soft-reserve: bump held counts. Will be released on reject / expire,
    // or moved into sold on approve.
    await client.query(
      `UPDATE event_ticket_types SET held = held + $1 WHERE event_id = $2 AND type_id = $3`,
      [attendees.length, eventId, ticketTypeId],
    );
    if (accommodationId) {
      await client.query(
        `UPDATE event_accommodation SET held = held + $1 WHERE event_id = $2 AND acc_id = $3`,
        [attendees.length, eventId, accommodationId],
      );
    }

    const amountCents = (ttRow.price_cents || 0) * attendees.length;
    const ins = await client.query(
      `INSERT INTO pending_registrations
         (event_id, ticket_type_id, accommodation_id, quantity, amount_cents,
          attendees, group_info, seat_labels, custom_answers,
          proof_image, transfer_reference, registrant_email)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)
       RETURNING *`,
      [
        eventId, ticketTypeId, accommodationId, attendees.length, amountCents,
        JSON.stringify(attendees),
        group ? JSON.stringify(group) : null,
        seatLabels ? JSON.stringify(seatLabels) : null,
        customAnswers ? JSON.stringify(customAnswers) : null,
        proofImage,
        transferReference,
        registrantEmail,
      ],
    );

    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      id: ins.rows[0].id,
      status: ins.rows[0].status,
      message: 'Your registration is awaiting verification. We will email you once the organizer reviews your transfer.',
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/events/:id/registrations/pending:', e.code, e.message);
    res.status(500).json({ error: 'Could not submit pending registration.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. List pending registrations the calling user is allowed to see.
//    Scoping: super-admin sees all; everyone else sees only registrations
//    for events they created (events.creator_email = req.user.email).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/admin/pending-registrations', userAuth, async (req, res) => {
  const status  = String(req.query?.status  || 'pending').toLowerCase();
  const eventId = req.query?.eventId ? String(req.query.eventId) : null;
  if (!['pending', 'approved', 'rejected', 'expired', 'all'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter.' });
  }

  // Sweep stale rows so the list reflects current state.
  await sweepStandalone();

  try {
    const isAdmin = req.user.role === 'admin';
    const params  = [];
    const where   = [];
    if (status !== 'all') { params.push(status); where.push(`p.status = $${params.length}`); }
    if (eventId)          { params.push(eventId); where.push(`p.event_id = $${params.length}`); }
    if (!isAdmin)         { params.push(req.user.email.toLowerCase()); where.push(`LOWER(e.creator_email) = $${params.length}`); }
    const sql = `
      SELECT p.*,
             e.title        AS event_title,
             e.starts_at    AS event_starts_at,
             e.location     AS event_location,
             e.cover_color  AS event_cover_color,
             e.banner_url   AS event_banner_url,
             tt.name        AS ticket_type_name,
             acc.name       AS accommodation_name
        FROM pending_registrations p
        JOIN events e ON e.id = p.event_id
   LEFT JOIN event_ticket_types  tt  ON tt.event_id  = p.event_id AND tt.type_id  = p.ticket_type_id
   LEFT JOIN event_accommodation acc ON acc.event_id = p.event_id AND acc.acc_id = p.accommodation_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.created_at DESC
    `;
    const r = await db.query(sql, params);
    res.json(r.rows.map(pendingRow));
  } catch (e) {
    console.error('GET /api/admin/pending-registrations:', e.code, e.message);
    res.status(500).json({ error: 'Could not load pending registrations.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Approve — mints tickets + fires confirmation email per ticket.
//    Mirrors the INSERT shape used by POST /api/events/:id/register so the
//    resulting event_tickets rows are indistinguishable from a direct
//    registration. Inside one transaction: row lock, capacity move
//    (held → sold), N inserts, status flip. Confirmation emails fire
//    fire-and-forget after the tx commits.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/admin/pending-registrations/:id/approve', userAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });

  const client = await txPool.connect();
  try {
    await client.query('BEGIN');

    // Lock the pending row + join event to do the ownership check in one shot.
    const pr = await client.query(
      `SELECT p.*, e.creator_email, e.title AS event_title, e.starts_at AS event_starts_at,
              e.location AS event_location
         FROM pending_registrations p
         JOIN events e ON e.id = p.event_id
        WHERE p.id = $1
          FOR UPDATE OF p`,
      [id],
    );
    if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pending registration not found.' }); }
    const p = pr.rows[0];

    const isAdmin = req.user.role === 'admin';
    const isOwner = String(p.creator_email || '').toLowerCase() === String(req.user.email).toLowerCase();
    if (!isAdmin && !isOwner) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the event creator (or a super-admin) can approve.' });
    }
    if (p.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Already ${p.status}.` });
    }

    // Lock ticket type / accommodation rows so the held → sold move is atomic.
    const tt = await client.query(
      `SELECT * FROM event_ticket_types WHERE event_id = $1 AND type_id = $2 FOR UPDATE`,
      [p.event_id, p.ticket_type_id],
    );
    if (!tt.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Ticket type no longer exists.' }); }
    const ttRow = tt.rows[0];

    let accRow = null;
    if (p.accommodation_id) {
      const ar = await client.query(
        `SELECT * FROM event_accommodation WHERE event_id = $1 AND acc_id = $2 FOR UPDATE`,
        [p.event_id, p.accommodation_id],
      );
      if (!ar.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Accommodation no longer exists.' }); }
      accRow = ar.rows[0];
    }

    // Move held → sold. Held was bumped on submit; if it was somehow
    // released (e.g. expiry race), recompute from current sold + capacity
    // to make sure we're not overselling.
    const attendees = Array.isArray(p.attendees) ? p.attendees : [];
    const seatLabels = Array.isArray(p.seat_labels) ? p.seat_labels : [];
    const group = p.group_info || null;
    const customAnswers = p.custom_answers || null;
    const groupId = group ? newGroupId() : null;
    const groupLeadEmail = group
      ? (group.leadEmail || attendees[0]?.email || null)
      : null;

    const ticketUrlOrigin = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');

    const tickets = [];
    for (let aIdx = 0; aIdx < attendees.length; aIdx++) {
      const a = attendees[aIdx];
      const pickedSeat = seatLabels[aIdx] || null;
      let code; let attempts = 0;
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
              code, p.event_id, p.ticket_type_id, p.accommodation_id,
              groupId, group?.type || null, group?.name || null, groupLeadEmail,
              `${a.firstName || ''} ${a.lastName || ''}`.trim() || (a.firstName || a.lastName || 'Guest'),
              a.email ? String(a.email).toLowerCase() : null,
              a.phone || null,
              JSON.stringify({
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
                photo: a.photo || null,
              }),
              a.ageGroup || 'adult',
              a.dietary || '',
              a.emergencyName || '',
              a.emergencyPhone || '',
              ttRow.role || 'attendee',
              null, // referrer
              'confirmed',
              ticketUrlOrigin ? `${ticketUrlOrigin}/tickets/${code}` : `/tickets/${code}`,
              pickedSeat,
              null, // registered_by_user_id — bank-transfer flow may not have a session
              p.registrant_email || null,
              (a.customAnswers && typeof a.customAnswers === 'object')
                ? JSON.stringify(a.customAnswers)
                : (customAnswers ? JSON.stringify(customAnswers) : null),
            ],
          );
          tickets.push(row.rows[0]);
          break;
        } catch (err) {
          if (err.code === '23505' && ++attempts < 5) continue;
          throw err;
        }
      }
    }

    // Move soft-reserve into a hard sold. Clamp held at zero in case of
    // any drift from a parallel expiry sweep.
    await client.query(
      `UPDATE event_ticket_types
          SET sold = sold + $1, held = GREATEST(held - $1, 0)
        WHERE event_id = $2 AND type_id = $3`,
      [attendees.length, p.event_id, p.ticket_type_id],
    );
    if (accRow) {
      await client.query(
        `UPDATE event_accommodation
            SET taken = taken + $1, held = GREATEST(held - $1, 0)
          WHERE event_id = $2 AND acc_id = $3`,
        [attendees.length, p.event_id, p.accommodation_id],
      );
    }

    await client.query(
      `UPDATE pending_registrations
          SET status = 'approved',
              reviewed_at = NOW(),
              reviewed_by_email = $2,
              ticket_codes = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [id, req.user.email.toLowerCase(), tickets.map((t) => t.code)],
    );

    await client.query('COMMIT');

    // Confirmation emails — same payload shape and dedupe key as the
    // standard register handler (routes/events.js).
    Promise.all(tickets.map((t) => {
      const to = (t.attendee_email || '').toLowerCase();
      if (!to) return null;
      return sendNow({
        kind:      'ticket.confirmation',
        channel:   'email',
        recipient: to,
        payload: {
          eventTitle:        p.event_title,
          eventStartsAt:     p.event_starts_at,
          eventLocation:     p.event_location,
          attendeeName:      t.attendee_name,
          attendeeEmail:     t.attendee_email,
          attendeePhone:     t.attendee_phone,
          attendeePhoto:     (t.attendee_profile && t.attendee_profile.photo) || null,
          attendeeProfile:   t.attendee_profile,
          ticketCode:        t.code,
          role:              t.role,
          ticketUrl:         t.ticket_url,
          ticketTypeName:    ttRow.name,
          accommodationName: accRow?.name || null,
          roomLabel:         t.room_label,
          seatLabel:         t.seat_label,
          groupName:         t.group_name,
          groupType:         t.group_type,
        },
        dedupeKey: `ticket:${t.code}:email:confirmation:${to}`,
        metadata:  { ticketCode: t.code, eventId: p.event_id, source: 'pending-approve' },
      }).catch((e) => console.warn('approve confirm-email failed', t.code, e.message));
    })).catch(() => {});

    res.json({
      ok: true,
      status: 'approved',
      tickets: tickets.map((t) => ({ code: t.code, email: t.attendee_email, name: t.attendee_name })),
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/admin/pending-registrations/:id/approve:', e.code, e.message);
    res.status(500).json({ error: 'Could not approve registration.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Reject — releases held capacity, stores the reason, emails the
//    registrant with the reason and a link back to the share-link page so
//    they can re-submit.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/admin/pending-registrations/:id/reject', userAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  if (!reason)              return res.status(400).json({ error: 'A reason is required.' });

  const client = await txPool.connect();
  try {
    await client.query('BEGIN');

    const pr = await client.query(
      `SELECT p.*, e.creator_email, e.title AS event_title
         FROM pending_registrations p
         JOIN events e ON e.id = p.event_id
        WHERE p.id = $1
          FOR UPDATE OF p`,
      [id],
    );
    if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pending registration not found.' }); }
    const p = pr.rows[0];

    const isAdmin = req.user.role === 'admin';
    const isOwner = String(p.creator_email || '').toLowerCase() === String(req.user.email).toLowerCase();
    if (!isAdmin && !isOwner) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the event creator (or a super-admin) can reject.' });
    }
    if (p.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Already ${p.status}.` });
    }

    // Release held capacity. Clamp at zero in case of drift.
    await client.query(
      `UPDATE event_ticket_types SET held = GREATEST(held - $1, 0)
        WHERE event_id = $2 AND type_id = $3`,
      [p.quantity, p.event_id, p.ticket_type_id],
    );
    if (p.accommodation_id) {
      await client.query(
        `UPDATE event_accommodation SET held = GREATEST(held - $1, 0)
          WHERE event_id = $2 AND acc_id = $3`,
        [p.quantity, p.event_id, p.accommodation_id],
      );
    }

    await client.query(
      `UPDATE pending_registrations
          SET status = 'rejected',
              rejection_reason = $2,
              reviewed_at = NOW(),
              reviewed_by_email = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [id, reason, req.user.email.toLowerCase()],
    );

    await client.query('COMMIT');

    // Rejection notice — fire and forget so failure here doesn't roll
    // back the rejection itself.
    sendNow({
      kind:      'registration.rejected',
      channel:   'email',
      recipient: p.registrant_email,
      payload: {
        eventTitle: p.event_title,
        eventId:    p.event_id,
        reason,
        amountCents: p.amount_cents,
        ticketTypeId: p.ticket_type_id,
      },
      dedupeKey: `pending:${id}:rejected:${p.registrant_email}`,
      metadata:  { pendingId: id, eventId: p.event_id, source: 'pending-reject' },
    }).catch((e) => console.warn('reject email failed', id, e.message));

    res.json({ ok: true, status: 'rejected' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/admin/pending-registrations/:id/reject:', e.code, e.message);
    res.status(500).json({ error: 'Could not reject registration.' });
  } finally {
    client.release();
  }
});

module.exports = router;
