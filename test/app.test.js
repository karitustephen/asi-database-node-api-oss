const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');

const { createApp } = require('../src/app');
const { createRepository } = require('../src/storage');

function getTemporaryDbPath(name) {
  const directory = path.resolve(process.cwd(), '.data', 'tests');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${name}.sqlite`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return filePath;
}

async function startApp(dbPath, appOptions = {}) {
  const app = createApp({
    dbPath,
    adminUsername: 'admin',
    adminPassword: 'local-test-admin-password',
    tenantAdminUsername: 'tenant-user',
    tenantAdminPassword: 'local-test-tenant-password',
    seedDemoData: true,
    ...appOptions,
  });
  await app.locals.initialize();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  return {
    app,
    server,
    port,
    close: async () => {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await app.locals.close();
    },
  };
}

test('health endpoint responds with ok status', async () => {
  const instance = await startApp(getTemporaryDbPath('health'));
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
  } finally {
    await instance.close();
  }
});

test('invalid credentials are rejected', async () => {
  const instance = await startApp(getTemporaryDbPath('bad-login'));
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });

    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, 'invalid_credentials');
  } finally {
    await instance.close();
  }
});

test('login endpoint returns a token and tenant listing works for an authorized user', async () => {
  const instance = await startApp(getTemporaryDbPath('login-list'));
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });

    const loginPayload = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.ok(loginPayload.token);

    const tenantsResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      headers: { authorization: `Bearer ${loginPayload.token}` },
    });

    const tenantPayload = await tenantsResponse.json();
    assert.equal(tenantsResponse.status, 200);
    assert.ok(Array.isArray(tenantPayload.tenants));
    assert.ok(tenantPayload.tenants.some((tenant) => tenant.id === 'tenant-demo'));
  } finally {
    await instance.close();
  }
});

test('tenant-admin can only access the assigned tenant and cannot create tenants', async () => {
  const instance = await startApp(getTemporaryDbPath('tenant-admin'));
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tenant-user', password: 'local-test-tenant-password' }),
    });

    const loginPayload = await loginResponse.json();
    assert.equal(loginResponse.status, 200);

    const tenantsResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      headers: { authorization: `Bearer ${loginPayload.token}` },
    });

    const tenantPayload = await tenantsResponse.json();
    assert.equal(tenantsResponse.status, 200);
    assert.deepEqual(tenantPayload.tenants.map((tenant) => tenant.id), ['tenant-demo']);

    const createTenantResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${loginPayload.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Forbidden Tenant' }),
    });

    const createTenantPayload = await createTenantResponse.json();
    assert.equal(createTenantResponse.status, 403);
    assert.equal(createTenantPayload.error.code, 'forbidden');
  } finally {
    await instance.close();
  }
});

test('tenant admins cannot access other tenants and API keys can be revoked', async () => {
  const instance = await startApp(getTemporaryDbPath('tenant-isolation'));
  try {
    const adminLogin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });
    const adminToken = (await adminLogin.json()).token;

    const otherTenant = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Second Tenant', region: 'westus', plan: 'pro' }),
    });
    const createdTenant = await otherTenant.json();
    assert.equal(otherTenant.status, 201);

    const tenantUserLogin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tenant-user', password: 'local-test-tenant-password' }),
    });
    const tenantUserToken = (await tenantUserLogin.json()).token;

    const forbiddenProjects = await fetch(`http://127.0.0.1:${instance.port}/api/v1/projects?tenantId=${createdTenant.tenant.id}`, {
      headers: { authorization: `Bearer ${tenantUserToken}` },
    });

    const forbiddenPayload = await forbiddenProjects.json();
    assert.equal(forbiddenProjects.status, 403);
    assert.equal(forbiddenPayload.error.code, 'forbidden');

    const keyResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/keys`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenantUserToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'tenant-readonly' }),
    });

    const keyPayload = await keyResponse.json();
    assert.equal(keyResponse.status, 201);

    const revokeResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/keys/revoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenantUserToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ keyId: keyPayload.id }),
    });

    const revokePayload = await revokeResponse.json();
    assert.equal(revokeResponse.status, 200);
    assert.equal(revokePayload.status, 'revoked');

    const shouldFail = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      headers: { authorization: `Bearer ${keyPayload.token}` },
    });
    assert.equal(shouldFail.status, 401);
  } finally {
    await instance.close();
  }
});

test('data survives an app restart when using the same SQLite database', async () => {
  const dbPath = getTemporaryDbPath('restart-persistence');
  const firstInstance = await startApp(dbPath);
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${firstInstance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });

    const loginPayload = await loginResponse.json();
    const createTenant = await fetch(`http://127.0.0.1:${firstInstance.port}/api/v1/tenants`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${loginPayload.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Persistent Tenant', region: 'centralus', plan: 'growth' }),
    });

    assert.equal(createTenant.status, 201);
  } finally {
    await firstInstance.close();
  }

  const secondInstance = await startApp(dbPath);
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${secondInstance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });

    const loginPayload = await loginResponse.json();
    const tenantsResponse = await fetch(`http://127.0.0.1:${secondInstance.port}/api/v1/tenants`, {
      headers: { authorization: `Bearer ${loginPayload.token}` },
    });

    const payload = await tenantsResponse.json();
    assert.equal(tenantsResponse.status, 200);
    assert.ok(payload.tenants.some((tenant) => tenant.name === 'Persistent Tenant'));
  } finally {
    await secondInstance.close();
  }
});

