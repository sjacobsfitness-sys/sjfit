import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv, getConfig } from './config.js';
import { CATALOG, findItem } from './catalog.js';
import { TruemedClient, applyFee, dollarsToCents } from './truemed.js';
import { OrderStore } from './store.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#111;background:#fff}
input,select,button{font:inherit;padding:8px;margin:4px 0 12px;width:100%;box-sizing:border-box}
button{background:#111;color:#fff;border:0;border-radius:6px;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}
.box{padding:12px;border-radius:8px;background:#f3f3f3;word-break:break-all}
</style></head><body>${body}</body></html>`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Truemed statuses that mean "money is captured, deliver the service".
const PAID_STATUSES = new Set(['captured', 'complete', 'completed', 'succeeded', 'paid']);

export function createApp({ config, truemed, store, log = console }) {
  function isAdmin(req) {
    if (!config.adminPassword) return false;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return user === 'admin' && safeEqual(pass ?? '', config.adminPassword);
  }

  function adminPage(result = '') {
    const options = CATALOG.map((i) => `<option value="${esc(i.sku)}">${esc(i.name)} (${esc(i.sku)})</option>`).join('');
    const rows = store
      .all()
      .map(
        (o) => `<tr><td>${esc(o.createdAt.slice(0, 10))}</td><td>${esc(o.customerName)}<br><small>${esc(o.customerEmail)}</small></td>
<td>${esc(o.items.map((i) => i.name).join(', '))}</td><td>${money(o.totalAmount)}</td><td><b>${esc(o.status)}</b></td>
<td><a href="${esc(o.redirectUrl)}">link</a></td></tr>`,
      )
      .join('');
    return page(
      'SJFit Admin',
      `<h1>HSA/FSA payment link (Truemed ${esc(config.truemedEnv)})</h1>${result}
<form method="post" action="/admin/sessions">
<label>Client name<input name="customerName" required></label>
<label>Client email<input name="customerEmail" type="email" required></label>
<label>Client state (2-letter, optional)<input name="customerState" maxlength="2"></label>
<label>Service<select name="sku">${options}</select></label>
<label>Description shown to client (e.g. "6 months online coaching")<input name="description"></label>
<label>Price in dollars (full prepaid amount)<input name="price" inputmode="decimal" required></label>
${config.feePercent ? `<p><small>Price is grossed up by ${config.feePercent}% to cover Truemed's fee.</small></p>` : ''}
<button>Create payment link</button></form>
<h2>Orders</h2><table><tr><th>Date</th><th>Client</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr>${rows}</table>`,
    );
  }

  async function createSession(form) {
    const catalogItem = findItem(form.sku);
    if (!catalogItem) throw new Error(`Unknown SKU ${form.sku}`);
    const price = applyFee(dollarsToCents(form.price), config.feePercent);
    const orderId = `sjf_${randomUUID()}`;
    const items = [{ sku: catalogItem.sku, name: form.description || catalogItem.name, price, quantity: 1 }];
    const session = await truemed.createPaymentSession({
      orderId,
      items,
      customerName: form.customerName,
      customerEmail: form.customerEmail,
      customerState: form.customerState?.toUpperCase() || undefined,
      successUrl: `${config.publicUrl}/checkout/success?order=${orderId}`,
      failureUrl: `${config.publicUrl}/checkout/failure?order=${orderId}`,
      idempotencyKey: orderId,
    });
    const redirectUrl = session.redirect_url || session.redirectUrl || session.url;
    return store.add({
      orderId,
      truemedSessionId: session.id || session.payment_session_id,
      redirectUrl,
      customerName: form.customerName,
      customerEmail: form.customerEmail,
      items,
      totalAmount: price,
      status: 'created',
      createdAt: new Date().toISOString(),
    });
  }

  // Webhooks are only a hint: we always re-fetch the session from Truemed's API
  // (authenticated with our key) before trusting its status.
  async function handleWebhook(req, raw) {
    if (config.webhookSecret) {
      const provided =
        req.headers['x-truemed-webhook-secret'] ||
        req.headers['x-webhook-secret'] ||
        (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!safeEqual(provided || '', config.webhookSecret)) return { status: 401, body: 'unauthorized' };
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return { status: 400, body: 'invalid json' };
    }
    const data = event.data || event.payment_session || event;
    const sessionId = data.payment_session_id || data.id || event.payment_session_id;
    if (!sessionId) return { status: 400, body: 'missing payment session id' };

    const order = store.findBySessionId(sessionId);
    if (!order) {
      log.warn?.(`Webhook for unknown Truemed session ${sessionId}`);
      return { status: 200, body: 'ignored' };
    }
    const session = await truemed.getPaymentSession(sessionId);
    const status = String(session.status || 'unknown').toLowerCase();
    const paid = PAID_STATUSES.has(status);
    store.update(sessionId, { status, paid, lastEvent: event.type || event.event_type || event.event });
    if (paid) {
      // Deliver the service here: email Sean, unlock the program, etc.
      log.log?.(`PAID: ${order.customerName} <${order.customerEmail}> ${money(order.totalAmount)} (${order.orderId})`);
    }
    return { status: 200, body: 'ok' };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return send(
          200,
          page(
            'Jacobs Fitness - HSA/FSA',
            `<h1>Pay for coaching with your HSA/FSA</h1>
<p>Jacobs Fitness accepts HSA and FSA cards through Truemed for online movement coaching, health &amp; nutrition coaching,
blood work review and in-person training.</p>
<p>Ask your coach for an HSA/FSA payment link. You'll answer a short health survey, then pay with your HSA/FSA card.</p>`,
          ),
        );
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok', 'text/plain');
      if (req.method === 'GET' && url.pathname === '/checkout/success') {
        return send(200, page('Thank you', `<h1>Thanks!</h1><p>Your payment is being processed. Your coach will be in touch shortly.</p>`));
      }
      if (req.method === 'GET' && url.pathname === '/checkout/failure') {
        return send(200, page('Payment not completed', `<h1>Payment not completed</h1><p>Please contact your coach for another payment option.</p>`));
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/truemed') {
        const result = await handleWebhook(req, await readBody(req));
        return send(result.status, result.body, 'text/plain');
      }
      if (url.pathname.startsWith('/admin')) {
        if (!isAdmin(req)) return send(401, 'Authentication required', 'text/plain', { 'www-authenticate': 'Basic realm="sjfit"' });
        if (req.method === 'GET' && url.pathname === '/admin') return send(200, adminPage());
        if (req.method === 'POST' && url.pathname === '/admin/sessions') {
          const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
          try {
            const order = await createSession(form);
            return send(
              200,
              adminPage(`<p>Send this link to ${esc(order.customerName)} (${money(order.totalAmount)}):</p>
<p class="box"><a href="${esc(order.redirectUrl)}">${esc(order.redirectUrl)}</a></p>`),
            );
          } catch (err) {
            log.error?.(err);
            const detail = err.body ? ` ${esc(JSON.stringify(err.body))}` : '';
            return send(400, adminPage(`<p class="box" style="background:#fdd">Error: ${esc(err.message)}${detail}</p>`));
          }
        }
      }
      return send(404, 'Not found', 'text/plain');
    } catch (err) {
      log.error?.(err);
      return send(500, 'Internal error', 'text/plain');
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnv();
  const config = getConfig();
  if (!config.adminPassword) console.warn('ADMIN_PASSWORD is not set; /admin will be locked.');
  const truemed = new TruemedClient({ apiKey: config.truemedApiKey, baseUrl: config.truemedBaseUrl });
  const store = new OrderStore(config.dataDir);
  createServer(createApp({ config, truemed, store })).listen(config.port, () => {
    console.log(`SJFit listening on ${config.publicUrl} (Truemed ${config.truemedEnv}: ${config.truemedBaseUrl})`);
  });
}
