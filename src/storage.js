const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function randomId(prefix) {
  return `${prefix}-${randomToken()}`;
}

function hashBearerToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 200000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPasswordHash(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    return false;
  }

  const separatorIndex = storedHash.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === storedHash.length - 1) {
    return false;
  }

  const salt = storedHash.slice(0, separatorIndex);
  const expectedHash = storedHash.slice(separatorIndex + 1);
  const candidateHash = crypto.pbkdf2Sync(password, salt, 200000, 64, 'sha512').toString('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(candidateHash, 'hex'));
  } catch (error) {
    return false;
  }
}

function resolveDbPath(dbPath) {
  if (dbPath) {
    return path.resolve(dbPath);
  }

  return path.resolve(process.cwd(), '.data', 'asi-database.sqlite');
}

function createSqliteDb(dbPath) {
  const resolvedPath = resolveDbPath(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return new sqlite3.Database(resolvedPath);
}

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    const callback = (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    if (Array.isArray(params) && params.length > 0) {
      db.run(sql, params, callback);
      return;
    }

    db.run(sql, callback);
  });
}

function allSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function getSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function normalizeUserRecord(row) {
  if (!row) {
    return null;
  }

  const tenantIds = row.tenant_ids ? JSON.parse(row.tenant_ids) : [];
  const safeUser = {
    id: row.id,
    username: row.username,
    role: row.role,
    tenantIds,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  };

  return safeUser;
}

