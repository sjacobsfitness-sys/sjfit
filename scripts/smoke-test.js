// End-to-end sandbox check against Truemed's real API.
// Usage: TRUEMED_API_KEY=... npm run smoke   (or put the key in .env)
import { loadEnv, getConfig } from '../src/config.js';
import { TruemedClient } from '../src/truemed.js';
import { CATALOG } from '../src/catalog.js';

loadEnv();
const config = getConfig();
if (config.truemedEnv !== 'sandbox') {
  console.error('Refusing to run: TRUEMED_ENV must be "sandbox" for the smoke test.');
  process.exit(1);
}
const truemed = new TruemedClient({ apiKey: config.truemedApiKey, baseUrl: config.truemedBaseUrl });
const item = CATALOG[0];

console.log(`Creating sandbox payment session at ${config.truemedBaseUrl} for ${item.sku}...`);
try {
  const session = await truemed.createPaymentSession({
    orderId: `smoke_${Date.now()}`,
    items: [{ sku: item.sku, name: `${item.name} - 6 months (TEST)`, price: 60000 }],
    customerName: 'Test Client',
    customerEmail: 'test+truemed@example.com',
    customerState: 'CA',
    successUrl: `${config.publicUrl}/checkout/success`,
    failureUrl: `${config.publicUrl}/checkout/failure`,
  });
  console.log('Created:', JSON.stringify(session, null, 2));
  const id = session.id || session.payment_session_id;
  if (id) {
    const fetched = await truemed.getPaymentSession(id);
    console.log('Fetched status:', fetched.status, JSON.stringify(fetched, null, 2));
  }
  console.log('\nOpen the redirect URL above to walk through the survey + checkout as a client.');
} catch (err) {
  console.error('FAILED:', err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  if (err.cause) console.error('Cause:', err.cause.message || err.cause);
  process.exit(1);
}
