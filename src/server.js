const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
const app = createApp();

async function start() {
  await app.locals.initialize();
  const server = app.listen(port, () => {
    console.log(`asi-database-node-api-oss listening on http://localhost:${port}`);
  });

  const shutdown = (signal) => {
    server.close(async (error) => {
      if (error) {
        console.error(`Failed to close HTTP server after ${signal}.`, error);
        process.exitCode = 1;
      }
      try {
        await app.locals.close();
      } catch (closeError) {
        console.error('Failed to close the database connection.', closeError);
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

start().catch(async (error) => {
  console.error('Application startup failed.', error);
  try {
    await app.locals.close();
  } catch (closeError) {
    console.error('Failed to close the database after startup failure.', closeError);
  }
  process.exitCode = 1;
});

app.start = start;
module.exports = app;
