const SAFE_FIELDS = new Set([
  'requestId',
  'errorCode',
  'status',
  'code',
  'port',
]);

function write(level, event, fields = {}) {
  const safeFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (typeof value === 'string') safeFields[key] = value.slice(0, 100);
    else if (Number.isSafeInteger(value)) safeFields[key] = value;
  }
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'healthsys',
    event: String(event)
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 80),
    ...safeFields,
  };
  const output =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.info;
  output(JSON.stringify(entry));
}

module.exports = {
  error: (event, fields) => write('error', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
};
