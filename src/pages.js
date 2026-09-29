import { applyFee } from './truemed.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
// JSON safe to embed inside a <script> tag.
const scriptJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function layout(title, body, head = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>
:root{--fg:#111;--muted:#666;--bg:#fff;--card:#f5f5f5;--accent:#111;--err:#b00020}
body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:var(--fg);background:var(--bg);line-height:1.5}
h1{font-size:1.5rem;margin:0 0 4px}.muted{color:var(--muted)}.err{color:var(--err)}
.card{background:var(--card);border-radius:10px;padding:16px;margin:16px 0}
.row{display:flex;justify-content:space-between;gap:12px}
button,.btn{display:block;width:100%;box-sizing:border-box;padding:14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin-top:12px}
.btn.secondary{background:#fff;color:var(--fg);border:1px solid #ccc}
button[disabled]{opacity:.6;cursor:wait}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:8px 4px;text-align:left;vertical-align:top}
input.copy{width:100%;font:inherit;font-size:12px;padding:6px}
</style></head><body>${body}</body></html>`;
}

export function messagePage(title, html) {
  return layout(title, `<h1>${esc(title)}</h1><p>${html}</p>`);
}

export function homePage() {
  return layout(
    'HSA/FSA accepted',
    `<h1>Pay for coaching with your HSA/FSA</h1>
<p>We accept HSA and FSA cards through Truemed for private in-person training and 1:1 online training and nutrition coaching.</p>
<p>Ask your coach for your invoice pay link and choose <b>HSA/FSA</b> at checkout. You'll answer a short health survey, then pay with your HSA/FSA card.</p>`,
  );
}

export function payPage({ invoice, config, truemedFailed }) {
  const currency = invoice.currency || 'usd';
  const hsaAmount = applyFee(invoice.amount_due, config.feePercent);
  const lines = (invoice.lines?.data || [])
    .map((l) => `<div class="row"><span>${esc(l.description)}</span><span>${money(l.amount, currency)}</span></div>`)
    .join('');
  const summary = `<h1>${esc(config.brandName)}</h1>
<p class="muted">Invoice ${esc(invoice.number || invoice.id)}${invoice.customer_name ? ` · ${esc(invoice.customer_name)}` : ''}</p>
<div class="card">${lines}<hr><div class="row"><b>Total</b><b>${money(invoice.amount_due, currency)}</b></div>
${hsaAmount !== invoice.amount_due ? `<div class="row muted"><span>Paying with HSA/FSA (includes processing)</span><span>${money(hsaAmount, currency)}</span></div>` : ''}</div>
${truemedFailed ? '<p class="err">Your HSA/FSA payment wasn’t completed. You can try again or pay by card.</p>' : ''}`;

  const pi = typeof invoice.payment_intent === 'object' ? invoice.payment_intent : undefined;
  const useElement = Boolean(config.stripePublishableKey && config.stripeCpmTypeId && pi?.client_secret);

  const startTruemedJs = `
async function startTruemed(){
  const r = await fetch(location.pathname + '/truemed', {method:'POST'});
  const d = await r.json().catch(()=>({}));
  if (!r.ok || !d.redirect_url) throw new Error(d.error || 'Could not start HSA/FSA checkout.');
  location.href = d.redirect_url;
}`;

  if (!useElement) {
    // Fallback until the Stripe publishable key + custom payment method ID are configured:
    // HSA/FSA button next to Stripe's own hosted invoice page for card.
    return layout(
      'Pay invoice',
      `${summary}
<button id="hsa">Pay with HSA/FSA</button>
${invoice.hosted_invoice_url ? `<a class="btn secondary" href="${esc(invoice.hosted_invoice_url)}">Pay by card</a>` : ''}
<p id="msg" class="err"></p>
<script>${startTruemedJs}
document.getElementById('hsa').onclick = async (e) => {
  e.target.disabled = true;
  try { await startTruemed(); } catch (err) { document.getElementById('msg').textContent = err.message; e.target.disabled = false; }
};</script>`,
    );
  }

  const clientConfig = {
    publishableKey: config.stripePublishableKey,
    clientSecret: pi.client_secret,
    amount: pi.amount,
    currency: pi.currency,
    paymentMethodTypes: pi.payment_method_types,
    cpmTypeId: config.stripeCpmTypeId,
    returnUrl: `${config.publicUrl}/pay/${invoice.id}/complete`,
  };
  return layout(
    'Pay invoice',
    `${summary}
<form id="form"><div id="payment-element"></div><button id="submit">Pay</button><p id="msg" class="err"></p></form>
<script>const CFG = ${scriptJson(clientConfig)};${startTruemedJs}
const stripe = Stripe(CFG.publishableKey);
const elements = stripe.elements({
  mode: 'payment',
  amount: CFG.amount,
  currency: CFG.currency,
  paymentMethodTypes: CFG.paymentMethodTypes,
  customPaymentMethods: [{ id: CFG.cpmTypeId, options: { type: 'static', subtitle: 'Pay with your HSA/FSA card via Truemed' } }],
});
elements.create('payment').mount('#payment-element');
const btn = document.getElementById('submit'), msg = document.getElementById('msg');
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true; msg.textContent = '';
  try {
    const { error, selectedPaymentMethod } = await elements.submit();
    if (error) throw error;
    if (selectedPaymentMethod === CFG.cpmTypeId) return await startTruemed();
    const res = await stripe.confirmPayment({ elements, clientSecret: CFG.clientSecret, confirmParams: { return_url: CFG.returnUrl } });
    if (res.error) throw res.error;
  } catch (err) {
    msg.textContent = err.message || 'Payment failed.';
    btn.disabled = false;
  }
});</script>`,
    '<script src="https://js.stripe.com/v3/"></script>',
  );
}

export function adminPage({ invoices, payUrl, config }) {
  const rows = invoices
    .map((inv) => {
      const customer = typeof inv.customer === 'object' ? inv.customer : {};
      const link = payUrl(inv.id);
      return `<tr><td>${esc(inv.number || inv.id)}<br><small class="muted">${esc(inv.customer_name || customer.name)}<br>${esc(inv.customer_email || customer.email)}</small></td>
<td>${money(inv.amount_due, inv.currency)}</td><td>${esc(inv.metadata?.truemed_status || '')}</td>
<td><input class="copy" readonly value="${esc(link)}" onclick="this.select()"></td></tr>`;
    })
    .join('');
  return layout(
    'Invoices',
    `<h1>Open invoices</h1>
<p class="muted">Truemed ${esc(config.truemedEnv)}. Send the client the pay link; they can pay by card or HSA/FSA.
Paid invoices drop off this list automatically.</p>
<table><tr><th>Invoice</th><th>Amount</th><th>Truemed</th><th>Pay link</th></tr>${rows || '<tr><td colspan="4">No open invoices.</td></tr>'}</table>`,
  );
}
