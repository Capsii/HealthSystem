const crypto = require('node:crypto');
const express = require('express');
const pool = require('../db');
const { requireAuth, sensitiveCsrf } = require('../middleware/auth');
const { isUuid, isDateOnly } = require('../patient_validation');
const {
  normalizeAppointmentInput,
} = require('../appointment_validation');
const { writeAuditEvent } = require('../audit');
const logger = require('../logger');

const router = express.Router();
const PAGE_SIZE = 50;
const STATUSES = ['scheduled', 'completed', 'cancelled', 'missed'];

router.use(requireAuth);
router.use(sensitiveCsrf);

function isAdmin(req) {
  return req.session.user.role === 'admin';
}

function acceptsJson(req) {
  return req.is('application/json') ||
    (req.headers.accept || '').includes('application/json');
}

function cleanDate(value) {
  return typeof value === 'string' && isDateOnly(value) ? value : '';
}

function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 300) return '/appointments';
  const match = value.match(/^\/patients\/([0-9a-f-]{36})$/i);
  if (match && isUuid(match[1])) return `/patients/${encodeURIComponent(match[1])}`;
  return value === '/appointments' ? value : '/appointments';
}

function redirectResult(req, res, status, code, appointmentId = null) {
  if (acceptsJson(req)) {
    return res.status(status).json({
      success: status < 400,
      appointmentId,
      error: status >= 400 ? code : undefined,
    });
  }
  const destination = safeReturnTo(req.body?.return_to);
  const separator = destination.includes('?') ? '&' : '?';
  const isProfile = destination.startsWith('/patients/');
  const key = status < 400
    ? 'appointment'
    : isProfile
      ? 'error'
      : 'appointment_error';
  const value = status < 400
    ? code
    : isProfile
      ? `appointment_${code}`
      : code;
  return res.redirect(
    `${destination}${separator}${key}=${encodeURIComponent(value)}`,
  );
}

