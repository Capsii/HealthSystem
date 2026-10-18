const buckets = new Map();
let limiterSequence = 0;

function createRateLimiter({ windowMs, max, message = 'Too many requests. Please try again later.' }) {
    const limiterId = ++limiterSequence;
    return (req, res, next) => {
        const now = Date.now();
        const key = `${limiterId}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count++;

        if (buckets.size > 10000) {
            for (const [entryKey, entry] of buckets) {
                if (entry.resetAt <= now) buckets.delete(entryKey);
            }
        }
        res.set('RateLimit-Limit', String(max));
        res.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
        res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
        if (bucket.count > max) {
            res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
            return res.status(429).send(message);
        }
        return next();
    };
}

module.exports = { createRateLimiter };
