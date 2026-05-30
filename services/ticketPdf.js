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
//   buildBadgePdf(payload)   → Portrait 2.5" × 4" lanyard badge, TWO PAGES
//                              (front + back) that mirror the on-screen
//                              /tickets/:code/badge page (frontend's
//                              components/Badge.jsx). Front: photo + name +
//                              role/type + seat pill + contact + small QR.
//                              Back: brand mark + event title + logistics
//                              + big QR + code + host.
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
// Badge — portrait 2.5" × 4" lanyard card. Mirrors components/Badge.jsx
// (the on-screen /tickets/:code/badge page): two pages, front + back, the
// same dimensions and visual layout the printable React badge uses.
// ─────────────────────────────────────────────────────────────────────────────
async function buildBadgePdf(p) {
  // 2.5" × 4" — matches the React Badge dims so the print sheet and the
  // emailed PDF are interchangeable.
  const W = 2.5 * 72;  // 180pt
  const H = 4.0 * 72;  // 288pt
  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false });
  const out = bufferizeDoc(doc);

  const theme = themeFor(p.templateId);
  const role  = roleColour(p.role);
  const code  = p.ticketCode || p.code || '';

  // Pre-render the two QRs once each so we don't block the second page on
  // network or CPU after the first finishes drawing.
  let qrSmall = null, qrLarge = null;
  try { qrSmall = await qrPngBuffer(checkInUrl(code), 200); } catch { /* graceful */ }
  try { qrLarge = await qrPngBuffer(checkInUrl(code), 320); } catch { /* graceful */ }

  doc.addPage({ size: [W, H], margin: 0 });
  renderBadgeFront(doc, p, { W, H, theme, role, qrSmall, code });

  doc.addPage({ size: [W, H], margin: 0 });
  renderBadgeBack(doc,  p, { W, H, theme, role, qrLarge, code });

  doc.end();
  return out;
}

// Shared chrome both sides paint first: theme-gradient body, dark vignette
// at the bottom for legibility, and the lanyard clip + hole at the top.
function paintBadgeChrome(doc, { W, H, theme }) {
  // Card body — vertical gradient theme.primary → theme.secondary.
  paintVerticalGradient(doc, 0, 0, W, H, theme.primary, theme.secondary);

  // Vignette — three thin horizontal slabs near the bottom approximating
  // the React `from-black/0 via-black/15 to-black/55` overlay. pdfkit has
  // no real radial gradient so we layer rects with rising opacity.
  doc.save();
  doc.fillColor('#000000').fillOpacity(0.10);
  doc.rect(0, H * 0.55, W, H * 0.20).fill();
  doc.fillOpacity(0.22);
  doc.rect(0, H * 0.75, W, H * 0.15).fill();
  doc.fillOpacity(0.42);
  doc.rect(0, H * 0.90, W, H * 0.10).fill();
  doc.restore();

  // Lanyard clip — dark notch (10pt wide × 3pt tall) with a white hole.
  const clipW = 28, clipH = 8;
  const clipX = (W - clipW) / 2;
  doc.save();
  doc.fillColor('#0F172A');
  doc.roundedRect(clipX, 0, clipW, clipH, 3).fill();
  // White slot in the middle of the clip — reads as the lanyard hole.
  doc.fillColor('#FFFFFF').fillOpacity(0.85);
  doc.roundedRect(clipX + 6, clipH - 3, clipW - 12, 2, 1).fill();
  doc.restore();
}

