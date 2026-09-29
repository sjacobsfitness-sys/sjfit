import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, validateConfig } from '../src/config.js';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_1',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_1',
  STRIPE_CPM_TYPE_ID: 'cpmt_test',
  TRUEMED_API_KEY: 'tm_sandbox',
  STRIPE_SECRET_KEY_LIVE: 'rk_live_1',
  STRIPE_PUBLISHABLE_KEY_LIVE: 'pk_live_1',
  STRIPE_CPM_TYPE_ID_LIVE: 'cpmt_live',
  TRUEMED_API_KEY_LIVE: 'tm_prod',
};

test('test mode uses test keys and Truemed sandbox', () => {
  const c = getConfig(env);
  assert.equal(c.mode, 'test');
  assert.equal(c.stripeSecretKey, 'sk_test_1');
  assert.equal(c.stripeCpmTypeId, 'cpmt_test');
  assert.equal(c.truemedApiKey, 'tm_sandbox');
  assert.equal(c.truemedBaseUrl, 'https://dev-api.truemed.com');
  assert.deepEqual(validateConfig(c), []);
});

test('MODE=live switches every credential and Truemed to production', () => {
  const c = getConfig({ ...env, MODE: 'live', TRUEMED_ENV: 'sandbox' });
  assert.equal(c.stripeSecretKey, 'rk_live_1');
  assert.equal(c.stripePublishableKey, 'pk_live_1');
  assert.equal(c.stripeCpmTypeId, 'cpmt_live');
  assert.equal(c.truemedApiKey, 'tm_prod');
  assert.equal(c.truemedEnv, 'production');
  assert.equal(c.truemedBaseUrl, 'https://api.truemed.com');
  assert.deepEqual(validateConfig(c), []);
});

test('mixed-up keys are rejected', () => {
  const live = getConfig({ ...env, MODE: 'live', STRIPE_SECRET_KEY_LIVE: 'sk_test_oops', TRUEMED_API_KEY_LIVE: '' });
  const problems = validateConfig(live);
  assert.ok(problems.some((p) => /STRIPE_SECRET_KEY_LIVE must be a live key/.test(p)));
  assert.ok(problems.some((p) => /TRUEMED_API_KEY_LIVE is not set/.test(p)));
  assert.ok(validateConfig(getConfig({ ...env, STRIPE_PUBLISHABLE_KEY: 'pk_live_x' })).length);
});
