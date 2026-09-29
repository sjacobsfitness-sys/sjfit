// Minimal Stripe REST client (no SDK, so the app stays dependency-free).
// Pinned API version so response shapes (invoice.payment_intent, line.price) stay stable.
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
