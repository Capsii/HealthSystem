const { isUuid, PATIENT_FIELDS } = require('./patient_validation');

const PAGE_SIZES = Object.freeze([10, 25, 50, 100]);
const PAGE_SIZE_SET = new Set(PAGE_SIZES);
const SORT_COLUMNS = Object.freeze({
  name: 'full_name',
  date_of_birth: 'date_of_birth',
  created_at: 'created_at',
});

async function findById(executor, id, { forUpdate = false } = {}) {
  if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
  const [rows] = await executor.execute(
    `SELECT * FROM patients WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] || null;
}

async function getActive(executor) {
  const [rows] = await executor.execute(
    'SELECT * FROM patients WHERE is_deleted = FALSE',
  );
  return rows;
}

function buildPatientFilters({
  search = '',
  gender = '',
  status = 'active',
  fromDate = '',
  toDate = '',
} = {}) {
  const conditions = [];
  const params = [];
  if (status === 'active') conditions.push('is_deleted = FALSE');
  else if (status === 'deleted') conditions.push('is_deleted = TRUE');
  else if (status !== 'all') throw new TypeError('Unsupported patient status filter.');
  if (search) {
    conditions.push(
      '(LOWER(full_name) LIKE LOWER(?) OR LOWER(CAST(id AS CHAR)) LIKE LOWER(?) OR LOWER(phone) LIKE LOWER(?))',
    );
    const partial = `%${search}%`;
    params.push(partial, partial, partial);
  }
  if (gender) {
    if (!['male', 'female', 'other'].includes(gender)) {
      throw new TypeError('Unsupported patient gender filter.');
    }
    conditions.push('LOWER(gender) = ?');
    params.push(gender);
  }
  if (fromDate) {
    conditions.push('date_of_birth >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    conditions.push('date_of_birth <= ?');
    params.push(toDate);
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

async function listPage(
  executor,
  {
    search = '',
    gender = '',
    status = 'active',
    fromDate = '',
    toDate = '',
    sort = 'created_at',
    direction = 'DESC',
    pageSize = 25,
    page = 1,
  },
) {
  if (!PAGE_SIZE_SET.has(pageSize))
    throw new TypeError('Unsupported patient page size.');
  if (!Number.isSafeInteger(page) || page < 1)
    throw new TypeError('Invalid patient page number.');
  const sortColumn = SORT_COLUMNS[sort];
  if (!sortColumn) throw new TypeError('Unsupported patient sort field.');
  const order =
    direction === 'ASC' ? 'ASC' : direction === 'DESC' ? 'DESC' : null;
  if (!order) throw new TypeError('Unsupported patient sort direction.');

  const filters = buildPatientFilters({
    search,
    gender,
    status,
    fromDate,
    toDate,
  });
  const { where, params } = filters;
  const { where: totalWhere } = buildPatientFilters({ status });

  const [[totalRows]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM patients ${totalWhere}`,
  );
  const [[filteredRows]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM patients ${where}`,
    params,
  );
  const filtered = Number(filteredRows.total);
  const pages = Math.max(1, Math.ceil(filtered / pageSize));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * pageSize;
  if (!Number.isSafeInteger(offset))
    throw new RangeError('Patient page offset is out of range.');

  const [patients] = await executor.execute(
    `SELECT * FROM patients ${where} ORDER BY ${sortColumn} ${order}, id ASC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  return {
    patients,
    counts: { total: Number(totalRows.total), filtered },
    pagination: { page: currentPage, pageSize, pages },
  };
}

async function create(executor, { id, data, actorId }) {
  if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
  const columns = ['id', ...PATIENT_FIELDS];
  const values = [id, ...PATIENT_FIELDS.map((field) => data[field])];
  if (actorId) {
    columns.push('last_modified_by');
    values.push(actorId);
  }
  const placeholders = columns.map(() => '?').join(', ');
  return executor.execute(
    `INSERT INTO patients (${columns.join(', ')}) VALUES (${placeholders})`,
    values,
  );
}

async function updateIfVersion(
  executor,
  { id, data, actorId, expectedVersion, deleted },
) {
  if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('A valid expected patient version is required.');
  }
  const assignments = data
    ? `${PATIENT_FIELDS.map((field) => `${field} = ?`).join(', ')}, `
    : '';
  const values = data ? PATIENT_FIELDS.map((field) => data[field]) : [];
  let deletionAssignment = '';
  if (typeof deleted === 'boolean') {
    deletionAssignment = 'is_deleted = ?, ';
    values.push(deleted);
  }
  const actorAssignment = actorId ? 'last_modified_by = ?, ' : '';
  if (actorId) {
    values.push(actorId);
  }
  values.push(id, expectedVersion);
  const [result] = await executor.execute(
    `UPDATE patients
         SET ${assignments}${deletionAssignment}${actorAssignment}version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND version = ? AND is_deleted = FALSE`,
    values,
  );
  return result.affectedRows > 0;
}

async function restoreIfVersion(executor, { id, expectedVersion, actorId }) {
  if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('A valid expected patient version is required.');
  }
  const [result] = await executor.execute(
    `UPDATE patients
         SET is_deleted = FALSE, version = version + 1,
             updated_at = CURRENT_TIMESTAMP, last_modified_by = ?
         WHERE id = ? AND version = ? AND is_deleted = TRUE`,
    [actorId || null, id, expectedVersion],
  );
  return result.affectedRows > 0;
}

async function getCounts(executor) {
  const counts = await getStatusCounts(executor);
  return {
    total: counts.total,
    active: counts.active,
    deleted: counts.deleted,
  };
}

async function getStatusCounts(executor) {
  const [[counts]] = await executor.execute(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(is_deleted = FALSE), 0) AS active,
               COALESCE(SUM(is_deleted = TRUE), 0) AS deleted,
               COALESCE(SUM(is_deleted IS NULL), 0) AS unknown_status
        FROM patients
    `);
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [key, Number(value)]),
  );
}

module.exports = {
  PAGE_SIZES,
  SORT_COLUMNS,
  buildPatientFilters,
  create,
  getActive,
  findById,
  getCounts,
  getStatusCounts,
  listPage,
  restoreIfVersion,
  updateIfVersion,
};
