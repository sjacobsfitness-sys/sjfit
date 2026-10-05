// Create a Stripe invoice for a client and print their pay link.
//
//   node scripts/invoice.js --name "Jane Doe" --email jane@x.com --sku online-training \
//        --amount 600 --desc "Online Coaching: Training - 6 months" [--state CA] [--live]
//
// Uses the Stripe product tagged with metadata truemed_sku=<sku>. Reuses the customer if the
// email already exists. Finalizes the invoice (Stripe does not email it) and prints the link.
import { parseArgs } from 'node:util';
import { loadEnv, getConfig } from '../src/config.js';
import { StripeClient } from '../src/stripe.js';
import { dollarsToCents } from '../src/truemed.js';

loadEnv();
const { values: a } = parseArgs({
  options: {
    name: { type: 'string' }, email: { type: 'string' }, sku: { type: 'string' }, amount: { type: 'string' },
    desc: { type: 'string' }, state: { type: 'string' }, live: { type: 'boolean', default: false },
    'due-days': { type: 'string', default: '7' },
  },
});
for (const k of ['name', 'email', 'sku', 'amount']) if (!a[k]) throw new Error(`--${k} is required`);

const config = getConfig({ ...process.env, MODE: a.live ? 'live' : 'test' });
const stripe = new StripeClient({ secretKey: config.stripeSecretKey });
const publicUrl = process.env.PAY_BASE_URL || 'https://pay.jacobsfit.com';

const products = await stripe.request('GET', '/v1/products/search', { query: `metadata['truemed_sku']:'${a.sku}' AND active:'true'` });
const product = products.data[0];
if (!product) throw new Error(`No active Stripe product tagged truemed_sku=${a.sku} (${config.mode} mode)`);

const existing = await stripe.request('GET', '/v1/customers', { email: a.email, limit: 1 });
const customer =
  existing.data[0] ||
  (await stripe.request('POST', '/v1/customers', {
    name: a.name,
    email: a.email,
    address: a.state ? { state: a.state.toUpperCase(), country: 'US' } : undefined,
  }));

const invoice = await stripe.request('POST', '/v1/invoices', {
  customer: customer.id,
  collection_method: 'send_invoice',
  days_until_due: Number(a['due-days']),
  auto_advance: false,
  pending_invoice_items_behavior: 'exclude',
  custom_fields: [{ name: 'Pay by card or HSA/FSA', value: `${publicUrl}/pay/PENDING` }],
});
await stripe.request('POST', '/v1/invoiceitems', {
  customer: customer.id,
  invoice: invoice.id,
  description: a.desc || product.name,
  price_data: { currency: 'usd', product: product.id, unit_amount: dollarsToCents(a.amount) },
});
const link = `${publicUrl}/pay/${invoice.id}`;
await stripe.request('POST', `/v1/invoices/${invoice.id}`, { custom_fields: [{ name: 'Pay by card or HSA/FSA', value: link }] });
const final = await stripe.request('POST', `/v1/invoices/${invoice.id}/finalize`);

console.log(JSON.stringify({ mode: config.mode, invoice: final.id, number: final.number, status: final.status, amount: final.amount_due / 100, customer: customer.email, link }, null, 2));
