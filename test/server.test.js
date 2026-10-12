const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const serverPath = path.resolve(__dirname, '../src/server.js');

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve())));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test('server initializes durable storage before serving and shuts down cleanly', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asi-db-server-test-'));
  const databasePath = path.join(temporaryRoot, 'data', 'server.sqlite');
  const port = await getAvailablePort();
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ADMIN_USERNAME: 'server-admin',
      ADMIN_PASSWORD: 'server-test-password-12345',
      ASI_DB_PATH: databasePath,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let readinessResponse;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      break;
    }
    try {
      readinessResponse = await fetch(`${baseUrl}/api/v1/ready`);
      if (readinessResponse.ok) {
        break;
      }
    } catch (error) {
      if (attempt === 49) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(readinessResponse?.ok, `server did not become ready. Output: ${output}`);
  assert.equal((await readinessResponse.json()).status, 'ready');

  const exitPromise = new Promise((resolve) => child.once('exit', (code, childSignal) => resolve([code, childSignal])));
  child.kill('SIGTERM');
  const [exitCode, signal] = await exitPromise;
  assert.equal(signal, null);
  assert.equal(exitCode, 0, output);
  assert.ok(fs.existsSync(databasePath));
});
