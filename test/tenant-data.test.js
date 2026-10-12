'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');
const { createTenantDataRepository, validateRecordKey, validateRecordValue } = require('../src/tenant-data');
const { validateTenantSql } = require('../src/tenant-sql');

async function startApp(t, tenantDataRepository, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asi-tenant-data-api-'));
  const app = createApp({
    dbPath: path.join(root, 'control.sqlite'),
    adminUsername: 'platform-admin',
    adminPassword: 'local-platform-admin-password',
    tenantAdminUsername: 'tenant-user',
    tenantAdminPassword: 'local-tenant-admin-password',
    seedDemoData: true,
    tenantDataRepository,
    usageGracePeriodSeconds: 0,
    ...options,
  });
  await app.locals.initialize();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await app.locals.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

function createFakeTenantRepository() {
  const calls = [];
  return {
    calls,
    configured: true,
    initialize: async () => {},
    check: async () => ({ status: 'available' }),
    close: async () => {},
    listRecords: async (context, limit, offset) => {
      calls.push({ operation: 'list', context, limit, offset });
      return { rowCount: 2, rows: [{ record_key: 'one' }, { record_key: 'two' }] };
    },
    getRecord: async (context, recordKey) => {
      calls.push({ operation: 'get', context, recordKey });
      return { rowCount: 1, rows: [{ record_key: recordKey, value: { ok: true } }] };
    },
    putRecord: async (context, recordKey, value) => {
      calls.push({ operation: 'put', context, recordKey, value });
      return { rowCount: 1, rows: [{ record_key: recordKey, value }] };
    },
    deleteRecord: async (context, recordKey) => {
      calls.push({ operation: 'delete', context, recordKey });
      return { rowCount: 1, rows: [{ record_key: recordKey }] };
    },
    execute: async (context, sql, params) => {
      calls.push({ operation: 'execute', context, sql, params });
      return { statementType: 'select', rowCount: 3, rows: [{ record_key: 'one' }, { record_key: 'two' }, { record_key: 'three' }] };
    },
  };
}

test('tenant SQL accepts only bounded statements against the RLS-protected records table', () => {
  assert.deepEqual(
    validateTenantSql('SELECT * FROM tenant_data.records WHERE record_key = $1 LIMIT $2', ['key', 10]),
    { statementType: 'select', maxOperations: 10 },
  );
  assert.equal(
    validateTenantSql(
      'UPDATE tenant_data.records SET value = $1 WHERE record_key = $2',
      [{ saved: true }, 'key'],
    ).statementType,
    'update',
  );
  for (const sql of [
    'SELECT * FROM pg_catalog.pg_user LIMIT 1',
    'SELECT set_config($1, $2, true) FROM tenant_data.records LIMIT 1',
    'SELECT * FROM tenant_data.records LIMIT 101',
    'SELECT * FROM tenant_data.records; DELETE FROM tenant_data.records WHERE record_key = $1',
    'UPDATE tenant_data.records SET value = $1 WHERE record_key = $2 OR record_key = $3',
    'DELETE FROM tenant_data.records',
    'SELECT * FROM tenant_data.records',
    'CREATE TABLE tenant_data.other_table (id int)',
  ]) {
    assert.throws(() => validateTenantSql(sql, ['one', 'two', 'three']), { code: 'invalid_tenant_sql' }, sql);
  }
});

test('tenant records API verifies project/database ownership and meters bounded bulk work', async (t) => {
  const tenantDataRepository = createFakeTenantRepository();
  const { baseUrl } = await startApp(t, tenantDataRepository, {
    planConfig: {
      starter: { monthlyIncludedOperations: 5 },
      pro: { monthlyIncludedOperations: 1_000_000 },
      growth: { monthlyIncludedOperations: 10_000_000 },
    },
  });
  const adminToken = await login(baseUrl, 'platform-admin', 'local-platform-admin-password');
  const tenantToken = await login(baseUrl, 'tenant-user', 'local-tenant-admin-password');
  const headers = { authorization: `Bearer ${tenantToken}`, 'content-type': 'application/json' };

  const createdDatabaseResponse = await fetch(`${baseUrl}/api/v1/databases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: 'tenant-demo',
      projectId: 'project-demo',
      name: 'tenant-data',
      engine: 'postgresql',
    }),
  });
  assert.equal(createdDatabaseResponse.status, 201);
  const databaseId = (await createdDatabaseResponse.json()).database.id;
  const recordsUrl = `${baseUrl}/api/v1/projects/project-demo/databases/${databaseId}/records`;

  const listResponse = await fetch(`${recordsUrl}?limit=5`, { headers });
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).records.length, 2);
  assert.deepEqual(tenantDataRepository.calls[0], {
    operation: 'list',
    context: { tenantId: 'tenant-demo', projectId: 'project-demo', databaseId },
    limit: 5,
    offset: 0,
  });

  const queryResponse = await fetch(`${recordsUrl.replace(/\/records$/, '')}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sql: 'SELECT * FROM tenant_data.records WHERE record_key = $1 LIMIT $2',
      params: ['one', 4],
    }),
  });
  assert.equal(queryResponse.status, 200);
  assert.equal((await queryResponse.json()).rowCount, 3);

  const invalidSqlResponse = await fetch(`${recordsUrl.replace(/\/records$/, '')}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql: 'SELECT * FROM pg_catalog.pg_user LIMIT 1' }),
  });
  assert.equal(invalidSqlResponse.status, 400);
  assert.equal(tenantDataRepository.calls.length, 2);

  const keyResponse = await fetch(`${baseUrl}/api/v1/auth/keys`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'data-plane-readonly', scope: 'read-only' }),
  });
  assert.equal(keyResponse.status, 201);
  const readOnlyKey = (await keyResponse.json()).token;
  const deniedWriteResponse = await fetch(`${recordsUrl.replace(/\/records$/, '')}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${readOnlyKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sql: 'DELETE FROM tenant_data.records WHERE record_key = $1',
      params: ['one'],
    }),
  });
  assert.equal(deniedWriteResponse.status, 403);
  assert.equal(tenantDataRepository.calls.length, 2);

  const foreignTenantResponse = await fetch(`${baseUrl}/api/v1/tenants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Other Tenant', plan: 'starter' }),
  });
  const foreignTenantId = (await foreignTenantResponse.json()).tenant.id;
  const foreignProjectResponse = await fetch(`${baseUrl}/api/v1/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: foreignTenantId, name: 'Foreign project' }),
  });
  const foreignProjectId = (await foreignProjectResponse.json()).project.id;
  const foreignDatabaseResponse = await fetch(`${baseUrl}/api/v1/databases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: foreignTenantId,
      projectId: foreignProjectId,
      name: 'foreign-data',
      engine: 'postgresql',
    }),
  });
  const foreignDatabaseId = (await foreignDatabaseResponse.json()).database.id;
  const forbiddenResponse = await fetch(
    `${baseUrl}/api/v1/projects/${foreignProjectId}/databases/${foreignDatabaseId}/records`,
    { headers },
  );
  assert.equal(forbiddenResponse.status, 403);
  assert.equal(tenantDataRepository.calls.length, 2);

  const usageResponse = await fetch(`${baseUrl}/api/v1/usage?tenantId=tenant-demo`, {
    headers: { authorization: `Bearer ${tenantToken}` },
  });
  const usage = await usageResponse.json();
  assert.equal(usage.usage.usedOperations, 6);
  assert.deepEqual(usage.history.filter((event) => event.resource === 'tenant_data')
    .slice(0, 2).map((event) => [event.resource, event.operations]), [
    ['tenant_data', 3],
    ['tenant_data', 2],
  ]);

  const exhaustedResponse = await fetch(`${recordsUrl}?limit=2`, { headers });
  assert.equal(exhaustedResponse.status, 429);
  assert.equal((await exhaustedResponse.json()).error.code, 'usage_limit_exceeded');
});

test('tenant PostgreSQL data plane does not silently fall back when unconfigured', async (t) => {
  const repository = createTenantDataRepository({});
  assert.equal(repository.configured, false);
  assert.deepEqual(await repository.check(), { status: 'not_configured' });
  await assert.rejects(repository.initialize(), { code: 'tenant_data_not_configured' });
  await repository.close();

  const { baseUrl } = await startApp(t, repository);
  const adminToken = await login(baseUrl, 'platform-admin', 'local-platform-admin-password');
  const databaseResponse = await fetch(`${baseUrl}/api/v1/databases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: 'tenant-demo',
      projectId: 'project-demo',
      name: 'postgres-unconfigured',
      engine: 'postgresql',
    }),
  });
  const databaseId = (await databaseResponse.json()).database.id;
  const response = await fetch(
    `${baseUrl}/api/v1/projects/project-demo/databases/${databaseId}/records`,
    { headers: { authorization: `Bearer ${adminToken}` } },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'tenant_data_unavailable');
});

