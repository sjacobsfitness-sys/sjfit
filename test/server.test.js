import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { OrderStore } from '../src/store.js';

async function start({ webhookSecret = '', sessionStatus = 'captured' } = {}) {
  const calls = [];
  const truemed = {
    async createPaymentSession(args) {
      calls.push(args);
      return { id: 'ps_123', redirect_url: 'https://checkout.truemed.test/ps_123' };
    },
    async getPaymentSession(id) {
      return { id, status: sessionStatus };
    },
  };
  const store = new OrderStore(mkdtempSync(join(tmpdir(), 'sjfit-')));
  const config = { adminPassword: 'pw', publicUrl: 'https://sjfit.test', truemedEnv: 'sandbox', feePercent: 0, webhookSecret };
  const log = { log() {}, warn() {}, error() {} };
  const server = createServer(createApp({ config, truemed, store, log }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, store, close: () => server.close() };
}

const auth = { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };

test('admin requires password', async () => {
  const app = await start();
  const res = await fetch(`${app.base}/admin`);
  assert.equal(res.status, 401);
  app.close();
});

test('creating a payment link then webhook marks order paid', async () => {
  const app = await start();
  const form = new URLSearchParams({
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    sku: 'SJF-MOVE-COACH',
    description: '6 months online coaching',
    price: '1200',
  });
  const res = await fetch(`${app.base}/admin/sessions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /checkout\.truemed\.test\/ps_123/);
  assert.equal(app.calls[0].items[0].price, 120000);
  assert.equal(app.calls[0].items[0].sku, 'SJF-MOVE-COACH');
  assert.match(app.calls[0].successUrl, /^https:\/\/sjfit\.test\/checkout\/success/);

  const hook = await fetch(`${app.base}/webhooks/truemed`, {
    method: 'POST',
    body: JSON.stringify({ event_type: 'payment_session_captured', payment_session_id: 'ps_123' }),
  });
  assert.equal(hook.status, 200);
  const order = app.store.findBySessionId('ps_123');
  assert.equal(order.status, 'captured');
  assert.equal(order.paid, true);
  app.close();
});

test('webhook status comes from Truemed API, not the payload', async () => {
  const app = await start({ sessionStatus: 'authorized' });
  app.store.add({ truemedSessionId: 'ps_9', status: 'created', items: [], totalAmount: 1, createdAt: '' });
  await fetch(`${app.base}/webhooks/truemed`, {
    method: 'POST',
    body: JSON.stringify({ payment_session_id: 'ps_9', status: 'captured' }),
  });
  assert.equal(app.store.findBySessionId('ps_9').paid, false);
  app.close();
});

test('webhook secret is enforced when configured', async () => {
  const app = await start({ webhookSecret: 's3cret' });
  const body = JSON.stringify({ payment_session_id: 'ps_1' });
  assert.equal((await fetch(`${app.base}/webhooks/truemed`, { method: 'POST', body })).status, 401);
  const ok = await fetch(`${app.base}/webhooks/truemed`, {
    method: 'POST',
    headers: { 'x-truemed-webhook-secret': 's3cret' },
    body,
  });
  assert.equal(ok.status, 200);
  app.close();
});
