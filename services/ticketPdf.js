// services/ticketPdf.js
// Server-side PDF generation for ticket confirmation emails.
//
// Three products, all theme-coloured by p.templateId (wedding reads
// pink/amber, retreat reads emerald, convention reads slate-navy, etc.):
//
//   buildTicketPdf(payload)  → Landscape Letter ticket. Wide main panel on
//                              the left (eyebrow + tagline + big title +
//                              date/time pills + photo + name + role chip +
//                              price chip + ticket code) and a perforated
//                              stub on the right (event recap + QR +
//                              barcode-style code).
//   buildBadgePdf(payload)   → Portrait CR80-ish (3.5" × 5") lanyard badge
//                              with clip slot at the top, themed banner,
//                              big photo, attendee name, role chip,
//                              contact stack, and a back-face QR panel.
//   buildFormPdf(payload)    → A4 paper-style printable copy of the
//                              attendee's full registration data (kept
//                              from the previous version, retinted to
//                              match the template theme).
//
// Renders with pdfkit (pure JS) + qrcode (local PNG) — no headless
// browser, no outbound HTTP per send.

const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');

// ─────────────────────────────────────────────────────────────────────────────
// Theme + role palettes
// ─────────────────────────────────────────────────────────────────────────────

// Template themes — mirror notifications.js TEMPLATE_THEMES so the PDF
// attachments visually match the email body's ticket + badge surfaces.
const TEMPLATE_THEMES = {
  wedding:                 { primary: '#7C2D5A', secondary: '#DB2777', accent: '#F59E0B', label: 'WEDDING',     tagline: 'You are invited' },
  'baby-dedication':       { primary: '#9A3412', secondary: '#FB7185', accent: '#FBBF24', label: 'DEDICATION',  tagline: 'A joyful celebration' },
  'graduation-ordination': { primary: '#5B21B6', secondary: '#D946EF', accent: '#FBBF24', label: 'GRADUATION',  tagline: 'Commissioning day' },
  'workers-meeting':       { primary: '#065F46', secondary: '#10B981', accent: '#FBBF24', label: 'TRAINING',    tagline: 'Equipping leaders' },
  'children-church':       { primary: '#0369A1', secondary: '#6366F1', accent: '#FBBF24', label: 'CHILDREN',    tagline: 'A special program' },
  'church-retreat':        { primary: '#065F46', secondary: '#0F766E', accent: '#FBBF24', label: 'RETREAT',     tagline: 'Worship & rest' },
  convention:              { primary: '#0F172A', secondary: '#1656c2', accent: '#FBBF24', label: 'CONFERENCE',  tagline: 'Future Forward' },
  'youth-program':         { primary: '#9F1239', secondary: '#F97316', accent: '#FBBF24', label: 'YOUTH',       tagline: 'For the next generation' },
  'mens-fellowship':       { primary: '#064E3B', secondary: '#059669', accent: '#FBBF24', label: 'BROTHERS',    tagline: 'Breakfast & the word' },
  default:                 { primary: '#0b3a8a', secondary: '#1656c2', accent: '#FBBF24', label: 'TICKET',      tagline: 'You are invited' },
};
function themeFor(templateId) {
  return TEMPLATE_THEMES[templateId] || TEMPLATE_THEMES.default;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────────────────────

function initialsFrom(name) {
  return String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => (w[0] || '').toUpperCase()).join('') || '?';
}

function checkInUrl(code) {
  const origin = (process.env.PUBLIC_APP_URL || 'https://gospelar.app').replace(/\/$/, '');
  return `${origin}/check-in?code=${encodeURIComponent(code || '')}`;
}

async function qrPngBuffer(text, size = 320) {
  return QRCode.toBuffer(text, {
    errorCorrectionLevel: 'M',
    type:   'png',
    margin: 1,
    width:  size,
  });
}

function photoBuffer(photo) {
  if (!photo) return null;
  try {
    const raw = String(photo).startsWith('data:')
      ? String(photo).split(',', 2)[1] || ''
      : String(photo);
    if (!raw) return null;
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < 100) return null;
    return buf;
  } catch {
    return null;
  }
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}
function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
}
function fmtWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-NG', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
function fmtMoney(cents) {
  if (!cents || cents <= 0) return null;
  return `₦${(cents / 100).toLocaleString()}`;
}

