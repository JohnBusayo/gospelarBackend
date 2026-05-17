// services/ticketPdf.js
// Server-side PDF generation for ticket confirmation emails.
//
// Two products:
//   buildTicketPdf(payload)  → Letter-sized full ticket (header band + QR +
//                              attendee details). Mirrors the /tickets/:code
//                              web view at a printable resolution.
//   buildBadgePdf(payload)   → CR80-sized (3.4" × 2.13") lanyard badge.
//                              Matches the on-screen Badge.jsx layout: role
//                              band, photo/initials avatar, name, role pill,
//                              QR, code.
//
// Both render with pdfkit (pure JS, no headless browser) and embed a locally
// generated QR PNG via the `qrcode` package, so the email pipeline doesn't
// need outbound HTTP per send. Photos are embedded when the payload carries
// `attendeePhoto` as a data URL or raw base64 PNG/JPEG.

const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

// Role gradient pairs — mirror notifications.js ROLE_GRADIENTS so badge/ticket
// PDFs match the on-screen avatar colours.
const ROLE_COLOURS = {
  attendee: { from: '#0EA5E9', to: '#4F46E5', label: 'Attendee' },
  staff:    { from: '#10B981', to: '#0F766E', label: 'Staff'    },
  speaker:  { from: '#F59E0B', to: '#E11D48', label: 'Speaker'  },
};
function roleColour(role) {
  return ROLE_COLOURS[String(role || 'attendee').toLowerCase()] || ROLE_COLOURS.attendee;
}

function initialsFrom(name) {
  return String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => (w[0] || '').toUpperCase()).join('') || '?';
}

// Build the check-in URL the QR encodes. Matches the web Badge/TicketTag
// origin handling so a scan at the door opens the staff check-in flow.
function checkInUrl(code) {
  const origin = (process.env.PUBLIC_APP_URL || 'https://gospelar.app').replace(/\/$/, '');
  return `${origin}/check-in?code=${encodeURIComponent(code || '')}`;
}

async function qrPngBuffer(text, size = 320) {
  // M-level error correction — survives a partial smudge but stays compact.
  return QRCode.toBuffer(text, {
    errorCorrectionLevel: 'M',
    type:   'png',
    margin: 1,
    width:  size,
  });
}

// Pull a photo into a Buffer pdfkit can embed. Accepts a data URL
// ("data:image/png;base64,…"), a raw base64 string, or returns null.
function photoBuffer(photo) {
  if (!photo) return null;
  try {
    const raw = String(photo).startsWith('data:')
      ? String(photo).split(',', 2)[1] || ''
      : String(photo);
    if (!raw) return null;
    const buf = Buffer.from(raw, 'base64');
    // Tiny / corrupted base64 still yields a small buffer; pdfkit throws on
    // those. Treat <100 bytes as "not a real image" and skip.
    if (buf.length < 100) return null;
    return buf;
  } catch {
    return null;
  }
}

// Format event timing for the right-hand details table.
function fmtWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-NG', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// pdfkit doesn't ship a gradient primitive, so we approximate with a two-stop
// linear-gradient via repeated thin rectangles. Used for the role band on
// the badge and the header band on the ticket.
function paintHorizontalGradient(doc, x, y, w, h, from, to) {
  const grad = doc.linearGradient(x, y, x + w, y);
  grad.stop(0, from).stop(1, to);
  doc.rect(x, y, w, h).fill(grad);
}
function paintDiagonalGradient(doc, x, y, w, h, from, to) {
  const grad = doc.linearGradient(x, y, x + w, y + h);
  grad.stop(0, from).stop(1, to);
  doc.rect(x, y, w, h).fill(grad);
}