test('PostgreSQL outages degrade readiness without disabling the SQLite control plane', async (t) => {
  const unavailableRepository = {
    configured: true,
    initialize: async () => {
      throw Object.assign(new Error('local test database is unavailable'), { code: 'ECONNREFUSED' });
    },
    check: async () => ({ status: 'unavailable', code: 'ECONNREFUSED' }),
    close: async () => {},
  };
  const { baseUrl } = await startApp(t, unavailableRepository);
  const adminToken = await login(baseUrl, 'platform-admin', 'local-platform-admin-password');

  const controlPlaneResponse = await fetch(`${baseUrl}/api/v1/tenants`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(controlPlaneResponse.status, 200);

  const databaseResponse = await fetch(`${baseUrl}/api/v1/databases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: 'tenant-demo',
      projectId: 'project-demo',
      name: 'postgres-offline',
      engine: 'postgresql',
    }),
  });
  const databaseId = (await databaseResponse.json()).database.id;
  const dataResponse = await fetch(
    `${baseUrl}/api/v1/projects/project-demo/databases/${databaseId}/records`,
    { headers: { authorization: `Bearer ${adminToken}` } },
  );
  assert.equal(dataResponse.status, 503);
  assert.equal((await dataResponse.json()).error.code, 'tenant_data_unavailable');

  const readyResponse = await fetch(`${baseUrl}/api/v1/ready`);
  assert.equal(readyResponse.status, 503);
  assert.equal((await readyResponse.json()).status, 'degraded');
});

test('record request validators reject malformed keys and values', () => {
  assert.equal(validateRecordKey('record-1'), true);
  assert.equal(validateRecordKey(''), false);
  assert.equal(validateRecordKey('x'.repeat(257)), false);
  assert.equal(validateRecordValue({ value: true }), true);
  assert.equal(validateRecordValue(null), false);
  assert.equal(validateRecordValue('not-json-object'), false);
  assert.equal(validateRecordValue({ value: 'x'.repeat(64 * 1024) }), false);
});

test('PostgreSQL configuration bounds pools and requires TLS for remote hosts', () => {
  for (const sslmode of ['disable', 'no-verify']) {
    assert.throws(
      () => createTenantDataRepository({
        connectionString: `postgresql://asi_app:password@db.example.test/data?sslmode=${sslmode}`,
      }),
      { code: 'tenant_data_configuration_error' },
    );
  }
  assert.throws(
    () => createTenantDataRepository({ connectionString: 'postgresql://app:secret@db.example.test/data', ssl: false }),
    { code: 'tenant_data_configuration_error' },
  );
  assert.throws(
    () => createTenantDataRepository({ connectionString: 'postgresql://localhost/data', poolMax: 21 }),
    { code: 'tenant_data_configuration_error' },
  );
  const localRepository = createTenantDataRepository({
    connectionString: 'postgresql://app:secret@localhost/data',
    ssl: false,
    poolMax: 2,
  });
  assert.equal(localRepository.configured, true);
  return localRepository.close();
});
