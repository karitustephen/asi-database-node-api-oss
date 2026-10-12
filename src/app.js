const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const Stripe = require('stripe');
const { createRepository, verifyPasswordHash, randomToken } = require('./storage');
const { createPlanConfiguration, currentBillingPeriod } = require('./plans');

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    error: {
      code,
      message,
    },
  });
}

function createToken() {
  return randomToken();
}

function parseBoolean(value) {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return Boolean(value);
}

function requireAuth(repository) {
  return async function authMiddleware(req, res, next) {
    try {
      const authorization = req.get('authorization') || '';
      const headerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
      const apiKeyToken = req.get('x-api-key') || null;
      const candidateToken = headerToken || apiKeyToken;

      if (!candidateToken) {
        return errorResponse(res, 401, 'missing_token', 'Authentication token is required.');
      }

      const session = await repository.findValidSession(candidateToken);
      if (session) {
        const user = await repository.getUserById(session.user_id);
        if (!user) {
          return errorResponse(res, 401, 'invalid_token', 'The supplied token is invalid or revoked.');
        }

        req.user = user;
        req.session = session;
        req.authType = 'session';
        return next();
      }

      const apiKey = await repository.getApiKey(candidateToken);
      if (!apiKey) {
        return errorResponse(res, 401, 'invalid_token', 'The supplied token is invalid or revoked.');
      }

      const user = await repository.getUserById(apiKey.user_id);
      if (!user) {
        return errorResponse(res, 401, 'invalid_token', 'The supplied API key is invalid.');
      }

      req.user = user;
      req.session = null;
      req.apiKey = apiKey;
      req.authType = 'api_key';
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireWriteAccess(req, res, next) {
  if (req.apiKey && ['read', 'read-only'].includes(req.apiKey.scope)) {
    return errorResponse(res, 403, 'forbidden', 'This API key does not permit write operations.');
  }
  return next();
}

function createPlanConfig(options) {
  const overrides = options.planConfig || (process.env.ASI_PLAN_QUOTAS
    ? JSON.parse(process.env.ASI_PLAN_QUOTAS)
    : {});
  return createPlanConfiguration(overrides);
}

function requireUsage(repository, planConfig, gracePeriodSeconds, operation, resource, clock) {
  return async function usageMiddleware(req, res, next) {
    try {
      const now = clock();
      let tenantIds;
      if (req.method === 'GET') {
        const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null;
        if (tenantId) {
          tenantIds = await repository.canAccessTenant(req.user, tenantId) ? [tenantId] : [];
        } else {
          tenantIds = await repository.listAccessibleTenantIds(req.user);
        }
      } else {
        const tenantId = req.body?.tenantId;
        tenantIds = typeof tenantId === 'string' && await repository.canAccessTenant(req.user, tenantId)
          ? [tenantId]
          : [];
      }

      const periodsByTenantId = {};
      for (const tenantId of tenantIds) {
        const period = await repository.getCurrentUsagePeriod(tenantId, now);
        if (period) {
          periodsByTenantId[tenantId] = period;
        }
      }
      const reservation = await repository.reserveUsage({
        tenantIds,
        period: currentBillingPeriod(now),
        periodsByTenantId,
        operation,
        actor: req.user.username,
        resource,
        now,
        includedOperations: Object.fromEntries(
          Object.entries(planConfig).map(([name, plan]) => [name, plan.monthlyIncludedOperations]),
        ),
        gracePeriodSeconds,
      });
      if (reservation) {
        let finalized = false;
        const originalJson = res.json.bind(res);
        res.json = (...args) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (!finalized) {
              finalized = true;
              repository.completeUsageReservation(reservation, true, clock())
                .then(() => originalJson(...args))
                .catch(next);
            }
            return res;
          }
          if (!finalized) {
            finalized = true;
            repository.completeUsageReservation(reservation, false, clock())
              .catch((error) => console.error('Failed to release unsuccessful tenant usage reservation.', error));
          }
          return originalJson(...args);
        };
        res.once('finish', () => {
          if (!finalized) {
            finalized = true;
            repository.completeUsageReservation(reservation, false, clock())
              .catch((error) => console.error('Failed to release unsuccessful tenant usage reservation.', error));
          }
        });
        res.once('close', () => {
          if (!res.writableFinished && !finalized) {
            finalized = true;
            repository.completeUsageReservation(reservation, false)
              .catch((error) => console.error('Failed to release abandoned tenant usage reservation.', error));
          }
        });
      }
      return next();
    } catch (error) {
      if (error.code === 'usage_limit_exceeded') {
        return res.status(429).json({
          error: {
            code: 'usage_limit_exceeded',
            message: 'This tenant has used its included operations and grace period for the current billing month.',
          },
          usage: {
            tenantId: error.usage.tenantId,
            period: error.usage.period,
            includedOperations: error.usage.includedOperations,
            usedOperations: error.usage.usedOperations,
            graceDeadline: error.usage.graceDeadline,
          },
        });
      }
      return next(error);
    }
  };
}

function createApp(options = {}) {
  const dbPath = options.dbPath || process.env.ASI_DB_PATH || path.resolve(process.cwd(), '.data', 'asi-database.sqlite');
  const configuredSessionTtl = options.sessionTtlSeconds ?? process.env.SESSION_TTL_SECONDS ?? 86400;
  const sessionTtlSeconds = Number(configuredSessionTtl);
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 1) {
    throw new Error('SESSION_TTL_SECONDS must be a positive integer.');
  }
  const usageGracePeriodSeconds = Number(
    options.usageGracePeriodSeconds ?? process.env.ASI_USAGE_GRACE_PERIOD_SECONDS ?? 3600,
  );
  if (!Number.isSafeInteger(usageGracePeriodSeconds) || usageGracePeriodSeconds < 0) {
    throw new Error('ASI_USAGE_GRACE_PERIOD_SECONDS must be a non-negative integer.');
  }
  const clock = options.clock || (() => new Date());
  if (typeof clock !== 'function') {
    throw new Error('clock must be a function that returns a Date.');
  }
  let planConfig;
  try {
    planConfig = createPlanConfig(options);
  } catch (error) {
    throw new Error(`Invalid plan configuration: ${error.message}`, { cause: error });
  }
  const repository = createRepository(dbPath, options);
  const stripeSecretKey = options.stripeSecretKey ?? process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = options.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  const stripePriceIds = options.stripePriceIds || {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    growth: process.env.STRIPE_PRICE_GROWTH,
  };
  const stripe = options.stripeClient || (stripeSecretKey ? new Stripe(stripeSecretKey) : null);
  const planByPriceId = {};
  for (const [plan, priceId] of Object.entries(stripePriceIds)) {
    if (priceId) {
      if (!Object.hasOwn(planConfig, plan) || typeof priceId !== 'string') {
        throw new Error(`Stripe price configuration contains an invalid plan: ${plan}`);
      }
      if (planByPriceId[priceId]) {
        throw new Error(`Stripe price ${priceId} is configured for multiple plans.`);
      }
      planByPriceId[priceId] = plan;
    }
  }
  const publicAppUrl = options.publicAppUrl ?? process.env.PUBLIC_APP_URL;
  const app = express();
  app.locals.initialize = () => repository.initialize();
  app.locals.close = () => repository.close();

  app.disable('x-powered-by');
  app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
    try {
      if (!stripe || !stripeWebhookSecret) {
        return errorResponse(res, 503, 'billing_unavailable', 'Stripe webhook processing is not configured.');
      }
      const signature = req.get('stripe-signature');
      if (!signature) {
        return errorResponse(res, 400, 'invalid_signature', 'Stripe-Signature header is required.');
      }
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
      } catch (error) {
        return errorResponse(res, 400, 'invalid_signature', 'The Stripe webhook signature is invalid.');
      }
      const includedOperations = Object.fromEntries(
        Object.entries(planConfig).map(([name, plan]) => [name, plan.monthlyIncludedOperations]),
      );
      await repository.applyStripeSubscriptionEvent(event, planByPriceId, includedOperations);
      return res.json({ received: true });
    } catch (error) {
      return next(error);
    }
  });
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
        '/api/v1/usage',
        '/api/v1/billing/checkout',
        '/api/v1/billing/portal',
        '/api/v1/billing/webhook',
      ],
    });
  });

  app.get(['/health', '/api/v1/health'], (req, res) => {
    res.json({
      status: 'ok',
      service: 'asi-database-node-api-oss',
      timestamp: new Date().toISOString(),
    });
  });

  app.get(['/ready', '/api/v1/ready'], async (req, res, next) => {
    try {
      await repository.initialize();
      const snapshot = await repository.getSnapshot();
      const ready = Boolean(snapshot.tenants && snapshot.users);
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        initialized: ready,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
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
        '/api/v1/auth/login': { post: { summary: 'Authenticate and issue a session token' } },
        '/api/v1/tenants': {
          get: { summary: 'List accessible tenants' },
          post: { summary: 'Create a tenant' },
        },
        '/api/v1/projects': {
          get: { summary: 'List accessible projects' },
          post: { summary: 'Create project' },
        },
        '/api/v1/databases': {
          get: { summary: 'List accessible databases' },
          post: { summary: 'Create database' },
        },
        '/api/v1/usage': { get: { summary: 'Get a tenant billing-period usage summary and recent usage history' } },
        '/api/v1/billing/checkout': { post: { summary: 'Create a Stripe Checkout subscription session' } },
        '/api/v1/billing/portal': { post: { summary: 'Create a Stripe Billing Portal session' } },
        '/api/v1/billing/webhook': { post: { summary: 'Process a signature-verified Stripe subscription event' } },
      },
    });
  });

  app.post('/api/v1/auth/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
        return errorResponse(res, 400, 'invalid_request', 'Username and password are required.');
      }

      await repository.initialize();
      const user = await repository.getUserByUsername(username);
      if (!user || !verifyPasswordHash(password, user.passwordHash)) {
        return errorResponse(res, 401, 'invalid_credentials', 'Username or password is incorrect.');
      }

      const token = createToken();
      await repository.createSession(token, user, sessionTtlSeconds);
      return res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
        expiresIn: sessionTtlSeconds,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/v1/auth/logout', requireAuth(repository), requireWriteAccess, async (req, res, next) => {
    try {
      if (!req.session) {
        return errorResponse(res, 400, 'invalid_request', 'API keys cannot log out; revoke the key instead.');
      }
      await repository.revokeSessionById(req.session.id, req.user.username);
      return res.json({ status: 'logged_out' });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/v1/auth/keys', requireAuth(repository), requireWriteAccess, async (req, res, next) => {
    try {
      const { name, scope = 'default' } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return errorResponse(res, 400, 'invalid_request', 'A valid key name is required.');
      }
      if (!['default', 'read-only', 'read-write'].includes(scope)) {
        return errorResponse(res, 400, 'invalid_request', 'scope must be default, read-only, or read-write.');
      }

      const apiKey = await repository.createApiKey(req.user.id, name.trim(), scope, req.user.username);

      return res.status(201).json({
        id: apiKey.id,
        name: apiKey.name,
        scope: apiKey.scope,
        token: apiKey.token,
        createdAt: apiKey.createdAt,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/v1/auth/keys/revoke', requireAuth(repository), requireWriteAccess, async (req, res, next) => {
    try {
      const { keyId } = req.body || {};
      if (!keyId || typeof keyId !== 'string') {
        return errorResponse(res, 400, 'invalid_request', 'A valid keyId is required.');
      }

      const revoked = await repository.revokeApiKeyById(keyId, req.user);
      if (!revoked) {
        return errorResponse(res, 404, 'key_not_found', 'The specified API key does not exist.');
      }
      return res.json({ status: 'revoked', keyId });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/v1/billing/checkout', requireAuth(repository), async (req, res, next) => {
    try {
      const tenantId = req.body?.tenantId;
      const plan = req.body?.plan;
      if (typeof tenantId !== 'string' || !Object.hasOwn(planConfig, plan) || !stripePriceIds[plan]) {
        return errorResponse(res, 400, 'invalid_request', 'A tenantId and a Stripe-configured plan are required.');
      }
      if (!(await repository.canAccessTenant(req.user, tenantId))) {
        return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
      }
      if (req.user.role !== 'admin' && req.user.role !== 'tenant_admin') {
        return errorResponse(res, 403, 'forbidden', 'Only tenant administrators may manage billing.');
      }
      if (!stripe || !publicAppUrl) {
        return errorResponse(res, 503, 'billing_unavailable', 'Stripe checkout is not configured.');
      }
      const tenant = await repository.getTenantById(tenantId);
      if (!tenant) {
        return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
      }
      if (tenant.stripe_subscription_id && tenant.billing_status !== 'canceled') {
        return errorResponse(res, 409, 'subscription_exists', 'Manage the tenant subscription through the Stripe billing portal.');
      }
      let baseUrl;
      try {
        baseUrl = new URL(publicAppUrl);
      } catch (error) {
        return errorResponse(res, 503, 'billing_unavailable', 'PUBLIC_APP_URL must be a valid absolute URL.');
      }
      if (baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) {
        return errorResponse(res, 503, 'billing_unavailable', 'PUBLIC_APP_URL must use HTTPS.');
      }
      const idempotencyKey = req.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,255}$/.test(idempotencyKey)) {
        return errorResponse(res, 400, 'invalid_request', 'A valid Idempotency-Key header is required.');
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: stripePriceIds[plan], quantity: 1 }],
        ...(tenant.stripe_customer_id ? { customer: tenant.stripe_customer_id } : {}),
        client_reference_id: tenantId,
        metadata: { tenantId, plan },
        subscription_data: { metadata: { tenantId, plan } },
        success_url: new URL('/ui/?checkout=success', baseUrl).toString(),
        cancel_url: new URL('/ui/?checkout=cancelled', baseUrl).toString(),
      }, {
        idempotencyKey,
      });
      if (typeof session.url !== 'string') {
        throw new Error('Stripe did not return a checkout URL.');
      }
      return res.status(201).json({ url: session.url });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/v1/billing/portal', requireAuth(repository), async (req, res, next) => {
    try {
      const tenantId = req.body?.tenantId;
      if (typeof tenantId !== 'string') {
        return errorResponse(res, 400, 'invalid_request', 'tenantId is required.');
      }
      if (!(await repository.canAccessTenant(req.user, tenantId))) {
        return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
      }
      if (req.user.role !== 'admin' && req.user.role !== 'tenant_admin') {
        return errorResponse(res, 403, 'forbidden', 'Only tenant administrators may manage billing.');
      }
      if (!stripe || !publicAppUrl) {
        return errorResponse(res, 503, 'billing_unavailable', 'Stripe billing portal is not configured.');
      }
      const tenant = await repository.getTenantById(tenantId);
      if (!tenant) {
        return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
      }
      if (!tenant.stripe_customer_id) {
        return errorResponse(res, 404, 'billing_account_not_found', 'This tenant does not yet have a Stripe customer account.');
      }
      let baseUrl;
      try {
        baseUrl = new URL(publicAppUrl);
      } catch (error) {
        return errorResponse(res, 503, 'billing_unavailable', 'PUBLIC_APP_URL must be a valid absolute URL.');
      }
      if (baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) {
        return errorResponse(res, 503, 'billing_unavailable', 'PUBLIC_APP_URL must use HTTPS.');
      }
      const session = await stripe.billingPortal.sessions.create({
        customer: tenant.stripe_customer_id,
        return_url: new URL('/ui/', baseUrl).toString(),
      });
      if (typeof session.url !== 'string') {
        throw new Error('Stripe did not return a billing portal URL.');
      }
      return res.json({ url: session.url });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/v1/tenants', requireAuth(repository), async (req, res, next) => {
    try {
      const tenants = await repository.listTenantsForUser(req.user.id);
      res.json({ tenants });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/usage', requireAuth(repository), async (req, res, next) => {
    try {
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null;
      if (!tenantId) {
        return errorResponse(res, 400, 'invalid_request', 'tenantId is required.');
      }
      if (!(await repository.canAccessTenant(req.user, tenantId))) {
        return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
      }
      const tenant = await repository.getTenantById(tenantId);
      if (!tenant) {
        return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
      }
      const includedOperations = Object.fromEntries(
        Object.entries(planConfig).map(([name, plan]) => [name, plan.monthlyIncludedOperations]),
      );
      const requestedPeriod = typeof req.query.period === 'string' ? req.query.period : null;
      const period = requestedPeriod || await repository.getCurrentUsagePeriod(tenantId, clock());
      if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(period)) {
        return errorResponse(res, 400, 'invalid_request', 'period must use YYYY-MM or YYYY-MM-DD format.');
      }
      const summary = await repository.getUsageSummary(tenantId, period, includedOperations);
      if (!summary) {
        return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
      }
      const [notifications, history] = await Promise.all([
        repository.getUsageNotifications(tenantId, period),
        repository.getUsageHistory(tenantId, 100),
      ]);
      return res.json({
        usage: summary,
        notifications,
        history,
        gracePeriodSeconds: usageGracePeriodSeconds,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/v1/tenants', requireAuth(repository), requireWriteAccess, async (req, res, next) => {
    try {
      if (req.user.role !== 'admin') {
        return errorResponse(res, 403, 'forbidden', 'Only administrators may create tenants.');
      }

      const { name, region = 'eastus', plan = 'starter' } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 128) {
        return errorResponse(res, 400, 'invalid_name', 'Tenant name must contain between 2 and 128 characters.');
      }
      if (typeof region !== 'string' || typeof plan !== 'string') {
        return errorResponse(res, 400, 'invalid_request', 'region and plan must be strings.');
      }
      if (!Object.hasOwn(planConfig, plan)) {
        return errorResponse(res, 400, 'invalid_plan', 'plan must be starter, pro, or growth.');
      }

      const tenant = await repository.createTenant({
        name: name.trim(),
        region,
        plan,
        actor: req.user.username,
      });

      return res.status(201).json({ tenant });
    } catch (error) {
      return next(error);
    }
  });

  app.get(
    '/api/v1/projects',
    requireAuth(repository),
    requireUsage(repository, planConfig, usageGracePeriodSeconds, 'read', 'projects', clock),
    async (req, res, next) => {
    try {
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null;
      if (tenantId && !(await repository.canAccessTenant(req.user, tenantId))) {
        return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
      }

      const projects = await repository.listProjectsForUser(req.user, tenantId);
      return res.json({ projects });
    } catch (error) {
      return next(error);
    }
    },
  );

  app.post(
    '/api/v1/projects',
    requireAuth(repository),
    requireWriteAccess,
    requireUsage(repository, planConfig, usageGracePeriodSeconds, 'write', 'projects', clock),
    async (req, res, next) => {
    try {
      const { tenantId, name } = req.body || {};
      if (typeof tenantId !== 'string' || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 128) {
        return errorResponse(res, 400, 'invalid_request', 'tenantId and a 2-128 character name are required.');
      }

      if (!(await repository.canAccessTenant(req.user, tenantId))) {
        return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
      }

      const tenantExists = await repository.getSnapshot().then((snapshot) => snapshot.tenants.some((tenant) => tenant.id === tenantId));
      if (!tenantExists) {
        return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
      }

      const project = await repository.createProject({ tenantId, name: name.trim(), actor: req.user.username });
      return res.status(201).json({ project });
    } catch (error) {
      return next(error);
    }
    },
  );

  app.get(
    '/api/v1/databases',
    requireAuth(repository),
    requireUsage(repository, planConfig, usageGracePeriodSeconds, 'read', 'databases', clock),
    async (req, res, next) => {
    try {
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null;
      if (tenantId && !(await repository.canAccessTenant(req.user, tenantId))) {
        return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
      }

      const databases = await repository.listDatabasesForUser(req.user, tenantId);
      return res.json({ databases });
    } catch (error) {
      return next(error);
    }
    },
  );

  app.post(
    '/api/v1/databases',
    requireAuth(repository),
    requireWriteAccess,
    requireUsage(repository, planConfig, usageGracePeriodSeconds, 'write', 'databases', clock),
    async (req, res, next) => {
    try {
      const { tenantId, name, engine = 'mysql' } = req.body || {};
      if (typeof tenantId !== 'string' || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 128) {
        return errorResponse(res, 400, 'invalid_request', 'tenantId and a 2-128 character name are required.');
      }
      if (typeof engine !== 'string' || !['mysql', 'mariadb', 'postgresql'].includes(engine)) {
        return errorResponse(res, 400, 'invalid_request', 'engine must be mysql, mariadb, or postgresql.');
      }

      if (!(await repository.canAccessTenant(req.user, tenantId))) {
        return errorResponse(res, 403, 'forbidden', 'The requested tenant is not available to this account.');
      }

      const tenantExists = await repository.getSnapshot().then((snapshot) => snapshot.tenants.some((tenant) => tenant.id === tenantId));
      if (!tenantExists) {
        return errorResponse(res, 404, 'tenant_not_found', 'The specified tenant does not exist.');
      }

      const database = await repository.createDatabase({ tenantId, name: name.trim(), engine, actor: req.user.username });
      return res.status(201).json({ database });
    } catch (error) {
      return next(error);
    }
    },
  );

  app.get('/api/v1/metrics', requireAuth(repository), async (req, res, next) => {
    try {
      if (req.user.role !== 'admin') {
        return errorResponse(res, 403, 'forbidden', 'Only administrators may view platform metrics.');
      }
      const metrics = await repository.getMetrics();
      return res.json(metrics);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/v1/audit', requireAuth(repository), async (req, res, next) => {
    try {
      if (req.user.role !== 'admin') {
        return errorResponse(res, 403, 'forbidden', 'Only administrators may view the platform audit log.');
      }
      const auditLog = await repository.getAuditLog(25);
      res.json({ auditLog });
    } catch (error) {
      return next(error);
    }
  });

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return errorResponse(res, 400, 'invalid_json', 'The request body must contain valid JSON.');
    }
    if (err.type === 'entity.too.large') {
      return errorResponse(res, 413, 'payload_too_large', 'The request body exceeds the 1 MB limit.');
    }
    console.error(err);
    errorResponse(res, 500, 'internal_error', 'An internal server error occurred.');
  });

  app.use((req, res) => {
    errorResponse(res, 404, 'not_found', `Route not found: ${req.method} ${req.originalUrl}`);
  });

  return app;
}

module.exports = { createApp, createToken, errorResponse, parseBoolean };
