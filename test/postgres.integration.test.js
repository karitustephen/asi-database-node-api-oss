'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createTenantDataRepository } = require('../src/tenant-data');

const connectionString = process.env.ASI_TEST_TENANT_PG_URL;

test('PostgreSQL migrations, tenant RLS, CRUD, restricted SQL, and pool recovery work against a local database', {
  skip: !connectionString && 'Set ASI_TEST_TENANT_PG_URL to an isolated PostgreSQL test database.',
}, async () => {
  const repository = createTenantDataRepository({
    connectionString,
    ssl: false,
    poolMax: 2,
    connectionTimeoutMillis: 3000,
  });
  const tenantId = `tenant-${randomUUID()}`;
  const context = {
    tenantId,
    projectId: `project-${randomUUID()}`,
    databaseId: `database-${randomUUID()}`,
  };
  const otherProjectContext = { ...context, projectId: `project-${randomUUID()}` };
  const otherDatabaseContext = { ...context, databaseId: `database-${randomUUID()}` };
  const otherTenantContext = { ...context, tenantId: `tenant-${randomUUID()}` };
  const recordKey = `integration-${randomUUID()}`;
  let recordCreated = false;

  try {
    await repository.initialize();
    await repository.initialize();
    const restartedRepository = createTenantDataRepository({ connectionString, ssl: false, poolMax: 1 });
    try {
      await restartedRepository.initialize();
    } finally {
      await restartedRepository.close();
    }
    const created = await repository.putRecord(context, recordKey, { integration: true });
    assert.equal(created.rowCount, 1);
    recordCreated = true;

    const ownRecord = await repository.getRecord(context, recordKey);
    assert.equal(ownRecord.rowCount, 1);
    assert.deepEqual(ownRecord.rows[0].value, { integration: true });
    assert.equal((await repository.getRecord(otherProjectContext, recordKey)).rowCount, 0);
    assert.equal((await repository.getRecord(otherDatabaseContext, recordKey)).rowCount, 0);
    assert.equal((await repository.getRecord(otherTenantContext, recordKey)).rowCount, 0);

    const selected = await repository.execute(
      context,
      'SELECT record_key, value FROM tenant_data.records WHERE record_key = $1 LIMIT $2',
      [recordKey, 10],
    );
    assert.equal(selected.rowCount, 1);
    assert.equal((await repository.execute(
      otherProjectContext,
      'SELECT record_key FROM tenant_data.records LIMIT 10',
      [],
    )).rowCount, 0);
    assert.equal((await repository.execute(
      otherTenantContext,
      'UPDATE tenant_data.records SET value = $1 WHERE record_key = $2',
      [{ compromised: true }, recordKey],
    )).rowCount, 0);
    await assert.rejects(
      repository.execute(
        context,
        'UPDATE tenant_data.records SET tenant_id = $1 WHERE record_key = $2',
        [`tenant-${randomUUID()}`, recordKey],
      ),
      (error) => error.code === '42501' && error.tenantDataError === true,
    );
    assert.deepEqual((await repository.getRecord(context, recordKey)).rows[0].value, { integration: true });
    await assert.rejects(
      repository.execute(
        context,
        'INSERT INTO tenant_data.records (id, tenant_id, project_id, database_id, record_key, value) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          randomUUID(),
          otherTenantContext.tenantId,
          otherTenantContext.projectId,
          otherTenantContext.databaseId,
          `cross-tenant-${randomUUID()}`,
          { compromised: true },
        ],
      ),
      (error) => error.code === '42501' && error.tenantDataError === true,
    );

    await assert.rejects(
      repository.execute(
        context,
        'INSERT INTO tenant_data.records (id, tenant_id, project_id, database_id, record_key, value) VALUES ($1, $2, $3, $4, $5, $6)',
        [randomUUID(), tenantId, context.projectId, context.databaseId, 'x'.repeat(257), { invalid: true }],
      ),
      (error) => error.code === '23514' && error.tenantDataError === true,
    );
    assert.equal((await repository.getRecord(context, recordKey)).rowCount, 1);
    assert.equal((await repository.deleteRecord(context, recordKey)).rowCount, 1);
    recordCreated = false;
    assert.equal((await repository.getRecord(context, recordKey)).rowCount, 0);
  } finally {
    if (recordCreated) await repository.deleteRecord(context, recordKey);
    await repository.close();
  }
});

