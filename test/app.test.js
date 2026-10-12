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

test('login endpoint returns a token and authenticated tenant listing works', async () => {
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
  } finally {
    await instance.close();
  }
});

test('tenant creation requires a valid name and returns 201', async () => {
  const instance = await startApp();
  try {
    const loginResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });

    const { token } = await loginResponse.json();

    const createResponse = await fetch(`http://127.0.0.1:${instance.port}/api/v1/tenants`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Acme Labs', plan: 'growth' }),
    });

    const createPayload = await createResponse.json();
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.tenant.name, 'Acme Labs');
  } finally {
    await instance.close();
  }
});
