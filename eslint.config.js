const eslint = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'server/public/js/dexie.min.js'],
    },
    eslint.configs.recommended,
    {
        files: ['server/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: globals.node,
        },
    },
];