function authHeaders(token, includeJsonContentType = false) {
  return {
    authorization: ['Bearer', token].join(' '),
    ...(includeJsonContentType ? { 'content-type': 'application/json' } : {}),
  };
}

test('a fresh database refuses to initialize without a secure administrator', async () => {
  const app = createApp({ dbPath: getTemporaryDbPath('missing-admin') });
  try {
    await assert.rejects(app.locals.initialize(), /Initial administrator is not configured/);
  } finally {
    await app.locals.close();
  }

  const weakPasswordApp = createApp({
    dbPath: getTemporaryDbPath('weak-admin'),
    adminUsername: 'admin',
    adminPassword: 'too-short',
  });
  try {
    await assert.rejects(weakPasswordApp.locals.initialize(), /at least 16 characters/);
  } finally {
    await weakPasswordApp.locals.close();
  }
});

test('tenant reads and writes, global metrics, and audit data respect authorization boundaries', async () => {
  const instance = await startApp(getTemporaryDbPath('cross-tenant-writes'));
  try {
    const adminLogin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });
    const adminToken = (await adminLogin.json()).token;
    const createTenantResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Isolated Tenant' }),
    });
    const { tenant } = await createTenantResponse.json();
    assert.equal(createTenantResponse.status, 201);

    const tenantLogin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tenant-user', password: 'local-test-tenant-password' }),
    });
    const tenantToken = (await tenantLogin.json()).token;
    const tenantHeaders = authHeaders(tenantToken, true);

    for (const resource of ['projects', 'databases']) {
      const readResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/${resource}?tenantId=${tenant.id}`, {
        headers: tenantHeaders,
      });
      assert.equal(readResponse.status, 403, `cross-tenant ${resource} read must be forbidden`);

      const writeResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/${resource}`, {
        method: 'POST',
        headers: tenantHeaders,
        body: JSON.stringify({ tenantId: tenant.id, name: 'Cross-tenant attempt' }),
      });
      assert.equal(writeResponse.status, 403, `cross-tenant ${resource} write must be forbidden`);
    }

    for (const endpoint of ['metrics', 'audit']) {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/${endpoint}`, {
        headers: authHeaders(tenantToken),
      });
      assert.equal(response.status, 403, `tenant administrator must not read platform ${endpoint}`);
    }

    const invalidDatabase = await fetch(`http://127.0.0.1:${instance.port}/api/v1/databases`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-demo', name: 'invalid-engine-db', engine: 'unknown' }),
    });
    assert.equal(invalidDatabase.status, 400);
  } finally {
    await instance.close();
  }
});

