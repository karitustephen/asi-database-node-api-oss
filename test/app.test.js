const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');

async function startApp() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  return {
    app,
    server,
    port,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('health endpoint responds with ok status', async () => {
  const instance = await startApp();
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
  const instance = await startApp();
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
  const instance = await startApp();
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
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
  const instance = await startApp();
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tenant-user', password: 'tenant123' }),
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
