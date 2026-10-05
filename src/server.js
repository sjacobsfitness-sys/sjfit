import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv, getConfig, validateConfig } from './config.js';
import { TruemedClient } from './truemed.js';
import { StripeClient } from './stripe.js';
import { truemedItemsFromInvoice } from './invoice.js';
import { payPage, messagePage, adminPage, homePage } from './pages.js';

// Truemed sessions in these states can't be paid any more; a fresh one is created instead.
const DEAD_TRUEMED_STATUSES = new Set(['failed', 'canceled', 'cancelled', 'voided', 'expired', 'rejected']);

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

export function createApp({ config, truemed, stripe, log = console }) {
  const payUrl = (invoiceId) => `${config.publicUrl}/pay/${invoiceId}`;

  function isAdmin(req) {
    if (!config.adminPassword) return false;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return user === 'admin' && safeEqual(pass ?? '', config.adminPassword);
  }

  // Create (or reuse) the Truemed payment session for an open Stripe invoice.
  // The invoice is always re-read from Stripe: amounts never come from the browser.
  async function startTruemed(invoiceId) {
    const invoice = await stripe.getInvoice(invoiceId);
    if (invoice.status !== 'open') throw Object.assign(new Error('This invoice is not open for payment.'), { status: 409 });

    const existingId = invoice.metadata?.truemed_session_id;
    if (existingId && invoice.metadata?.truemed_redirect_url) {
      const existing = await truemed.getPaymentSession(existingId).catch(() => undefined);
      const status = String(existing?.status || '').toLowerCase();
      if (existing && !DEAD_TRUEMED_STATUSES.has(status)) {
        return { redirect_url: invoice.metadata.truemed_redirect_url };
      }
    }

    const { items } = truemedItemsFromInvoice(invoice, config.feePercent);
    const customer = typeof invoice.customer === 'object' ? invoice.customer : {};
    const session = await truemed.createPaymentSession({
      orderId: invoice.id,
      items,
      customerEmail: invoice.customer_email || customer.email,
      customerName: invoice.customer_name || customer.name,
      customerState: invoice.customer_address?.state || customer.address?.state || undefined,
      successUrl: `${payUrl(invoice.id)}/complete?via=truemed`,
      failureUrl: `${payUrl(invoice.id)}?truemed=failed`,
      idempotencyKey: `${invoice.id}-${Date.now()}`,
    });
    await stripe.updateInvoiceMetadata(invoice.id, {
      truemed_session_id: session.id,
      truemed_redirect_url: session.redirect_url,
      truemed_status: 'created',
    });
    return { redirect_url: session.redirect_url };
  }

  // Check a Truemed session and, once captured, mark its Stripe invoice paid (out of band).
  // Safe to call repeatedly: an already-paid invoice is left alone.
  async function reconcileTruemedSession(sessionId, invoice) {
    const session = await truemed.getPaymentSession(sessionId);
    const status = String(session.status || 'unknown').toLowerCase();
    invoice ??= await stripe.findInvoiceByTruemedSession(sessionId);
    if (!invoice) {
      log.warn?.(`No Stripe invoice found for Truemed session ${sessionId}`);
      return { status, invoice: undefined };
    }
    if (invoice.metadata?.truemed_session_id !== sessionId) return { status, invoice };
    if (status === 'captured' && invoice.status === 'open') {
      await stripe.updateInvoiceMetadata(invoice.id, { truemed_status: status });
      invoice = await stripe.markInvoicePaidOutOfBand(invoice.id);
      log.log?.(`PAID via Truemed: invoice ${invoice.id} (${invoice.customer_email}) session ${sessionId}`);
    } else if (invoice.metadata?.truemed_status !== status && invoice.status === 'open') {
      await stripe.updateInvoiceMetadata(invoice.id, { truemed_status: status });
    }
    return { status, invoice };
  }

  // Webhooks are only a hint: the session status is always re-read from Truemed's API
  // (authenticated with our key), so a forged webhook can't mark an invoice paid.
  async function handleTruemedWebhook(req, raw) {
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
    log.log?.(`Truemed webhook: ${raw.slice(0, 2000)}`);
    // Header names only (values may be secrets) so we can see how Truemed signs webhooks.
    log.log?.(`Truemed webhook headers: ${Object.keys(req.headers).join(', ')}`);
    const data = event.data || event.payment_session || event;
    const sessionId = data.payment_session_id || event.payment_session_id || data.id;
    if (!sessionId) return { status: 200, body: 'ignored: no payment session id' };
    try {
      await reconcileTruemedSession(sessionId);
    } catch (err) {
      // Unknown ids (e.g. a dispute id) or Truemed hiccups: log and ack so Truemed doesn't retry forever.
      // The client's return page re-checks the session anyway.
      log.error?.(`Truemed webhook for ${sessionId} not reconciled: ${err.message}`);
      return { status: 200, body: 'ignored' };
    }
    return { status: 200, body: 'ok' };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    const json = (status, obj) => send(status, JSON.stringify(obj), 'application/json');
    const pay = url.pathname.match(/^\/pay\/(in_[A-Za-z0-9]+)(\/truemed|\/complete)?$/);

    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, homePage());
      if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok', 'text/plain');

      if (pay && req.method === 'GET' && !pay[2]) {
        const invoice = await stripe.getInvoice(pay[1]).catch(() => undefined);
        if (!invoice) return send(404, messagePage('Invoice not found', 'Please check the link your coach sent you.'));
        if (invoice.status === 'paid') return send(200, messagePage('Already paid', 'This invoice has been paid. Thank you!'));
        if (invoice.status !== 'open') return send(409, messagePage('Invoice unavailable', 'This invoice is not open for payment. Please contact your coach.'));
        return send(200, payPage({ invoice, config, truemedFailed: url.searchParams.get('truemed') === 'failed' }));
      }

      if (pay && req.method === 'POST' && pay[2] === '/truemed') {
        try {
          return json(200, await startTruemed(pay[1]));
        } catch (err) {
          log.error?.(err);
          return json(err.status || 400, { error: err.message });
        }
      }

      if (pay && req.method === 'GET' && pay[2] === '/complete') {
        let invoice = await stripe.getInvoice(pay[1]);
        if (url.searchParams.get('via') === 'truemed' && invoice.metadata?.truemed_session_id) {
          ({ invoice } = await reconcileTruemedSession(invoice.metadata.truemed_session_id, invoice));
          return send(
            200,
            messagePage(
              'Thank you!',
              invoice?.status === 'paid'
                ? 'Your HSA/FSA payment is complete. Your coach will be in touch shortly.'
                : 'Your HSA/FSA payment is being finalized by Truemed (usually within minutes). You’ll get a receipt by email, and your coach will be in touch.',
            ),
          );
        }
        const piId = url.searchParams.get('payment_intent');
        const pi = piId ? await stripe.getPaymentIntent(piId).catch(() => undefined) : undefined;
        const ok = invoice.status === 'paid' || pi?.status === 'succeeded' || pi?.status === 'processing';
        return send(
          200,
          ok
            ? messagePage('Thank you!', 'Your payment was received. Your coach will be in touch shortly.')
            : messagePage('Payment not completed', `Your payment didn’t go through. <a href="${payUrl(invoice.id)}">Try again</a>.`),
        );
      }

      if (req.method === 'POST' && url.pathname === '/webhooks/truemed') {
        const result = await handleTruemedWebhook(req, await readBody(req));
        return send(result.status, result.body, 'text/plain');
      }

      if (url.pathname === '/admin') {
        if (!isAdmin(req)) return send(401, 'Authentication required', 'text/plain', { 'www-authenticate': 'Basic realm="sjfit"' });
        const { data } = await stripe.listOpenInvoices();
        return send(200, adminPage({ invoices: data, payUrl, config }));
      }

      return send(404, 'Not found', 'text/plain');
    } catch (err) {
      log.error?.(err);
      return send(500, messagePage('Something went wrong', 'Please try again, or contact your coach.'));
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnv();
  const config = getConfig();
  const problems = validateConfig(config);
  if (problems.length) {
    console.error(`Config problems (MODE=${config.mode}):\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  if (!config.adminPassword) console.warn('ADMIN_PASSWORD is not set; /admin will be locked.');
  const truemed = new TruemedClient({ apiKey: config.truemedApiKey, baseUrl: config.truemedBaseUrl });
  const stripe = new StripeClient({ secretKey: config.stripeSecretKey });
  createServer(createApp({ config, truemed, stripe })).listen(config.port, () => {
    console.log(`SJFit listening on ${config.publicUrl} (MODE=${config.mode}, Truemed ${config.truemedEnv}: ${config.truemedBaseUrl})`);
  });
}
