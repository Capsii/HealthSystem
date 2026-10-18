function assertIsolatedIntegrationDatabase() {
    const databaseName = process.env.DB_NAME || '';
    if (!/(^|[_-])(test|testing|ci)([_-]|$)/i.test(databaseName)) {
        throw new Error('Integration tests require a dedicated test database.');
    }
    if (process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS !== 'true') {
        throw new Error(
            'Set ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true only after confirming this database is disposable.'
        );
    }
}

module.exports = { assertIsolatedIntegrationDatabase };
