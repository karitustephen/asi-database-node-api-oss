#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const [sourcePath, destinationPath] = process.argv.slice(2);

if (!sourcePath || !destinationPath) {
  console.error('Usage: sqlite-backup.js <source database> <destination database>');
  process.exit(2);
}

if (!fs.existsSync(sourcePath)) {
  console.error(`Database file does not exist: ${sourcePath}`);
  process.exit(2);
}

if (fs.existsSync(destinationPath)) {
  console.error(`Backup destination already exists: ${destinationPath}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
const source = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY, (openError) => {
  if (openError) {
    console.error('Unable to open the source database.', openError);
    process.exitCode = 1;
    return;
  }

  const backup = source.backup(destinationPath);
  backup.step(-1, (stepError) => {
    backup.finish((finishError) => {
      source.close((closeError) => {
        const error = stepError || finishError || closeError;
        if (error) {
          console.error('SQLite backup failed.', error);
          process.exitCode = 1;
        }
      });
    });
  });
});
