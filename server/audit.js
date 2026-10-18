const pool = require('./db');

async function writeAuditEvent(executor, {
    actorId = null,
    actorRole = null,
    action,
    targetId = null,
    entityType = null,
    entityId = targetId,
    outcome = 'success',
    requestId = null,
    operationId = null,
    details = null,
    failureCategory = null,
}) {
    const detailsText = details === null
        ? null
        : typeof details === 'string'
            ? details
            : JSON.stringify(details);
    await executor.execute(
        `INSERT INTO security_audit_log
         (actor_id, actor_role, action, target_id, entity_type, entity_id, outcome,
          request_id, operation_id, details, failure_category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [
            actorId,
            actorRole,
            action,
            targetId,
            entityType,
            entityId,
            outcome,
            requestId,
            operationId,
            detailsText,
            failureCategory,
        ],
    );
}

async function recordAudit(event) {
    try {
        await writeAuditEvent(pool, event);
    } catch (error) {
        console.error('Security audit event could not be recorded:', error.code || 'DATABASE_ERROR');
    }
}

module.exports = { recordAudit, writeAuditEvent };