function readVersion(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

async function getStaffChoices() {
  const [rows] = await pool.execute(
    `SELECT id, username FROM users
     WHERE is_active = TRUE AND is_deleted = FALSE
       AND role IN ('admin', 'staff')
     ORDER BY username, id`,
  );
  return rows;
}

function inputFromRequest(req, assignedStaffId) {
  const body = req.body || {};
  return normalizeAppointmentInput(
    {
      patient_id: body.patient_id,
      assigned_staff_id: assignedStaffId,
      appointment_date: body.appointment_date,
      start_time: body.start_time,
      duration_minutes: body.duration_minutes,
      reason: body.reason,
      operation_id: body.operation_id,
    },
    { now: new Date() },
  );
}

async function getConnectionOrRespond(req, res, action) {
  try {
    return await pool.getConnection();
  } catch (error) {
    logger.error(`appointment.${action}.connection.failed`, {
      requestId: req.requestId,
      errorCode: error.code || 'DATABASE_ERROR',
    });
    redirectResult(req, res, 503, 'failed');
    return null;
  }
}

async function lockStaff(connection, staffIds) {
  const uniqueIds = [...new Set(staffIds)].sort();
  const users = new Map();
  for (const id of uniqueIds) {
    const [rows] = await connection.execute(
      `SELECT id, role, is_active, is_deleted FROM users
       WHERE id = ? FOR UPDATE`,
      [id],
    );
    users.set(id, rows[0] || null);
  }
  return users;
}

async function priorOperation(connection, operationId) {
  const [rows] = await connection.execute(
    `SELECT appointment_id, event_type, payload_hash
     FROM appointment_events WHERE operation_id = ? FOR UPDATE`,
    [operationId],
  );
  return rows[0] || null;
}

async function getAppointment(connection, id, forUpdate = false) {
  const [rows] = await connection.execute(
    `SELECT id, patient_id, assigned_staff_id, created_by,
            DATE_FORMAT(start_at, '%Y-%m-%d %H:%i:%s') AS start_at_utc,
            duration_minutes, reason, status, version, created_at, updated_at
     FROM appointments WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] || null;
}

async function recordEvent(connection, appointmentId, actor, eventType, input, details) {
  await connection.execute(
    `INSERT INTO appointment_events
     (appointment_id, actor_id, event_type, operation_id, payload_hash, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      appointmentId,
      actor.id,
      eventType,
      input.operationId,
      input.payloadHash,
      JSON.stringify(details),
    ],
  );
  await writeAuditEvent(connection, {
    actorId: actor.id,
    actorRole: actor.role,
    action: `appointment.${eventType}`,
    targetId: appointmentId,
    entityType: 'appointment',
    entityId: appointmentId,
    requestId: input.operationId,
    operationId: input.operationId,
    details,
  });
}

async function overlappingAppointment(connection, staffId, startAt, endAt, excludeId = null) {
  const [rows] = await connection.execute(
    `SELECT id FROM appointments
     WHERE assigned_staff_id = ? AND status = 'scheduled'
       AND start_at < ? AND DATE_ADD(start_at, INTERVAL duration_minutes MINUTE) > ?
       AND (? IS NULL OR id <> ?)
     LIMIT 1 FOR UPDATE`,
    [staffId, endAt, startAt, excludeId, excludeId],
  );
  return rows[0] || null;
}

async function findRecordedOperation(input) {
  const [rows] = await pool.execute(
    `SELECT appointment_id, event_type, payload_hash
     FROM appointment_events WHERE operation_id = ?`,
    [input.operationId],
  );
  const previous = rows[0];
  return previous &&
    previous.event_type === input.eventType &&
    previous.payload_hash === input.payloadHash
    ? previous.appointment_id
    : null;
}

router.get('/', async (req, res) => {
  const status = STATUSES.includes(String(req.query.status))
    ? String(req.query.status)
    : 'all';
  const fromDate = cleanDate(req.query.fromDate);
  const toDate = cleanDate(req.query.toDate);
  const patientSearch = String(req.query.search || '').trim().slice(0, 100);
  const staffFilter = isAdmin(req) && isUuid(String(req.query.staff || ''))
    ? String(req.query.staff)
    : '';
  const requestedPage = Number(req.query.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? Math.min(requestedPage, 1_000_000)
    : 1;

  if (
    (req.query.fromDate && !fromDate) ||
    (req.query.toDate && !toDate) ||
    (fromDate && toDate && fromDate > toDate)
  ) {
    return res.status(400).render('appointments', {
      user: req.session.user,
      appointments: [],
      staff: [],
      filters: { status, fromDate, toDate, search: patientSearch, staff: staffFilter, page: 1 },
      pagination: { page: 1, pages: 1 },
      operationId: crypto.randomUUID(),
      error: 'Enter a valid date range.',
      message: null,
    });
  }

  const conditions = [];
  const params = [];
  if (status !== 'all') {
    conditions.push('a.status = ?');
    params.push(status);
  }
  if (fromDate) {
    conditions.push('a.start_at >= ?');
    params.push(`${fromDate} 00:00:00`);
  }
  if (toDate) {
    conditions.push('a.start_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(`${toDate} 00:00:00`);
  }
  if (patientSearch) {
    const partial = `%${patientSearch.toLowerCase()}%`;
    conditions.push(
      `(LOWER(p.full_name) LIKE ? OR LOWER(p.id) LIKE ? OR LOWER(p.phone) LIKE ?)`,
    );
    params.push(partial, partial, partial);
  }
  if (isAdmin(req) && staffFilter) {
    conditions.push('a.assigned_staff_id = ?');
    params.push(staffFilter);
  } else if (!isAdmin(req)) {
    conditions.push('a.assigned_staff_id = ?');
    params.push(req.session.user.id);
    conditions.push('p.is_deleted = FALSE');
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const staff = isAdmin(req) ? await getStaffChoices() : [];
    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total
       FROM appointments a
       INNER JOIN patients p ON p.id = a.patient_id ${where}`,
      params,
    );
    const total = Number(countRow.total) || 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const selectedPage = Math.min(page, pages);
    const [appointments] = await pool.query(
      `SELECT a.id, a.patient_id, p.full_name AS patient_name,
              a.assigned_staff_id, u.username AS staff_name,
              DATE_FORMAT(a.start_at, '%Y-%m-%d %H:%i:%s') AS start_at_utc,
              a.duration_minutes, a.reason, a.status, a.version
       FROM appointments a
       INNER JOIN patients p ON p.id = a.patient_id
       INNER JOIN users u ON u.id = a.assigned_staff_id
       ${where}
       ORDER BY a.start_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (selectedPage - 1) * PAGE_SIZE],
    );
    const filtersQuery = new URLSearchParams();
    for (const [key, value] of Object.entries({
      status,
      fromDate,
      toDate,
      search: patientSearch,
      staff: staffFilter,
    })) {
      if (value && !(key === 'status' && value === 'all')) {
        filtersQuery.set(key, value);
      }
    }
    const now = Date.now();
    for (const appointment of appointments) {
      appointment.rescheduleOperationId = crypto.randomUUID();
      appointment.cancelOperationId = crypto.randomUUID();
      appointment.completeOperationId = crypto.randomUUID();
      appointment.missedOperationId = crypto.randomUUID();
      const start = new Date(`${appointment.start_at_utc.replace(' ', 'T')}Z`).getTime();
      appointment.canComplete = start <= now;
      appointment.canMiss =
        start + Number(appointment.duration_minutes) * 60_000 <= now;
      appointment.queryString = filtersQuery.toString();
    }
    const messageMap = {
      scheduled: 'Appointment scheduled.',
      rescheduled: 'Appointment rescheduled.',
      cancelled: 'Appointment cancelled.',
      completed: 'Appointment marked completed.',
      missed: 'Appointment marked missed.',
    };
    const errorMap = {
      invalid: 'Check the appointment details and try again.',
      missing_patient: 'The selected patient is unavailable.',
      missing_staff: 'The selected staff member is unavailable.',
      forbidden: 'You do not have permission to access or change this appointment.',
      conflict: 'That staff member already has an overlapping appointment. Choose another time.',
      stale: 'This appointment changed in another request. Reload it before trying again.',
      failed: 'The appointment could not be saved. Try again.',
      cancelled: 'The appointment has already been cancelled.',
      status: 'This appointment cannot be changed to that status.',
      past: 'The appointment time has not arrived yet.',
    };
    return res.render('appointments', {
      user: req.session.user,
      appointments,
      staff,
      filters: {
        status,
        fromDate,
        toDate,
        search: patientSearch,
        staff: staffFilter,
        page: selectedPage,
        queryString: filtersQuery.toString(),
      },
      pagination: { page: selectedPage, pages, total },
      operationId: crypto.randomUUID(),
      error: errorMap[String(req.query.appointment_error)] || null,
      message: messageMap[String(req.query.appointment)] || null,
    });
  } catch (error) {
    logger.error('appointment.list.failed', {
      requestId: req.requestId,
      errorCode: error.code || 'DATABASE_ERROR',
    });
    return res.status(500).render('appointments', {
      user: req.session.user,
      appointments: [],
      staff: [],
      filters: { status, fromDate, toDate, search: patientSearch, staff: staffFilter, page: 1 },
      pagination: { page: 1, pages: 1, total: 0 },
      operationId: crypto.randomUUID(),
      error: 'Appointments could not be loaded. Please try again.',
      message: null,
    });
  }
});

router.post('/create', async (req, res) => {
  const actor = req.session.user;
  const assignedStaffId = actor.role === 'admin'
    ? String(req.body?.assigned_staff_id || '').trim()
    : actor.id;
  const normalized = inputFromRequest(req, assignedStaffId);
  if (normalized.error) return redirectResult(req, res, 400, 'invalid');
  const input = normalized.value;
  const connection = await getConnectionOrRespond(req, res, 'create');
  if (!connection) return;
  try {
    await connection.beginTransaction();
    const lockedStaff = await lockStaff(connection, [input.assignedStaffId]);
    const staffUser = lockedStaff.get(input.assignedStaffId);
    if (
      !staffUser ||
      !staffUser.is_active ||
      staffUser.is_deleted ||
      !['admin', 'staff'].includes(staffUser.role) ||
      (actor.role !== 'admin' && input.assignedStaffId !== actor.id)
    ) {
      await connection.rollback();
      return redirectResult(req, res, 403, 'missing_staff');
    }
    const prior = await priorOperation(connection, input.operationId);
    if (prior) {
      await connection.rollback();
      if (
        prior.event_type === 'scheduled' &&
        prior.payload_hash === input.payloadHash
      ) {
        return redirectResult(req, res, 200, 'scheduled', prior.appointment_id);
      }
      return redirectResult(req, res, 409, 'stale');
    }
    const [patients] = await connection.execute(
      `SELECT id FROM patients
       WHERE id = ? AND is_deleted = FALSE FOR UPDATE`,
      [input.patientId],
    );
    if (!patients.length) {
      await connection.rollback();
      return redirectResult(req, res, 404, 'missing_patient');
    }
    if (
      await overlappingAppointment(
        connection,
        input.assignedStaffId,
        input.startAt,
        input.endAt,
      )
    ) {
      await connection.rollback();
      return redirectResult(req, res, 409, 'conflict');
    }
    const appointmentId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO appointments
       (id, patient_id, assigned_staff_id, created_by, start_at,
        duration_minutes, reason, status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 1)`,
      [
        appointmentId,
        input.patientId,
        input.assignedStaffId,
        actor.id,
        input.startAt,
        input.durationMinutes,
        input.reason,
      ],
    );
    await recordEvent(connection, appointmentId, actor, 'scheduled', input, {
      patientId: input.patientId,
      assignedStaffId: input.assignedStaffId,
      startAtUtc: input.startAt,
      durationMinutes: input.durationMinutes,
      reason: input.reason,
    });
    await connection.commit();
    return redirectResult(req, res, 200, 'scheduled', appointmentId);
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      const existingOperationId = await findRecordedOperation({
        ...input,
        eventType: 'scheduled',
      });
      if (existingOperationId) {
        return redirectResult(
          req,
          res,
          200,
          'scheduled',
          existingOperationId,
        );
      }
      return redirectResult(req, res, 409, 'stale');
    }
    logger.error('appointment.create.failed', {
      requestId: req.requestId,
      errorCode: error.code || 'DATABASE_ERROR',
    });
    return redirectResult(req, res, 500, 'failed');
  } finally {
    connection.release();
  }
});

router.post('/:id/reschedule', async (req, res) => {
  if (!isUuid(req.params.id)) return redirectResult(req, res, 400, 'invalid');
  const actor = req.session.user;
  const version = readVersion(String(req.body?.version || ''));
  if (!version) return redirectResult(req, res, 400, 'invalid');
  const connection = await getConnectionOrRespond(req, res, 'reschedule');
  if (!connection) return;
  let operationInput = null;
  try {
    await connection.beginTransaction();
    const [unlockedRows] = await connection.execute(
      'SELECT assigned_staff_id FROM appointments WHERE id = ?',
      [req.params.id],
    );
    if (!unlockedRows.length) {
      await connection.rollback();
      return redirectResult(req, res, 404, 'invalid');
    }
    const currentStaffId = String(unlockedRows[0].assigned_staff_id);
    const assignedStaffId = actor.role === 'admin'
      ? String(req.body?.assigned_staff_id || '').trim()
      : actor.id;
    const normalized = inputFromRequest(req, assignedStaffId);
    if (normalized.error) {
      await connection.rollback();
      return redirectResult(req, res, 400, 'invalid');
    }
    const input = normalized.value;
    operationInput = input;
    const lockedStaff = await lockStaff(connection, [
      currentStaffId,
      input.assignedStaffId,
    ]);
    const prior = await priorOperation(connection, input.operationId);
    if (prior) {
      await connection.rollback();
      return prior.event_type === 'rescheduled' &&
        prior.payload_hash === input.payloadHash
        ? redirectResult(req, res, 200, 'rescheduled', prior.appointment_id)
        : redirectResult(req, res, 409, 'stale');
    }
    const lockedAppointment = await getAppointment(
      connection,
      req.params.id,
      true,
    );
    if (
      !lockedAppointment ||
      lockedAppointment.assigned_staff_id !== currentStaffId ||
      (!isAdmin(req) &&
        (currentStaffId !== actor.id || input.assignedStaffId !== actor.id))
    ) {
      await connection.rollback();
      return redirectResult(req, res, 403, 'forbidden');
    }
    if (
      lockedAppointment.status !== 'scheduled' ||
      Number(lockedAppointment.version) !== version
    ) {
      await connection.rollback();
      return redirectResult(req, res, 409, 'stale');
    }
    if (input.patientId !== lockedAppointment.patient_id) {
      await connection.rollback();
      return redirectResult(req, res, 400, 'invalid');
    }
    const [activePatient] = await connection.execute(
      'SELECT id FROM patients WHERE id = ? AND is_deleted = FALSE FOR UPDATE',
      [lockedAppointment.patient_id],
    );
    if (!activePatient.length) {
      await connection.rollback();
      return redirectResult(req, res, 404, 'missing_patient');
    }
    const newStaff = lockedStaff.get(input.assignedStaffId);
    if (
      !newStaff ||
      !newStaff.is_active ||
      newStaff.is_deleted ||
      !['admin', 'staff'].includes(newStaff.role)
    ) {
      await connection.rollback();
      return redirectResult(req, res, 400, 'missing_staff');
    }
    if (
      await overlappingAppointment(
        connection,
        input.assignedStaffId,
        input.startAt,
        input.endAt,
        req.params.id,
      )
    ) {
      await connection.rollback();
      return redirectResult(req, res, 409, 'conflict');
    }
    const [update] = await connection.execute(
      `UPDATE appointments
       SET assigned_staff_id = ?, start_at = ?, duration_minutes = ?,
           reason = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND version = ? AND status = 'scheduled'`,
      [
        input.assignedStaffId,
        input.startAt,
        input.durationMinutes,
        input.reason,
        req.params.id,
        version,
      ],
    );
    if (!update.affectedRows) {
      await connection.rollback();
      return redirectResult(req, res, 409, 'stale');
    }
    await recordEvent(connection, req.params.id, actor, 'rescheduled', input, {
      previous: {
        assignedStaffId: lockedAppointment.assigned_staff_id,
        startAtUtc: lockedAppointment.start_at_utc,
        durationMinutes: Number(lockedAppointment.duration_minutes),
        reason: lockedAppointment.reason,
      },
      next: {
        assignedStaffId: input.assignedStaffId,
        startAtUtc: input.startAt,
        durationMinutes: input.durationMinutes,
        reason: input.reason,
      },
    });
    await connection.commit();
    return redirectResult(req, res, 200, 'rescheduled', req.params.id);
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY' && operationInput) {
      const existingId = await findRecordedOperation({
        ...operationInput,
        eventType: 'rescheduled',
      });
      return existingId
        ? redirectResult(req, res, 200, 'rescheduled', existingId)
        : redirectResult(req, res, 409, 'stale');
    }
    logger.error('appointment.reschedule.failed', {
      requestId: req.requestId,
      errorCode: error.code || 'DATABASE_ERROR',
    });
    return redirectResult(req, res, 500, 'failed');
  } finally {
    connection.release();
  }
});

async function updateAppointmentStatus(req, res, status) {
  if (!isUuid(req.params.id)) return redirectResult(req, res, 400, 'invalid');
  const actor = req.session.user;
  const version = readVersion(String(req.body?.version || ''));
  const operationId = String(req.body?.operation_id || '');
  if (!version || !isUuid(operationId)) {
    return redirectResult(req, res, 400, 'invalid');
  }
  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ appointmentId: req.params.id, status }))
    .digest('hex');
  const input = { operationId, payloadHash };
  const connection = await getConnectionOrRespond(req, res, status);
  if (!connection) return;
  try {
    await connection.beginTransaction();
    const [unlockedRows] = await connection.execute(
      'SELECT assigned_staff_id FROM appointments WHERE id = ?',
      [req.params.id],
    );
    if (!unlockedRows.length) {
      await connection.rollback();
      return redirectResult(req, res, 404, 'invalid');
    }
    const staffId = String(unlockedRows[0].assigned_staff_id);
    await lockStaff(connection, [staffId]);
    const prior = await priorOperation(connection, operationId);
    if (prior) {
      await connection.rollback();
      return prior.event_type === status &&
        prior.payload_hash === payloadHash
        ? redirectResult(req, res, 200, status, prior.appointment_id)
        : redirectResult(req, res, 409, 'stale');
    }
    const appointment = await getAppointment(connection, req.params.id, true);
    if (
      !appointment ||
      (!isAdmin(req) && appointment.assigned_staff_id !== actor.id)
    ) {
      await connection.rollback();
      return redirectResult(req, res, 403, 'forbidden');
    }
    if (
      appointment.status !== 'scheduled' ||
      Number(appointment.version) !== version
    ) {
      await connection.rollback();
      return redirectResult(req, res, 409, 'stale');
    }
    const timeMatch = String(appointment.start_at_utc).match(
      /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/,
    );
    if (!timeMatch) {
      await connection.rollback();
      return redirectResult(req, res, 500, 'failed');
    }
    const startsAt = Date.UTC(
      Number(timeMatch[1]),
      Number(timeMatch[2]) - 1,
      Number(timeMatch[3]),
      Number(timeMatch[4]),
      Number(timeMatch[5]),
      Number(timeMatch[6]),
    );
    const endsAt =
      startsAt + Number(appointment.duration_minutes) * 60_000;
    const now = Date.now();
    if (
      (status === 'completed' && now < startsAt) ||
      (status === 'missed' && now < endsAt)
    ) {
      await connection.rollback();
      return redirectResult(req, res, 409, 'past');
    }
    const [update] = await connection.execute(
      `UPDATE appointments SET status = ?, version = version + 1,
              updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND version = ? AND status = 'scheduled'`,
      [status, req.params.id, version],
    );
    if (!update.affectedRows) {
      await connection.rollback();
      return redirectResult(req, res, 409, 'stale');
    }
    await recordEvent(connection, req.params.id, actor, status, input, {
      from: 'scheduled',
      to: status,
      startAtUtc: appointment.start_at_utc,
      durationMinutes: Number(appointment.duration_minutes),
    });
    await connection.commit();
    return redirectResult(req, res, 200, status, req.params.id);
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      const existingId = await findRecordedOperation({
        ...input,
        eventType: status,
      });
      return existingId
        ? redirectResult(req, res, 200, status, existingId)
        : redirectResult(req, res, 409, 'stale');
    }
    logger.error(`appointment.${status}.failed`, {
      requestId: req.requestId,
      errorCode: error.code || 'DATABASE_ERROR',
    });
    return redirectResult(req, res, 500, 'failed');
  } finally {
    connection.release();
  }
}

router.post('/:id/cancel', (req, res) =>
  updateAppointmentStatus(req, res, 'cancelled'),
);
router.post('/:id/complete', (req, res) =>
  updateAppointmentStatus(req, res, 'completed'),
);
router.post('/:id/missed', (req, res) =>
  updateAppointmentStatus(req, res, 'missed'),
);

module.exports = router;
