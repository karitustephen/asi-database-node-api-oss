'use strict';

const { createRepository } = require('../src/storage');

const repository = createRepository(process.env.ASI_DB_PATH, {
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  seedDemoData: true,
});

repository.initialize()
  .then(() => repository.reserveUsage({
    tenantIds: ['tenant-demo'],
    period: '2026-10',
    operation: 'write',
    actor: 'crash-test-worker',
    resource: 'tenant_data',
    operations: 1,
    includedOperations: { starter: 1, pro: 10, growth: 15 },
    gracePeriodSeconds: 0,
    now: new Date('2026-10-12T17:00:00.000Z'),
  }))
  .then((reservation) => {
    if (!reservation) throw new Error('The worker did not create a usage reservation.');
    if (process.send) process.send({ type: 'reserved', id: reservation.id });
    setInterval(() => {}, 1000);
  })
  .catch(async (error) => {
    console.error('Failed to create the simulated in-flight usage reservation.', error);
    await repository.close();
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
