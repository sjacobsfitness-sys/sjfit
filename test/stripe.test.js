import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formEncode, StripeClient } from '../src/stripe.js';

test('formEncode handles nested objects and arrays', () => {
  const s = formEncode({ expand: ['a', 'b'], metadata: { k: 'v' }, paid_out_of_band: true }).toString();
  assert.equal(decodeURIComponent(s), 'expand[0]=a&expand[1]=b&metadata[k]=v&paid_out_of_band=true');
});

test('client sends auth + pinned version and surfaces errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: false, status: 400, json: async () => ({ error: { message: 'No such invoice' } }) };
  };
  const stripe = new StripeClient({ secretKey: 'sk_test_x', fetchImpl });
  await assert.rejects(stripe.markInvoicePaidOutOfBand('in_1'), /No such invoice/);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/invoices/in_1/pay');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test_x');
  assert.equal(calls[0].init.headers['stripe-version'], '2024-06-20');
  assert.equal(calls[0].init.body, 'paid_out_of_band=true');
});
