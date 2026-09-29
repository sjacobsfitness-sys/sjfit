import { randomUUID } from 'node:crypto';

// All Truemed endpoint paths live here so they are easy to adjust against
// https://docs.truemed.com if Truemed's API reference differs.
export const PATHS = {
  createSession: '/payments/v1/create_payment_session',
  getSession: (id) => `/payments/v1/payment_session/${encodeURIComponent(id)}`,
  captureSession: (id) => `/payments/v1/payment_session/${encodeURIComponent(id)}/capture`,
  voidSession: (id) => `/payments/v1/payment_session/${encodeURIComponent(id)}/void`,
};

export class TruemedError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'TruemedError';
    this.status = status;
    this.body = body;
  }
}

export class TruemedClient {
  constructor({ apiKey, baseUrl, fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new Error('TRUEMED_API_KEY is not set');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-truemed-api-key': this.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new TruemedError(`Truemed ${method} ${path} failed with ${res.status}`, {
        status: res.status,
        body: data,
      });
    }
    return data;
  }

  /**
   * Create a one-time payment session. Returns { id, redirect_url, ... }.
   * Send the client to redirect_url: they take Truemed's health survey, then pay
   * with their HSA/FSA card. Amounts are in cents.
   */
  async createPaymentSession({
    orderId,
    items,
    customerEmail,
    customerName,
    customerState,
    successUrl,
    failureUrl,
    idempotencyKey = randomUUID(),
  }) {
    if (!items?.length) throw new Error('At least one item is required');
    const orderItems = items.map((item) => {
      if (!item.sku) throw new Error('Every item needs a SKU');
      if (!Number.isInteger(item.price) || item.price <= 0) {
        throw new Error(`Item ${item.sku} needs a positive integer price in cents`);
      }
      return {
        sku: item.sku,
        name: item.name,
        price: item.price,
        quantity: item.quantity ?? 1,
      };
    });
    const totalAmount = orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

    const body = {
      idempotency_key: idempotencyKey,
      order_id: orderId,
      total_amount: totalAmount,
      order_items: orderItems,
      customer_email: customerEmail,
      customer_name: customerName,
      success_url: successUrl,
      failure_url: failureUrl,
    };
    if (customerState) body.customer_state = customerState;
    return this.request('POST', PATHS.createSession, body);
  }

  getPaymentSession(id) {
    return this.request('GET', PATHS.getSession(id));
  }

  capturePaymentSession(id) {
    return this.request('POST', PATHS.captureSession(id), {});
  }

  voidPaymentSession(id) {
    return this.request('POST', PATHS.voidSession(id), {});
  }
}

/** Gross a price up so Truemed's percentage fee is wrapped into what the client pays. */
export function applyFee(cents, feePercent) {
  if (!feePercent) return cents;
  return Math.round(cents / (1 - feePercent / 100));
}

export function dollarsToCents(value) {
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid amount: ${value}`);
  return Math.round(n * 100);
}
