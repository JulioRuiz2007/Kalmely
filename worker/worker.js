/**
 * Kalmely Stripe + Email Worker
 *
 *  POST /api/checkout         → create Stripe Checkout Session with auto-applied coupons
 *  POST /api/webhook          → handle checkout.session.completed (email + ebook delivery)
 *  GET  /api/health           → health probe
 *
 * Env vars (set via wrangler secret put):
 *   STRIPE_SECRET              sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET      whsec_…
 *   STRIPE_PRICE_KAL_SOLO      price_…  (£149)
 *   STRIPE_PRICE_KAL_BUNDLE    price_…  (£223 list — bundle includes free digital guide)
 *   STRIPE_COUPON_LAUNCH           coupon_…  (-£74, bundle only, automatic)
 *   STRIPE_COUPON_RELIEF15         coupon_…  (-£15, applies to KAL-SOLO)
 *   STRIPE_COUPON_LAUNCH_RELIEF15  coupon_…  (-£89, bundle + RELIEF15 combined,
 *                                  required because Stripe Checkout accepts only 1 discount)
 *   KLAVIYO_KEY                pk_… (private key)
 *   EBOOK_PDF_URL              https://cdn.kalmely.com/migraine-tracker.pdf  (or R2 signed url generator)
 *   SITE_ORIGIN                https://kalmely.com
 */

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
  'Access-Control-Max-Age': '86400'
});

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });

const SKU_MAP = (env) => ({
  'KAL-SOLO':   { price: env.STRIPE_PRICE_KAL_SOLO,   applyLaunch: false, applyRelief: true, shippable: true, includesEbook: false },
  'KAL-BUNDLE': { price: env.STRIPE_PRICE_KAL_BUNDLE, applyLaunch: true,  applyRelief: true, shippable: true, includesEbook: true  }
});

async function stripe(env, path, params, method = 'POST') {
  const body = new URLSearchParams();
  const flatten = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item, i) => {
        if (item && typeof item === 'object') flatten(item, `${key}[${i}]`);
        else body.append(`${key}[${i}]`, String(item));
      });
      else if (typeof v === 'object') flatten(v, key);
      else body.append(key, String(v));
    }
  };
  if (params) flatten(params);
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: method === 'POST' ? body : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path}: ${data.error?.message || res.status}`);
  return data;
}

async function createCheckout(request, env) {
  const origin = request.headers.get('Origin') || env.SITE_ORIGIN;
  const { sku, qty = 1, coupon } = await request.json();
  const map = SKU_MAP(env);
  const bundle = map[sku];
  if (!bundle) return json({ error: `Unknown sku ${sku}` }, 400, CORS(origin));

  // Stripe Checkout accepts only ONE discount per session, so we pick the
  // pre-combined coupon when both LAUNCH (auto-bundle) and RELIEF15 (user) apply.
  const wantsRelief = coupon && coupon.toUpperCase() === 'RELIEF15' && bundle.applyRelief;
  let discountCoupon = null;
  if (bundle.applyLaunch && wantsRelief && env.STRIPE_COUPON_LAUNCH_RELIEF15) {
    discountCoupon = env.STRIPE_COUPON_LAUNCH_RELIEF15;          // bundle + RELIEF15 → −£89
  } else if (bundle.applyLaunch && env.STRIPE_COUPON_LAUNCH) {
    discountCoupon = env.STRIPE_COUPON_LAUNCH;                   // bundle only         → −£74
  } else if (wantsRelief && env.STRIPE_COUPON_RELIEF15) {
    discountCoupon = env.STRIPE_COUPON_RELIEF15;                 // solo + RELIEF15     → −£15
  }
  const discounts = discountCoupon ? [{ coupon: discountCoupon }] : null;

  const successUrl = `${env.SITE_ORIGIN}/thank-you.html?sku=${sku}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${env.SITE_ORIGIN}/cart.html?sku=${sku}`;

  const session = await stripe(env, '/checkout/sessions', {
    mode: 'payment',
    line_items: [{ price: bundle.price, quantity: Math.max(1, Math.min(10, +qty || 1)) }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    billing_address_collection: 'required',
    ...(bundle.shippable ? { shipping_address_collection: { allowed_countries: ['GB'] } } : {}),
    ...(discounts ? { discounts } : { allow_promotion_codes: true }),
    metadata: { sku, qty: String(qty), applied_coupon: coupon || '' }
  });

  return json({ url: session.url, id: session.id }, 200, CORS(origin));
}

// ---------- WEBHOOK ----------

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) throw new Error('Missing stripe-signature');
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) throw new Error('Malformed signature');
  const signed = `${ts}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const computed = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (computed !== v1) throw new Error('Signature mismatch');
  if (Math.abs(Date.now() / 1000 - +ts) > 300) throw new Error('Timestamp too old');
}

async function sendKlaviyoEvent(env, email, props, metricName = 'Order placed') {
  if (!env.KLAVIYO_KEY) return { skipped: true };
  const res = await fetch('https://a.klaviyo.com/api/events/', {
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
          properties: props,
          metric:  { data: { type: 'metric',  attributes: { name: metricName } } },
          profile: { data: { type: 'profile', attributes: { email } } }
        }
      }
    })
  });
  return { status: res.status, ok: res.ok };
}

async function handleWebhook(request, env, ctx) {
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();
  try {
    await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return new Response(`Bad signature: ${e.message}`, { status: 400 });
  }
  const event = JSON.parse(body);
  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 });
  }
  const session = event.data.object;
  const email = session.customer_details?.email;
  const sku = session.metadata?.sku;
  const amountTotal = (session.amount_total || 0) / 100;
  const includesEbook = sku === 'KAL-BUNDLE';

  // Fire-and-forget Klaviyo notification
  ctx.waitUntil(sendKlaviyoEvent(env, email, {
    order_id: session.id,
    sku,
    amount: amountTotal,
    currency: (session.currency || 'gbp').toUpperCase(),
    pdf_url: includesEbook ? env.EBOOK_PDF_URL : null,
    includes_ebook: includesEbook,
    delivery_eta: '5-7 business days'
  }));

  return new Response('ok', { status: 200 });
}

// ---------- ROUTER ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || env.SITE_ORIGIN;

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS(origin) });

    if (url.pathname === '/api/health') return json({ ok: true, time: new Date().toISOString() });

    if (url.pathname === '/api/checkout' && request.method === 'POST') {
      try { return await createCheckout(request, env); }
      catch (e) { return json({ error: e.message }, 500, CORS(origin)); }
    }

    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      return handleWebhook(request, env, ctx);
    }

    if (url.pathname === '/api/lead-magnet' && request.method === 'POST') {
      try { return await handleLeadMagnet(request, env, ctx, origin); }
      catch (e) { return json({ error: e.message }, 500, CORS(origin)); }
    }

    return new Response('Not found', { status: 404 });
  }
};

// ---------- LEAD MAGNET ----------

async function handleLeadMagnet(request, env, ctx, origin) {
  const { email, source } = await request.json();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, 400, CORS(origin));
  }
  // Fire a Klaviyo event so the "Lead magnet requested" flow can deliver the PDF.
  // The flow itself lives in Klaviyo; here we only need to push the event.
  ctx.waitUntil(sendKlaviyoEvent(env, email, {
    source: source || 'lead_magnet_ebook',
    pdf_url: env.EBOOK_PDF_URL || null,
    requested_at: new Date().toISOString()
  }, 'Lead magnet requested'));
  return json({ ok: true }, 202, CORS(origin));
}
