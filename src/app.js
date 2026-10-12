const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    return false;
  }

  const separatorIndex = storedHash.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === storedHash.length - 1) {
    return false;
  }

  const salt = storedHash.slice(0, separatorIndex);
  const expectedHash = storedHash.slice(separatorIndex + 1);
  const candidateHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(candidateHash, 'hex'));
  } catch (error) {
    return false;
  }
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function createInitialState() {
  const users = [
    {
      id: 'user-admin',
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      role: 'admin',
      tenantIds: ['tenant-demo'],
      createdAt: new Date().toISOString(),
    },
    {
      id: 'user-demo',
      username: 'tenant-user',
      passwordHash: hashPassword('tenant123'),
      role: 'tenant_admin',
      tenantIds: ['tenant-demo'],
      createdAt: new Date().toISOString(),
    },
  ];

  return {
    initialized: true,
    users,
    tenants: [
      {
        id: 'tenant-demo',
        name: 'Demo Tenant',
        region: 'eastus',
        plan: 'starter',
        createdAt: new Date().toISOString(),
      },
    ],
    projects: [
      {
        id: 'project-demo',
        tenantId: 'tenant-demo',
        name: 'Primary Sandbox',
        status: 'active',
        createdAt: new Date().toISOString(),
      },
    ],
    databases: [
      {
        id: 'db-demo',
        tenantId: 'tenant-demo',
        name: 'sandpit',
        engine: 'mysql',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
    ],
    apiKeys: [],
    sessions: [],
    auditLog: [
      {
        id: 'audit-1',
        actor: 'system',
        action: 'bootstrap',
        resource: 'platform',
        createdAt: new Date().toISOString(),
      },
    ],
    usage: [
      {
        id: 'usage-1',
        tenantId: 'tenant-demo',
        projectId: 'project-demo',
        readOps: 120,
        writeOps: 22,
        capturedAt: new Date().toISOString(),
      },
    ],
  };
}

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    error: {
      code,
      message,
    },
  });
}

function addAuditEntry(store, entry) {
  store.auditLog.unshift({
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...entry,
    createdAt: new Date().toISOString(),
  });
}

function findSession(store, token) {
  return store.sessions.find((session) => session.token === token && !session.revoked);
}

function canAccessTenant(user, tenantId) {
  if (!tenantId) {
    return true;
  }

  if (user && user.role === 'admin') {
    return true;
  }

  if (!user || !Array.isArray(user.tenantIds)) {
    return false;
  }

  return user.tenantIds.includes(tenantId);
}

function getAccessibleTenants(store, user) {
  if (!user || user.role === 'admin') {
    return store.tenants;
  }

  const tenantIds = new Set(user.tenantIds || []);
  return store.tenants.filter((tenant) => tenantIds.has(tenant.id));
}

function requireAuth(store) {
  return (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    const apiKeyToken = req.get('x-api-key') || null;
    const candidateToken = token || apiKeyToken;

    if (!candidateToken) {
      return errorResponse(res, 401, 'missing_token', 'Authentication token is required.');
    }

    const session = findSession(store, candidateToken);
    if (session) {
      const user = store.users.find((entry) => entry.id === session.user.id);
      if (!user) {
        return errorResponse(res, 401, 'invalid_token', 'The supplied token is invalid or revoked.');
      }

      req.user = sanitizeUser(user);
      req.session = session;
      req.authType = 'session';
      return next();
    }

    const apiKey = store.apiKeys.find((key) => key.token === candidateToken && !key.revoked);
    if (!apiKey) {
      return errorResponse(res, 401, 'invalid_token', 'The supplied token is invalid or revoked.');
    }

    const user = store.users.find((entry) => entry.id === apiKey.userId);
    if (!user) {
      return errorResponse(res, 401, 'invalid_token', 'The supplied API key is invalid.');
    }

    req.user = sanitizeUser(user);
    req.session = null;
    req.authType = 'api_key';
    return next();
  };
}