test('API keys cannot revoke another user key and read-only keys cannot write', async () => {
  const instance = await startApp(getTemporaryDbPath('api-key-ownership'));
  try {
    const adminLogin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });
    const adminToken = (await adminLogin.json()).token;
    const adminKeyResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/keys`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin-owned-key' }),
    });
    const adminKey = await adminKeyResponse.json();

    const tenantLogin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tenant-user', password: 'local-test-tenant-password' }),
    });
    const tenantToken = (await tenantLogin.json()).token;
    const revokeForeignKey = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/keys/revoke`, {
      method: 'POST',
      headers: { ...authHeaders(tenantToken), 'content-type': 'application/json' },
      body: JSON.stringify({ keyId: adminKey.id }),
    });
    assert.equal(revokeForeignKey.status, 404);

    const readOnlyKeyResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/keys`, {
      method: 'POST',
      headers: { ...authHeaders(tenantToken), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read-only-key', scope: 'read-only' }),
    });
    const readOnlyKey = await readOnlyKeyResponse.json();
    assert.equal(readOnlyKeyResponse.status, 201);

    const writeAttempt = await fetch(`http://127.0.0.1:${instance.port}/api/v1/projects`, {
      method: 'POST',
      headers: { 'x-api-key': readOnlyKey.token, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-demo', name: 'Blocked project' }),
    });
    assert.equal(writeAttempt.status, 403);

    const adminKeyStillWorks = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      headers: { 'x-api-key': adminKey.token },
    });
    assert.equal(adminKeyStillWorks.status, 200);
  } finally {
    await instance.close();
  }
});

test('expired sessions are rejected', async () => {
  const instance = await startApp(getTemporaryDbPath('expired-session'), { sessionTtlSeconds: 1 });
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });
    const { token, expiresIn } = await loginResponse.json();
    assert.equal(expiresIn, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      headers: authHeaders(token),
    });
    assert.equal(response.status, 401);
  } finally {
    await instance.close();
  }
});

test('invalid JSON and unauthenticated resource requests return explicit client errors', async () => {
  const instance = await startApp(getTemporaryDbPath('invalid-inputs'));
  try {
    const invalidJson = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"username":',
    });
    const invalidJsonPayload = await invalidJson.json();
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJsonPayload.error.code, 'invalid_json');

    const unauthorized = await fetch(`http://127.0.0.1:${instance.port}/api/v1/projects`);
    const unauthorizedPayload = await unauthorized.json();
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedPayload.error.code, 'missing_token');
  } finally {
    await instance.close();
  }
});

