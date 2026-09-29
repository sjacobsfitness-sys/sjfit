# SJFit – HSA/FSA payments for Stripe invoices (Truemed)

Clients pay Jacobs Fitness Stripe invoices by **card or HSA/FSA** on one pay page.

```
Sean creates an invoice in Stripe (unchanged)
  → sends the client  https://<app>/pay/<invoice id>   (links listed at /admin)
  → pay page shows Stripe's Payment Element: Card | HSA/FSA (Truemed custom payment method)
       ├─ Card    → the invoice's own Stripe PaymentIntent → invoice paid by Stripe
       └─ HSA/FSA → server reads the invoice from Stripe → Truemed create_payment_session
                    → client does survey + pays with HSA/FSA card on Truemed
                    → Truemed webhook (+ return page) → server re-checks session with Truemed
                    → status "captured" → Stripe invoice marked PAID (out of band)
```

- **No database.** The Truemed session id/link/status are stored on the Stripe invoice's metadata.
- **Amounts always come from Stripe**, never from the browser.
- **Webhooks are never trusted blindly**: the session is re-fetched from Truemed before marking anything paid.
- HSA/FSA invoices are marked *paid out of band*, so no Stripe Payment Records entitlement is needed and
  there's no "Canceled" PaymentIntent entry.
- Until `STRIPE_PUBLISHABLE_KEY` + `STRIPE_CPM_TYPE_ID` are set, the pay page shows two buttons instead:
  **Pay with HSA/FSA** and **Pay by card** (Stripe's hosted invoice page).

## SKUs

Each Stripe Product used on invoices needs metadata `truemed_sku` (already set in test mode):

| SKU | Stripe product |
| --- | --- |
| `inperson-training` | Private In-Person Training Sessions |
| `online-training` | Online Coaching: Training |
| `online-nutrition` | Online Coaching: Nutrition |
| `online-hybrid` | Online Coaching: Training + Nutrition |

Lines without a SKU block HSA/FSA checkout for that invoice (card still works). Fallback: product name match
against `src/catalog.js`.

## Setup

1. **Stripe custom payment method**: Dashboard → Settings → Payments → Custom payment methods → Create →
   "Provide a custom name and icon" → name `HSA/FSA (Truemed)`, Truemed logo. Copy the `cpmt_...` id.
2. **Deploy** on Render: New → Blueprint → this repo (uses `render.yaml`), then fill in the secret env vars
   from `.env.example`.
3. **Truemed webhook** destination: `https://<app>/webhooks/truemed`.
4. Create a test invoice in Stripe test mode with one of the products above, open `/admin`, click through the pay link.

```bash
npm test         # unit tests, no network
npm run smoke    # live Truemed sandbox session (needs TRUEMED_API_KEY)
npm start
```

## Verified against Truemed sandbox (2026-09-29)

- Base URL `https://dev-api.truemed.com`, header `x-truemed-api-key`
- `POST /payments/v1/create_payment_session` → `{ id, redirect_url }`
- `GET /payments/v1/payment_session/{id}` → `status`: `processing` (authorized, awaiting letter) → `captured`
- Fee on a $600 test: `truemed_fee` $38.00

Still to confirm: Truemed webhook payload/signature (handler logs raw payloads and accepts `payment_session_id`/`id`).

## Operations

- **Payouts** come from Truemed via its Stripe Express account (not your Stripe balance), ~1–2 days.
- **Refunds/disputes** for HSA/FSA payments are handled in Truemed, not Stripe.
