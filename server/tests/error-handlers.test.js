const assert = require('node:assert/strict');
const test = require('node:test');
const { errorHandler, notFound, requestContext } = require('../error_handlers');

function responseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

test('request context adds an untrusted-input-independent request ID', () => {
  const req = { headers: { 'x-request-id': 'attacker-controlled' } };
  const res = responseRecorder();
  let nextCalled = false;
  requestContext(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.match(req.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(res.headers['X-Request-ID'], req.requestId);
  assert.notEqual(req.requestId, req.headers['x-request-id']);
});

test('unexpected API errors return a generic correlation-aware response', () => {
  const req = {
    requestId: 'synthetic-request-id',
    path: '/api/example',
    accepts: () => 'json',
    body: { patient: 'synthetic sensitive value' },
  };
  const res = responseRecorder();
  const originalError = console.error;
  const logged = [];
  console.error = (message) => logged.push(String(message));
  try {
    errorHandler(
      new Error('SQL and patient details must not be returned'),
      req,
      res,
      assert.fail,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    success: false,
    error: 'The request could not be completed. Please try again.',
    code: 'INTERNAL_ERROR',
    requestId: 'synthetic-request-id',
  });
  assert.equal(JSON.stringify(res.body).includes('patient details'), false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes('synthetic sensitive value'), false);
});

test('malformed JSON and missing resources return classified safe errors', () => {
  const req = {
    requestId: 'synthetic-request-id',
    path: '/sync',
    accepts: () => 'json',
  };
  const malformedResponse = responseRecorder();
  errorHandler(
    { type: 'entity.parse.failed' },
    req,
    malformedResponse,
    assert.fail,
  );
  assert.equal(malformedResponse.statusCode, 400);
  assert.equal(malformedResponse.body.code, 'INVALID_REQUEST');

  const missingResponse = responseRecorder();
  notFound(req, missingResponse);
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(missingResponse.body.code, 'NOT_FOUND');
});
