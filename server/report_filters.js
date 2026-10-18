const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateOnly(value) {
    if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) return null;
    return { year, month, day, text: value, date };
}

function utcDateText(date) {
    return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

function resolveReportRange(query, now = new Date()) {
    const range = typeof query.range === 'string' ? query.range : '30d';
    const today = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
    ));
    let start;
    let endExclusive;
    let label;

    if (range === 'today') {
        start = today;
        endExclusive = addUtcDays(today, 1);
        label = 'Today (UTC)';
    } else if (range === '7d' || range === '30d') {
        const days = range === '7d' ? 7 : 30;
        start = addUtcDays(today, -(days - 1));
        endExclusive = addUtcDays(today, 1);
        label = `Last ${days} days (UTC)`;
    } else if (range === 'all') {
        label = 'All time';
    } else if (range === 'custom') {
        const from = parseDateOnly(query.fromDate);
        const to = parseDateOnly(query.toDate);
        if (!from || !to) {
            return {
                range,
                fromDate: query.fromDate,
                toDate: query.toDate,
                error: 'Choose valid start and end dates for the custom range.'
            };
        }
        if (from.date > to.date) {
            return {
                range,
                fromDate: query.fromDate,
                toDate: query.toDate,
                error: 'The start date must be on or before the end date.'
            };
        }
        start = from.date;
        endExclusive = addUtcDays(to.date, 1);
        label = `${from.text} through ${to.text} (UTC)`;
    } else {
        return { range, error: 'Choose a valid report date range.' };
    }

    const fromDate = start ? utcDateText(start) : null;
    const toDateExclusive = endExclusive ? utcDateText(endExclusive) : null;
    const dayCount = start && endExclusive
        ? Math.round((endExclusive - start) / 86400000)
        : null;
    return {
        range,
        fromDate,
        toDate: range === 'custom' ? query.toDate : null,
        toDateExclusive,
        label,
        dayCount,
        bucketFormat: dayCount !== null && dayCount <= 62 ? '%Y-%m-%d' : '%Y-%m'
    };
}

module.exports = { parseDateOnly, resolveReportRange };