// pdfkit doesn't ship a gradient primitive directly, but linearGradient is
// supported. These are thin wrappers so call sites read cleanly.
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
function paintVerticalGradient(doc, x, y, w, h, from, to) {
  const grad = doc.linearGradient(x, y, x, y + h);
  grad.stop(0, from).stop(1, to);
  doc.rect(x, y, w, h).fill(grad);
}

// Photo / avatar block — square with rounded corners. Photo if present,
// otherwise gradient + initials.
function drawAvatar(doc, { x, y, size, photo, name, role, radius = 8 }) {
  const r = roleColour(role);
  doc.save();
  doc.roundedRect(x, y, size, size, radius).clip();
  const buf = photoBuffer(photo);
  if (buf) {
    try {
      doc.image(buf, x, y, { width: size, height: size, fit: [size, size], align: 'center', valign: 'center' });
    } catch {
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

// Fake barcode (vertical lines of varying widths derived from the code's
// chars). Not a real Code128 — but it visually reads as a barcode on the
// stub like the reference image.
function drawFakeBarcode(doc, { x, y, w, h, code }) {
  const seed = String(code || 'GOSPELAR');
  // Build a deterministic sequence of widths from the code's chars.
  let cursor = x;
  let i = 0;
  while (cursor < x + w - 1) {
    const ch = seed.charCodeAt(i % seed.length);
    const isBar = (ch + i) % 2 === 0;
    const widths = [0.8, 1.2, 1.6, 2.4];
    const stripeW = widths[(ch + i) % widths.length];
    if (isBar) {
      doc.rect(cursor, y, stripeW, h).fill('#0F172A');
    }
    cursor += stripeW + 0.6;
    i += 1;
  }
}

function bufferizeDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket — Landscape Letter, main panel + perforated stub
// ─────────────────────────────────────────────────────────────────────────────
async function buildTicketPdf(p) {
  // Landscape so we can lay out main panel + stub side-by-side at a
  // print-friendly size (11" × 8.5"). margin: 0 because the ticket art
  // bleeds to the page edge inside the surrounding rounded card.
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0 });
  const out = bufferizeDoc(doc);

  const theme  = themeFor(p.templateId);
  const role   = roleColour(p.role);
  const code   = p.ticketCode || p.code || '';
  const W      = doc.page.width;
  const H      = doc.page.height;

  // Outer page bg — soft cream so the white card shadow reads.
  doc.rect(0, 0, W, H).fill('#F4F4F1');

  // Card geometry — centered, ~85% of page width, with rounded clip.
  const cardW = Math.min(820, W - 64);
  const cardH = Math.min(360, H - 100);
  const cardX = (W - cardW) / 2;
  const cardY = (H - cardH) / 2;

  // Card shadow (poor-man's: a slightly larger, darker rounded rect behind).
  doc.save();
  doc.fillColor('#0F172A').fillOpacity(0.10);
  doc.roundedRect(cardX + 4, cardY + 10, cardW, cardH, 22).fill();
  doc.restore();

  // Stub is the right ~28% of the card.
  const stubW = Math.round(cardW * 0.28);
  const mainW = cardW - stubW;

  // ── MAIN PANEL — theme gradient bg ──
  doc.save();
  doc.roundedRect(cardX, cardY, cardW, cardH, 22).clip();
  paintDiagonalGradient(doc, cardX, cardY, mainW, cardH, theme.primary, theme.secondary);

  // Soft top-left glow circle for richness (matches the email's glassy feel).
  doc.save();
  doc.fillColor('#FFFFFF').fillOpacity(0.10);
  doc.circle(cardX + 60, cardY + 60, 130).fill();
  doc.restore();
  doc.save();
  doc.fillColor('#000000').fillOpacity(0.10);
  doc.circle(cardX + mainW - 80, cardY + cardH - 60, 110).fill();
  doc.restore();

  // Eyebrow — TEMPLATE LABEL · ADMIT ONE
  const padX = 28;
  let cursorY = cardY + 26;
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9)
     .text(`${theme.label}  ·  ADMIT ONE`, cardX + padX, cursorY, {
       characterSpacing: 2.4, lineBreak: false,
     });

  // Script tagline — Helvetica-Oblique stands in for a calligraphic face.
  cursorY += 14;
  doc.fillColor('#FFFFFF').font('Helvetica-Oblique').fontSize(13)
     .text(theme.tagline, cardX + padX, cursorY, { lineBreak: false });

  // Event title — large, two-line cap.
  cursorY += 22;
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(28)
     .text(p.eventTitle || 'Event', cardX + padX, cursorY, {
       width: mainW - padX * 2 - 110, ellipsis: true,
     });

  // Date / time pills — translucent white capsules.
  const pillRowY = cardY + 138;
  const pillH    = 21;
  let pillX = cardX + padX;
  const dateText = fmtDate(p.eventStartsAt);
  const timeText = fmtTime(p.eventStartsAt);
  const renderPill = (label) => {
    doc.font('Helvetica-Bold').fontSize(9);
    const w = doc.widthOfString(label) + 24;
    doc.save();
    doc.fillColor('#FFFFFF').fillOpacity(0.18);
    doc.roundedRect(pillX, pillRowY, w, pillH, pillH / 2).fill();
    doc.restore();
    doc.fillColor('#FFFFFF').fillOpacity(1).font('Helvetica-Bold').fontSize(9)
       .text(label, pillX + 12, pillRowY + 6.5, { width: w - 16, lineBreak: false });
    pillX += w + 8;
  };
  if (dateText) renderPill(dateText);
  if (timeText) renderPill(timeText);
  if (p.eventLocation) {
    doc.font('Helvetica').fontSize(10).fillColor('#FFFFFF').fillOpacity(0.85)
       .text(String(p.eventLocation), pillX + 4, pillRowY + 5, {
         width: cardX + mainW - padX - pillX - 8, ellipsis: true, lineBreak: false,
       });
    doc.fillOpacity(1);
  }

  // Bottom row inside main: photo + name + role chip on the left, price chip on the right.
  const bottomRowY = cardY + cardH - 102;
  const photoSize = 78;
  drawAvatar(doc, {
    x: cardX + padX, y: bottomRowY,
    size: photoSize,
    photo: p.attendeePhoto, name: p.attendeeName, role: p.role, radius: 14,
  });

  const nameX = cardX + padX + photoSize + 14;
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8)
     .text('ATTENDEE', nameX, bottomRowY + 4, { characterSpacing: 1.8, lineBreak: false });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18)
     .text(p.attendeeName || 'Attendee', nameX, bottomRowY + 16, {
       width: mainW - (nameX - cardX) - padX - 80, ellipsis: true, lineBreak: false,
     });

  // Role chip + ticket-type line directly under the name.
  doc.font('Helvetica-Bold').fontSize(8);
  const roleLabel = role.label.toUpperCase();
  const roleW = doc.widthOfString(roleLabel) + 20;
  doc.save();
  doc.fillColor('#FFFFFF').fillOpacity(0.22);
  doc.roundedRect(nameX, bottomRowY + 42, roleW, 17, 9).fill();
  doc.restore();
  doc.fillColor('#FFFFFF').fillOpacity(1).font('Helvetica-Bold').fontSize(8)
     .text(roleLabel, nameX, bottomRowY + 47, { width: roleW, align: 'center', characterSpacing: 1.4, lineBreak: false });

  const subBits = [p.ticketTypeName, p.seatLabel ? `Seat ${p.seatLabel}` : null].filter(Boolean).join('  ·  ');
  if (subBits) {
    doc.fillColor('#FFFFFF').fillOpacity(0.9).font('Helvetica').fontSize(10)
       .text(subBits, nameX + roleW + 10, bottomRowY + 46, {
         width: mainW - (nameX + roleW + 10 - cardX) - padX - 80, ellipsis: true, lineBreak: false,
       });
    doc.fillOpacity(1);
  }

  // Price chip — bottom-right of the main panel.
  const priceLabel = fmtMoney(p.priceCents);
  if (priceLabel) {
    doc.font('Helvetica-Bold').fontSize(11);
    const pw = doc.widthOfString(priceLabel) + 24;
    const ph = 28;
    const px = cardX + mainW - padX - pw;
    const py = bottomRowY + 32;
    doc.save();
    doc.fillColor(theme.accent);
    doc.roundedRect(px, py, pw, ph, ph / 2).fill();
    doc.restore();
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(11)
       .text(priceLabel, px, py + 9, { width: pw, align: 'center', lineBreak: false });
  }

  // Ticket code printed faintly at the very bottom of the main panel.
  doc.fillColor('#FFFFFF').fillOpacity(0.7).font('Courier-Bold').fontSize(10)
     .text(`CODE  ${code}`, cardX + padX, cardY + cardH - 22, {
       characterSpacing: 1.4, lineBreak: false,
     });
  doc.fillOpacity(1);

  doc.restore(); // end main-panel clip

  // ── PERFORATION — vertical dashed line between main and stub ──
  doc.save();
  doc.strokeColor('#FFFFFF').lineWidth(1.2).dash(5, { space: 4 });
  doc.moveTo(cardX + mainW, cardY + 12)
     .lineTo(cardX + mainW, cardY + cardH - 12).stroke();
  doc.undash();
  doc.restore();

  // Two small white circles at the perforation top/bottom — "ticket eyes"
  // that sit on the perforation line.
  doc.save();
  doc.fillColor('#F4F4F1');
  doc.circle(cardX + mainW, cardY, 8).fill();
  doc.circle(cardX + mainW, cardY + cardH, 8).fill();
  doc.restore();

  // ── STUB — solid theme primary, recap + QR + barcode ──
  doc.save();
  doc.roundedRect(cardX, cardY, cardW, cardH, 22).clip();
  // Stub bg — slightly lighter than primary for visual separation.
  paintVerticalGradient(doc, cardX + mainW, cardY, stubW, cardH,
    shade(theme.primary, -8), shade(theme.primary, 8));

  const sPad = 18;
  const sX = cardX + mainW + sPad;
  const sW = stubW - sPad * 2;

  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(8)
     .text('TICKET STUB', sX, cardY + 26, { characterSpacing: 2, lineBreak: false });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
     .text(p.eventTitle || 'Event', sX, cardY + 40, {
       width: sW, ellipsis: true, height: 30,
     });

  // Tiny recap rows.
  let sCursor = cardY + 78;
  const recap = [
    ['DATE',  dateText],
    ['TIME',  timeText],
    ['SEAT',  p.seatLabel ? String(p.seatLabel) : null],
    ['TICKET', p.ticketTypeName],
  ].filter((r) => r[1]);
  for (const [k, v] of recap) {
    doc.fillColor('#FFFFFF').fillOpacity(0.55).font('Helvetica-Bold').fontSize(7)
       .text(k, sX, sCursor, { characterSpacing: 1.3, lineBreak: false });
    doc.fillColor('#FFFFFF').fillOpacity(1).font('Helvetica-Bold').fontSize(10)
       .text(String(v), sX, sCursor + 9, { width: sW, ellipsis: true, lineBreak: false });
    sCursor += 26;
  }

  // QR on the stub — bottom-centered on a white plate so it scans cleanly.
  const qrSize = 86;
  const qrX = cardX + mainW + (stubW - qrSize) / 2;
  const qrY = cardY + cardH - qrSize - 56;
  doc.save();
  doc.fillColor('#FFFFFF');
  doc.roundedRect(qrX - 6, qrY - 6, qrSize + 12, qrSize + 12, 8).fill();
  doc.restore();
  try {
    const qr = await qrPngBuffer(checkInUrl(code), 320);
    doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });
  } catch {
    // Skip silently.
  }

  // Barcode strip + code under QR.
  const barY = cardY + cardH - 40;
  doc.save();
  doc.fillColor('#FFFFFF');
  doc.rect(cardX + mainW + sPad, barY - 4, sW, 22).fill();
  doc.restore();
  drawFakeBarcode(doc, { x: cardX + mainW + sPad + 4, y: barY, w: sW - 8, h: 14, code });
  doc.fillColor('#FFFFFF').font('Courier-Bold').fontSize(8)
     .text(code, cardX + mainW + sPad, barY + 22, {
       width: sW, align: 'center', characterSpacing: 1.2, lineBreak: false,
     });

  doc.restore(); // end stub clip

  // ── Footer line under the card — brand stamp + scan hint ──
  const footY = cardY + cardH + 18;
  doc.fillColor('#52525B').font('Helvetica').fontSize(9)
     .text(`Present this QR or read out ${code} at check-in.`, cardX, footY, {
       width: cardW * 0.7, lineBreak: false,
     });
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10)
     .text('GOSPELAR', cardX, footY, {
       width: cardW, align: 'right', characterSpacing: 2, lineBreak: false,
     });

  doc.end();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge — portrait lanyard card (3.5" × 5") with clip slot + back-face QR