// ── FRONT side — photo + name + role + seat + contact + small QR ─────
function renderBadgeFront(doc, p, ctx) {
  const { W, H, role, qrSmall, code } = ctx;
  paintBadgeChrome(doc, ctx);

  const PAD = 14;
  let y = 22; // start below the lanyard clip

  // Event title ribbon at the very top.
  doc.fillColor('#FFFFFF').fillOpacity(0.95).font('Helvetica-Bold').fontSize(7)
     .text(String(p.eventTitle || '').toUpperCase(), PAD, y, {
       width: W - PAD * 2, align: 'center',
       characterSpacing: 1.6, ellipsis: true, lineBreak: false,
     });
  doc.fillOpacity(1);
  y += 16;

  // Photo — 1.5" × 1.5" rounded square with a 3pt white ring.
  const photoSize = 1.5 * 72; // 108pt
  const photoX = (W - photoSize) / 2;
  const photoY = y;
  doc.save();
  doc.fillColor('#FFFFFF').fillOpacity(0.85);
  doc.roundedRect(photoX - 3, photoY - 3, photoSize + 6, photoSize + 6, 14).fill();
  doc.restore();
  drawAvatar(doc, {
    x: photoX, y: photoY, size: photoSize,
    photo: p.attendeePhoto, name: p.attendeeName, role: p.role, radius: 12,
  });
  y = photoY + photoSize + 14;

  // Name — display extrabold, uppercase, centered, two-line cap.
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15)
     .text(String(p.attendeeName || 'Attendee').toUpperCase(), PAD, y, {
       width: W - PAD * 2, align: 'center',
       characterSpacing: 0.6, ellipsis: true, height: 36,
     });
  y += 30;

  // Role / ticket type subtitle.
  const subtitle = p.ticketTypeName || role.label;
  doc.fillColor('#FFFFFF').fillOpacity(0.92).font('Helvetica').fontSize(9)
     .text(subtitle, PAD, y, {
       width: W - PAD * 2, align: 'center',
       ellipsis: true, lineBreak: false,
     });
  doc.fillOpacity(1);
  y += 14;

  // Seat pill — only when assigned. Mirrors the React frosted chip.
  if (p.seatLabel) {
    doc.font('Helvetica-Bold').fontSize(10);
    const labelW = doc.widthOfString(`SEAT  ${p.seatLabel}`) + 20;
    const pillX = (W - labelW) / 2;
    doc.save();
    doc.fillColor('#FFFFFF').fillOpacity(0.18);
    doc.roundedRect(pillX, y, labelW, 18, 9).fill();
    doc.restore();
    doc.fillColor('#FFFFFF').fillOpacity(0.85).font('Helvetica-Bold').fontSize(6.5)
       .text('SEAT', pillX + 9, y + 6, { width: labelW, characterSpacing: 1.4, lineBreak: false });
    doc.fillOpacity(1).font('Helvetica-Bold').fontSize(11)
       .text(p.seatLabel, pillX + 32, y + 4, { lineBreak: false });
    y += 24;
  }

  // Footer block sticks to the bottom — contact lines + code/QR row.
  const FOOTER_BOTTOM = 14;
  const qrSize = 28;
  const footerY = H - FOOTER_BOTTOM - qrSize;

  // Contact lines (phone, email) — centered, above the footer row.
  const contactLines = [p.attendeePhone, p.attendeeEmail].filter(Boolean);
  let cy = footerY - 6 - contactLines.length * 10;
  for (const line of contactLines) {
    doc.fillColor('#FFFFFF').fillOpacity(0.92).font('Helvetica').fontSize(8)
       .text(line, PAD, cy, {
         width: W - PAD * 2, align: 'center', ellipsis: true, lineBreak: false,
       });
    cy += 10;
  }
  doc.fillOpacity(1);

  // Footer row: code (mono, left, opacity 0.8) + small QR (right).
  doc.fillColor('#FFFFFF').fillOpacity(0.80).font('Courier-Bold').fontSize(7)
     .text(code, PAD, footerY + qrSize - 9, {
       width: W - PAD * 2 - qrSize - 8, characterSpacing: 0.8, lineBreak: false,
     });
  doc.fillOpacity(1);
  if (qrSmall) {
    // White rounded backdrop so the QR contrasts the gradient body.
    doc.save();
    doc.fillColor('#FFFFFF');
    doc.roundedRect(W - PAD - qrSize, footerY, qrSize, qrSize, 3).fill();
    doc.restore();
    doc.image(qrSmall, W - PAD - qrSize + 2, footerY + 2, { width: qrSize - 4, height: qrSize - 4 });
  }
}