test('tenant usage counts successful operations, notifies at thresholds, enforces grace, and resets monthly', async () => {
  let currentTime = new Date('2026-01-15T12:00:00.000Z');
  const instance = await startApp(getTemporaryDbPath('monthly-usage'), {
    clock: () => new Date(currentTime),
    usageGracePeriodSeconds: 5,
    planConfig: {
      starter: { monthlyIncludedOperations: 5 },
      pro: { monthlyIncludedOperations: 10 },
      growth: { monthlyIncludedOperations: 15 },
    },
  });
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });
    const token = (await loginResponse.json()).token;

    for (let operation = 0; operation < 4; operation += 1) {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/projects?tenantId=tenant-demo`, {
        headers: authHeaders(token),
      });
      assert.equal(response.status, 200);
    }

    const failedWrite = await fetch(`http://127.0.0.1:${instance.port}/api/v1/projects`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-demo', name: 'x' }),
    });
    assert.equal(failedWrite.status, 400);

    const successfulWrite = await fetch(`http://127.0.0.1:${instance.port}/api/v1/projects`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-demo', name: 'Metered project' }),
    });
    assert.equal(successfulWrite.status, 201);

    const usageUrl = `http://127.0.0.1:${instance.port}/api/v1/usage?tenantId=tenant-demo`;
    const atLimitResponse = await fetch(usageUrl, { headers: authHeaders(token) });
    const atLimit = await atLimitResponse.json();
    assert.equal(atLimitResponse.status, 200);
    assert.equal(atLimit.usage.usedOperations, 5);
    assert.equal(atLimit.usage.includedOperations, 5);
    assert.equal(atLimit.usage.remainingOperations, 0);
    assert.equal(atLimit.usage.usagePercent, 100);
    assert.ok(atLimit.usage.graceDeadline);
    assert.deepEqual(atLimit.notifications.map((notification) => notification.threshold), [80, 100]);
    assert.ok(atLimit.notifications.every((notification) => notification.state === 'dashboard_pending_email_not_configured'));
    assert.equal(atLimit.history.length, 5);

    const duringGrace = await fetch(`http://127.0.0.1:${instance.port}/api/v1/databases?tenantId=tenant-demo`, {
      headers: authHeaders(token),
    });
    assert.equal(duringGrace.status, 200);

    currentTime = new Date(currentTime.getTime() + 6000);
    const overLimit = await fetch(`http://127.0.0.1:${instance.port}/api/v1/databases?tenantId=tenant-demo`, {
      headers: authHeaders(token),
    });
    const limitPayload = await overLimit.json();
    assert.equal(overLimit.status, 429);
    assert.equal(limitPayload.error.code, 'usage_limit_exceeded');
    assert.equal(limitPayload.usage.usedOperations, 6);

    currentTime = new Date('2026-02-01T00:00:00.000Z');
    const newPeriodResponse = await fetch(usageUrl, { headers: authHeaders(token) });
    const newPeriod = await newPeriodResponse.json();
    assert.equal(newPeriod.usage.period, '2026-02');
    assert.equal(newPeriod.usage.usedOperations, 0);
    assert.equal(newPeriod.usage.remainingOperations, 5);
    assert.deepEqual(newPeriod.notifications, []);

    const previousPeriodResponse = await fetch(`${usageUrl}&period=2026-01`, { headers: authHeaders(token) });
    const previousPeriod = await previousPeriodResponse.json();
    assert.equal(previousPeriod.usage.usedOperations, 6);
    assert.equal(previousPeriod.history.length, 6);
  } finally {
    await instance.close();
  }
});

