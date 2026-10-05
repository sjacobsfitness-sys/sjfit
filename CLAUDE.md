# SJFit pay app – notes for Claude

Jacobs Fitness (Sean) bills clients with Stripe invoices. Clients pay at `https://pay.jacobsfit.com/pay/<invoice id>`
by card or HSA/FSA (Truemed). App runs on Render (service `srv-datvjf8jo6nc73cks1o0`, free plan); admin work stays in Stripe.

## When Sean asks for a client invoice / pay link

ALWAYS ask for anything missing before creating it. Required:

1. **Client full name**
2. **Client email**
3. **Service** – one of:
   - `inperson-training` – Private In-Person Training Sessions
   - `online-training` – Online Coaching: Training
   - `online-nutrition` – Online Coaching: Nutrition
   - `online-hybrid` – Online Coaching: Training + Nutrition
4. **Price** (the normal card price; the app adds the 6.34% Truemed fee only for HSA/FSA payers)
5. **What it's for**, shown on the invoice (e.g. "6 months online coaching")
6. **Live or test** (default: live for real clients)

Optional: client's US state (helps Truemed), days until due (default 7).

Repeat the details back in one line and confirm before creating a **live** invoice. Then run:

```bash
node scripts/invoice.js --name "Jane Doe" --email jane@example.com --sku online-training \
  --amount 600 --desc "Online Coaching: Training - 6 months" [--state CA] --live
```

`--live` needs `STRIPE_SECRET_KEY_LIVE` in the environment (it lives in Render → Environment). Reply with the `link`
from the output; that is what Sean sends the client. The script finalizes the invoice but does not email it.

## Facts

- `MODE` env var picks test vs live credentials (`*_LIVE` vars). Currently `live`.
- Invoices must use a Stripe product with metadata `truemed_sku`, or HSA/FSA checkout is blocked (card still works).
- Paid via Truemed → invoice marked "paid out of band" once the Truemed session is `captured`.
- Refunds/disputes for HSA/FSA payments are handled in Truemed, not Stripe.
- Never paste or commit secret keys; they live in Render's Environment tab.
