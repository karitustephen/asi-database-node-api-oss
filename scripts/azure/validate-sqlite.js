#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const sqlite3 = require('sqlite3');

const [databasePath] = process.argv.slice(2);

if (!databasePath || !fs.existsSync(databasePath)) {
  console.error('A readable SQLite database path is required.');
  process.exit(2);
}

const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, async (openError) => {
  if (openError) {
    console.error('Unable to open the SQLite database.', openError);
    process.exitCode = 1;
    return;
  }

  try {
    const integrity = await new Promise((resolve, reject) => {
      db.get('PRAGMA integrity_check', (error, row) => (error ? reject(error) : resolve(row.integrity_check)));
    });
    if (integrity !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${integrity}`);
    }

    const migrationTable = await new Promise((resolve, reject) => {
      db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        (error, row) => (error ? reject(error) : resolve(row)),
      );
    });
    if (!migrationTable) {
      throw new Error('The database does not contain the schema migration ledger.');
    }

    const migrationCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS count FROM schema_migrations', (error, row) => (error ? reject(error) : resolve(Number(row.count))));
    });
    if (migrationCount < 1) {
      throw new Error('The database has no recorded schema migrations.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    db.close((closeError) => {
      if (closeError) {
        console.error('Failed to close the database after validation.', closeError);
        process.exitCode = 1;
      }
    });
  }
});
