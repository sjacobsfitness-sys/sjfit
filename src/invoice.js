import { CATALOG } from './catalog.js';
import { applyFee } from './truemed.js';

// Work out the Truemed SKU for a Stripe invoice line. Preferred: set metadata
// truemed_sku on the Stripe Product. Fallback: match the product/line name to the catalog.
export function skuForLine(line) {
  const product = line.price?.product;
  const fromMeta = typeof product === 'object' ? product?.metadata?.truemed_sku : undefined;
  if (fromMeta) return fromMeta;
  const names = [typeof product === 'object' ? product?.name : undefined, line.description]
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  const bySku = CATALOG.find((c) => names.some((n) => n.includes(c.sku)));
  if (bySku) return bySku.sku;
  // Longest catalog name first so "Training + Nutrition" wins over "Training".
  const byName = [...CATALOG]
    .sort((a, b) => b.name.length - a.name.length)
    .find((c) => names.some((n) => n.includes(c.name.toLowerCase())));
  return byName?.sku;
}

/**
 * Turn a Stripe invoice into Truemed order_items whose prices sum exactly to the
 * amount the client will be charged (amount_due, optionally grossed up for Truemed's fee).
 */
export function truemedItemsFromInvoice(invoice, feePercent = 0) {
  const lines = (invoice.lines?.data || []).filter((l) => l.amount > 0);
  if (!lines.length) throw new Error('Invoice has no billable lines');
  const items = lines.map((line) => {
    const sku = skuForLine(line);
    if (!sku) {
      throw new Error(
        `No Truemed SKU for invoice line "${line.description}". Set metadata truemed_sku on the Stripe product.`,
      );
    }
    const product = line.price?.product;
    return { sku, name: (typeof product === 'object' && product?.name) || line.description, amount: line.amount };
  });

  const total = applyFee(invoice.amount_due, feePercent);
  const lineSum = items.reduce((s, i) => s + i.amount, 0);
  let allocated = 0;
  return {
    total,
    items: items.map((item, idx) => {
      const price =
        idx === items.length - 1 ? total - allocated : Math.round((item.amount * total) / lineSum);
      allocated += price;
      return { sku: item.sku, name: item.name, price, quantity: 1 };
    }),
  };
}
