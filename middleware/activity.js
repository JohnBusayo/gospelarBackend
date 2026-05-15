// middleware/activity.js
// Append-only audit log helper used by every churchAuth-gated mutation.
// Errors are swallowed — auditing must never break the operation that
// triggered it.

const db = require('../db');

async function logActivity({
  church_id, branch_id, actor_email, actor_name,
  action, entity_type, entity_id, summary, metadata,
}) {
  if (!church_id || !action || !summary) return;
  try {
    await db.query(
      `INSERT INTO activity_log
         (church_id, branch_id, actor_email, actor_name, action, entity_type, entity_id, summary, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        church_id,
        branch_id || null,
        actor_email || null,
        actor_name || null,
        action,
        entity_type || null,
        entity_id ? String(entity_id) : null,
        summary,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (e) {
    console.error('logActivity:', e.code || '(no code)', e.message);
  }
}

module.exports = { logActivity };
