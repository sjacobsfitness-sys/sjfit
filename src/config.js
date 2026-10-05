import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader so we have zero dependencies.
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const BASE_URLS = {
  sandbox: 'https://dev-api.truemed.com',
  production: 'https://api.truemed.com',
};

// MODE switches every credential at once:
//   test (default): Stripe test keys + Truemed sandbox      -> STRIPE_SECRET_KEY, TRUEMED_API_KEY, ...
//   live:           Stripe live keys + Truemed production   -> STRIPE_SECRET_KEY_LIVE, TRUEMED_API_KEY_LIVE, ...
// Both sets can sit in the environment side by side; going live is flipping MODE.
export function getConfig(env = process.env) {
  const mode = (env.MODE || 'test').toLowerCase() === 'live' ? 'live' : 'test';
  const pick = (name) => (mode === 'live' ? env[`${name}_LIVE`] : env[name]) || '';
  const truemedEnv = mode === 'live' ? 'production' : env.TRUEMED_ENV || 'sandbox';
  return {
    mode,
    truemedEnv,
    truemedApiKey: pick('TRUEMED_API_KEY'),
    truemedBaseUrl: env.TRUEMED_BASE_URL || BASE_URLS[truemedEnv] || BASE_URLS.sandbox,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
    port: Number(env.PORT || 3000),
    adminPassword: env.ADMIN_PASSWORD || '',
    webhookSecret: pick('TRUEMED_WEBHOOK_SECRET'),
    feePercent: Number(env.TRUEMED_FEE_PERCENT || 0),
    stripeSecretKey: pick('STRIPE_SECRET_KEY'),
    stripePublishableKey: pick('STRIPE_PUBLISHABLE_KEY'),
    // Custom payment method type created in Stripe Dashboard (cpmt_...). Test and live have different ids.
    // Without it the pay page shows plain Card / HSA-FSA buttons instead of the Payment Element.
    stripeCpmTypeId: pick('STRIPE_CPM_TYPE_ID'),
    // Signing secret (whsec_...) of the Stripe webhook that adds pay links to new invoices.
    stripeWebhookSecret: pick('STRIPE_WEBHOOK_SECRET'),
    brandName: env.BRAND_NAME || 'Jacobs Fitness',
  };
}

// Refuse to start with keys from the wrong mode (e.g. MODE=live but a test Stripe key).
export function validateConfig(config) {
  const problems = [];
  const suffix = config.mode === 'live' ? '_LIVE' : '';
  const want = config.mode === 'live' ? 'live' : 'test';
  if (!config.truemedApiKey) problems.push(`TRUEMED_API_KEY${suffix} is not set`);
  if (!config.stripeSecretKey) problems.push(`STRIPE_SECRET_KEY${suffix} is not set`);
  else if (!new RegExp(`^(sk|rk)_${want}_`).test(config.stripeSecretKey)) {
    problems.push(`STRIPE_SECRET_KEY${suffix} must be a ${want} key (sk_${want}_ or rk_${want}_)`);
  }
  if (config.stripePublishableKey && !config.stripePublishableKey.startsWith(`pk_${want}_`)) {
    problems.push(`STRIPE_PUBLISHABLE_KEY${suffix} must start with pk_${want}_`);
  }
  return problems;
}
