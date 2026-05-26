# Kalmely API Worker

Cloudflare Worker that bridges the front-end (`cart.html`, `ebook-only.html`) to Stripe + Klaviyo.

## Endpoints

- `POST /api/checkout` — body `{ sku, qty?, coupon? }` → returns `{ url }` (Stripe Checkout Session URL with automatic discounts).
- `POST /api/webhook` — Stripe `checkout.session.completed` handler. Sends `Order placed` event to Klaviyo, which triggers the post-purchase flow (confirmation + ebook PDF link).
- `GET  /api/health` — sanity probe.

## First-time setup

```bash
# 1. Install wrangler if you don't have it
npm install -g wrangler

# 2. Authenticate (opens browser)
wrangler login

# 3. From this directory, create the secrets
cd worker
wrangler secret put STRIPE_SECRET            # sk_live_… or sk_test_…
wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_…
wrangler secret put STRIPE_PRICE_KAL_SOLO    # price_…  (£149 device only)
wrangler secret put STRIPE_PRICE_KAL_BUNDLE  # price_…  (£223 list price for bundle)
wrangler secret put STRIPE_PRICE_EBOOK       # price_…  (£29 digital guide)
wrangler secret put STRIPE_COUPON_LAUNCH     # coupon_…  (−£74, bundle only, automatic)
wrangler secret put STRIPE_COUPON_RELIEF15   # coupon_…  (−£15, devices only, on demand)
wrangler secret put KLAVIYO_KEY              # pk_… (Klaviyo private API key)
wrangler secret put EBOOK_PDF_URL            # https://cdn.kalmely.com/migraine-tracker.pdf

# 4. Deploy
wrangler deploy

# Output:
#   Uploaded kalmely-api
#   Published kalmely-api
#     https://kalmely-api.<your-subdomain>.workers.dev
```

## Attach custom domain `webhook.kalmely.com`

In Cloudflare dashboard → **Workers & Pages → kalmely-api → Settings → Triggers → Custom Domains → Add Custom Domain → `webhook.kalmely.com`**.

Cloudflare adds the necessary CNAME/A automatically because the zone is on Cloudflare.

## Configure Stripe webhook

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
2. URL: `https://webhook.kalmely.com/api/webhook`
3. Event: `checkout.session.completed`
4. Copy the **Signing secret** (`whsec_…`)
5. `wrangler secret put STRIPE_WEBHOOK_SECRET` and paste it

## Test (test mode, before going live)

```bash
# Health
curl https://webhook.kalmely.com/api/health

# Create a session
curl -X POST https://webhook.kalmely.com/api/checkout \
  -H "Content-Type: application/json" \
  -d '{"sku":"KAL-BUNDLE","qty":1,"coupon":"RELIEF15"}'
# → returns { url: "https://checkout.stripe.com/..." }

# Open the URL — you should see:
#   Kalmely + Launch Bonus Kit … £223
#   Launch week promo            −£74
#   RELIEF15                     −£15
#   Total                         £134
```

Pay with `4242 4242 4242 4242`, any future expiry, any CVC. Stripe will fire the webhook to `/api/webhook` and you'll see the Klaviyo event appear in Klaviyo → Events.
