const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRepository } = require('../src/storage');

const repositoryRoot = path.resolve(__dirname, '..');
const backupScript = path.join(repositoryRoot, 'scripts/azure/backup.sh');
const restoreScript = path.join(repositoryRoot, 'scripts/azure/restore-test.sh');

test('encrypted backup restores validated SQLite data into a new isolated directory', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asi-db-recovery-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const dataDirectory = path.join(temporaryRoot, 'data');
  const databasePath = path.join(dataDirectory, 'asi.sqlite');
  const backupDirectory = path.join(temporaryRoot, 'external-backups');
  const gnupgDirectory = path.join(temporaryRoot, 'gnupg');
  fs.mkdirSync(gnupgDirectory, { recursive: true, mode: 0o700 });
  const backupPassphrase = 'unit-test-backup-passphrase';
  const repository = createRepository(databasePath, {
    adminUsername: 'backup-admin',
    adminPassword: 'unit-test-admin-password',
  });

  await repository.initialize();
  await repository.createTenant({
    name: 'Backup recovery fixture',
    region: 'test',
    plan: 'starter',
    actor: 'backup-admin',
  });
  await repository.close();

  const environment = {
    ...process.env,
    ASI_DB_PATH: databasePath,
    BACKUP_ROOT: backupDirectory,
    BACKUP_PASSPHRASE: backupPassphrase,
    GNUPGHOME: gnupgDirectory,
  };
  execFileSync('bash', [backupScript], { cwd: repositoryRoot, env: environment });

  const backupFiles = fs.readdirSync(backupDirectory);
  assert.equal(backupFiles.length, 1);
  const backupPath = path.join(backupDirectory, backupFiles[0]);
  assert.match(backupPath, /\.sqlite\.gpg$/);
  assert.notEqual(fs.readFileSync(backupPath).subarray(0, 15).toString(), 'SQLite format 3');

  const restoreDirectory = path.join(temporaryRoot, 'isolated-restore');
  execFileSync('bash', [restoreScript], {
    cwd: repositoryRoot,
    env: {
      ...environment,
      BACKUP_PATH: backupPath,
      RESTORE_DIR: restoreDirectory,
    },
  });

  const restoredDatabasePath = path.join(restoreDirectory, 'asi-database.sqlite');
  assert.ok(fs.existsSync(restoredDatabasePath));
  const restoredRepository = createRepository(restoredDatabasePath);
  await restoredRepository.initialize();
  try {
    const snapshot = await restoredRepository.getSnapshot();
    assert.ok(snapshot.tenants.some((tenant) => tenant.name === 'Backup recovery fixture'));
  } finally {
    await restoredRepository.close();
  }

  const overwriteAttempt = spawnSync('bash', [restoreScript], {
    cwd: repositoryRoot,
    env: {
      ...environment,
      BACKUP_PATH: backupPath,
      RESTORE_DIR: restoreDirectory,
    },
    encoding: 'utf8',
  });
  assert.notEqual(overwriteAttempt.status, 0);
  assert.match(overwriteAttempt.stderr, /refusing to overwrite/);
});