function createApp(initialState) {
  const store = initialState || createInitialState();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-API-Version', 'v1');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/ui', express.static(path.join(__dirname, '../ui/public')));

  app.get('/', (req, res) => {
    res.json({
      name: 'asi-database-node-api-oss',
      description: 'Open-source AI database API for the Arybit ecosystem',
      status: 'ok',
      endpoints: [
        '/health',
        '/api/v1/health',
        '/api/v1/auth/login',
        '/api/v1/tenants',
        '/api/v1/projects',
        '/api/v1/databases',
      ],
    });
  });

  app.get(['/health', '/api/v1/health'], (req, res) => {
    res.json({ status: 'ok', service: 'asi-database-node-api-oss', timestamp: new Date().toISOString() });
  });

  app.get(['/ready', '/api/v1/ready'], (req, res) => {
    const ready = store.initialized && Array.isArray(store.tenants);
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      initialized: store.initialized,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/openapi.json', (req, res) => {
    res.json({
      openapi: '3.0.3',
      info: {
        title: 'ASI Database Node API',
        version: '1.0.0',
        description: 'Database and tenant management API for the Arybit ecosystem.',
      },
      servers: [{ url: 'http://localhost:3000' }],
      paths: {
        '/health': { get: { summary: 'Health check' } },
        '/api/v1/auth/login': { post: { summary: 'Login with username and password' } },
        '/api/v1/tenants': {
          get: { summary: 'List tenants' },
          post: { summary: 'Create tenant' },
        },
        '/api/v1/projects': {
          get: { summary: 'List projects' },
          post: { summary: 'Create project' },
        },
        '/api/v1/databases': {
          get: { summary: 'List databases' },
          post: { summary: 'Create database' },
        },
      },
    });
  });

  app.post('/api/v1/auth/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      return errorResponse(res, 400, 'invalid_request', 'Username and password are required.');
    }

    const user = store.users.find((entry) => entry.username === username);

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return errorResponse(res, 401, 'invalid_credentials', 'Username or password is incorrect.');
    }

    const token = createToken();
    const session = {
      id: `session-${Date.now()}`,
      token,
      user: { id: user.id, username: user.username, role: user.role },
      createdAt: new Date().toISOString(),
      revoked: false,
    };
    store.sessions.push(session);
    addAuditEntry(store, { actor: user.username, action: 'login', resource: 'session' });

    return res.json({
      token,
      user: session.user,
      expiresIn: 86400,
    });
  });

  app.post('/api/v1/auth/logout', requireAuth(store), (req, res) => {
    const session = findSession(store, req.session ? req.session.token : null);
    if (session) {
      session.revoked = true;
    }
    addAuditEntry(store, { actor: req.user.username, action: 'logout', resource: 'session' });
    return res.json({ status: 'logged_out' });
  });

  app.post('/api/v1/auth/keys', requireAuth(store), (req, res) => {
    const { name, scope = 'default' } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return errorResponse(res, 400, 'invalid_request', 'Key name is required.');
    }

    const apiKey = {
      id: `key-${Date.now()}`,
      name: name.trim(),
      scope,
      userId: req.user.id,
      token: createToken(),
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    store.apiKeys.push(apiKey);
    addAuditEntry(store, { actor: req.user.username, action: 'issue_api_key', resource: name });

    return res.status(201).json({
      id: apiKey.id,
      name: apiKey.name,
      scope: apiKey.scope,
      token: apiKey.token,
      createdAt: apiKey.createdAt,
    });
  });

  app.get('/api/v1/tenants', requireAuth(store), (req, res) => {
    const tenants = getAccessibleTenants(store, req.user).map((tenant) => ({ ...tenant }));
    res.json({ tenants });
  });

  app.post('/api/v1/tenants', requireAuth(store), (req, res) => {
    if (req.user.role !== 'admin') {
      return errorResponse(res, 403, 'forbidden', 'Only administrators may create tenants.');
    }

    const { name, region = 'eastus', plan = 'starter' } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return errorResponse(res, 400, 'invalid_name', 'Tenant name must be at least 2 characters long.');
    }

    const created = {
      id: `tenant-${Date.now()}`,
      name: name.trim(),
      region,
      plan,
      createdAt: new Date().toISOString(),
    };

    store.tenants.push(created);
    addAuditEntry(store, { actor: req.user.username, action: 'create_tenant', resource: created.id });

    return res.status(201).json({ tenant: created });
  });

  app.get('/api/v1/projects', requireAuth(store), (req, res) => {
    const { tenantId } = req.query;
    const tenantIdValue = typeof tenantId === 'string' ? tenantId : null;

    if (tenantIdValue && !canAccessTenant(req.user, tenantIdValue)) {
      return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
    }

    const projects = store.projects.filter((project) => {
      if (!tenantIdValue) {
        return req.user.role === 'admin' || (req.user.tenantIds || []).includes(project.tenantId);
      }
      return project.tenantId === tenantIdValue;
    });

    res.json({ projects });
  });

  app.post('/api/v1/projects', requireAuth(store), (req, res) => {
    const { tenantId, name } = req.body || {};

    if (!tenantId || !name) {
      return errorResponse(res, 400, 'invalid_request', 'tenantId and name are required.');
    }

    if (!canAccessTenant(req.user, tenantId)) {
      return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
    }

    const tenantExists = store.tenants.some((tenant) => tenant.id === tenantId);
    if (!tenantExists) {
      return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
    }

    const created = {
      id: `project-${Date.now()}`,
      tenantId,
      name,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    store.projects.push(created);
    addAuditEntry(store, { actor: req.user.username, action: 'create_project', resource: created.id });

    return res.status(201).json({ project: created });
  });

  app.get('/api/v1/databases', requireAuth(store), (req, res) => {
    const { tenantId } = req.query;
    const tenantIdValue = typeof tenantId === 'string' ? tenantId : null;

    if (tenantIdValue && !canAccessTenant(req.user, tenantIdValue)) {
      return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
    }

    const databases = store.databases.filter((database) => {
      if (!tenantIdValue) {
        return req.user.role === 'admin' || (req.user.tenantIds || []).includes(database.tenantId);
      }
      return database.tenantId === tenantIdValue;
    });

    res.json({ databases });
  });

  app.post('/api/v1/databases', requireAuth(store), (req, res) => {
    const { tenantId, name, engine = 'mysql' } = req.body || {};

    if (!tenantId || !name) {
      return errorResponse(res, 400, 'invalid_request', 'tenantId and name are required.');
    }

    if (!canAccessTenant(req.user, tenantId)) {
      return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
    }

    const tenantExists = store.tenants.some((tenant) => tenant.id === tenantId);
    if (!tenantExists) {
      return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
    }

    const created = {
      id: `db-${Date.now()}`,
      tenantId,
      name,
      engine,
      status: 'provisioning',
      createdAt: new Date().toISOString(),
    };

    store.databases.push(created);
    addAuditEntry(store, { actor: req.user.username, action: 'create_database', resource: created.id });

    return res.status(201).json({ database: created });
  });

  app.get('/api/v1/metrics', requireAuth(store), (req, res) => {
    const summary = {
      totalTenants: store.tenants.length,
      totalProjects: store.projects.length,
      totalDatabases: store.databases.length,
      activeSessions: store.sessions.filter((session) => !session.revoked).length,
      totalAuditEntries: store.auditLog.length,
    };
    res.json({ metrics: summary, usage: store.usage });
  });

  app.get('/api/v1/audit', requireAuth(store), (req, res) => {
    res.json({ auditLog: store.auditLog.slice(0, 25) });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    errorResponse(res, 500, 'internal_error', 'An internal server error occurred.');
  });

  app.use((req, res) => {
    errorResponse(res, 404, 'not_found', `Route not found: ${req.method} ${req.originalUrl}`);
  });

  return app;
}

module.exports = { createApp, createInitialState, createToken, verifyPassword };