function parseJsonArray(rawValue) {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function createRepository(dbPath, configuration = {}) {
  const db = createSqliteDb(dbPath);
  let operationQueue = Promise.resolve();
  let initialization;

  function serialize(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  }

  async function inTransaction(operation) {
    await runSql(db, 'BEGIN IMMEDIATE');
    try {
      const result = await operation();
      await runSql(db, 'COMMIT');
      return result;
    } catch (error) {
      try {
        await runSql(db, 'ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Database transaction and rollback both failed.');
      }
      throw error;
    }
  }

  async function applyMigrations() {
    await runSql(db, 'PRAGMA busy_timeout = 5000;');
    await runSql(db, 'PRAGMA journal_mode = WAL;');
    await runSql(db, 'PRAGMA foreign_keys = ON;');
    const migrationDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const contents = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      await inTransaction(async () => {
        const applied = await getSql(db, 'SELECT version FROM schema_migrations WHERE version = ?', [version]);
        if (applied) {
          return;
        }

        await new Promise((resolve, reject) => {
          db.exec(contents, (error) => (error ? reject(error) : resolve()));
        });
        if (version === '003_token_hashes') {
          await hashExistingBearerTokens();
        }
        await runSql(db, 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, new Date().toISOString()]);
      });
    }
  }

  async function hashExistingBearerTokens() {
    const [sessions, apiKeys] = await Promise.all([
      allSql(db, 'SELECT id, token FROM sessions WHERE token_hash IS NULL'),
      allSql(db, 'SELECT id, token FROM api_keys WHERE token_hash IS NULL'),
    ]);
    for (const session of sessions) {
      await runSql(
        db,
        'UPDATE sessions SET token_hash = ?, token = ? WHERE id = ?',
        [hashBearerToken(session.token), `stored-session-${session.id}`, session.id],
      );
    }
    for (const apiKey of apiKeys) {
      await runSql(
        db,
        'UPDATE api_keys SET token_hash = ?, token = ? WHERE id = ?',
        [hashBearerToken(apiKey.token), `stored-key-${apiKey.id}`, apiKey.id],
      );
    }
  }

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        await runSql(db, `
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
          );
        `);
        await applyMigrations();
        await ensureSeedData();
      })();
    }
    return initialization;
  }

  async function ensureSeedData() {
    const adminUsername = configuration.adminUsername ?? process.env.ADMIN_USERNAME;
    const adminPassword = configuration.adminPassword ?? process.env.ADMIN_PASSWORD;
    const tenantUserName = configuration.tenantAdminUsername ?? process.env.TENANT_ADMIN_USERNAME;
    const tenantUserPassword = configuration.tenantAdminPassword ?? process.env.TENANT_ADMIN_PASSWORD;
    const seedDemoData = configuration.seedDemoData ?? process.env.ASI_SEED_DEMO_DATA === 'true';
    const users = await getSql(db, 'SELECT COUNT(*) as count FROM users');

    if (Number(users.count) === 0 && (!adminUsername || !adminPassword)) {
      throw new Error('Initial administrator is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD before starting the application.');
    }
    if (adminUsername && (typeof adminUsername !== 'string' || adminUsername.trim().length < 3 || adminUsername.trim().length > 128)) {
      throw new Error('ADMIN_USERNAME must contain between 3 and 128 characters.');
    }
    if (adminPassword && (typeof adminPassword !== 'string' || adminPassword.length < 16)) {
      throw new Error('ADMIN_PASSWORD must contain at least 16 characters.');
    }
    if (Boolean(tenantUserName) !== Boolean(tenantUserPassword)) {
      throw new Error('TENANT_ADMIN_USERNAME and TENANT_ADMIN_PASSWORD must be set together.');
    }
    if (tenantUserName && !seedDemoData) {
      throw new Error('TENANT_ADMIN credentials are only supported when ASI_SEED_DEMO_DATA=true.');
    }
    if (tenantUserName && (typeof tenantUserName !== 'string' || tenantUserName.trim().length < 3 || tenantUserName.trim().length > 128)) {
      throw new Error('TENANT_ADMIN_USERNAME must contain between 3 and 128 characters.');
    }
    if (tenantUserPassword && tenantUserPassword.length < 16) {
      throw new Error('TENANT_ADMIN_PASSWORD must contain at least 16 characters.');
    }

    await inTransaction(async () => {
      if (adminUsername) {
        const adminRecord = await getSql(db, 'SELECT id FROM users WHERE username = ?', [adminUsername.trim()]);
        if (!adminRecord) {
          await runSql(
            db,
            'INSERT INTO users (id, username, password_hash, role, tenant_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [`user-${randomToken()}`, adminUsername.trim(), hashPassword(adminPassword), 'admin', '[]', new Date().toISOString()],
          );
        }
      }

      if (seedDemoData) {
        const demoTenant = await getSql(db, 'SELECT id FROM tenants WHERE id = ?', ['tenant-demo']);
        if (!demoTenant) {
          await runSql(
            db,
            'INSERT INTO tenants (id, name, region, plan, created_at) VALUES (?, ?, ?, ?, ?)',
            ['tenant-demo', 'Demo Tenant', 'eastus', 'starter', new Date().toISOString()],
          );
        }

        const demoProject = await getSql(db, 'SELECT id FROM projects WHERE id = ?', ['project-demo']);
        if (!demoProject) {
          await runSql(
            db,
            'INSERT INTO projects (id, tenant_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)',
            ['project-demo', 'tenant-demo', 'Primary Sandbox', 'active', new Date().toISOString()],
          );
        }

        const demoDatabase = await getSql(db, 'SELECT id FROM databases WHERE id = ?', ['db-demo']);
        if (!demoDatabase) {
          await runSql(
            db,
            'INSERT INTO databases (id, tenant_id, name, engine, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            ['db-demo', 'tenant-demo', 'sandpit', 'mysql', 'running', new Date().toISOString()],
          );
        }
      }

      if (tenantUserName) {
        const tenantUserRecord = await getSql(db, 'SELECT id FROM users WHERE username = ?', [tenantUserName.trim()]);
        if (!tenantUserRecord) {
          await runSql(
            db,
            'INSERT INTO users (id, username, password_hash, role, tenant_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [`user-${randomToken()}`, tenantUserName.trim(), hashPassword(tenantUserPassword), 'tenant_admin', JSON.stringify(['tenant-demo']), new Date().toISOString()],
          );
        }
      }

      const auditCount = await getSql(db, 'SELECT COUNT(*) as total FROM audit_log');
      if (Number(auditCount.total) === 0) {
        await runSql(
          db,
          'INSERT INTO audit_log (id, actor, action, resource, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ['audit-bootstrap', 'system', 'bootstrap', 'platform', 'Database initialized', new Date().toISOString()],
        );
      }
    });
  }

  async function getUserByUsername(username) {
    const row = await getSql(db, 'SELECT * FROM users WHERE username = ?', [username]);
    return normalizeUserRecord(row);
  }

  async function getUserById(userId) {
    const row = await getSql(db, 'SELECT * FROM users WHERE id = ?', [userId]);
    return normalizeUserRecord(row);
  }

  async function listTenantsForUser(userId) {
    const user = await getUserById(userId);
    if (!user) {
      return [];
    }

    if (user.role === 'admin') {
      return allSql(db, 'SELECT * FROM tenants ORDER BY created_at DESC');
    }

    const tenantIds = user.tenantIds || [];
    if (tenantIds.length === 0) {
      return [];
    }

    const placeholders = tenantIds.map(() => '?').join(',');
    return allSql(db, `SELECT * FROM tenants WHERE id IN (${placeholders}) ORDER BY created_at DESC`, tenantIds);
  }

  async function listProjectsForUser(user, tenantIdValue) {
    if (!user) {
      return [];
    }

    if (user.role === 'admin') {
      if (tenantIdValue) {
        return allSql(db, 'SELECT * FROM projects WHERE tenant_id = ? ORDER BY created_at DESC', [tenantIdValue]);
      }
      return allSql(db, 'SELECT * FROM projects ORDER BY created_at DESC');
    }

    const tenantIds = user.tenantIds || [];
    if (tenantIdValue) {
      if (!tenantIds.includes(tenantIdValue)) {
        return [];
      }
      return allSql(db, 'SELECT * FROM projects WHERE tenant_id = ? ORDER BY created_at DESC', [tenantIdValue]);
    }

    if (tenantIds.length === 0) {
      return [];
    }

    const placeholders = tenantIds.map(() => '?').join(',');
    return allSql(db, `SELECT * FROM projects WHERE tenant_id IN (${placeholders}) ORDER BY created_at DESC`, tenantIds);
  }

  async function listDatabasesForUser(user, tenantIdValue) {
    if (!user) {
      return [];
    }

    if (user.role === 'admin') {
      if (tenantIdValue) {
        return allSql(db, 'SELECT * FROM databases WHERE tenant_id = ? ORDER BY created_at DESC', [tenantIdValue]);
      }
      return allSql(db, 'SELECT * FROM databases ORDER BY created_at DESC');
    }

    const tenantIds = user.tenantIds || [];
    if (tenantIdValue) {
      if (!tenantIds.includes(tenantIdValue)) {
        return [];
      }
      return allSql(db, 'SELECT * FROM databases WHERE tenant_id = ? ORDER BY created_at DESC', [tenantIdValue]);
    }

    if (tenantIds.length === 0) {
      return [];
    }

    const placeholders = tenantIds.map(() => '?').join(',');
    return allSql(db, `SELECT * FROM databases WHERE tenant_id IN (${placeholders}) ORDER BY created_at DESC`, tenantIds);
  }

  async function getProjectById(projectId) {
    const row = await getSql(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
    return row ? { ...row, tenantId: row.tenant_id, createdAt: row.created_at } : null;
  }

  async function getDatabaseById(databaseId) {
    const row = await getSql(db, 'SELECT * FROM databases WHERE id = ?', [databaseId]);
    return row ? {
      ...row,
      tenantId: row.tenant_id,
      projectId: row.project_id || null,
      createdAt: row.created_at,
    } : null;
  }

  async function canAccessTenant(user, tenantId) {
    if (!tenantId) {
      return true;
    }

    if (!user) {
      return false;
    }

    if (user.role === 'admin') {
      return true;
    }

    const tenantIds = user.tenantIds || [];
    return tenantIds.includes(tenantId);
  }

  async function createSession(token, user, expiresInSeconds = 86400) {
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    await inTransaction(async () => {
      await runSql(
        db,
        'INSERT INTO sessions (id, token, token_hash, user_id, username, role, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [`session-${randomToken()}`, `stored-session-${randomToken()}`, hashBearerToken(token), user.id, user.username, user.role, createdAt, expiresAt],
      );
      await addAuditEntry({ actor: user.username, action: 'login', resource: 'session' });
    });
  }

  async function findValidSession(token) {
    const row = await getSql(
      db,
      'SELECT * FROM sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > ?',
      [hashBearerToken(token), new Date().toISOString()],
    );
    return row || null;
  }

  async function revokeSessionById(sessionId, actor) {
    await inTransaction(async () => {
      await runSql(db, 'UPDATE sessions SET revoked = 1 WHERE id = ?', [sessionId]);
      await addAuditEntry({ actor, action: 'logout', resource: 'session' });
    });
  }

  async function createApiKey(userId, name, scope = 'default', actor) {
    const key = {
      id: `key-${Date.now()}-${randomToken().slice(0,8)}`,
      name,
      scope,
      userId,
      token: randomToken(),
      revoked: false,
      createdAt: new Date().toISOString(),
    };

    await inTransaction(async () => {
      await runSql(
        db,
        'INSERT INTO api_keys (id, name, scope, user_id, token, token_hash, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        [key.id, key.name, key.scope, key.userId, `stored-key-${randomToken()}`, hashBearerToken(key.token), key.createdAt],
      );
      await addAuditEntry({ actor, action: 'issue_api_key', resource: key.name });
    });

    return key;
  }

  async function getApiKey(token) {
    return getSql(db, 'SELECT * FROM api_keys WHERE token_hash = ? AND revoked = 0', [hashBearerToken(token)]);
  }

  async function revokeApiKeyById(keyId, user) {
    return inTransaction(async () => {
      const key = await getSql(db, 'SELECT id, user_id FROM api_keys WHERE id = ?', [keyId]);
      if (!key || (user.role !== 'admin' && key.user_id !== user.id)) {
        return false;
      }
      await runSql(db, 'UPDATE api_keys SET revoked = 1 WHERE id = ?', [keyId]);
      await addAuditEntry({ actor: user.username, action: 'revoke_api_key', resource: keyId });
      return true;
    });
  }

  async function listAccessibleTenantIds(user) {
    const tenants = await listTenantsForUser(user.id);
    return tenants.map((tenant) => tenant.id);
  }

  async function getTenantById(tenantId) {
    return getSql(db, 'SELECT * FROM tenants WHERE id = ?', [tenantId]);
  }

  async function getCurrentUsagePeriod(tenantId, now = new Date()) {
    const tenant = await getTenantById(tenantId);
    if (!tenant) {
      return null;
    }
    const nowIso = now.toISOString();
    if (['active', 'trialing'].includes(tenant.billing_status)) {
      if (!tenant.billing_period_start || !tenant.billing_period_end || nowIso < tenant.billing_period_start || nowIso >= tenant.billing_period_end) {
        throw new Error(`Tenant ${tenantId} billing period is stale; synchronize the current Stripe subscription before metering usage.`);
      }
      return tenant.billing_period_start.slice(0, 10);
    }
    return nowIso.slice(0, 7);
  }

  async function applyStripeSubscriptionEvent(event, planByPriceId, includedOperations) {
    const subscriptionEvents = new Set([
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]);
    await inTransaction(async () => {
      const existingEvent = await getSql(db, 'SELECT id FROM stripe_webhook_events WHERE id = ?', [event.id]);
      if (existingEvent) {
        return;
      }

      if (subscriptionEvents.has(event.type)) {
        const subscription = event.data?.object;
        const tenantId = subscription?.metadata?.tenantId;
        if (typeof tenantId !== 'string' || !tenantId) {
          throw new Error(`Stripe subscription event ${event.id} is missing tenant metadata.`);
        }

        const tenant = await getSql(db, 'SELECT id, plan, stripe_event_created FROM tenants WHERE id = ?', [tenantId]);
        if (!tenant) {
          throw new Error(`Stripe subscription event ${event.id} references unknown tenant ${tenantId}.`);
        }
        if (!Number.isSafeInteger(event.created) || event.created < 0) {
          throw new Error(`Stripe subscription event ${event.id} is missing its creation timestamp.`);
        }

        const priceId = subscription.items?.data?.[0]?.price?.id;
        const recurring = subscription.items?.data?.[0]?.price?.recurring;
        const active = event.type !== 'customer.subscription.deleted'
          && ['active', 'trialing'].includes(subscription.status);
        const plan = active ? planByPriceId[priceId] : 'starter';
        if (!plan) {
          throw new Error(`Stripe subscription event ${event.id} contains an unconfigured price.`);
        }
        const customerId = typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id;
        if (!customerId || typeof subscription.id !== 'string') {
          throw new Error(`Stripe subscription event ${event.id} is missing customer or subscription identity.`);
        }
        if (active && (recurring?.interval !== 'month' || recurring.interval_count !== 1)) {
          throw new Error(`Stripe subscription event ${event.id} must use a monthly recurring price.`);
        }

        const deleted = event.type === 'customer.subscription.deleted';
        let billingPeriodStart = null;
        let billingPeriodEnd = null;
        if (active) {
          if (!Number.isSafeInteger(subscription.current_period_start) || !Number.isSafeInteger(subscription.current_period_end)) {
            throw new Error(`Stripe subscription event ${event.id} is missing its billing period.`);
          }
          billingPeriodStart = new Date(subscription.current_period_start * 1000).toISOString();
          billingPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
          if (billingPeriodEnd <= billingPeriodStart) {
            throw new Error(`Stripe subscription event ${event.id} contains an invalid billing period.`);
          }
        }
        if (event.created >= Number(tenant.stripe_event_created || 0)) {
          await runSql(
            db,
            `UPDATE tenants
             SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, billing_status = ?,
                 billing_period_start = ?, billing_period_end = ?, stripe_event_created = ?
             WHERE id = ?`,
            [
              plan,
              customerId,
              deleted ? null : subscription.id,
              deleted ? 'canceled' : subscription.status,
              billingPeriodStart,
              billingPeriodEnd,
              event.created,
              tenantId,
            ],
          );
          if (includedOperations?.[plan]) {
            const currentPeriod = billingPeriodStart
              ? billingPeriodStart.slice(0, 10)
              : new Date().toISOString().slice(0, 7);
            await runSql(
              db,
              `UPDATE usage_periods
               SET plan = ?, included_operations = ?
               WHERE tenant_id = ? AND period = ?`,
              [plan, includedOperations[plan], tenantId, currentPeriod],
            );
          }
          await addAuditEntry({
            actor: 'stripe',
            action: 'subscription_updated',
            resource: tenantId,
            details: JSON.stringify({ plan, status: subscription.status, eventId: event.id }),
          });
        }
      }

      await runSql(
        db,
        'INSERT INTO stripe_webhook_events (id, event_type, processed_at) VALUES (?, ?, ?)',
        [event.id, event.type, new Date().toISOString()],
      );
    });
  }

  async function getUsageSummary(tenantId, period, includedOperations) {
    const tenant = await getSql(db, 'SELECT id, plan, billing_status FROM tenants WHERE id = ?', [tenantId]);
    if (!tenant) {
      return null;
    }
    const usage = await getSql(
      db,
      'SELECT * FROM usage_periods WHERE tenant_id = ? AND period = ?',
      [tenantId, period],
    );
    const planLimit = includedOperations[tenant.plan];
    if (!planLimit) {
      throw new Error(`Tenant ${tenantId} has an unsupported plan: ${tenant.plan}`);
    }
    const included = usage ? Number(usage.included_operations) : planLimit;
    const used = usage ? Number(usage.used_operations) : 0;
    return {
      tenantId,
      plan: tenant.plan,
      billingStatus: tenant.billing_status,
      period,
      includedOperations: included,
      usedOperations: used,
      remainingOperations: Math.max(0, included - used),
      usagePercent: included === 0 ? 100 : Math.min(100, Math.round((used / included) * 10000) / 100),
      graceStartedAt: usage?.grace_started_at || null,
      graceDeadline: usage?.grace_deadline || null,
    };
  }

  async function reserveUsage({
    tenantIds,
    period,
    periodsByTenantId = {},
    operation,
    actor,
    resource,
    operations = 1,
    includedOperations,
    gracePeriodSeconds,
    now = new Date(),
  }) {
    if (!Number.isSafeInteger(operations) || operations < 1 || operations > 100) {
      throw new Error('Usage reservation operations must be between 1 and 100.');
    }
    const reservationId = randomId('usage-reservation');
    const allocations = [];
    let limitFailure = null;
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

    await inTransaction(async () => {
      const expiredReservations = await allSql(
        db,
        'SELECT tenant_id, period, SUM(operations) AS operations FROM usage_reservations WHERE expires_at <= ? GROUP BY tenant_id, period',
        [nowIso],
      );
      for (const expired of expiredReservations) {
        await runSql(
          db,
          'UPDATE usage_periods SET reserved_operations = MAX(0, reserved_operations - ?) WHERE tenant_id = ? AND period = ?',
          [Number(expired.operations), expired.tenant_id, expired.period],
        );
      }
      await runSql(db, 'DELETE FROM usage_reservations WHERE expires_at <= ?', [nowIso]);

      for (const tenantId of tenantIds) {
        const tenant = await getSql(db, 'SELECT id, plan FROM tenants WHERE id = ?', [tenantId]);
        if (!tenant) {
          continue;
        }
        const tenantPeriod = periodsByTenantId[tenantId] || period;
        const included = includedOperations[tenant.plan];
        if (!Number.isSafeInteger(included) || included < 1) {
          throw new Error(`Tenant ${tenantId} has an unsupported plan: ${tenant.plan}`);
        }
        await runSql(
          db,
          `INSERT INTO usage_periods (tenant_id, period, plan, included_operations)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (tenant_id, period) DO NOTHING`,
          [tenantId, tenantPeriod, tenant.plan, included],
        );
        const usage = await getSql(
          db,
          'SELECT included_operations, used_operations, reserved_operations, grace_deadline FROM usage_periods WHERE tenant_id = ? AND period = ?',
          [tenantId, tenantPeriod],
        );
        const used = Number(usage.used_operations);
        const reserved = Number(usage.reserved_operations);
        const quota = Number(usage.included_operations);
        if (used + reserved >= quota) {
          let graceDeadline = usage.grace_deadline;
          if (!graceDeadline) {
            graceDeadline = new Date(now.getTime() + gracePeriodSeconds * 1000).toISOString();
            await runSql(
              db,
              'UPDATE usage_periods SET grace_started_at = ?, grace_deadline = ? WHERE tenant_id = ? AND period = ? AND grace_deadline IS NULL',
              [nowIso, graceDeadline, tenantId, tenantPeriod],
            );
          }
          if (nowIso >= graceDeadline) {
            limitFailure = {
              tenantId,
              period: tenantPeriod,
              includedOperations: quota,
              usedOperations: used,
              graceDeadline,
            };
            break;
          }
        }
        await runSql(
          db,
          'INSERT INTO usage_reservations (id, tenant_id, period, operations, expires_at) VALUES (?, ?, ?, ?, ?)',
          [`${reservationId}-${tenantId}`, tenantId, tenantPeriod, operations, expiresAt],
        );
        await runSql(
          db,
          'UPDATE usage_periods SET reserved_operations = reserved_operations + ? WHERE tenant_id = ? AND period = ?',
          [operations, tenantId, tenantPeriod],
        );
        if (used + reserved + operations >= quota && !usage.grace_deadline) {
          const deadline = new Date(now.getTime() + gracePeriodSeconds * 1000).toISOString();
          await runSql(
            db,
            'UPDATE usage_periods SET grace_started_at = ?, grace_deadline = ? WHERE tenant_id = ? AND period = ? AND grace_deadline IS NULL',
            [nowIso, deadline, tenantId, tenantPeriod],
          );
        }
        allocations.push({ tenantId, period: tenantPeriod, operations });
      }

      if (limitFailure) {
        throw Object.assign(new Error('Tenant usage quota has been exhausted.'), {
          code: 'usage_limit_exceeded',
          usage: limitFailure,
        });
      }
    });

    return allocations.length
      ? { id: reservationId, allocations, operation, actor, resource, gracePeriodSeconds }
      : null;
  }

  async function completeUsageReservation(reservation, succeeded, now = new Date(), actualOperations) {
    if (!reservation) {
      return;
    }
    const occurredAt = now.toISOString();
    await inTransaction(async () => {
      for (const { tenantId, period, operations: reservedOperations = 1 } of reservation.allocations) {
        const operations = succeeded ? (actualOperations ?? reservedOperations) : 0;
        if (!Number.isSafeInteger(operations) || operations < 0 || operations > reservedOperations) {
          throw new Error('Completed usage operations exceed the reserved amount.');
        }
        const reservationId = `${reservation.id}-${tenantId}`;
        const reservationRow = await getSql(db, 'SELECT operations FROM usage_reservations WHERE id = ?', [reservationId]);
        if (!reservationRow) {
          continue;
        }
        await runSql(db, 'DELETE FROM usage_reservations WHERE id = ?', [reservationId]);
        await runSql(
          db,
          'UPDATE usage_periods SET reserved_operations = MAX(0, reserved_operations - ?) WHERE tenant_id = ? AND period = ?',
          [Number(reservationRow.operations), tenantId, period],
        );
        if (!succeeded) {
          await clearUnusedGracePeriod(tenantId, period);
          continue;
        }

        await runSql(
          db,
          'UPDATE usage_periods SET used_operations = used_operations + ? WHERE tenant_id = ? AND period = ?',
          [operations, tenantId, period],
        );
        await runSql(
          db,
          `INSERT INTO billable_usage_events
            (id, tenant_id, period, operation, operations, actor, resource, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomId('usage-event'), tenantId, period, reservation.operation, operations, reservation.actor, reservation.resource, occurredAt],
        );

        const usage = await getSql(
          db,
          'SELECT plan, included_operations, used_operations, grace_started_at FROM usage_periods WHERE tenant_id = ? AND period = ?',
          [tenantId, period],
        );
        const included = Number(usage.included_operations);
        const used = Number(usage.used_operations);
        for (const threshold of [80, 100]) {
          if (used * 100 < included * threshold) {
            continue;
          }
          const notification = await getSql(
            db,
            'SELECT id FROM usage_notifications WHERE tenant_id = ? AND period = ? AND plan = ? AND threshold = ?',
            [tenantId, period, usage.plan, threshold],
          );
          if (!notification) {
            await runSql(
              db,
              `INSERT INTO usage_notifications
                (id, tenant_id, period, plan, threshold, usage_percent, state, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'dashboard_pending_email_not_configured', ?)`,
              [randomId('usage-notification'), tenantId, period, usage.plan, threshold, used * 100 / included, occurredAt],
            );
          }
        }

        if (used >= included && !usage.grace_started_at) {
          const deadline = new Date(now.getTime() + reservation.gracePeriodSeconds * 1000).toISOString();
          await runSql(
            db,
            'UPDATE usage_periods SET grace_started_at = ?, grace_deadline = ? WHERE tenant_id = ? AND period = ?',
            [occurredAt, deadline, tenantId, period],
          );
        }
        await clearUnusedGracePeriod(tenantId, period);
      }
    });
  }

  async function clearUnusedGracePeriod(tenantId, period) {
    await runSql(
      db,
      `UPDATE usage_periods
       SET grace_started_at = NULL, grace_deadline = NULL
       WHERE tenant_id = ? AND period = ?
         AND used_operations < included_operations
         AND used_operations + reserved_operations < included_operations`,
      [tenantId, period],
    );
  }

  async function getUsageHistory(tenantId, limit = 100) {
    return allSql(
      db,
      `SELECT id, tenant_id, period, operation, operations, actor, resource, occurred_at
       FROM billable_usage_events
       WHERE tenant_id = ?
       ORDER BY occurred_at DESC
       LIMIT ?`,
      [tenantId, limit],
    );
  }

  async function getUsageNotifications(tenantId, period) {
    return allSql(
      db,
      `SELECT id, tenant_id, period, plan, threshold, usage_percent, state, created_at
       FROM usage_notifications
       WHERE tenant_id = ? AND period = ?
       ORDER BY threshold ASC`,
      [tenantId, period],
    );
  }

  async function createTenant({ name, region, plan, actor }) {
    const tenant = {
      id: `tenant-${Date.now()}-${randomToken().slice(0, 6)}`,
      name,
      region,
      plan,
      createdAt: new Date().toISOString(),
    };
    await inTransaction(async () => {
      await runSql(
        db,
        'INSERT INTO tenants (id, name, region, plan, created_at) VALUES (?, ?, ?, ?, ?)',
        [tenant.id, tenant.name, tenant.region, tenant.plan, tenant.createdAt],
      );
      await addAuditEntry({ actor, action: 'create_tenant', resource: tenant.id });
    });
    return tenant;
  }

  async function createProject({ tenantId, name, status = 'active', actor }) {
    const project = {
      id: `project-${Date.now()}-${randomToken().slice(0, 6)}`,
      tenantId,
      name,
      status,
      createdAt: new Date().toISOString(),
    };
    await inTransaction(async () => {
      await runSql(
        db,
        'INSERT INTO projects (id, tenant_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [project.id, project.tenantId, project.name, project.status, project.createdAt],
      );
      await addAuditEntry({ actor, action: 'create_project', resource: project.id });
    });
    return project;
  }

  async function createDatabase({ tenantId, projectId = null, name, engine = 'mysql', actor }) {
    const database = {
      id: `db-${Date.now()}-${randomToken().slice(0, 6)}`,
      tenantId,
      projectId,
      name,
      engine,
      status: 'provisioning',
      createdAt: new Date().toISOString(),
    };
    await inTransaction(async () => {
      await runSql(
        db,
        'INSERT INTO databases (id, tenant_id, project_id, name, engine, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [database.id, database.tenantId, database.projectId, database.name, database.engine, database.status, database.createdAt],
      );
      await addAuditEntry({ actor, action: 'create_database', resource: database.id });
    });
    return database;
  }

  async function addAuditEntry({ actor, action, resource, details = null }) {
    const id = `audit-${Date.now()}-${randomToken().slice(0, 8)}`;
    await runSql(
      db,
      'INSERT INTO audit_log (id, actor, action, resource, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, actor, action, resource, details, new Date().toISOString()],
    );
  }

  async function getMetrics() {
    const totals = await getSql(db, `
      SELECT
        (SELECT COUNT(*) FROM tenants) as totalTenants,
        (SELECT COUNT(*) FROM projects) as totalProjects,
        (SELECT COUNT(*) FROM databases) as totalDatabases,
        (SELECT COUNT(*) FROM sessions WHERE revoked = 0 AND expires_at > ?) as activeSessions,
        (SELECT COUNT(*) FROM audit_log) as totalAuditEntries
    `, [new Date().toISOString()]);

    const usageRows = await allSql(db, 'SELECT * FROM usage_events ORDER BY captured_at DESC LIMIT 25');
    return { metrics: totals, usage: usageRows };
  }

  async function getAuditLog(limit = 25) {
    return allSql(db, 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  async function getSnapshot() {
    const [users, tenants, projects, databases, apiKeys, sessions, auditLog, usage] = await Promise.all([
      allSql(db, 'SELECT * FROM users ORDER BY username ASC'),
      allSql(db, 'SELECT * FROM tenants ORDER BY created_at DESC'),
      allSql(db, 'SELECT * FROM projects ORDER BY created_at DESC'),
      allSql(db, 'SELECT * FROM databases ORDER BY created_at DESC'),
      allSql(db, 'SELECT * FROM api_keys ORDER BY created_at DESC'),
      allSql(db, 'SELECT * FROM sessions ORDER BY created_at DESC'),
      allSql(db, 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 25'),
      allSql(db, 'SELECT * FROM usage_events ORDER BY captured_at DESC LIMIT 25'),
    ]);

    return {
      users: users.map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        tenantIds: parseJsonArray(row.tenant_ids),
        createdAt: row.created_at,
      })),
      tenants,
      projects,
      databases,
      apiKeys,
      sessions,
      auditLog,
      usage,
    };
  }

  return {
    db,
    initialize: () => serialize(initialize),
    getUserByUsername: (...args) => serialize(() => getUserByUsername(...args)),
    getUserById: (...args) => serialize(() => getUserById(...args)),
    listTenantsForUser: (...args) => serialize(() => listTenantsForUser(...args)),
    listProjectsForUser: (...args) => serialize(() => listProjectsForUser(...args)),
    listDatabasesForUser: (...args) => serialize(() => listDatabasesForUser(...args)),
    getProjectById: (...args) => serialize(() => getProjectById(...args)),
    getDatabaseById: (...args) => serialize(() => getDatabaseById(...args)),
    canAccessTenant: (...args) => serialize(() => canAccessTenant(...args)),
    createSession: (...args) => serialize(() => createSession(...args)),
    findValidSession: (...args) => serialize(() => findValidSession(...args)),
    revokeSessionById: (...args) => serialize(() => revokeSessionById(...args)),
    createApiKey: (...args) => serialize(() => createApiKey(...args)),
    getApiKey: (...args) => serialize(() => getApiKey(...args)),
    revokeApiKeyById: (...args) => serialize(() => revokeApiKeyById(...args)),
    listAccessibleTenantIds: (...args) => serialize(() => listAccessibleTenantIds(...args)),
    getTenantById: (...args) => serialize(() => getTenantById(...args)),
    getCurrentUsagePeriod: (...args) => serialize(() => getCurrentUsagePeriod(...args)),
    applyStripeSubscriptionEvent: (...args) => serialize(() => applyStripeSubscriptionEvent(...args)),
    getUsageSummary: (...args) => serialize(() => getUsageSummary(...args)),
    reserveUsage: (...args) => serialize(() => reserveUsage(...args)),
    completeUsageReservation: (...args) => serialize(() => completeUsageReservation(...args)),
    getUsageHistory: (...args) => serialize(() => getUsageHistory(...args)),
    getUsageNotifications: (...args) => serialize(() => getUsageNotifications(...args)),
    createTenant: (...args) => serialize(() => createTenant(...args)),
    createProject: (...args) => serialize(() => createProject(...args)),
    createDatabase: (...args) => serialize(() => createDatabase(...args)),
    addAuditEntry: (...args) => serialize(() => addAuditEntry(...args)),
    getMetrics: (...args) => serialize(() => getMetrics(...args)),
    getAuditLog: (...args) => serialize(() => getAuditLog(...args)),
    getSnapshot: (...args) => serialize(() => getSnapshot(...args)),
    close: () => serialize(() => new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())))),
    resolveDbPath,
  };
}

module.exports = {
  createRepository,
  hashPassword,
  verifyPasswordHash,
  randomToken,
  hashBearerToken,
  resolveDbPath,
};
