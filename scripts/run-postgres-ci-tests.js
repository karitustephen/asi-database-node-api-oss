'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const requiredVariables = [
  'ASI_TEST_TENANT_PG_URL',
  'ASI_TEST_TENANT_PG_TLS_URL',
  'ASI_TEST_TENANT_PG_TLS_CA',
  'ASI_TEST_TENANT_PG_TLS_UNTRUSTED_CA',
];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length > 0) {
  console.error(`PostgreSQL CI tests require: ${missingVariables.join(', ')}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'test/postgres.integration.test.js'],
    {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) {
    console.error('Could not start the PostgreSQL integration tests.', result.error);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exitCode = result.status ?? 1;
  } else if (!/^# skipped 0$/m.test(result.stdout)) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    console.error('PostgreSQL CI integration tests must not skip any tests.');
    process.exitCode = 1;
  } else {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exitCode = 0;
  }
}
