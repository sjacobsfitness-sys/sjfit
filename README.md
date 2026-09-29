# SJFit – Truemed HSA/FSA payments

Lets Jacobs Fitness clients pay for coaching with HSA/FSA cards through Truemed.

Sean invoices clients one-on-one, so there is no Stripe checkout to modify. Instead:

1. Sean opens `/admin`, picks the service (SKU), enters the client's name/email and the **full prepaid price**
   (e.g. 6 or 12 months up front), and gets a Truemed payment link.
2. Sean sends that link to the client like any other payment link.
3. The client takes Truemed's short health survey and pays with their HSA/FSA card.
4. Truemed gets a Letter of Medical Necessity, captures the payment and sends a webhook to `/webhooks/truemed`.
   The order flips to `captured` in `/admin` and payout arrives through Truemed's Stripe connection in 1–2 days.

## SKUs (send these to Truemed / Lucas)

| SKU | Service |
| --- | --- |
| `SJF-MOVE-COACH` | Online Movement Coaching |
| `SJF-NUTRITION-COACH` | Health & Nutrition Coaching |
| `SJF-BLOODWORK-REVIEW` | Blood Work Review |
| `SJF-INPERSON-SESSION` | In-Person Training Session |

SKUs must never change; prices can be anything at purchase time. Edit `src/catalog.js` to add more.

## Setup

Requires Node 20+. No npm dependencies.

```bash
cp .env.example .env      # then paste your Truemed SANDBOX API key into TRUEMED_API_KEY
npm test                  # unit tests (no network)
npm run smoke             # creates a real Truemed sandbox payment session and prints the checkout URL
npm start                 # http://localhost:3000  (admin at /admin, user "admin", password = ADMIN_PASSWORD)
```

Never commit `.env`. It's already in `.gitignore`.

To go live: set `TRUEMED_ENV=production`, swap in the production API key Truemed gives you, set `PUBLIC_URL` to
the deployed URL and give Truemed `https://<your-domain>/webhooks/truemed` as the webhook URL.

## Verified against Truemed sandbox (2026-09-29)

Full lifecycle tested end to end: create session → survey → HSA/FSA checkout → letter → `captured`.

- Base URL `https://dev-api.truemed.com`, auth header `x-truemed-api-key`
- `POST /payments/v1/create_payment_session` returns `{ id, redirect_url }`
- `GET /payments/v1/payment_session/{id}` returns `status: "captured"` once paid, plus `truemed_fee`
- Truemed's fee on a $600 test order was $38.00 (~6.33%). Set `TRUEMED_FEE_PERCENT=6.33` to pass it through to clients.

Still unverified: the webhook payload shape. The handler looks for `payment_session_id`/`id`, then **re-fetches the
session from Truemed** to get the real status, so a forged webhook can't mark an order paid.
