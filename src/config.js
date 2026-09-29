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

export function getConfig(env = process.env) {
  const truemedEnv = env.TRUEMED_ENV || 'sandbox';
  return {
    truemedEnv,
    truemedApiKey: env.TRUEMED_API_KEY || '',
    truemedBaseUrl: env.TRUEMED_BASE_URL || BASE_URLS[truemedEnv] || BASE_URLS.sandbox,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
    port: Number(env.PORT || 3000),
    adminPassword: env.ADMIN_PASSWORD || '',
    webhookSecret: env.TRUEMED_WEBHOOK_SECRET || '',
    feePercent: Number(env.TRUEMED_FEE_PERCENT || 0),
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    // Custom payment method type created in Stripe Dashboard (cpmt_...). Optional:
    // without it the pay page shows plain Card / HSA-FSA buttons instead of the Payment Element.
    stripeCpmTypeId: env.STRIPE_CPM_TYPE_ID || '',
    brandName: env.BRAND_NAME || 'Jacobs Fitness',
  };
}