// ── BACK side — brand mark + event title + logistics + big QR + code ─
function renderBadgeBack(doc, p, ctx) {
  const { W, H, qrLarge, code } = ctx;
  paintBadgeChrome(doc, ctx);

  const PAD = 14;
  let y = 16;

  // Brand row — small "G" square + "Gospelar Events" + "Official badge".
  const markSize = 22;
  doc.save();
  doc.fillColor('#FFFFFF').fillOpacity(0.15);
  doc.roundedRect(PAD, y, markSize, markSize, 5).fill();
  doc.restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
     .text('G', PAD, y + 4, { width: markSize, align: 'center', lineBreak: false });
  doc.fillColor('#FFFFFF').fillOpacity(0.95).font('Helvetica-Bold').fontSize(7.5)
     .text('GOSPELAR EVENTS', PAD + markSize + 6, y + 3, {
       width: W - PAD * 2 - markSize - 6, characterSpacing: 1.6, lineBreak: false,
     });
  doc.fillColor('#FFFFFF').fillOpacity(0.70).font('Helvetica').fontSize(6.5)
     .text('OFFICIAL BADGE', PAD + markSize + 6, y + 14, {
       width: W - PAD * 2 - markSize - 6, characterSpacing: 1.4, lineBreak: false,
     });
  doc.fillOpacity(1);
  y += markSize + 12;

  // Event title — display extrabold 12pt, two-line cap.
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(12)
     .text(p.eventTitle || 'Event', PAD, y, {
       width: W - PAD * 2, ellipsis: true, height: 30,
     });
  y += 32;

  // Logistics block — When / Where / Ticket / Seat label-value rows.
  const rows = [
    ['WHEN',   fmtWhen(p.eventStartsAt)],
    ['WHERE',  p.eventLocation],
    ['TICKET', p.ticketTypeName],
    ['SEAT',   p.seatLabel],
  ].filter(([, v]) => v);

  for (const [label, value] of rows) {
    doc.fillColor('#FFFFFF').fillOpacity(0.65).font('Helvetica-Bold').fontSize(6)
       .text(label, PAD, y + 1, { width: 30, characterSpacing: 1.4, lineBreak: false });
    doc.fillOpacity(0.95).font('Helvetica').fontSize(8.5)
       .text(String(value), PAD + 34, y, {
         width: W - PAD - 34 - PAD, ellipsis: true, lineBreak: false,
       });
    y += 12;
  }
  doc.fillOpacity(1);

  // Big QR + Code/host stack at the bottom — mirrors React Back layout.
  const qrSize = 1.25 * 72; // 90pt
  const qrX = PAD;
  const qrY = H - PAD - qrSize - 4;

  // White rounded backdrop for the big QR.
  doc.save();
  doc.fillColor('#FFFFFF');
  doc.roundedRect(qrX - 4, qrY - 4, qrSize + 8, qrSize + 8, 8).fill();
  doc.restore();
  if (qrLarge) {
    doc.image(qrLarge, qrX, qrY, { width: qrSize, height: qrSize });
  }

  // Code + websiteHost — right of the QR.
  const textX = qrX + qrSize + 12;
  const textW = W - textX - PAD;
  let ty = qrY + 6;
  doc.fillColor('#FFFFFF').fillOpacity(0.70).font('Helvetica-Bold').fontSize(6)
     .text('CODE', textX, ty, { width: textW, characterSpacing: 1.4, lineBreak: false });
  ty += 10;
  doc.fillOpacity(1).font('Courier-Bold').fontSize(9)
     .text(code, textX, ty, { width: textW, characterSpacing: 1.0, ellipsis: true, lineBreak: false });
  ty += 16;
  doc.fillColor('#FFFFFF').fillOpacity(0.80).font('Helvetica').fontSize(7)
     .text('register.gospelar.com', textX, ty, { width: textW, ellipsis: true, lineBreak: false });
  doc.fillOpacity(1);
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

  // ── Page 2 — Event plan ──────────────────────────────────────────────────
  // Rendered only when the event has a schedule or a long-form summary.
  // Mirrors the day/items structure of the schedule JSONB (array of
  // { day, items: string[] }), with the summary surfaced above the schedule
  // when present. Auto-paginates if the schedule overflows a single A4 page.
  const scheduleDays = Array.isArray(p.eventSchedule)
    ? p.eventSchedule
        .map((d) => ({
          day:   String(d?.day || '').trim(),
          items: Array.isArray(d?.items)
            ? d.items.map((it) => String(it || '').trim()).filter(Boolean)
            : [],
        }))
        .filter((d) => d.day || d.items.length)
    : [];
  const hasSummary  = !!(p.eventSummary && String(p.eventSummary).trim());
  const hasPlanPage = scheduleDays.length > 0 || hasSummary;

  if (hasPlanPage) {
    doc.addPage();

    // Header band — same theme as page 1.
    paintDiagonalGradient(doc, margin, margin, innerW, bandH, theme.primary, theme.secondary);
    doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9)
       .text(`${theme.label}  ·  EVENT PLAN`, margin + 18, margin + 14, {
         characterSpacing: 2, lineBreak: false,
       });
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18)
       .text(p.eventTitle || 'Event', margin + 18, margin + 30, {
         width: innerW - 36, ellipsis: true, lineBreak: false,
       });
    if (p.eventTagline) {
      doc.fillColor('#FFFFFF').fillOpacity(0.85).font('Helvetica-Oblique').fontSize(9.5)
         .text(p.eventTagline, margin + 18, margin + 55, {
           width: innerW - 36, ellipsis: true, lineBreak: false,
         });
      doc.fillOpacity(1);
    }

    let cursor2 = margin + bandH + 22;

    // Compact at-a-glance facts row (When / Ends / Where / RSVP by). Skips
    // empties so a free, location-less webinar doesn't render blank cells.
    const factsPairs = [
      ['When',    fmtWhen(p.eventStartsAt)],
      ['Ends',    fmtWhen(p.eventEndsAt)],
      ['Where',   p.eventLocation || ''],
      ['RSVP by', fmtWhen(p.eventRegistrationDeadline)],
    ].filter(([, v]) => v);

    if (factsPairs.length) {
      const cellW = (innerW - 24) / Math.min(factsPairs.length, 4);
      factsPairs.slice(0, 4).forEach(([label, value], i) => {
        const x = margin + i * (cellW + 8);
        doc.fillColor('#71717A').font('Helvetica-Bold').fontSize(7.5)
           .text(label.toUpperCase(), x, cursor2, {
             width: cellW, characterSpacing: 1.2, lineBreak: false,
           });
        doc.fillColor('#0F172A').font('Helvetica').fontSize(10.5)
           .text(value, x, cursor2 + 11, {
             width: cellW, ellipsis: true, lineBreak: false,
           });
      });
      cursor2 += 38;
    }

    // Summary block — long-form description from the event row.
    if (hasSummary) {
      doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10)
         .text('ABOUT THIS EVENT', margin, cursor2, {
           characterSpacing: 1.8, lineBreak: false,
         });
      cursor2 += 14;
      doc.lineWidth(1.4).strokeColor(theme.accent)
         .moveTo(margin, cursor2).lineTo(margin + 40, cursor2).stroke();
      doc.lineWidth(0.5).strokeColor('#E5E7EB')
         .moveTo(margin + 40, cursor2).lineTo(margin + innerW, cursor2).stroke();
      cursor2 += 10;
      const summaryText = String(p.eventSummary).trim();
      doc.fillColor('#27272A').font('Helvetica').fontSize(10.5);
      const summaryHeight = doc.heightOfString(summaryText, { width: innerW, lineGap: 2 });
      doc.text(summaryText, margin, cursor2, { width: innerW, lineGap: 2 });
      cursor2 += summaryHeight + 18;
    }

    // Schedule — one labelled block per day, items as soft bullets. Day
    // blocks paginate independently: if a block would overflow the bottom
    // margin, we addPage() first so a single day never splits mid-block.
    if (scheduleDays.length) {
      doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10)
         .text('SCHEDULE', margin, cursor2, {
           characterSpacing: 1.8, lineBreak: false,
         });
      cursor2 += 14;
      doc.lineWidth(1.4).strokeColor(theme.accent)
         .moveTo(margin, cursor2).lineTo(margin + 40, cursor2).stroke();
      doc.lineWidth(0.5).strokeColor('#E5E7EB')
         .moveTo(margin + 40, cursor2).lineTo(margin + innerW, cursor2).stroke();
      cursor2 += 12;

      const bottomLimit = doc.page.height - margin - 36; // leave room for page-footer line

      // Three-column timetable: TIME | ACTIVITY | DESCRIPTION. Each schedule
      // item is a tab-separated string ("9:00 AM<TAB>Arrival<TAB>Details") or
      // an object { time, activity, description }. Columns wrap independently;
      // the header repeats on every page the table spills onto.
      const padX = 7, padY = 6;
      const colTimeW = Math.round(innerW * 0.21);
      const colActW  = Math.round(innerW * 0.31);
      const colDescW = innerW - colTimeW - colActW;
      const colX = [
        margin,
        margin + colTimeW,
        margin + colTimeW + colActW,
      ];
      const colW = [colTimeW, colActW, colDescW];

      function parseRow(it) {
        if (it && typeof it === 'object') {
          return {
            time:        String(it.time || '').trim(),
            activity:    String(it.activity || '').trim(),
            description: String(it.description || '').trim(),
          };
        }
        const parts = String(it || '').split('\t').map((s) => s.trim());
        // A bare line with no tabs is treated as an activity (no time column),
        // so legacy single-string schedules still read sensibly.
        if (parts.length === 1) return { time: '', activity: parts[0], description: '' };
        return { time: parts[0] || '', activity: parts[1] || '', description: parts.slice(2).join(' — ') };
      }

      function drawHeader(y) {
        const hH = 20;
        doc.save();
        doc.fillColor(theme.primary).rect(margin, y, innerW, hH).fill();
        doc.restore();
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
        ['TIME', 'ACTIVITY', 'DESCRIPTION'].forEach((label, c) => {
          doc.text(label, colX[c] + padX, y + 6.5, {
            width: colW[c] - padX * 2, characterSpacing: 1, lineBreak: false,
          });
        });
        return y + hH;
      }

      // Outer border + the two column dividers for one page's worth of table
      // (between `top` and `bottom`). Called on each page break and at the end
      // so multi-page tables get clean column lines on every page.
      function closeSegment(top, bottom) {
        doc.lineWidth(0.8).strokeColor('#D4D4D8').rect(margin, top, innerW, bottom - top).stroke();
        doc.lineWidth(0.5).strokeColor('#E5E7EB');
        doc.moveTo(colX[1], top).lineTo(colX[1], bottom).stroke();
        doc.moveTo(colX[2], top).lineTo(colX[2], bottom).stroke();
      }

      scheduleDays.forEach((d) => {
        const rows = d.items.map(parseRow).filter((r) => r.time || r.activity || r.description);
        if (!rows.length && !d.day) return;

        // Optional day caption (multi-day events). Break to a new page if the
        // caption + header + first row wouldn't fit.
        if (d.day) {
          doc.font('Helvetica-Bold').fontSize(11);
          const dayH = doc.heightOfString(d.day, { width: innerW });
          if (cursor2 + dayH + 40 > bottomLimit) { doc.addPage(); cursor2 = margin; }
          doc.fillColor('#0F172A').text(d.day, margin, cursor2, { width: innerW, lineBreak: false });
          cursor2 += dayH + 6;
        }

        let tableTop = cursor2;
        cursor2 = drawHeader(cursor2);
        let zebra = false;

        rows.forEach((r) => {
          // Measure the tallest cell to get the row height.
          doc.font('Helvetica-Bold').fontSize(9);
          const hTime = doc.heightOfString(r.time || ' ',     { width: colW[0] - padX * 2 });
          const hAct  = doc.heightOfString(r.activity || ' ', { width: colW[1] - padX * 2 });
          doc.font('Helvetica').fontSize(9);
          const hDesc = doc.heightOfString(r.description || ' ', { width: colW[2] - padX * 2, lineGap: 1 });
          const rowH = Math.max(hTime, hAct, hDesc) + padY * 2;

          // Page break — close the current table border, start fresh with a
          // repeated header on the next page.
          if (cursor2 + rowH > bottomLimit) {
            closeSegment(tableTop, cursor2);
            doc.addPage();
            cursor2 = margin;
            tableTop = cursor2;
            cursor2 = drawHeader(cursor2);
            zebra = false;
          }

          if (zebra) {
            doc.save();
            doc.fillColor('#F4F6FB').rect(margin, cursor2, innerW, rowH).fill();
            doc.restore();
          }
          doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(9)
             .text(r.time, colX[0] + padX, cursor2 + padY, { width: colW[0] - padX * 2 });
          doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9)
             .text(r.activity, colX[1] + padX, cursor2 + padY, { width: colW[1] - padX * 2 });
          doc.fillColor('#3F3F46').font('Helvetica').fontSize(9)
             .text(r.description, colX[2] + padX, cursor2 + padY, { width: colW[2] - padX * 2, lineGap: 1 });

          // Row separator.
          doc.lineWidth(0.5).strokeColor('#E5E7EB')
             .moveTo(margin, cursor2 + rowH).lineTo(margin + innerW, cursor2 + rowH).stroke();
          cursor2 += rowH;
          zebra = !zebra;
        });

        // Outer border + column dividers for the final page segment.
        closeSegment(tableTop, cursor2);
        cursor2 += 16;
      });
    }

    // Page footer — same dashed rule + brand stamp as page 1 for visual
    // consistency. Applies to whichever page is current when we draw it.
    const footY2 = doc.page.height - margin - 24;
    doc.save();
    doc.lineWidth(0.6).strokeColor('#A1A1AA').dash(4, { space: 3 })
       .moveTo(margin, footY2).lineTo(margin + innerW, footY2).stroke();
    doc.restore();
    doc.fillColor('#52525B').font('Helvetica').fontSize(8)
       .text(`Event plan  ·  ${p.eventTitle || ''}`, margin, footY2 + 8, {
         width: innerW * 0.7, lineBreak: false,
       });
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9)
       .text('GOSPELAR', margin, footY2 + 8, {
         width: innerW, align: 'right', characterSpacing: 2, lineBreak: false,
       });
  }

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
