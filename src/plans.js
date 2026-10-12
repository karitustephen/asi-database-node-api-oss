'use strict';

const DEFAULT_PLANS = Object.freeze({
  starter: Object.freeze({ monthlyIncludedOperations: 100_000 }),
  pro: Object.freeze({ monthlyIncludedOperations: 1_000_000 }),
  growth: Object.freeze({ monthlyIncludedOperations: 10_000_000 }),
});

function createPlanConfiguration(overrides = {}) {
  const plans = {};
  for (const [name, defaults] of Object.entries(DEFAULT_PLANS)) {
    const configuredLimit = overrides[name]?.monthlyIncludedOperations ?? defaults.monthlyIncludedOperations;
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) {
      throw new Error(`The ${name} plan monthlyIncludedOperations must be a positive safe integer.`);
    }
    plans[name] = Object.freeze({ monthlyIncludedOperations: configuredLimit });
  }
  return Object.freeze(plans);
}

function currentBillingPeriod(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

module.exports = { DEFAULT_PLANS, createPlanConfiguration, currentBillingPeriod };
