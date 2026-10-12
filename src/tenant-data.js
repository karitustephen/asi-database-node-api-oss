'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { validateTenantSql } = require('./tenant-sql');

const MAX_RECORDS_PER_REQUEST = 100;
const MAX_RECORD_KEY_LENGTH = 256;

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'tenant_data_configuration_error' });
}

function numericOption(value, fallback, name, min, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw configurationError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

function resolvePoolOptions(options, connectionString) {
  const parsedConnectionString = new URL(connectionString);
  const connectionStringTlsOptions = new Set([
    'ssl',
    'sslcert',
    'sslkey',
    'sslmode',
    'sslnegotiation',
    'sslrootcert',
    'uselibpqcompat',
  ]);
  for (const key of parsedConnectionString.searchParams.keys()) {
    if (connectionStringTlsOptions.has(key.toLowerCase())) {
      throw configurationError('TLS options must be configured with ASI_TENANT_PG_SSL, not in ASI_TENANT_PG_URL.');
    }
  }

  const max = numericOption(options.poolMax ?? process.env.ASI_TENANT_PG_POOL_MAX, 10, 'ASI_TENANT_PG_POOL_MAX', 1, 20);
  const connectionTimeoutMillis = numericOption(
    options.connectionTimeoutMillis ?? process.env.ASI_TENANT_PG_CONNECT_TIMEOUT_MS,
    5000,
    'ASI_TENANT_PG_CONNECT_TIMEOUT_MS',
    100,
    30000,
  );
  const idleTimeoutMillis = numericOption(
    options.idleTimeoutMillis ?? process.env.ASI_TENANT_PG_IDLE_TIMEOUT_MS,
    30000,
    'ASI_TENANT_PG_IDLE_TIMEOUT_MS',
    1000,
    300000,
  );
  const statementTimeoutMillis = numericOption(
    options.statementTimeoutMillis ?? process.env.ASI_TENANT_PG_STATEMENT_TIMEOUT_MS,
    5000,
    'ASI_TENANT_PG_STATEMENT_TIMEOUT_MS',
    100,
    30000,
  );

  let ssl = options.ssl;
  if (ssl === undefined) {
    const configuredSsl = process.env.ASI_TENANT_PG_SSL;
    if (configuredSsl !== undefined && !['true', 'false'].includes(configuredSsl.toLowerCase())) {
      throw configurationError('ASI_TENANT_PG_SSL must be true or false.');
    }
    if (configuredSsl !== undefined) {
      ssl = configuredSsl.toLowerCase() === 'true';
    } else {
      const hostname = parsedConnectionString.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      ssl = !['localhost', '127.0.0.1', '::1'].includes(hostname);
    }
  }
  const hostname = parsedConnectionString.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (ssl === false && !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw configurationError('TLS cannot be disabled for remote tenant PostgreSQL connections.');
  }
  if (ssl === true) ssl = { rejectUnauthorized: true };

  return {
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    ssl,
    statementTimeoutMillis,
    statement_timeout: statementTimeoutMillis,
    query_timeout: statementTimeoutMillis,
  };
}

function createTenantDataRepository(options = {}) {
  const connectionString = options.connectionString ?? process.env.ASI_TENANT_PG_URL ?? '';
  if (connectionString && !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw configurationError('ASI_TENANT_PG_URL must use the postgres:// or postgresql:// scheme.');
  }
  const configured = Boolean(connectionString || options.pool);
  const poolOptions = configured
    ? resolvePoolOptions(options, connectionString || 'postgres://localhost/tenant_data')
    : null;
  const pool = options.pool || (connectionString
    ? new Pool({ connectionString, ...poolOptions })
    : null);
  let initialization;

  pool?.on?.('error', (error) => {
    console.error('Idle tenant PostgreSQL connection error.', error);
  });

  async function migrate() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['asi-tenant-data-migrations']);
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
        throw configurationError('The tenant PostgreSQL role must not be a superuser or have BYPASSRLS.');
      }
      await client.query('CREATE SCHEMA IF NOT EXISTS tenant_data');
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenant_data.schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const migrationDirectory = path.join(__dirname, 'migrations', 'postgres');
      const migrationFiles = fs.readdirSync(migrationDirectory)
        .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/.test(file))
        .sort();
      for (const file of migrationFiles) {
        const version = file.replace(/\.sql$/, '');
        const applied = await client.query(
          'SELECT version FROM tenant_data.schema_migrations WHERE version = $1',
          [version],
        );
        if (applied.rowCount > 0) continue;
        const migration = fs.readFileSync(path.join(migrationDirectory, file), 'utf8');
        await client.query(migration);
        await client.query(
          'INSERT INTO tenant_data.schema_migrations (version) VALUES ($1)',
          [version],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'PostgreSQL migration and rollback both failed.');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function initialize() {
    if (!configured) {
      throw Object.assign(new Error('Tenant PostgreSQL data plane is not configured.'), {
        code: 'tenant_data_not_configured',
      });
    }
    if (!initialization) {
      initialization = migrate().catch((error) => {
        initialization = null;
        throw error;
      });
    }
    return initialization;
  }

  async function withTenantTransaction(context, operation, readOnly = false) {
    let client;
    let transactionStarted = false;
    try {
      await initialize();
      client = await pool.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      if (readOnly) await client.query('SET TRANSACTION READ ONLY');
      await client.query(
        'SELECT set_config($1, $2, true)',
        ['statement_timeout', `${poolOptions.statementTimeoutMillis}ms`],
      );
      await client.query(
        `SELECT
          set_config('asi.tenant_id', $1, true),
          set_config('asi.project_id', $2, true),
          set_config('asi.database_id', $3, true)`,
        [context.tenantId, context.projectId, context.databaseId],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted && client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Tenant data transaction and rollback both failed.');
        }
      }
      error.tenantDataError = true;
      throw error;
    } finally {
      client?.release();
    }
  }

  async function listRecords(context, limit, offset = 0) {
    const safeLimit = numericOption(limit, MAX_RECORDS_PER_REQUEST, 'limit', 1, MAX_RECORDS_PER_REQUEST);
    const safeOffset = numericOption(offset, 0, 'offset', 0, 1_000_000);
    return withTenantTransaction(context, (client) => client.query(
      `SELECT id, record_key, value, created_at, updated_at
       FROM tenant_data.records
       ORDER BY record_key
       LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset],
    ), true);
  }

  async function getRecord(context, recordKey) {
    return withTenantTransaction(context, (client) => client.query(
      `SELECT id, record_key, value, created_at, updated_at
       FROM tenant_data.records
       WHERE record_key = $1`,
      [recordKey],
    ), true);
  }

  async function putRecord(context, recordKey, value) {
    return withTenantTransaction(context, (client) => client.query(
      `INSERT INTO tenant_data.records
        (id, tenant_id, project_id, database_id, record_key, value)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (database_id, record_key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now()
       RETURNING id, record_key, value, created_at, updated_at`,
      [crypto.randomUUID(), context.tenantId, context.projectId, context.databaseId, recordKey, JSON.stringify(value)],
    ));
  }

  async function deleteRecord(context, recordKey) {
    return withTenantTransaction(context, (client) => client.query(
      'DELETE FROM tenant_data.records WHERE record_key = $1 RETURNING id, record_key',
      [recordKey],
    ));
  }

  async function execute(context, sql, params = []) {
    const validated = validateTenantSql(sql, params);
    const result = await withTenantTransaction(
      context,
      (client) => client.query(sql, params),
      validated.statementType === 'select',
    );
    return { ...result, statementType: validated.statementType };
  }

  async function check() {
    if (!configured) return { status: 'not_configured' };
    try {
      await initialize();
      await pool.query('SELECT 1');
      return { status: 'available' };
    } catch (error) {
      console.error('Tenant PostgreSQL data plane readiness check failed.', error);
      return { status: 'unavailable', code: error.code || 'database_error' };
    }
  }

  async function close() {
    if (pool) await pool.end();
  }

  return {
    configured,
    initialize,
    check,
    listRecords,
    getRecord,
    putRecord,
    deleteRecord,
    execute,
    close,
  };
}

function validateRecordKey(recordKey) {
  return typeof recordKey === 'string'
    && recordKey.trim().length > 0
    && recordKey.length <= MAX_RECORD_KEY_LENGTH;
}

function validateRecordValue(value) {
  if (value === null || typeof value !== 'object') return false;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    return false;
  }
  return serialized !== undefined && Buffer.byteLength(serialized) <= 64 * 1024;
}

module.exports = {
  createTenantDataRepository,
  validateRecordKey,
  validateRecordValue,
  MAX_RECORDS_PER_REQUEST,
};