// Avatar block: square with the photo if present, otherwise a gradient fill
// with bold initials. Used by both PDFs so the visual identity stays
// consistent with the on-screen Badge/TicketTag components.
function drawAvatar(doc, { x, y, size, photo, name, role, radius = 8 }) {
  const r = roleColour(role);
  doc.save();
  doc.roundedRect(x, y, size, size, radius).clip();
  const buf = photoBuffer(photo);
  if (buf) {
    try {
      doc.image(buf, x, y, { width: size, height: size, fit: [size, size], align: 'center', valign: 'center' });
    } catch {
      // Bad image — fall through to initials.
      paintDiagonalGradient(doc, x, y, size, size, r.from, r.to);
      doc.fillColor('#FFFFFF')
         .font('Helvetica-Bold').fontSize(size * 0.42)
         .text(initialsFrom(name), x, y + size * 0.28, { width: size, align: 'center' });
    }
  } else {
    paintDiagonalGradient(doc, x, y, size, size, r.from, r.to);
    doc.fillColor('#FFFFFF')
       .font('Helvetica-Bold').fontSize(size * 0.42)
       .text(initialsFrom(name), x, y + size * 0.28, { width: size, align: 'center' });
  }
  doc.restore();
}

// Resolve a pdfkit doc's accumulated bytes into a single Buffer when 'end' fires.
function bufferizeDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge — CR80 (3.4" × 2.13") single-card PDF
// ─────────────────────────────────────────────────────────────────────────────
async function buildBadgePdf(p) {
  // 1 inch = 72 pts in pdfkit's default unit space.
  const W = 3.4 * 72;
  const H = 2.13 * 72;
  const doc = new PDFDocument({ size: [W, H], margin: 0 });
  const out = bufferizeDoc(doc);

  const role = roleColour(p.role);
  const code = p.ticketCode || p.code || '';

  // White card surface + 1pt outline (so the printed boundary is visible
  // before scissors).
  doc.rect(0, 0, W, H).fill('#FFFFFF');
  doc.lineWidth(0.5).strokeColor('#D4D4D8').rect(0.5, 0.5, W - 1, H - 1).stroke();

  // Top role band — gradient + role label + (optional) event title.
  const bandH = 22;
  paintHorizontalGradient(doc, 0, 0, W, bandH, role.from, role.to);
  doc.fillColor('#FFFFFF')
     .font('Helvetica-Bold').fontSize(8)
     .text(role.label.toUpperCase(), 10, 7, { lineBreak: false, characterSpacing: 1.5 });
  if (p.eventTitle) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF')
       .text(String(p.eventTitle).toUpperCase(), W / 2, 8, {
         width: W / 2 - 12, align: 'right', lineBreak: false, characterSpacing: 1.2,
       });
  }

  // Body: avatar + name + chips.
  const avatarSize = 48;
  const avatarX = 10;
  const avatarY = bandH + 8;
  drawAvatar(doc, {
    x: avatarX, y: avatarY, size: avatarSize,
    photo: p.attendeePhoto, name: p.attendeeName, role: p.role,
    radius: 8,
  });

  const textX = avatarX + avatarSize + 10;
  const textW = W - textX - 10;

  doc.fillColor('#A1A1AA').font('Helvetica-Bold').fontSize(6.5)
     .text(String(p.eventTitle || '').toUpperCase(), textX, avatarY + 2, {
       width: textW, lineBreak: false, ellipsis: true, characterSpacing: 1.2,
     });
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(12)
     .text(p.attendeeName || 'Attendee', textX, avatarY + 13, {
       width: textW, lineBreak: false, ellipsis: true,
     });

  // Detail line (ticket type · seat · room).
  const detailParts = [
    p.ticketTypeName ? String(p.ticketTypeName) : null,
    p.seatLabel ? `Seat ${p.seatLabel}` : null,
    p.roomLabel ? String(p.roomLabel).replace(/^.+ · /, '') : null,
  ].filter(Boolean);
  if (detailParts.length) {
    doc.fillColor('#52525B').font('Helvetica').fontSize(7.5)
       .text(detailParts.join('  ·  '), textX, avatarY + 30, {
         width: textW, lineBreak: false, ellipsis: true,
       });
  }

  // Footer: code on the left, QR on the right.
  const qrSize = 44;
  const qrX = W - qrSize - 8;
  const qrY = H - qrSize - 6;
  try {
    const qr = await qrPngBuffer(checkInUrl(code), 200);
    doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });
  } catch {
    // Skip QR silently rather than crashing — code is still printed below.
  }
  doc.fillColor('#71717A').font('Courier-Bold').fontSize(8)
     .text(code, 10, H - 14, { lineBreak: false });

  doc.end();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket — Letter-page PDF with the full attendee ticket
