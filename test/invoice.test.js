import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skuForLine, truemedItemsFromInvoice } from '../src/invoice.js';

const line = (description, amount, product) => ({ description, amount, price: { product } });

test('SKU from product metadata wins', () => {
  assert.equal(skuForLine(line('x', 1, { name: 'Anything', metadata: { truemed_sku: 'online-nutrition' } })), 'online-nutrition');
});

test('SKU falls back to catalog name, preferring the longest match', () => {
  assert.equal(skuForLine(line('6 months', 1, { name: 'Online Coaching: Training + Nutrition', metadata: {} })), 'online-hybrid');
  assert.equal(skuForLine(line('Online Coaching: Training - 12 months', 1, 'prod_123')), 'online-training');
  assert.equal(skuForLine(line('Shaker cup', 1, { name: 'Shaker cup', metadata: {} })), undefined);
});

test('items sum exactly to amount due, with fee gross-up and discounts', () => {
  const invoice = {
    amount_due: 90000, // after a discount
    lines: {
      data: [
        line('Online Coaching: Training', 60000, { name: 'Online Coaching: Training', metadata: {} }),
        line('Online Coaching: Nutrition', 40000, { name: 'Online Coaching: Nutrition', metadata: {} }),
      ],
    },
  };
  const { total, items } = truemedItemsFromInvoice(invoice, 5);
  assert.equal(total, 94737);
  assert.equal(items.reduce((s, i) => s + i.price, 0), total);
  assert.deepEqual(items.map((i) => i.sku), ['online-training', 'online-nutrition']);
});

test('unknown line blocks HSA checkout with a helpful error', () => {
  const invoice = { amount_due: 100, lines: { data: [line('Shaker cup', 100, { name: 'Shaker cup', metadata: {} })] } };
  assert.throws(() => truemedItemsFromInvoice(invoice), /truemed_sku/);
});
