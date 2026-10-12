'use strict';

const { parse } = require('pgsql-ast-parser');

const TABLE = Object.freeze({ schema: 'tenant_data', name: 'records' });
const COLUMNS = new Set([
  'id',
  'tenant_id',
  'project_id',
  'database_id',
  'record_key',
  'value',
  'created_at',
  'updated_at',
]);
const ALLOWED_NODE_TYPES = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'table',
  'ref',
  'parameter',
  'integer',
  'binary',
  'unary',
  'values',
]);

function invalidSql(message) {
  return Object.assign(new Error(message), { code: 'invalid_tenant_sql' });
}

function isParameter(node) {
  return node?.type === 'parameter'
    && /^\$[1-9]\d*$/.test(node.name);
}

function validateTenantSql(sql, params = []) {
  if (typeof sql !== 'string' || sql.trim().length === 0 || sql.length > 16_384) {
    throw invalidSql('sql must be a non-empty string no longer than 16384 characters.');
  }
  if (!Array.isArray(params) || params.length > 100) {
    throw invalidSql('params must be an array containing at most 100 values.');
  }
  if (/--|\/\*|\*\//.test(sql)) {
    throw invalidSql('SQL comments are not supported.');
  }

  let statements;
  try {
    statements = parse(sql);
  } catch (error) {
    throw invalidSql(`SQL could not be parsed: ${error.message}`);
  }
  if (statements.length !== 1) {
    throw invalidSql('Exactly one SQL statement is allowed.');
  }

  const [statement] = statements;
  if (!['select', 'insert', 'update', 'delete'].includes(statement.type)) {
    throw invalidSql('Only SELECT, INSERT, UPDATE, and DELETE are allowed.');
  }
  if (statement.type === 'select'
    && (statement.into || statement.from?.some((source) => source.type !== 'table'))) {
    throw invalidSql('Subqueries and non-table sources are not supported.');
  }
  if (statement.type === 'select' && statement.from?.length !== 1) {
    throw invalidSql('SELECT must read only tenant_data.records.');
  }
  if (statement.type === 'update' && statement.from) {
    throw invalidSql('UPDATE FROM is not supported.');
  }
  if (statement.type === 'delete' && (statement.using || statement.from?.type === 'join')) {
    throw invalidSql('DELETE USING is not supported.');
  }
  if (statement.type === 'insert'
    && (statement.insert?.type !== 'values' || statement.insert.values.length !== 1 || statement.onConflict)) {
    throw invalidSql('INSERT must contain exactly one VALUES row and cannot use ON CONFLICT.');
  }

  const tableReferences = [];
  const parameterIndexes = new Set();
  const seen = new Set();
  const allowedIntegerValues = new Set();
  if (statement.type === 'select') {
    if (statement.limit?.limit?.type === 'integer') allowedIntegerValues.add(statement.limit.limit);
    if (statement.limit?.offset?.type === 'integer') allowedIntegerValues.add(statement.limit.offset);
  }
  function inspect(value, isRoot = false) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    if (value.type && !ALLOWED_NODE_TYPES.has(value.type)) {
      throw invalidSql(`SQL expression type "${value.type}" is not supported.`);
    }
    if (value.type === 'integer' && !allowedIntegerValues.has(value)) {
      throw invalidSql('Use positional parameters for integer values; only LIMIT and OFFSET may be literals.');
    }
    if (!isRoot && ['select', 'insert', 'update', 'delete'].includes(value.type)) {
      throw invalidSql('Nested SQL statements are not supported.');
    }
    if (value.type === 'call') {
      throw invalidSql('SQL function calls are not supported.');
    }
    if (value.type === 'table') {
      tableReferences.push(value.name);
    }
    if (value.type === 'ref' && value.name !== '*' && !COLUMNS.has(value.name)) {
      throw invalidSql(`Column "${value.name}" is not available.`);
    }
    if (value.type === 'parameter') {
      if (!isParameter(value)) {
        throw invalidSql('Only positional SQL parameters ($1, $2, ...) are supported.');
      }
      parameterIndexes.add(Number(value.name.slice(1)));
    }
    for (const child of Object.values(value)) inspect(child);
  }
  inspect(statement, true);

  let target;
  if (statement.type === 'insert') target = statement.into;
  if (statement.type === 'update') target = statement.table;
  if (statement.type === 'delete') target = statement.from;
  const allTables = target ? [...tableReferences, target] : tableReferences;
  if (allTables.length === 0 || allTables.some((table) => table?.schema !== TABLE.schema || table?.name !== TABLE.name)) {
    throw invalidSql('SQL may reference only tenant_data.records.');
  }

  for (let index = 1; index <= params.length; index += 1) {
    if (!parameterIndexes.has(index)) {
      throw invalidSql(`SQL parameter $${index} is not used.`);
    }
  }
  for (const index of parameterIndexes) {
    if (index > params.length) {
      throw invalidSql(`SQL parameter $${index} has no matching value.`);
    }
  }

  let maxOperations;
  if (statement.type === 'select') {
    const limit = statement.limit?.limit;
    const value = limit?.type === 'parameter'
      ? params[Number(limit.name.slice(1)) - 1]
      : limit?.value;
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
      throw invalidSql('SELECT must include a LIMIT between 1 and 100 (a literal or parameter).');
    }
    const offset = statement.limit?.offset;
    const offsetValue = offset?.type === 'parameter'
      ? params[Number(offset.name.slice(1)) - 1]
      : offset?.value;
    if (offset && (!Number.isSafeInteger(offsetValue) || offsetValue < 0 || offsetValue > 1_000_000)) {
      throw invalidSql('SELECT OFFSET must be a non-negative integer no greater than 1000000.');
    }
    maxOperations = value;
  } else if (statement.type === 'update' || statement.type === 'delete') {
    const where = statement.where;
    const left = where?.left;
    const right = where?.right;
    if (where?.type !== 'binary'
      || where.op !== '='
      || left?.type !== 'ref'
      || left.name !== 'record_key'
      || !isParameter(right)) {
      throw invalidSql('UPDATE and DELETE must match one record by record_key = $n.');
    }
    maxOperations = 1;
  } else {
    maxOperations = 1;
  }

  return { statementType: statement.type, maxOperations };
}

module.exports = { validateTenantSql };