// ─────────────────────────────────────────────────────────────────────────────
async function buildTicketPdf(p) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
  const out = bufferizeDoc(doc);

  const role     = roleColour(p.role);
  const code     = p.ticketCode || p.code || '';
  const W        = doc.page.width;
  const margin   = 36;
  const innerW   = W - margin * 2;

  // ── Header band — gradient with event title + role chip ──
  const headerY = margin;
  const headerH = 110;
  paintDiagonalGradient(doc, margin, headerY, innerW, headerH, role.from, role.to);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9)
     .text('ADMISSION TICKET', margin + 18, headerY + 16, { characterSpacing: 2, lineBreak: false });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22)
     .text(p.eventTitle || 'Event', margin + 18, headerY + 32, {
       width: innerW - 130, ellipsis: true, lineBreak: false,
     });
  const whenLine = fmtWhen(p.eventStartsAt);
  const subParts = [whenLine, p.eventLocation].filter(Boolean).join('   ·   ');
  if (subParts) {
    doc.fillColor('#FFFFFF').font('Helvetica').fontSize(10)
       .text(subParts, margin + 18, headerY + 68, {
         width: innerW - 130, ellipsis: true, lineBreak: false,
       });
  }
  // Role chip (top-right) — pill shape.
  const chipText = role.label.toUpperCase();
  doc.font('Helvetica-Bold').fontSize(8);
  const chipTextW = doc.widthOfString(chipText);
  const chipW = chipTextW + 18;
  const chipH = 18;
  const chipX = margin + innerW - chipW - 18;
  const chipY = headerY + 18;
  doc.save();
  doc.roundedRect(chipX, chipY, chipW, chipH, chipH / 2)
     .fillOpacity(0.22).fill('#FFFFFF');
  doc.restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8)
     .text(chipText, chipX, chipY + 5, { width: chipW, align: 'center', characterSpacing: 1.2, lineBreak: false });

  // ── Body: QR (left) + details table (right) ──
  const bodyY = headerY + headerH + 24;
  const qrSize = 170;
  try {
    const qr = await qrPngBuffer(checkInUrl(code), 600);
    doc.image(qr, margin, bodyY, { width: qrSize, height: qrSize });
  } catch {
    doc.lineWidth(1).strokeColor('#E5E7EB')
       .rect(margin, bodyY, qrSize, qrSize).stroke();
  }
  doc.fillColor('#71717A').font('Helvetica-Bold').fontSize(8)
     .text('SCAN AT CHECK-IN', margin, bodyY + qrSize + 8, {
       width: qrSize, align: 'center', characterSpacing: 1.4, lineBreak: false,
     });
  doc.fillColor('#0F172A').font('Courier-Bold').fontSize(12)
     .text(code, margin, bodyY + qrSize + 22, {
       width: qrSize, align: 'center', lineBreak: false,
     });

  // Details table — two columns: label / value.
  const detailX = margin + qrSize + 28;
  const detailW = innerW - qrSize - 28;
  const rows = [
    ['Attendee',       p.attendeeName || '—'],
    ['Event',          p.eventTitle   || '—'],
    ['When',           whenLine       || null],
    ['Where',          p.eventLocation|| null],
    ['Ticket',         p.ticketTypeName || null],
    ['Accommodation',  p.accommodationName || null],
    ['Room',           p.roomLabel    || null],
    ['Seat',           p.seatLabel    || null],
    ['Group',          p.groupName    || null],
    ['Code',           code           || null],
  ].filter((r) => r[1] != null && r[1] !== '');

  let cursor = bodyY;
  const labelW = 90;
  const rowGap = 22;
  for (const [label, value] of rows) {
    doc.fillColor('#71717A').font('Helvetica-Bold').fontSize(8)
       .text(label.toUpperCase(), detailX, cursor + 4, {
         width: labelW, characterSpacing: 1.2, lineBreak: false,
       });
    const isCode = label === 'Code';
    doc.fillColor('#0F172A')
       .font(isCode ? 'Courier-Bold' : 'Helvetica-Bold')
       .fontSize(isCode ? 11 : 12)
       .text(String(value), detailX + labelW, cursor, {
         width: detailW - labelW, ellipsis: true, lineBreak: false,
       });
    cursor += rowGap;
    if (cursor > bodyY + qrSize + 80) break; // keep within ticket body
  }

  // ── Footer: dashed tear-off rule + brand line ──
  const footY = doc.page.height - margin - 36;
  doc.save();
  doc.lineWidth(0.8).strokeColor('#A1A1AA').dash(4, { space: 3 })
     .moveTo(margin, footY).lineTo(margin + innerW, footY).stroke();
  doc.restore();
  doc.fillColor('#52525B').font('Helvetica').fontSize(9)
     .text(`Present this QR or read out ${code} at check-in.`, margin, footY + 10, {
       width: innerW * 0.6, lineBreak: false,
     });
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10)
     .text('GOSPELAR', margin, footY + 10, {
       width: innerW, align: 'right', characterSpacing: 2, lineBreak: false,
     });

  doc.end();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filled-form PDF — paper-style A4 of the attendee's registration data
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the "filled form" the attendee can detach from the confirmation
// email — a printable copy of what they submitted, useful at door check-in
// or for offline record-keeping. Reads from p.attendeeProfile (carries the
// full personal/contact/location fields the registration form captures) and
// falls back to top-level ticket fields when individual keys are missing.
async function buildFormPdf(p) {
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  const out = bufferizeDoc(doc);

  const role     = roleColour(p.role);
  const code     = p.ticketCode || p.code || '';
  const profile  = p.attendeeProfile || {};
  const margin   = 42;
  const W        = doc.page.width;
  const innerW   = W - margin * 2;

  // ── Header band ──
  const bandH = 70;
  paintDiagonalGradient(doc, margin, margin, innerW, bandH, role.from, role.to);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9)
     .text('REGISTRATION FORM', margin + 16, margin + 14, {
       characterSpacing: 2, lineBreak: false,
     });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18)
     .text(p.eventTitle || 'Event', margin + 16, margin + 30, {
       width: innerW - 130, ellipsis: true, lineBreak: false,
     });
  doc.fillColor('#FFFFFF').font('Helvetica').fontSize(9)
     .text(`Ticket ${code}`, margin + 16, margin + 52, { lineBreak: false });

  // ── Body: photo (top-left) + sections of label/value pairs ──
  let cursor = margin + bandH + 22;

  // Photo block (if any).
  const photoSize = 80;
  const photoX = margin;
  const photoY = cursor;
  drawAvatar(doc, {
    x: photoX, y: photoY, size: photoSize,
    photo: p.attendeePhoto, name: p.attendeeName, role: p.role, radius: 10,
  });

  // Heading block to the right of the photo.
  const headX = photoX + photoSize + 16;
  const headW = innerW - photoSize - 16;
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(16)
     .text(p.attendeeName || 'Attendee', headX, photoY, {
       width: headW, ellipsis: true, lineBreak: false,
     });
  const heads = [
    [profile.title, profile.sex, profile.maritalStatus].filter(Boolean).join(' · '),
    [profile.assembly, profile.district, profile.region].filter(Boolean).join(' · '),
    [profile.city, profile.country].filter(Boolean).join(', '),
  ].filter(Boolean);
  let headY = photoY + 22;
  for (const line of heads) {
    doc.fillColor('#52525B').font('Helvetica').fontSize(10)
       .text(line, headX, headY, { width: headW, ellipsis: true, lineBreak: false });
    headY += 14;
  }

  cursor = Math.max(photoY + photoSize, headY) + 22;

  // Section renderer — title bar + two-column grid of label/value pairs.
  function section(title, pairs) {
    const visible = pairs.filter((r) => r[1] != null && r[1] !== '');
    if (!visible.length) return;
    // Section title.
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10)
       .text(title.toUpperCase(), margin, cursor, {
         width: innerW, characterSpacing: 1.8, lineBreak: false,
       });
    cursor += 14;
    doc.lineWidth(0.5).strokeColor('#E5E7EB')
       .moveTo(margin, cursor).lineTo(margin + innerW, cursor).stroke();
    cursor += 8;

    // Two-column grid — alternate left/right per pair so the page packs nicely.
    const colW = (innerW - 24) / 2;
    const rowH = 30;
    visible.forEach((pair, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = margin + (col === 0 ? 0 : colW + 24);
      const y = cursor + row * rowH;
      doc.fillColor('#71717A').font('Helvetica-Bold').fontSize(7.5)
         .text(String(pair[0]).toUpperCase(), x, y, {
           width: colW, characterSpacing: 1.2, lineBreak: false,
         });
      doc.fillColor('#0F172A').font('Helvetica').fontSize(11)
         .text(String(pair[1]), x, y + 11, {
           width: colW, ellipsis: true, lineBreak: false,
         });
    });
    const rows = Math.ceil(visible.length / 2);
    cursor += rows * rowH + 10;
  }

  section('Personal', [
    ['Title',          profile.title],
    ['Surname',        profile.lastName || (p.attendeeName || '').split(' ').slice(-1).join(' ')],
    ['Other names',    profile.firstName || (p.attendeeName || '').split(' ').slice(0, -1).join(' ')],
    ['Sex',            profile.sex],
    ['Status',         profile.maritalStatus],
    ['Age bracket',    profile.ageBracket],
  ]);

  section('Contact', [
    ['Phone',          profile.phone || p.attendeePhone],
    ['Email',          profile.email || p.attendeeEmail],
    ['Emergency name', profile.emergencyName],
    ['Emergency phone',profile.emergencyPhone],
  ]);

  section('Location', [
    ['City',           profile.city],
    ['Country',        profile.country],
    ['Region',         profile.region],
    ['District',       profile.district],
    ['Assembly',       profile.assembly],
    ['Convention',     profile.conventionLocation],
  ]);

  section('Event', [
    ['Event',          p.eventTitle],
    ['When',           fmtWhen(p.eventStartsAt)],
    ['Where',          p.eventLocation],
    ['Ticket type',    p.ticketTypeName],
    ['Accommodation',  p.accommodationName],
    ['Room',           p.roomLabel],
    ['Seat',           p.seatLabel],
    ['Group',          p.groupName],
    ['Code',           code],
  ]);

  if (profile.dietary || profile.otherInfo) {
    section('Other', [
      ['Dietary needs',  profile.dietary],
      ['Other info',     profile.otherInfo],
    ]);
  }

  // Footer — declaration line + brand stamp.
  const footY = doc.page.height - margin - 24;
  doc.save();
  doc.lineWidth(0.6).strokeColor('#A1A1AA').dash(4, { space: 3 })
     .moveTo(margin, footY).lineTo(margin + innerW, footY).stroke();
  doc.restore();
  doc.fillColor('#52525B').font('Helvetica').fontSize(8)
     .text(`Submitted via Gospelar · Keep this copy for your records.`, margin, footY + 8, {
       width: innerW * 0.7, lineBreak: false,
     });
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9)
     .text('GOSPELAR', margin, footY + 8, {
       width: innerW, align: 'right', characterSpacing: 2, lineBreak: false,
     });

  doc.end();
  return out;
}

module.exports = { buildBadgePdf, buildTicketPdf, buildFormPdf };