test('concurrent tenant operations cannot exceed an exhausted quota without a grace period', async () => {
  const instance = await startApp(getTemporaryDbPath('concurrent-quota'), {
    usageGracePeriodSeconds: 0,
    planConfig: {
      starter: { monthlyIncludedOperations: 3 },
      pro: { monthlyIncludedOperations: 10 },
      growth: { monthlyIncludedOperations: 15 },
    },
  });
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });
    const token = (await loginResponse.json()).token;
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(
      `http://127.0.0.1:${instance.port}/api/v1/projects?tenantId=tenant-demo`,
      { headers: authHeaders(token) },
    )));

    assert.equal(responses.filter((response) => response.status === 200).length, 3);
    assert.equal(responses.filter((response) => response.status === 429).length, 9);

    const usageResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/usage?tenantId=tenant-demo`, {
      headers: authHeaders(token),
    });
    const usage = await usageResponse.json();
    assert.equal(usage.usage.usedOperations, 3);
  } finally {
    await instance.close();
  }
});

test('recovery charges an expired reservation after the reserving process is terminated', async () => {
  const dbPath = getTemporaryDbPath('crashed-usage-reservation');
  const configuration = {
    adminUsername: 'crash-test-admin',
    adminPassword: 'local-crash-test-admin-password',
    seedDemoData: true,
  };
  const repository = createRepository(dbPath, configuration);
  const worker = fork(path.resolve(__dirname, '../scripts/usage-reservation-crash-worker.js'), [], {
    env: {
      ...process.env,
      ASI_DB_PATH: dbPath,
      ADMIN_USERNAME: configuration.adminUsername,
      ADMIN_PASSWORD: configuration.adminPassword,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await repository.initialize();
    const reserved = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Worker did not reserve usage. ${stderr}`)), 15000);
      worker.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Worker exited before reserving usage (code ${code}, signal ${signal}). ${stderr}`));
      });
      worker.on('message', (message) => {
        if (message?.type === 'reserved') {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    const reservation = await reserved;
    assert.match(reservation.id, /^usage-reservation-/);
    const exited = once(worker, 'exit');
    worker.kill('SIGKILL');
    await exited;

    await assert.rejects(repository.reserveUsage({
      tenantIds: ['tenant-demo'],
      period: '2026-10',
      operation: 'write',
      actor: 'recovery-test',
      resource: 'tenant_data',
      operations: 1,
      includedOperations: { starter: 1, pro: 10, growth: 15 },
      gracePeriodSeconds: 0,
      now: new Date('2026-10-12T17:06:00.000Z'),
    }), { code: 'usage_limit_exceeded' });
    await assert.rejects(repository.reserveUsage({
      tenantIds: ['tenant-demo'],
      period: '2026-10',
      operation: 'write',
      actor: 'recovery-retry',
      resource: 'tenant_data',
      operations: 1,
      includedOperations: { starter: 1, pro: 10, growth: 15 },
      gracePeriodSeconds: 0,
      now: new Date('2026-10-12T17:07:00.000Z'),
    }), { code: 'usage_limit_exceeded' });

    const usage = await repository.getUsageSummary(
      'tenant-demo',
      '2026-10',
      { starter: 1, pro: 10, growth: 15 },
    );
    assert.equal(usage.usedOperations, 1);
    assert.equal(usage.remainingOperations, 0);
    const history = await repository.getUsageHistory('tenant-demo', 10);
    assert.equal(history.length, 1);
    assert.equal(history[0].operations, 1);
    assert.equal(history[0].period, '2026-10');
    assert.equal(history[0].resource, 'reservation_recovery');
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
    await repository.close();
  }
});

test('usage and billing limits cannot be accessed across tenant boundaries', async () => {
  const instance = await startApp(getTemporaryDbPath('usage-tenant-boundary'));
  try {
    const tenantLogin = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tenant-user', password: 'local-test-tenant-password' }),
    });
    const tenantToken = (await tenantLogin.json()).token;
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1/usage?tenantId=tenant-other`, {
      headers: authHeaders(tenantToken),
    });
    assert.equal(response.status, 403);
  } finally {
    await instance.close();
  }
});

