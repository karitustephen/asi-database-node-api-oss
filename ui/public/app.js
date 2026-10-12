const status = document.getElementById('status');
const loginForm = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const tenantSelect = document.getElementById('tenantSelect');
const refreshButton = document.getElementById('refreshButton');
const logoutButton = document.getElementById('logoutButton');
const usagePanel = document.getElementById('usagePanel');
let token = sessionStorage.getItem('asi-session-token');

function setStatus(message) {
  status.textContent = message;
}

function addText(parent, tagName, text) {
  const element = document.createElement(tagName);
  element.textContent = text;
  parent.append(element);
  return element;
}

async function apiRequest(url, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || `Request failed (${response.status}).`);
  }
  return payload;
}

function renderUsage(payload) {
  usagePanel.replaceChildren();
  const usage = payload.usage;
  addText(usagePanel, 'h2', `Usage for ${usage.period}`);
  addText(usagePanel, 'p', `Plan: ${usage.plan}`);
  addText(usagePanel, 'p', `Operations: ${usage.usedOperations.toLocaleString()} / ${usage.includedOperations.toLocaleString()}`);
  addText(usagePanel, 'p', `Remaining: ${usage.remainingOperations.toLocaleString()} (${usage.usagePercent}% used)`);
  addText(usagePanel, 'p', `Grace deadline: ${usage.graceDeadline || 'Not reached'}`);
  addText(usagePanel, 'p', `Stripe billing status: ${usage.billingStatus}`);
  addText(usagePanel, 'p', `Configured grace period: ${payload.gracePeriodSeconds} seconds`);

  const billingPanel = document.createElement('section');
  addText(billingPanel, 'h3', 'Plans and billing');
  for (const plan of ['pro', 'growth']) {
    const checkoutButton = addText(billingPanel, 'button', `Choose ${plan}`);
    checkoutButton.type = 'button';
    checkoutButton.addEventListener('click', () => startCheckout(usage.tenantId, plan));
  }
  const portalButton = addText(billingPanel, 'button', 'Manage Stripe subscription');
  portalButton.type = 'button';
  portalButton.addEventListener('click', () => openBillingPortal(usage.tenantId));
  usagePanel.append(billingPanel);

  if (payload.notifications.length) {
    addText(usagePanel, 'h3', 'Usage notifications');
    const notificationList = document.createElement('ul');
    for (const notification of payload.notifications) {
      addText(
        notificationList,
        'li',
        `${notification.threshold}% threshold reached (${notification.usage_percent.toFixed(2)}%). State: ${notification.state}.`,
      );
    }
    usagePanel.append(notificationList);
    addText(usagePanel, 'p', 'Notifications are shown here. Email delivery is not configured in this deployment foundation.');
  }

  addText(usagePanel, 'h3', 'Recent operations');
  const history = document.createElement('ul');
  for (const event of payload.history) {
    addText(
      history,
      'li',
      `${event.occurred_at}: ${event.operation} ${event.resource} (+${event.operations})`,
    );
  }
  if (!payload.history.length) addText(history, 'li', 'No operations recorded for this tenant yet.');
  usagePanel.append(history);
}

async function openBillingUrl(endpoint, body, idempotencyKey) {
  try {
    const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : {};
    const payload = await apiRequest(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const billingUrl = new URL(payload.url);
    if (billingUrl.protocol !== 'https:') {
      throw new Error('Stripe returned a billing URL that does not use HTTPS.');
    }
    window.location.assign(billingUrl.toString());
  } catch (error) {
    setStatus(error.message);
  }
}

function startCheckout(tenantId, plan) {
  return openBillingUrl('/api/v1/billing/checkout', { tenantId, plan }, crypto.randomUUID());
}

function openBillingPortal(tenantId) {
  return openBillingUrl('/api/v1/billing/portal', { tenantId });
}

async function loadUsage() {
  const tenantId = tenantSelect.value;
  if (!token || !tenantId) return;
  try {
    const payload = await apiRequest(`/api/v1/usage?tenantId=${encodeURIComponent(tenantId)}`);
    renderUsage(payload);
    setStatus('Usage loaded.');
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadTenants() {
  const payload = await apiRequest('/api/v1/tenants');
  tenantSelect.replaceChildren();
  for (const tenant of payload.tenants) {
    const option = document.createElement('option');
    option.value = tenant.id;
    option.textContent = tenant.name;
    tenantSelect.append(option);
  }
  tenantSelect.disabled = payload.tenants.length === 0;
  refreshButton.disabled = payload.tenants.length === 0;
  logoutButton.hidden = false;
  await loadUsage();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || 'Login failed.');
    token = payload.token;
    sessionStorage.setItem('asi-session-token', token);
    passwordInput.value = '';
    loginForm.hidden = true;
    await loadTenants();
  } catch (error) {
    setStatus(error.message);
  }
});

tenantSelect.addEventListener('change', loadUsage);
refreshButton.addEventListener('click', loadUsage);
logoutButton.addEventListener('click', async () => {
  let logoutWarning = '';
  try {
    await apiRequest('/api/v1/auth/logout', { method: 'POST' });
  } catch (error) {
    logoutWarning = ` Server logout did not complete: ${error.message}`;
  }
  sessionStorage.removeItem('asi-session-token');
  token = null;
  loginForm.hidden = false;
  logoutButton.hidden = true;
  tenantSelect.replaceChildren();
  tenantSelect.disabled = true;
  refreshButton.disabled = true;
  usagePanel.replaceChildren();
  setStatus(`Signed out locally.${logoutWarning}`);
});

async function loadHealth() {
  try {
    const response = await fetch('/api/v1/health');
    const payload = await response.json();
    setStatus(`API ${payload.status}. Sign in to view tenant usage.`);
  } catch (error) {
    setStatus(`API health check failed: ${error.message}`);
  }
}

if (token) {
  loginForm.hidden = true;
  loadTenants().catch((error) => {
    sessionStorage.removeItem('asi-session-token');
    token = null;
    loginForm.hidden = false;
    setStatus(error.message);
  });
} else {
  loadHealth();
}
