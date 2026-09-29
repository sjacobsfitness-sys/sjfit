import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TruemedClient, TruemedError, applyFee, dollarsToCents } from '../src/truemed.js';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
}

test('createPaymentSession sends SKUs, cents total and api key', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { id: 'ps_1', redirect_url: 'https://tm/x' } }]);
  const client = new TruemedClient({ apiKey: 'k', baseUrl: 'https://dev-api.truemed.com/', fetchImpl });
  const res = await client.createPaymentSession({
    orderId: 'o1',
    items: [{ sku: 'A', name: 'A', price: 1000, quantity: 2 }, { sku: 'B', name: 'B', price: 500 }],
    customerEmail: 'a@b.c',
    customerName: 'A B',
    successUrl: 's',
    failureUrl: 'f',
    idempotencyKey: 'idem',
  });
  assert.equal(res.redirect_url, 'https://tm/x');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://dev-api.truemed.com/payments/v1/create_payment_session');
  assert.equal(call.init.headers['x-truemed-api-key'], 'k');
  assert.equal(call.body.total_amount, 2500);
  assert.equal(call.body.idempotency_key, 'idem');
  assert.deepEqual(call.body.order_items.map((i) => i.sku), ['A', 'B']);
});

test('rejects items without SKU or with non-cent prices', async () => {
  const client = new TruemedClient({ apiKey: 'k', baseUrl: 'x', fetchImpl: fakeFetch([]) });
  await assert.rejects(client.createPaymentSession({ items: [{ price: 100 }] }), /SKU/);
  await assert.rejects(client.createPaymentSession({ items: [{ sku: 'A', price: 1.5 }] }), /cents/);
});

test('API errors surface status and body', async () => {
  const fetchImpl = fakeFetch([{ status: 422, body: { detail: 'bad sku' } }]);
  const client = new TruemedClient({ apiKey: 'k', baseUrl: 'x', fetchImpl });
  await assert.rejects(client.getPaymentSession('ps_1'), (err) => {
    assert.ok(err instanceof TruemedError);
    assert.equal(err.status, 422);
    assert.deepEqual(err.body, { detail: 'bad sku' });
    return true;
  });
});

test('money helpers', () => {
  assert.equal(dollarsToCents('$1,200.50'), 120050);
  assert.throws(() => dollarsToCents('abc'));
  assert.equal(applyFee(10000, 0), 10000);
  assert.equal(applyFee(9500, 5), 10000);
});