// ─────────────────────────────────────────────────────────────────────────────
async function buildBadgePdf(p) {
  // Slightly larger than a CR80 so it reads at conference distance and
  // there is room for the lanyard clip cutout at the top.
  const W = 3.5  * 72;  // 252pt
  const H = 5.0  * 72;  // 360pt
  const doc = new PDFDocument({ size: [W, H], margin: 0 });
  const out = bufferizeDoc(doc);

  const theme = themeFor(p.templateId);
  const role  = roleColour(p.role);
  const code  = p.ticketCode || p.code || '';

  // Background — soft neutral with a subtle inner card.
  doc.rect(0, 0, W, H).fill('#F4F4F1');

  // ── Card ──
  const cardX = 12;
  const cardY = 14;
  const cardW = W - cardX * 2;
  const cardH = H - cardY * 2;

  // Shadow.
  doc.save();
  doc.fillColor('#0F172A').fillOpacity(0.10);
  doc.roundedRect(cardX + 2, cardY + 6, cardW, cardH, 16).fill();
  doc.restore();

  // Card surface.
  doc.save();
  doc.roundedRect(cardX, cardY, cardW, cardH, 16).clip();
  doc.rect(cardX, cardY, cardW, cardH).fill('#FFFFFF');

  // ── Header band — theme gradient ──
  const bandH = 110;
  paintDiagonalGradient(doc, cardX, cardY, cardW, bandH, theme.primary, theme.secondary);

  // Lanyard clip slot (rounded rect cutout) — pure decoration but reads as
  // "this is a badge".
  doc.save();
  doc.fillColor('#F4F4F1');
  doc.roundedRect(cardX + cardW / 2 - 18, cardY + 8, 36, 7, 3.5).fill();
  doc.restore();

  // Eyebrow row inside the band.
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(7.5)
     .text(theme.label, cardX + 14, cardY + 24, { characterSpacing: 2.2, lineBreak: false });
  // Event title — short, two-line cap.
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11)
     .text(p.eventTitle || 'Event', cardX + 14, cardY + 36, {
       width: cardW - 28, ellipsis: true, height: 30,
     });
  // Sub line — date.
  const dateText = fmtDate(p.eventStartsAt);
  if (dateText) {
    doc.fillColor('#FFFFFF').fillOpacity(0.85).font('Helvetica').fontSize(8)
       .text(dateText, cardX + 14, cardY + 70, { lineBreak: false });
    doc.fillOpacity(1);
  }

  // ── Photo — sits half on band, half on white body ──
  const photoSize = 110;
  const photoX = cardX + (cardW - photoSize) / 2;
  const photoY = cardY + bandH - photoSize / 2;
  // White ring around photo.
  doc.save();
  doc.fillColor('#FFFFFF');
  doc.circle(photoX + photoSize / 2, photoY + photoSize / 2, photoSize / 2 + 4).fill();
  doc.restore();
  // Photo (round-clipped).
  doc.save();
  doc.circle(photoX + photoSize / 2, photoY + photoSize / 2, photoSize / 2).clip();
  const buf = photoBuffer(p.attendeePhoto);
  if (buf) {
    try {
      doc.image(buf, photoX, photoY, { width: photoSize, height: photoSize, fit: [photoSize, photoSize], align: 'center', valign: 'center' });
    } catch {
      paintDiagonalGradient(doc, photoX, photoY, photoSize, photoSize, role.from, role.to);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(40)
         .text(initialsFrom(p.attendeeName), photoX, photoY + 30, { width: photoSize, align: 'center' });
    }
  } else {
    paintDiagonalGradient(doc, photoX, photoY, photoSize, photoSize, role.from, role.to);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(40)
       .text(initialsFrom(p.attendeeName), photoX, photoY + 30, { width: photoSize, align: 'center' });
  }
  doc.restore();

  // ── Name + role chip ──
  let bodyY = photoY + photoSize + 14;
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(16)
     .text(p.attendeeName || 'Attendee', cardX + 12, bodyY, {
       width: cardW - 24, align: 'center', ellipsis: true, lineBreak: false,
     });
  bodyY += 22;

  // Role chip — centered, theme-coloured.
  doc.font('Helvetica-Bold').fontSize(8);
  const roleLabel = role.label.toUpperCase();
  const rW = doc.widthOfString(roleLabel) + 22;
  const rX = cardX + (cardW - rW) / 2;
  doc.save();
  doc.fillColor(role.from);
  doc.roundedRect(rX, bodyY, rW, 18, 9).fill();
  doc.restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8)
     .text(roleLabel, rX, bodyY + 5.5, { width: rW, align: 'center', characterSpacing: 1.4, lineBreak: false });
  bodyY += 28;

  // Contact / sub-info stack — phone, ticket type, seat.
  const subItems = [
    p.attendeePhone ? p.attendeePhone : null,
    p.ticketTypeName ? p.ticketTypeName : null,
    p.seatLabel ? `Seat ${p.seatLabel}` : null,
    p.roomLabel ? String(p.roomLabel).replace(/^.+ · /, '') : null,
  ].filter(Boolean);
  for (const line of subItems) {
    doc.fillColor('#52525B').font('Helvetica').fontSize(9)
       .text(line, cardX + 12, bodyY, {
         width: cardW - 24, align: 'center', ellipsis: true, lineBreak: false,
       });
    bodyY += 13;
  }

  // ── Back-face panel — separated by dashed rule, holds the QR ──
  bodyY += 6;
  doc.save();
  doc.strokeColor('#D4D4D8').lineWidth(0.6).dash(3, { space: 3 });
  doc.moveTo(cardX + 18, bodyY).lineTo(cardX + cardW - 18, bodyY).stroke();
  doc.undash();
  doc.restore();
  bodyY += 8;

  // QR + code.
  const qrSize = 70;
  const qrX = cardX + (cardW - qrSize) / 2;
  try {
    const qr = await qrPngBuffer(checkInUrl(code), 320);
    doc.image(qr, qrX, bodyY, { width: qrSize, height: qrSize });
  } catch {
    doc.lineWidth(1).strokeColor('#E5E7EB').rect(qrX, bodyY, qrSize, qrSize).stroke();
  }
  bodyY += qrSize + 4;
  doc.fillColor('#71717A').font('Helvetica-Bold').fontSize(7)
     .text('SCAN AT CHECK-IN', cardX, bodyY, {
       width: cardW, align: 'center', characterSpacing: 1.5, lineBreak: false,
     });
  bodyY += 10;
  doc.fillColor('#0F172A').font('Courier-Bold').fontSize(9)
     .text(code, cardX, bodyY, { width: cardW, align: 'center', lineBreak: false });

  // Brand footer.
  doc.fillColor('#A1A1AA').font('Helvetica-Bold').fontSize(7)
     .text('GOSPELAR', cardX, cardY + cardH - 14, {
       width: cardW, align: 'center', characterSpacing: 2, lineBreak: false,
     });

  doc.restore(); // end card clip
  doc.end();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filled-form PDF — A4 printable copy of the attendee's registration data
