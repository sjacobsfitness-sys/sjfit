// Minimal Stripe REST client (no SDK, so the app stays dependency-free).
// Pinned API version so response shapes (invoice.payment_intent, line.price) stay stable.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_API_VERSION = '2024-06-20';

export class StripeError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.body = body;
  }
}

// Stripe expects form encoding with bracketed keys: a[b][0]=c
export function formEncode(obj, prefix, out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) =>
        typeof v === 'object' ? formEncode(v, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(v)),
      );
    } else if (typeof value === 'object') {
      formEncode(value, name, out);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

export class StripeClient {
  constructor({ secretKey, fetchImpl = globalThis.fetch, baseUrl = 'https://api.stripe.com' }) {
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not set');
    this.secretKey = secretKey;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
  }

  async request(method, path, params) {
    let url = this.baseUrl + path;
    let body;
    if (params && method === 'GET') url += '?' + formEncode(params).toString();
    else if (params) body = formEncode(params).toString();
    const res = await this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': STRIPE_API_VERSION,
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new StripeError(data.error?.message || `Stripe ${method} ${path} failed with ${res.status}`, {
        status: res.status,
        body: data,
      });
    }
    return data;
  }

  getInvoice(id) {
    return this.request('GET', `/v1/invoices/${encodeURIComponent(id)}`, {
      expand: ['payment_intent', 'customer', 'lines.data.price.product'],
    });
  }

  listOpenInvoices() {
    return this.request('GET', '/v1/invoices', { status: 'open', limit: 50, expand: ['data.customer'] });
  }

  updateInvoiceMetadata(id, metadata) {
    return this.request('POST', `/v1/invoices/${encodeURIComponent(id)}`, { metadata });
  }

  markInvoicePaidOutOfBand(id) {
    return this.request('POST', `/v1/invoices/${encodeURIComponent(id)}/pay`, { paid_out_of_band: true });
  }

  getPaymentIntent(id) {
    return this.request('GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
  }
}

StripeClient.prototype.findInvoiceByTruemedSession = async function (sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '');
  const res = await this.request('GET', '/v1/invoices/search', {
    query: `metadata['truemed_session_id']:'${safe}'`,
  });
  return res.data?.[0];
};

// Verify a Stripe-Signature header (t=...,v1=...) against the raw request body.
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]),
  );
  const v1s = header.split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !v1s.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return v1s.some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export const PAY_LINK_FIELD = 'Pay by card or HSA/FSA';

StripeClient.prototype.addPayLinkToInvoice = async function (invoice, url) {
  const fields = (invoice.custom_fields || []).filter((f) => f.name !== PAY_LINK_FIELD);
  if (fields.length >= 4) return undefined; // Stripe allows max 4 custom fields; leave the invoice alone
  fields.push({ name: PAY_LINK_FIELD, value: url });
  return this.request('POST', `/v1/invoices/${encodeURIComponent(invoice.id)}`, { custom_fields: fields });
};
