const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDateOnly, resolveReportRange } = require('../report_filters');

test('report date filters use validated UTC inclusive date ranges', async (t) => {
    const now = new Date('2026-10-12T01:56:00+05:30');

    await t.test('today and rolling presets use UTC midnight boundaries', () => {
        assert.deepEqual(
            (({ range, fromDate, toDateExclusive, dayCount }) => ({ range, fromDate, toDateExclusive, dayCount }))(resolveReportRange({ range: 'today' }, now)),
            { range: 'today', fromDate: '2026-10-11', toDateExclusive: '2026-10-12', dayCount: 1 }
        );
        assert.equal(resolveReportRange({ range: '7d' }, now).fromDate, '2026-10-05');
        assert.equal(resolveReportRange({ range: '7d' }, now).toDateExclusive, '2026-10-12');
        assert.equal(resolveReportRange({ range: '30d' }, now).fromDate, '2026-09-12');
        assert.equal(resolveReportRange({ range: '30d' }, now).toDateExclusive, '2026-10-12');
    });

    await t.test('custom ranges include the ending date using an exclusive next-day boundary', () => {
        const result = resolveReportRange({
            range: 'custom',
            fromDate: '2026-03-07',
            toDate: '2026-03-08',
        }, now);
        assert.equal(result.error, undefined);
        assert.equal(result.fromDate, '2026-03-07');
        assert.equal(result.toDate, '2026-03-08');
        assert.equal(result.toDateExclusive, '2026-03-09');
        assert.equal(result.dayCount, 2);
        assert.equal(result.bucketFormat, '%Y-%m-%d');
    });

    await t.test('all time omits date constraints and long custom ranges bucket by month', () => {
        const all = resolveReportRange({ range: 'all' }, now);
        assert.equal(all.fromDate, null);
        assert.equal(all.toDateExclusive, null);
        assert.equal(all.bucketFormat, '%Y-%m');
        assert.equal(resolveReportRange({
            range: 'custom',
            fromDate: '2024-01-01',
            toDate: '2026-01-01',
        }, now).bucketFormat, '%Y-%m');
    });

    await t.test('rejects malformed, impossible, reversed, and unsupported date ranges', () => {
        assert.equal(parseDateOnly('2026-02-29'), null);
        assert.match(resolveReportRange({ range: 'custom', fromDate: '2026-02-30', toDate: '2026-03-01' }, now).error, /valid start and end/);
        assert.match(resolveReportRange({ range: 'custom', fromDate: '2026-03-02', toDate: '2026-03-01' }, now).error, /on or before/);
        assert.match(resolveReportRange({ range: 'year' }, now).error, /valid report date range/);
    });
});
