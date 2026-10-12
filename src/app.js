const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');

function createInitialState() {
  return {
    initialized: true,
    users: [
      {
        id: 'user-admin',
        username: 'admin',
        password: 'admin123',
        role: 'admin',
        createdAt: new Date().toISOString(),
      },
    ],
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

function requireAuth(store) {
  return (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;

    if (!token) {
      return errorResponse(res, 401, 'missing_token', 'Authentication token is required.');
    }

    const session = findSession(store, token);
    if (!session) {
      return errorResponse(res, 401, 'invalid_token', 'The supplied token is invalid or revoked.');
    }

    req.user = session.user;
    req.session = session;
    next();
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

    if (!username || !password) {
      return errorResponse(res, 400, 'invalid_request', 'Username and password are required.');
    }

    const user = store.users.find(
      (entry) => entry.username === username && entry.password === password,
    );

    if (!user) {
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
    const session = findSession(store, req.session.token);
    if (session) {
      session.revoked = true;
    }
    addAuditEntry(store, { actor: req.user.username, action: 'logout', resource: 'session' });
    return res.json({ status: 'logged_out' });
  });

  app.post('/api/v1/auth/keys', requireAuth(store), (req, res) => {
    const { name, scope = 'default' } = req.body || {};

    if (!name) {
      return errorResponse(res, 400, 'invalid_request', 'Key name is required.');
    }

    const apiKey = {
      id: `key-${Date.now()}`,
      name,
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
    const tenants = store.tenants.map((tenant) => ({ ...tenant }));
    res.json({ tenants });
  });

  app.post('/api/v1/tenants', requireAuth(store), (req, res) => {
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
    const projects = store.projects.filter((project) => !tenantId || project.tenantId === tenantId);
    res.json({ projects });
  });

  app.post('/api/v1/projects', requireAuth(store), (req, res) => {
    const { tenantId, name } = req.body || {};

    if (!tenantId || !name) {
      return errorResponse(res, 400, 'invalid_request', 'tenantId and name are required.');
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
    const databases = store.databases.filter((database) => !tenantId || database.tenantId === tenantId);
    res.json({ databases });
  });

  app.post('/api/v1/databases', requireAuth(store), (req, res) => {
    const { tenantId, name, engine = 'mysql' } = req.body || {};

    if (!tenantId || !name) {
      return errorResponse(res, 400, 'invalid_request', 'tenantId and name are required.');
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

module.exports = { createApp, createInitialState, createToken };
