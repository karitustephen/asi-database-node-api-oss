'use strict';

const { createApp } = require('../src/app');

const app = createApp();
let server;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await app.locals.close();
    if (process.connected) process.disconnect();
    process.exitCode = 0;
  } catch (error) {
    console.error('PostgreSQL quota test worker failed to shut down.', error);
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

app.locals.initialize()
  .then(() => {
    server = app.listen(0, '127.0.0.1', () => {
      if (process.send) process.send({ type: 'ready', port: server.address().port });
    });
  })
  .catch(async (error) => {
    console.error('PostgreSQL quota test worker failed to start.', error);
    process.exitCode = 1;
    await app.locals.close();
    if (process.connected) process.disconnect();
  });
