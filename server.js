// server.js — Gospeler backend entry point.
//
// Owns: app construction, global middleware, DB schema bootstrap, mounting
// each domain router under its own file in routes/, and starting the social
// scheduler. Domain logic lives in routes/* (HTTP) + services/* (third-party
// integrations) + utils/* (shared helpers) + middleware/* (auth, audit).

const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const { initDb } = require('./db/initSchema');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Bootstrap the schema. Errors are logged but never fatal — the server
// keeps booting so transient DB hiccups during deploy don't take it down.
initDb().catch((err) =>
  console.error('initDb failed:',
    err.code || '(no code)',
    err.message || '(no message)',
    '\nstack:', err.stack));

// ── Mount routers ──────────────────────────────────────────────────────────
// Each router declares its own full path prefixes (e.g. '/api/admin/churches')
// so order isn't load-bearing for routing — only for any same-path overlap,
// of which there is none today. Order kept roughly thematic for grep-ability.
app.use(require('./routes/health'));
app.use(require('./routes/churches'));
app.use(require('./routes/churchAdmin'));
app.use(require('./routes/members'));
app.use(require('./routes/learning'));
app.use(require('./routes/reading'));
app.use(require('./routes/content'));
app.use(require('./routes/lessons'));
app.use(require('./routes/insights'));
app.use(require('./routes/profile'));
app.use(require('./routes/auth'));
app.use(require('./routes/payments'));
app.use(require('./routes/quarterInfo'));
app.use(require('./routes/teacher'));
app.use(require('./routes/books'));
app.use(require('./routes/notifications'));
app.use(require('./routes/gospelerIds'));
app.use(require('./routes/membership'));
app.use(require('./routes/events'));
app.use(require('./routes/eventPayments'));

const social = require('./routes/social');
app.use(social);
social.startScheduler();   // once-a-minute due-post worker

const { startScheduler: startNotificationScheduler } = require('./services/notifications');
startNotificationScheduler();   // once-a-minute reminder/announcement worker

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
