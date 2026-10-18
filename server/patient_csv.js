const { PATIENT_FIELDS, normalizePatientData, isUuid } = require('./patient_validation');

const CSV_HEADERS = [
    'id',
    ...PATIENT_FIELDS,
    'is_deleted',
    'version',
    'created_at',
    'updated_at',
];
const REQUIRED_IMPORT_HEADERS = [
    'id',
    'full_name',
    'date_of_birth',
    'gender',
    'phone',
    'address',
];
const MAX_IMPORT_ROWS = 10000;
const DEFAULT_MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const configuredImportBytes = process.env.HEALTHSYS_CSV_MAX_BYTES;
const MAX_IMPORT_BYTES =
    configuredImportBytes === undefined
        ? DEFAULT_MAX_IMPORT_BYTES
        : Number(configuredImportBytes);
if (
    !Number.isSafeInteger(MAX_IMPORT_BYTES) ||
    MAX_IMPORT_BYTES < 1 ||
    MAX_IMPORT_BYTES > 20 * 1024 * 1024
) {
    throw new Error('HEALTHSYS_CSV_MAX_BYTES must be an integer from 1 to 20971520.');
}

function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
}

function csvRow(values) {
    return values.map(csvCell).join(',');
}

function unescapeExportedCell(value) {
    return value.replace(/^'(?=[\s]*[=+\-@\t\r])/, '');
}

function parseCsv(input, maxRows = MAX_IMPORT_ROWS + 1) {
    if (typeof input !== 'string') throw new Error('Upload a text CSV file.');
    const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let afterQuote = false;
    let touched = false;

    const finishField = () => {
        row.push(field);
        field = '';
        afterQuote = false;
    };
    const finishRow = () => {
        finishField();
        rows.push(row);
        row = [];
        touched = false;
        if (rows.length > maxRows) throw new Error(`CSV exceeds the ${MAX_IMPORT_ROWS} row limit.`);
    };

    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (quoted) {
            if (character === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index++;
                } else {
                    quoted = false;
                    afterQuote = true;
                }
            } else {
                field += character;
            }
            touched = true;
            continue;
        }

        if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
            throw new Error('CSV contains characters after a closing quote.');
        }
        if (character === '"' && field.length === 0 && !afterQuote) {
            quoted = true;
            touched = true;
        } else if (character === '"') {
            throw new Error('CSV contains an unescaped quote.');
        } else if (character === ',') {
            finishField();
            touched = true;
        } else if (character === '\r' || character === '\n') {
            if (character === '\r' && text[index + 1] === '\n') index++;
            finishRow();
        } else {
            field += character;
            touched = true;
        }
    }

    if (quoted) throw new Error('CSV contains an unclosed quoted field.');
    if (touched || field.length || row.length) finishRow();
    return rows;
}

function validatePatientCsv(input) {
    const rows = parseCsv(input);
    if (!rows.length || rows[0].every((header) => !header.trim())) {
        throw new Error('CSV is empty.');
    }

    const headers = rows[0].map((header) => header.trim());
    const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
    if (duplicates.length) throw new Error('CSV contains duplicate column headers.');
    const missing = REQUIRED_IMPORT_HEADERS.filter((header) => !headers.includes(header));
    if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(', ')}.`);
    const unexpected = headers.filter((header) => !CSV_HEADERS.includes(header));
    if (unexpected.length) throw new Error(`CSV contains unsupported columns: ${unexpected.join(', ')}.`);

    const validRows = [];
    const invalidRows = [];
    const seenIds = new Set();
    let skipped = 0;
    const addError = (errors, column, message) => errors.push({ column, message });
    for (let index = 1; index < rows.length; index++) {
        const values = rows[index];
        if (values.every((value) => !value.trim())) {
            skipped++;
            continue;
        }
        const rowNumber = index + 1;
        const errors = [];
        if (values.length !== headers.length) {
            invalidRows.push({
                row: rowNumber,
                errors: [{
                    column: 'row',
                    message: 'Row has a different number of fields than the header.',
                }],
            });
            continue;
        }

        const record = Object.fromEntries(headers.map((header, columnIndex) => [
            header,
            unescapeExportedCell(values[columnIndex]),
        ]));
        if (!isUuid(record.id)) addError(errors, 'id', 'Patient ID must be a valid UUID.');
        else if (seenIds.has(record.id.toLowerCase())) {
            addError(errors, 'id', 'Patient ID is duplicated in this file.');
        }
        else seenIds.add(record.id.toLowerCase());
        const validation = normalizePatientData(record);
        if (validation.error) {
            const fieldMatch = /^Patient field ([a-z_]+)/.exec(validation.error);
            const column = fieldMatch?.[1] ||
                (/name up to/.test(validation.error) ? 'full_name' :
                    /date of birth/.test(validation.error) ? 'date_of_birth' :
                        /gender/.test(validation.error) ? 'gender' :
                            /emergency contact phone/.test(validation.error) ? 'emergency_contact_phone' :
                                /phone/.test(validation.error) ? 'phone' :
                                    /address/.test(validation.error) ? 'address' : 'row');
            addError(errors, column, validation.error);
        }

        if (errors.length) {
            invalidRows.push({ row: rowNumber, id: isUuid(record.id) ? record.id : null, errors });
        } else {
            validRows.push({ row: rowNumber, id: record.id, data: validation.data });
        }
    }
    return { validRows, invalidRows, skipped };
}

function formatCsvTimestamp(value) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
        return `${text.replace(' ', 'T')}Z`;
    }
    return text;
}

function patientCsvValues(patient) {
    return CSV_HEADERS.map((header) => {
        if (header === 'date_of_birth') return String(patient[header] || '').slice(0, 10);
        if (header === 'created_at' || header === 'updated_at') return formatCsvTimestamp(patient[header]);
        return patient[header];
    });
}

module.exports = {
    CSV_HEADERS,
    MAX_IMPORT_ROWS,
    MAX_IMPORT_BYTES,
    csvCell,
    csvRow,
    formatCsvTimestamp,
    parseCsv,
    patientCsvValues,
    validatePatientCsv,
};
