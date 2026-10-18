function parseTrustProxy(value) {
    if (!value) return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return Number(value);
    return value;
}

function parseHttpsOrigin(value) {
    let url;
    try {
        url = new URL(value);
    } catch (error) {
        throw new Error('HTTPS_REDIRECT_ORIGIN must be an HTTPS origin in production.');
    }
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('HTTPS_REDIRECT_ORIGIN must be an HTTPS origin in production.');
    }
    return url.origin;
}

function createHttpsRedirect(isProduction, publicOrigin) {
    return (req, res, next) => {
        if (!isProduction) return next();
        if (req.secure) {
            res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            return next();
        }
        if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
            return res.status(426).send('HTTPS is required. Retry this request using the secure application URL.');
        }
        return res.redirect(308, `${publicOrigin}${req.originalUrl}`);
    };
}

module.exports = { createHttpsRedirect, parseHttpsOrigin, parseTrustProxy };
