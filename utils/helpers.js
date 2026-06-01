// utils/helpers.js
// Shared cross-route helpers — mostly small predicates, generators, and
// constants. Anything more than a few lines belongs in its own file.

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const SUBSCRIPTION_DAYS = 300;

// URL-safe random codes for new churches / classes / certificates.
// Avoids 0/O/I/1 to prevent visual confusion on printed material.
const randCode = (len = 8) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

const randToken = () => Array.from({ length: 4 }, () => randCode(8)).join('-');

// CERT-2026-A1B2C3D4 — 8 random chars from a 32-char alphabet ≈ 10^12 ids
// per year. The UNIQUE constraint on certificates.certificate_no is the
// hard guard if a collision ever happens.
function makeCertNo() {
  const year = new Date().getFullYear();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 8; i++) rand += A[Math.floor(Math.random() * A.length)];
  return `CERT-${year}-${rand}`;
}

// Comma-separated subscribed_books column → cleaned array. Defensive because
// admin tooling may edit it.
const parseBooks = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// Append a book id (de-duped) to the existing comma-separated list.
const addBookToList = (raw, bookId) => {
  const set = new Set(parseBooks(raw));
  set.add(String(bookId).toLowerCase());
  return Array.from(set).join(',');
};

// True when a subscribed_books list grants EVERY book — used by the free
// trial, which stores the sentinel 'all' instead of enumerating each SKU so
// books added later are unlocked automatically for the trial's duration.
const booksGrantAll = (raw) => parseBooks(raw).includes('all');

// Does this subscribed_books value grant access to bookId? Honors the 'all'
// wildcard. bookId is lower-cased to match the stored slugs.
const booksIncludeBook = (raw, bookId) => {
  const list = parseBooks(raw);
  return list.includes('all') || list.includes(String(bookId).toLowerCase());
};

// Free-trial length in days. One calendar month, expressed as 30 days so the
// countdown is predictable regardless of which month the user starts in.
const TRIAL_DAYS = 30;

module.exports = {
  isValidEmail,
  addDays,
  SUBSCRIPTION_DAYS,
  TRIAL_DAYS,
  randCode,
  randToken,
  makeCertNo,
  parseBooks,
  addBookToList,
  booksGrantAll,
  booksIncludeBook,
};