test('PostgreSQL API operations enforce tenant quotas end to end against SQLite control-plane auth', {
  skip: !connectionString && 'Set ASI_TEST_TENANT_PG_URL to an isolated PostgreSQL test database.',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asi-tenant-data-e2e-'));
  const tenantDataRepository = createTenantDataRepository({ connectionString, ssl: false, poolMax: 2 });
  const app = createApp({
    dbPath: path.join(root, 'control.sqlite'),
    adminUsername: 'postgres-integration-admin',
    adminPassword: 'local-postgres-admin-password',
    tenantAdminUsername: 'postgres-integration-user',
    tenantAdminPassword: 'local-postgres-tenant-password',
    seedDemoData: true,
    tenantDataRepository,
    usageGracePeriodSeconds: 0,
    planConfig: {
      starter: { monthlyIncludedOperations: 5 },
      pro: { monthlyIncludedOperations: 1_000_000 },
      growth: { monthlyIncludedOperations: 10_000_000 },
    },
  });
  let server;
  let databaseId;
  let recordCreated = false;
  const recordKey = `e2e-${randomUUID()}`;
  const context = {
    tenantId: 'tenant-demo',
    projectId: 'project-demo',
    databaseId: null,
  };
  try {
    await app.locals.initialize();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'postgres-integration-admin',
        password: 'local-postgres-admin-password',
      }),
    });
    const token = (await loginResponse.json()).token;
    const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const databaseResponse = await fetch(`${baseUrl}/api/v1/databases`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantId: context.tenantId,
        projectId: context.projectId,
        name: 'postgres-e2e',
        engine: 'postgresql',
      }),
    });
    assert.equal(databaseResponse.status, 201);
    databaseId = (await databaseResponse.json()).database.id;
    context.databaseId = databaseId;
    const recordsUrl = `${baseUrl}/api/v1/projects/${context.projectId}/databases/${databaseId}/records`;

    const putResponse = await fetch(`${recordsUrl}/${recordKey}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ value: { verified: true } }),
    });
    assert.equal(putResponse.status, 200);
    recordCreated = true;
    const getResponse = await fetch(`${recordsUrl}/${recordKey}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(getResponse.status, 200);
    assert.deepEqual((await getResponse.json()).record.value, { verified: true });
    const listResponse = await fetch(`${recordsUrl}?limit=5`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal((await listResponse.json()).records.length, 1);
    const sqlResponse = await fetch(`${recordsUrl.replace(/\/records$/, '')}/query`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sql: 'SELECT record_key, value FROM tenant_data.records WHERE record_key = $1 LIMIT $2',
        params: [recordKey, 5],
      }),
    });
    assert.equal(sqlResponse.status, 200);
    assert.equal((await sqlResponse.json()).rowCount, 1);

    const usageResponse = await fetch(`${baseUrl}/api/v1/usage?tenantId=${context.tenantId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const usage = await usageResponse.json();
    assert.equal(usage.usage.usedOperations, 5);
    assert.deepEqual(
      usage.history.filter((event) => event.resource === 'tenant_data')
        .map((event) => event.operations).sort((left, right) => left - right),
      [1, 1, 1, 1],
    );

    const tenantTokenResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'postgres-integration-user',
        password: 'local-postgres-tenant-password',
      }),
    });
    assert.equal(tenantTokenResponse.status, 200);
    const tenantToken = (await tenantTokenResponse.json()).token;
    const foreignTenantResponse = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'postgres-e2e-foreign', plan: 'starter' }),
    });
    const foreignTenantId = (await foreignTenantResponse.json()).tenant.id;
    const foreignProjectResponse = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tenantId: foreignTenantId, name: 'postgres-e2e-foreign' }),
    });
    const foreignProjectId = (await foreignProjectResponse.json()).project.id;
    const foreignDatabaseResponse = await fetch(`${baseUrl}/api/v1/databases`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenantId: foreignTenantId,
        projectId: foreignProjectId,
        name: 'postgres-e2e-foreign',
        engine: 'postgresql',
      }),
    });
    const foreignDatabaseId = (await foreignDatabaseResponse.json()).database.id;
    const foreignResourceUrl = `${baseUrl}/api/v1/projects/${foreignProjectId}/databases/${foreignDatabaseId}/records/${recordKey}`;
    const foreignReadResponse = await fetch(foreignResourceUrl, {
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    assert.equal(foreignReadResponse.status, 403);
    const foreignWriteResponse = await fetch(foreignResourceUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: { compromised: true } }),
    });
    assert.equal(foreignWriteResponse.status, 403);
    const mismatchedProjectResponse = await fetch(
      `${baseUrl}/api/v1/projects/${context.projectId}/databases/${foreignDatabaseId}/records/${recordKey}`,
      { headers: authHeaders },
    );
    assert.equal(mismatchedProjectResponse.status, 404);
    assert.deepEqual(
      (await tenantDataRepository.getRecord(context, recordKey)).rows[0].value,
      { verified: true },
    );
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (recordCreated) await tenantDataRepository.deleteRecord(context, recordKey);
    await app.locals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent PostgreSQL writes across app instances cannot exceed a shared SQLite tenant quota', {
  skip: !connectionString && 'Set ASI_TEST_TENANT_PG_URL to an isolated PostgreSQL test database.',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asi-tenant-data-concurrent-'));
  const dbPath = path.join(root, 'shared-control.sqlite');
  const quota = {
    starter: { monthlyIncludedOperations: 2 },
    pro: { monthlyIncludedOperations: 10 },
    growth: { monthlyIncludedOperations: 15 },
  };
  const repositories = [
    createTenantDataRepository({ connectionString, ssl: false, poolMax: 2 }),
    createTenantDataRepository({ connectionString, ssl: false, poolMax: 2 }),
  ];
  const apps = repositories.map((tenantDataRepository) => createApp({
    dbPath,
    adminUsername: 'postgres-concurrent-admin',
    adminPassword: 'local-postgres-concurrent-password',
    tenantAdminUsername: 'postgres-concurrent-user',
    tenantAdminPassword: 'local-postgres-concurrent-tenant-password',
    seedDemoData: true,
    tenantDataRepository,
    usageGracePeriodSeconds: 0,
    planConfig: quota,
  }));
  const servers = [];
  const context = { tenantId: 'tenant-demo', projectId: 'project-demo', databaseId: null };
  const recordKey = `concurrent-${randomUUID()}`;

  try {
    await apps[0].locals.initialize();
    await apps[1].locals.initialize();
    for (const app of apps) {
      const server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      servers.push(server);
    }
    const loginResponse = await fetch(`http://127.0.0.1:${servers[0].address().port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'postgres-concurrent-admin',
        password: 'local-postgres-concurrent-password',
      }),
    });
    assert.equal(loginResponse.status, 200);
    const token = (await loginResponse.json()).token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const databaseResponse = await fetch(`http://127.0.0.1:${servers[0].address().port}/api/v1/databases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenantId: context.tenantId,
        projectId: context.projectId,
        name: 'postgres-concurrent',
        engine: 'postgresql',
      }),
    });
    assert.equal(databaseResponse.status, 201);
    context.databaseId = (await databaseResponse.json()).database.id;
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const port = servers[index % servers.length].address().port;
      return fetch(
        `http://127.0.0.1:${port}/api/v1/projects/${context.projectId}/databases/${context.databaseId}/records/${recordKey}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ value: { request: index } }),
        },
      );
    }));
    const statusCounts = responses.reduce((counts, response) => {
      counts[response.status] = (counts[response.status] || 0) + 1;
      return counts;
    }, {});
    assert.equal(responses.filter((response) => response.status === 200).length, 1, JSON.stringify(statusCounts));
    assert.equal(responses.filter((response) => response.status === 429).length, 11, JSON.stringify(statusCounts));
    assert.equal((await repositories[0].getRecord(context, recordKey)).rowCount, 1);

    const usageResponse = await fetch(
      `http://127.0.0.1:${servers[0].address().port}/api/v1/usage?tenantId=${context.tenantId}`,
      { headers },
    );
    assert.equal(usageResponse.status, 200);
    const usage = await usageResponse.json();
    assert.equal(usage.usage.usedOperations, 2);
    assert.equal(
      usage.history.filter((event) => event.resource === 'tenant_data')
        .reduce((total, event) => total + event.operations, 0),
      1,
    );
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })));
    await Promise.all(apps.map((app) => app.locals.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
