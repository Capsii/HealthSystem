const { randomUUID } = require('node:crypto');
const logger = require('./logger');

function requestContext(req, res, next) {
  req.requestId = randomUUID();
  res.set('X-Request-ID', req.requestId);
  next();
}

function responseType(req) {
  return (
    req.accepts(['html', 'json']) === 'json' ||
    req.path.startsWith('/api/') ||
    req.path === '/sync' ||
    req.path.startsWith('/patients/json') ||
    req.path.startsWith('/dashboard/metrics')
  );
}

function notFound(req, res) {
  const message = 'The requested resource was not found.';
  if (responseType(req)) {
    return res.status(404).json({
      success: false,
      error: message,
      code: 'NOT_FOUND',
      requestId: req.requestId,
    });
  }
  return res.status(404).send(message);
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const status =
    error?.type === 'entity.parse.failed'
      ? 400
      : error?.type === 'entity.too.large'
        ? 413
        : Number.isInteger(error?.status) &&
            error.status >= 400 &&
            error.status < 500
          ? error.status
          : 500;
  const code =
    status === 400
      ? 'INVALID_REQUEST'
      : status === 413
        ? 'REQUEST_TOO_LARGE'
        : status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'CONFLICT'
                : status === 429
                  ? 'RATE_LIMITED'
                  : 'INTERNAL_ERROR';
  const message =
    status === 400
      ? 'The request is malformed.'
      : status === 413
        ? 'The request is too large.'
        : status === 401
          ? 'Authentication is required.'
          : status === 403
            ? 'You do not have permission to perform this action.'
            : status === 404
              ? 'The requested resource was not found.'
              : status === 409
                ? 'The request conflicts with the current record state.'
                : status === 429
                  ? 'Too many requests. Please try again later.'
                  : 'The request could not be completed. Please try again.';

  logger.error('request.failed', {
    requestId: req.requestId,
    status,
    code,
    errorCode:
      typeof error?.code === 'string' ? error.code.slice(0, 40) : undefined,
  });

  if (responseType(req)) {
    return res.status(status).json({
      success: false,
      error: message,
      code,
      requestId: req.requestId,
    });
  }
  return res.status(status).send(message);
}

module.exports = { errorHandler, notFound, requestContext };
