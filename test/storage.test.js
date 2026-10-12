const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const test = require('node:test');

const { createRepository, hashBearerToken, hashPassword } = require('../src/storage');

function exec(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function execute(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

test('token migration hashes legacy bearer tokens and retains authentication', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asi-db-token-migration-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const databasePath = path.join(temporaryRoot, 'legacy.sqlite');
  const db = new sqlite3.Database(databasePath);
  const migrationsDirectory = path.join(__dirname, '../src/migrations');

  await execute(db, `
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  for (const version of ['001_init', '002_indexes']) {
    await execute(db, fs.readFileSync(path.join(migrationsDirectory, `${version}.sql`), 'utf8'));
    await exec(db, 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, new Date().toISOString()]);
  }

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const sessionToken = 'legacy-session-token';
  const apiKeyToken = 'legacy-api-key-token';
  await exec(
    db,
    'INSERT INTO users (id, username, password_hash, role, tenant_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['user-legacy', 'legacy-admin', hashPassword('legacy-test-password'), 'admin', '[]', createdAt],
  );
  await exec(
    db,
    'INSERT INTO sessions (id, token, user_id, username, role, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
    ['session-legacy', sessionToken, 'user-legacy', 'legacy-admin', 'admin', createdAt, expiresAt],
  );
  await exec(
    db,
    'INSERT INTO api_keys (id, name, scope, user_id, token, revoked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ['key-legacy', 'legacy-key', 'default', 'user-legacy', apiKeyToken, createdAt],
  );
  await close(db);

  const repository = createRepository(databasePath);
  try {
    await repository.initialize();
    assert.equal((await repository.findValidSession(sessionToken)).id, 'session-legacy');
    assert.equal((await repository.getApiKey(apiKeyToken)).id, 'key-legacy');

    const session = await new Promise((resolve, reject) => {
      repository.db.get('SELECT token, token_hash FROM sessions WHERE id = ?', ['session-legacy'], (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
    const apiKey = await new Promise((resolve, reject) => {
      repository.db.get('SELECT token, token_hash FROM api_keys WHERE id = ?', ['key-legacy'], (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
    assert.equal(session.token_hash, hashBearerToken(sessionToken));
    assert.notEqual(session.token, sessionToken);
    assert.equal(apiKey.token_hash, hashBearerToken(apiKeyToken));
    assert.notEqual(apiKey.token, apiKeyToken);
  } finally {
    await repository.close();
  }
});

