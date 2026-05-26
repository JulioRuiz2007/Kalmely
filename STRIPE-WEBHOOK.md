# Stripe webhook + email delivery — implementation guide

This document describes the production wiring for **post-purchase email delivery** of the digital guide. The landing currently has placeholders only.

## Architecture

```
[Customer]
   │
   ▼
[Stripe Checkout] ──── checkout.session.completed ────► [Cloudflare Worker / Vercel function]
                                                            │
                                                            ▼
                                                  [Klaviyo / Mailchimp API]
                                                            │
                                                            ▼
                                                    [Email with PDF link]
```

The PDF lives in **Cloudflare R2** at a stable URL — we never email the file itself, only the signed download URL.

---

## Stripe — products to create

In Stripe Dashboard → Products, create:

| Product | Price ID env var | Amount | Mode |
|---|---|---|---|
| **Kalmely Head Massager** | `STRIPE_PRICE_KAL1` | $149.00 USD | one_time |
| **30-Day Migraine Tracker (digital)** | `STRIPE_PRICE_EBOOK` | $29.00 USD | one_time |

Klarna is enabled at Dashboard → Settings → Payment methods. No code change required.

Update `cart.html` (line ~190) and `ebook-only.html` (script block at the bottom):

```js
const stripe = Stripe('pk_live_REPLACE_ME');
const skuToPrice = {
  'KAL-1':  '<STRIPE_PRICE_KAL1>',
  'EBOOK':  '<STRIPE_PRICE_EBOOK>',
};
await stripe.redirectToCheckout({
  lineItems: [{ price: skuToPrice[sku], quantity: qty }],
  mode: 'payment',
  successUrl: 'https://kalmely.com/thank-you?sku=' + sku,
  cancelUrl: 'https://kalmely.com/cart?sku=' + sku
});
```

---

## Webhook endpoint — Cloudflare Worker (recommended)

```js
// worker.js
export default {
  async fetch(request, env) {
    const sig = request.headers.get('stripe-signature');
    const body = await request.text();

    // 1. Verify signature
    const evt = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
    if (evt.type !== 'checkout.session.completed') return new Response('ignored', { status: 200 });

    const session = evt.data.object;
    const email = session.customer_details.email;
    const amount = session.amount_total / 100;

    // 2. Determine product purchased
    const items = await listLineItems(session.id, env.STRIPE_SECRET);
    const includesEbook = items.some(i => i.price.id === env.STRIPE_PRICE_KAL1 || i.price.id === env.STRIPE_PRICE_EBOOK);

    // 3. Generate signed URL for PDF in R2 (24h validity)
    const pdfUrl = await signR2Url('migraine-tracker.pdf', env.R2_BUCKET, env.R2_KEY, env.R2_SECRET, 86400);

    // 4. Trigger Klaviyo email
    await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${env.KLAVIYO_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2024-10-15'
      },
      body: JSON.stringify({
        data: {
          type: 'event',
          attributes: {
            properties: {
              order_id: session.id,
              amount: amount,
              pdf_url: pdfUrl,
              includes_ebook: includesEbook,
              delivery_eta: '5-7 business days'
            },
            metric: { data: { type: 'metric', attributes: { name: 'Order placed' } } },
            profile: { data: { type: 'profile', attributes: { email: email } } }
          }
        }
      })
    });

    return new Response('ok', { status: 200 });
  }
};
```

### Klaviyo flow template

Create a flow in Klaviyo triggered by the `Order placed` metric:

1. **Email #1 — Order confirmation (immediate)**
   - Subject: `Your Kalmely is on its way — and here's your free guide`
   - Body includes: order number, amount, estimated delivery, **direct link to PDF**, link to /thank-you page, hello@kalmely.com
2. **Email #2 — Day 3** Tracking placeholder reminder
3. **Email #3 — Day 7** "How to use Kalmely" quick-start

### Cloudflare R2 setup

```bash
# Create bucket
wrangler r2 bucket create kalmely-assets

# Upload PDF
wrangler r2 object put kalmely-assets/migraine-tracker.pdf --file ./assets/ebook/migraine-tracker.pdf

# Configure custom domain (optional): cdn.kalmely.com
```

---

## Environment variables

Set in Cloudflare Workers / Vercel:

```
STRIPE_SECRET=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_KAL1=price_…
STRIPE_PRICE_EBOOK=price_…
KLAVIYO_KEY=pk_…
R2_BUCKET=kalmely-assets
R2_KEY=…
R2_SECRET=…
```

---

## TODO (cuando llegue el producto real)

- [ ] Crear los 2 productos en Stripe Dashboard, copiar los `price_xxx` IDs
- [ ] Reemplazar `pk_live_REPLACE_ME` en `cart.html` y `ebook-only.html`
- [ ] Subir el PDF final a `assets/ebook/migraine-tracker.pdf` (actualmente es placeholder de 1 página)
- [ ] Subir el PDF también a R2 bucket
- [ ] Deploy del Worker como `webhook.kalmely.com/stripe`
- [ ] Crear el endpoint en Stripe Dashboard → Webhooks → Add endpoint, copiar el `whsec_…`
- [ ] Crear flow en Klaviyo y conectar la metric `Order placed`
- [ ] Test end-to-end con tarjeta `4242 4242 4242 4242`