// ─────────────────────────────────────────────────────────────────────────────
async function buildFormPdf(p) {
  const doc = new PDFDocument({ size: 'A4', margin: 42 });
  const out = bufferizeDoc(doc);

  const theme    = themeFor(p.templateId);
  const code     = p.ticketCode || p.code || '';
  const profile  = p.attendeeProfile || {};
  const margin   = 42;
  const W        = doc.page.width;
  const innerW   = W - margin * 2;

  // ── Header band — theme gradient ──
  const bandH = 78;
  paintDiagonalGradient(doc, margin, margin, innerW, bandH, theme.primary, theme.secondary);
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9)
     .text(`${theme.label}  ·  REGISTRATION FORM`, margin + 18, margin + 14, {
       characterSpacing: 2, lineBreak: false,
     });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18)
     .text(p.eventTitle || 'Event', margin + 18, margin + 30, {
       width: innerW - 150, ellipsis: true, lineBreak: false,
     });
  doc.fillColor('#FFFFFF').fillOpacity(0.85).font('Helvetica').fontSize(9)
     .text(`Ticket ${code}`, margin + 18, margin + 55, { lineBreak: false });
  doc.fillOpacity(1);

  // Role chip top-right.
  const role = roleColour(p.role);
  const rl   = role.label.toUpperCase();
  doc.font('Helvetica-Bold').fontSize(8);
  const rlW  = doc.widthOfString(rl) + 20;
  doc.save();
  doc.fillColor('#FFFFFF').fillOpacity(0.22);
  doc.roundedRect(margin + innerW - rlW - 18, margin + 18, rlW, 18, 9).fill();
  doc.restore();
  doc.fillColor('#FFFFFF').fillOpacity(1).font('Helvetica-Bold').fontSize(8)
     .text(rl, margin + innerW - rlW - 18, margin + 23, {
       width: rlW, align: 'center', characterSpacing: 1.4, lineBreak: false,
     });

  // ── Body: photo + heading block ──
  let cursor = margin + bandH + 22;

  const photoSize = 80;
  const photoX = margin;
  const photoY = cursor;
  drawAvatar(doc, {
    x: photoX, y: photoY, size: photoSize,
    photo: p.attendeePhoto, name: p.attendeeName, role: p.role, radius: 12,
  });

  const headX = photoX + photoSize + 18;
  const headW = innerW - photoSize - 18;
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(17)
     .text(p.attendeeName || 'Attendee', headX, photoY, {
       width: headW, ellipsis: true, lineBreak: false,
     });
  const heads = [
    [profile.title, profile.sex, profile.maritalStatus].filter(Boolean).join('  ·  '),
    [profile.assembly, profile.district, profile.region].filter(Boolean).join('  ·  '),
    [profile.city, profile.country].filter(Boolean).join(', '),
  ].filter(Boolean);
  let headY = photoY + 23;
  for (const line of heads) {
    doc.fillColor('#52525B').font('Helvetica').fontSize(10)
       .text(line, headX, headY, { width: headW, ellipsis: true, lineBreak: false });
    headY += 14;
  }

  cursor = Math.max(photoY + photoSize, headY) + 22;

  // Section renderer — title bar (themed accent rule) + two-column grid.
  function section(title, pairs) {
    const visible = pairs.filter((r) => r[1] != null && r[1] !== '');
    if (!visible.length) return;
    doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10)
       .text(title.toUpperCase(), margin, cursor, {
         width: innerW, characterSpacing: 1.8, lineBreak: false,
       });
    cursor += 14;
    // Two-tone rule: thin colored under-bar + faint extension.
    doc.lineWidth(1.4).strokeColor(theme.accent)
       .moveTo(margin, cursor).lineTo(margin + 40, cursor).stroke();
    doc.lineWidth(0.5).strokeColor('#E5E7EB')
       .moveTo(margin + 40, cursor).lineTo(margin + innerW, cursor).stroke();
    cursor += 10;

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
     .text(`Submitted via Gospelar  ·  Keep this copy for your records.`, margin, footY + 8, {
       width: innerW * 0.7, lineBreak: false,
     });
  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9)
     .text('GOSPELAR', margin, footY + 8, {
       width: innerW, align: 'right', characterSpacing: 2, lineBreak: false,
     });

  doc.end();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny colour helper — shifts a hex toward black (-) or white (+) by `pct`.
// Used so the stub can sit a few % lighter / darker than the main panel
// without an extra colour in the theme map.
// ─────────────────────────────────────────────────────────────────────────────
function shade(hex, pct) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const f = pct / 100;
  const adj = (c) => {
    const t = f < 0 ? 0 : 255;
    const p = Math.abs(f);
    return Math.round((t - c) * p + c);
  };
  const to2 = (n) => n.toString(16).padStart(2, '0');
  return `#${to2(adj(r))}${to2(adj(g))}${to2(adj(b))}`;
}

module.exports = { buildBadgePdf, buildTicketPdf, buildFormPdf };
