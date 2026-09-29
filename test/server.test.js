import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';

function fakeStripe(invoice) {
  const calls = [];
  return {
    calls,
    invoice,
    async getInvoice(id) {
      if (id !== invoice.id) throw new Error('not found');
      return structuredClone(invoice);
    },
    async listOpenInvoices() {
      return { data: invoice.status === 'open' ? [structuredClone(invoice)] : [] };
    },
    async updateInvoiceMetadata(id, metadata) {
      calls.push(['metadata', metadata]);
      Object.assign(invoice.metadata, metadata);
      return structuredClone(invoice);
    },
    async markInvoicePaidOutOfBand(id) {
      calls.push(['paid_out_of_band', id]);
      invoice.status = 'paid';
      return structuredClone(invoice);
    },
    async findInvoiceByTruemedSession(sid) {
      return invoice.metadata.truemed_session_id === sid ? structuredClone(invoice) : undefined;
    },
    async getPaymentIntent() {
      return { status: 'succeeded' };
    },
  };
}

function fakeTruemed() {
  const t = {
    created: [],
    status: 'processing',
    async createPaymentSession(args) {
      t.created.push(args);
      return { id: `ps_${t.created.length}`, redirect_url: `https://dev.truemed.com/survey/ps_${t.created.length}` };
    },
    async getPaymentSession(id) {
      return { payment_session_id: id, status: t.status };
    },
  };
  return t;
}

const baseInvoice = () => ({
  id: 'in_test123',
  number: 'SJF-0001',
  status: 'open',
  currency: 'usd',
  amount_due: 60000,
  customer_email: 'jane@example.com',
  customer_name: 'Jane Doe',
  customer_address: { state: 'CA' },
  hosted_invoice_url: 'https://invoice.stripe.com/i/test',
  metadata: {},
  lines: { data: [{ description: 'Online Coaching: Training - 6 months', amount: 60000, price: { product: { name: 'Online Coaching: Training', metadata: {} } } }] },
});

async function start({ invoice = baseInvoice(), config = {} } = {}) {
  const stripe = fakeStripe(invoice);
  const truemed = fakeTruemed();
  const cfg = { adminPassword: 'pw', publicUrl: 'https://pay.sjfit.test', truemedEnv: 'sandbox', feePercent: 0, webhookSecret: '', brandName: 'Jacobs Fitness', ...config };
  const log = { log() {}, warn() {}, error() {} };
  const server = createServer(createApp({ config: cfg, truemed, stripe, log }));
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, stripe, truemed, close: () => server.close() };
}

test('pay page shows invoice with HSA/FSA and card options', async () => {
  const app = await start();
  const html = await (await fetch(`${app.base}/pay/in_test123`)).text();
  assert.match(html, /\$600\.00/);
  assert.match(html, /Pay with HSA\/FSA/);
  assert.match(html, /invoice\.stripe\.com/);
  app.close();
});

test('pay page uses Stripe Payment Element with custom payment method when configured', async () => {
  const invoice = { ...baseInvoice(), payment_intent: { client_secret: 'pi_1_secret_x', amount: 60000, currency: 'usd', payment_method_types: ['card'] } };
  const app = await start({ invoice, config: { stripePublishableKey: 'pk_test_1', stripeCpmTypeId: 'cpmt_abc' } });
  const html = await (await fetch(`${app.base}/pay/in_test123`)).text();
  assert.match(html, /js\.stripe\.com\/v3/);
  assert.match(html, /cpmt_abc/);
  assert.match(html, /customPaymentMethods/);
  app.close();
});

test('HSA/FSA creates a Truemed session from the Stripe invoice and reuses it', async () => {
  const app = await start();
  const r = await fetch(`${app.base}/pay/in_test123/truemed`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).redirect_url, 'https://dev.truemed.com/survey/ps_1');
  const args = app.truemed.created[0];
  assert.equal(args.orderId, 'in_test123');
  assert.deepEqual(args.items, [{ sku: 'online-training', name: 'Online Coaching: Training', price: 60000, quantity: 1 }]);
  assert.equal(args.customerEmail, 'jane@example.com');
  assert.equal(args.customerState, 'CA');
  assert.equal(app.stripe.invoice.metadata.truemed_session_id, 'ps_1');

  await fetch(`${app.base}/pay/in_test123/truemed`, { method: 'POST' });
  assert.equal(app.truemed.created.length, 1, 'live session is reused');
  app.close();
});

test('captured webhook marks the Stripe invoice paid out of band, once', async () => {
  const app = await start();
  await fetch(`${app.base}/pay/in_test123/truemed`, { method: 'POST' });

  const hook = () =>
    fetch(`${app.base}/webhooks/truemed`, { method: 'POST', body: JSON.stringify({ payment_session_id: 'ps_1', status: 'captured' }) });

  app.truemed.status = 'processing';
  await hook();
  assert.equal(app.stripe.invoice.status, 'open', 'payload status is not trusted');

  app.truemed.status = 'captured';
  assert.equal((await hook()).status, 200);
  assert.equal(app.stripe.invoice.status, 'paid');
  await hook();
  assert.equal(app.stripe.calls.filter((c) => c[0] === 'paid_out_of_band').length, 1);
  app.close();
});

test('webhook secret is enforced when configured', async () => {
  const app = await start({ config: { webhookSecret: 's3cret' } });
  const body = JSON.stringify({ payment_session_id: 'ps_1' });
  assert.equal((await fetch(`${app.base}/webhooks/truemed`, { method: 'POST', body })).status, 401);
  const ok = await fetch(`${app.base}/webhooks/truemed`, { method: 'POST', headers: { 'x-truemed-webhook-secret': 's3cret' }, body });
  assert.equal(ok.status, 200);
  app.close();
});

test('paid and unknown invoices are handled', async () => {
  const invoice = { ...baseInvoice(), status: 'paid' };
  const app = await start({ invoice });
  assert.match(await (await fetch(`${app.base}/pay/in_test123`)).text(), /Already paid/);
  assert.equal((await fetch(`${app.base}/pay/in_nope`)).status, 404);
  assert.equal((await fetch(`${app.base}/pay/in_test123/truemed`, { method: 'POST' })).status, 409);
  app.close();
});

test('admin lists open invoices with pay links and requires password', async () => {
  const app = await start();
  assert.equal((await fetch(`${app.base}/admin`)).status, 401);
  const html = await (await fetch(`${app.base}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') } })).text();
  assert.match(html, /https:\/\/pay\.sjfit\.test\/pay\/in_test123/);
  app.close();
});