test('Stripe checkout, signed subscription webhooks, and billing portal integrate idempotently', async () => {
  const stripe = new Stripe('sk_test_local-only');
  const checkoutRequests = [];
  const portalRequests = [];
  stripe.checkout.sessions.create = async (parameters, requestOptions) => {
    checkoutRequests.push({ parameters, requestOptions });
    return { url: 'https://checkout.stripe.test/session' };
  };
  stripe.billingPortal.sessions.create = async (parameters) => {
    portalRequests.push(parameters);
    return { url: 'https://billing.stripe.test/portal' };
  };
  const webhookSecret = 'whsec_local-test-webhook-secret';
  const billingCycleStart = new Date();
  billingCycleStart.setUTCDate(1);
  billingCycleStart.setUTCHours(0, 0, 0, 0);
  const billingCycleEnd = new Date(billingCycleStart);
  billingCycleEnd.setUTCMonth(billingCycleEnd.getUTCMonth() + 1);
  const instance = await startApp(getTemporaryDbPath('stripe-billing'), {
    stripeClient: stripe,
    stripeWebhookSecret: webhookSecret,
    publicAppUrl: 'https://asi.example.test',
    stripePriceIds: {
      starter: 'price_starter',
      pro: 'price_pro',
      growth: 'price_growth',
    },
  });
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'local-test-admin-password' }),
    });
    const adminToken = (await loginResponse.json()).token;

    const checkoutResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/billing/checkout`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'content-type': 'application/json', 'idempotency-key': 'checkout-tenant-pro-1' },
      body: JSON.stringify({ tenantId: 'tenant-demo', plan: 'pro' }),
    });
    assert.equal(checkoutResponse.status, 201);
    assert.equal((await checkoutResponse.json()).url, 'https://checkout.stripe.test/session');
    assert.equal(checkoutRequests.length, 1);
    assert.equal(checkoutRequests[0].parameters.subscription_data.metadata.tenantId, 'tenant-demo');
    assert.equal(checkoutRequests[0].parameters.subscription_data.metadata.plan, 'pro');
    assert.equal(checkoutRequests[0].requestOptions.idempotencyKey, 'checkout-tenant-pro-1');

    const subscriptionEvent = {
      id: 'evt_test_subscription_created',
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_test_tenant_demo',
          object: 'subscription',
          customer: 'cus_test_tenant_demo',
          status: 'active',
          current_period_start: Math.floor(billingCycleStart.getTime() / 1000),
          current_period_end: Math.floor(billingCycleEnd.getTime() / 1000),
          metadata: { tenantId: 'tenant-demo', plan: 'growth' },
          items: { data: [{ price: { id: 'price_pro', recurring: { interval: 'month', interval_count: 1 } } }] },
        },
      },
    };
    const sendWebhook = async (event) => {
      const payload = JSON.stringify(event);
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      return fetch(`http://127.0.0.1:${instance.port}/api/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
    };

    const invalidWebhook = await fetch(`http://127.0.0.1:${instance.port}/api/v1/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'invalid' },
      body: JSON.stringify(subscriptionEvent),
    });
    assert.equal(invalidWebhook.status, 400);

    const webhookResponse = await sendWebhook(subscriptionEvent);
    assert.equal(webhookResponse.status, 200);
    assert.equal((await webhookResponse.json()).received, true);

    const usageResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/usage?tenantId=tenant-demo`, {
      headers: authHeaders(adminToken),
    });
    const usage = await usageResponse.json();
    assert.equal(usage.usage.plan, 'pro');
    assert.equal(usage.usage.billingStatus, 'active');
    assert.equal(usage.usage.includedOperations, 1_000_000);

    const duplicateEvent = structuredClone(subscriptionEvent);
    duplicateEvent.id = 'evt_test_subscription_out_of_order';
    duplicateEvent.created -= 1;
    duplicateEvent.type = 'customer.subscription.updated';
    duplicateEvent.data.object.items.data[0].price.id = 'price_growth';
    assert.equal((await sendWebhook(duplicateEvent)).status, 200);
    const stillProResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/usage?tenantId=tenant-demo`, {
      headers: authHeaders(adminToken),
    });
    assert.equal((await stillProResponse.json()).usage.plan, 'pro');

    const duplicateCheckout = await fetch(`http://127.0.0.1:${instance.port}/api/v1/billing/checkout`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'content-type': 'application/json', 'idempotency-key': 'checkout-tenant-growth-1' },
      body: JSON.stringify({ tenantId: 'tenant-demo', plan: 'growth' }),
    });
    assert.equal(duplicateCheckout.status, 409);
    assert.equal(checkoutRequests.length, 1);

    const portalResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/billing/portal`, {
      method: 'POST',
      headers: { ...authHeaders(adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-demo' }),
    });
    assert.equal(portalResponse.status, 200);
    assert.equal((await portalResponse.json()).url, 'https://billing.stripe.test/portal');
    assert.equal(portalRequests[0].customer, 'cus_test_tenant_demo');
  } finally {
    await instance.close();
  }
});
