/**
 * Kalmely Stripe + Email Worker
 *
 *  POST /api/checkout         → create Stripe Checkout Session with auto-applied coupons
 *  POST /api/webhook          → handle checkout.session.completed (order email + travel-guide delivery via Resend)
 *  POST /api/lead-magnet      → email the 30-Day Migraine Tracker PDF via Resend
 *  GET  /api/health           → health probe
 *
 * Env vars (set via wrangler secret put):
 *   STRIPE_SECRET                  sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET          whsec_…
 *   STRIPE_PRICE_KAL_BUNDLE        price_…  (£223 list — legacy massager kit)
 *   STRIPE_PRICE_MASK_1            price_…  (£39 — Kalmely Sleep Mask, single)   ← create in Stripe
 *   STRIPE_PRICE_MASK_2            price_…  (£54 — Sleep Mask 2-pack)            ← create in Stripe
 *   STRIPE_PRICE_MASK_3            price_…  (£69 — Sleep Mask 3-pack)            ← create in Stripe
 *   STRIPE_COUPON_LAUNCH           coupon_…  (-£74, bundle only, automatic)
 *   STRIPE_COUPON_RELIEF15         coupon_…  (-£15, customer-entered code on KAL-BUNDLE)
 *   STRIPE_COUPON_LAUNCH_RELIEF15  coupon_…  (-£89, bundle + RELIEF15 combined,
 *                                  required because Stripe Checkout accepts only 1 discount)
 *   RESEND_API_KEY                 re_…   (Resend API key, used for all transactional email)
 *   RESEND_FROM                    "Kalmely <orders@kalmely.com>"  (verified sender)
 *   EBOOK_PDF_URL                  https://cdn.kalmely.com/migraine-tracker.pdf  (legacy KAL-BUNDLE only)
 *   GUIDE_PDF_URL                  /assets/how-to-sleep-on-any-flight.pdf  (sleep-mask orders; optional, defaults to SITE_ORIGIN)
 *   SITE_ORIGIN                    https://kalmely.com
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
  // Legacy massager kit — kept so old links/orders still resolve. No longer promoted.
  'KAL-BUNDLE': { price: env.STRIPE_PRICE_KAL_BUNDLE, applyLaunch: true, applyRelief: true, shippable: true, includesEbook: true },
  // Sleep Mask packs (2026 pivot). Fixed price per pack, NO auto-coupons.
  // Each maps to its own Stripe Price (create the 3 products in Stripe and set the
  // STRIPE_PRICE_MASK_* secrets below). qty is always 1 — the pack IS the quantity.
  'MASK-1': { price: env.STRIPE_PRICE_MASK_1, applyLaunch: false, applyRelief: false, shippable: true, includesEbook: false, includesGuide: true, qty: 1, name: 'Kalmely Sleep Mask' },
  'MASK-2': { price: env.STRIPE_PRICE_MASK_2, applyLaunch: false, applyRelief: false, shippable: true, includesEbook: false, includesGuide: true, qty: 2, name: 'Kalmely Sleep Mask (2-pack)' },
  'MASK-3': { price: env.STRIPE_PRICE_MASK_3, applyLaunch: false, applyRelief: false, shippable: true, includesEbook: false, includesGuide: true, qty: 3, name: 'Kalmely Sleep Mask (3-pack)' }
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
  const { sku, qty = 1, coupon, colors } = await request.json();
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
  const cancelUrl  = `${env.SITE_ORIGIN}/`;   // back/cancel from Stripe → home (bag persists, CTA shows "Resume your order")

  const session = await stripe(env, '/checkout/sessions', {
    mode: 'payment',
    line_items: [{ price: bundle.price, quantity: Math.max(1, Math.min(10, +qty || 1)) }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    billing_address_collection: 'required',
    ...(bundle.shippable ? { shipping_address_collection: { allowed_countries: ['GB'] } } : {}),
    ...(discounts ? { discounts } : { allow_promotion_codes: true }),
    metadata: { sku, qty: String(qty), applied_coupon: coupon || '', colors: colors || '' }
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

// ---------- EMAIL (Resend) ----------

async function sendResendEmail(env, { to, subject, html, attachments }) {
  if (!env.RESEND_API_KEY) {
    console.log('RESEND_API_KEY missing — skipping email to', to);
    return { skipped: true };
  }
  const from = env.RESEND_FROM || 'Kalmely <orders@kalmely.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html, ...(attachments && attachments.length ? { attachments } : {}) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.log('[resend] ERROR', res.status, JSON.stringify(data));
  else console.log('[resend] sent to', to, '· id', data.id || '(none)');
  return { status: res.status, ok: res.ok, data };
}

function emailShell(innerHtml, preheader = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kalmely</title>
</head>
<body style="margin:0;padding:0;background:#FBF7F0;font-family:Georgia,'Times New Roman',serif;color:#2C3A2F;">
<div style="display:none;font-size:1px;color:#FBF7F0;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBF7F0;padding:40px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:40px 36px;">
      <tr><td style="text-align:center;padding-bottom:24px;">
        <span style="font-family:Georgia,serif;font-size:22px;color:#1F3D2F;letter-spacing:.5px;">Kalmely<span style="color:#B25E3F;">·</span></span>
      </td></tr>
      ${innerHtml}
      <tr><td style="padding-top:32px;border-top:1px solid #EFEAE0;text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#8A8378;line-height:1.6;">
        Kalmely Ltd · Designed in the UK · <a href="https://kalmely.com" style="color:#8A8378;text-decoration:underline;">kalmely.com</a><br>
        Questions? Reply to this email — we answer within 24h.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildOrderHtml({ orderId, amountLabel, eta, productLine, colorsLine, digital, preheader }) {
  const digitalBlock = digital ? `
      <tr><td style="padding-top:32px;">
        <div style="background:#F4EFE5;border-radius:10px;padding:24px;">
          <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.4px;color:#B25E3F;text-transform:uppercase;margin-bottom:8px;">${digital.eyebrow}</div>
          <h2 style="font-family:Georgia,serif;font-size:22px;color:#1F3D2F;margin:0 0 12px;">${digital.title}</h2>
          <p style="font-family:Georgia,serif;font-size:15px;line-height:1.65;color:#2C3A2F;margin:0 0 18px;">${digital.blurb}</p>
          <a href="${digital.url}" style="display:inline-block;background:#1F3D2F;color:#FBF7F0;font-family:Arial,sans-serif;font-size:14px;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;letter-spacing:.4px;">${digital.btn}</a>
          <p style="font-family:Arial,sans-serif;font-size:12px;color:#8A8378;margin:14px 0 0;">If the button doesn't work, copy this link: <span style="color:#1F3D2F;">${digital.url}</span></p>
        </div>
      </td></tr>` : '';

  const itemRow = productLine ? `
          <tr>
            <td colspan="2" style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.2px;color:#8A8378;text-transform:uppercase;padding:14px 0 6px;">Your order</td>
          </tr>
          <tr>
            <td colspan="2" style="font-family:Georgia,serif;font-size:15px;color:#1F3D2F;">${productLine}${colorsLine ? ` &middot; ${colorsLine}` : ''}</td>
          </tr>` : '';

  const inner = `
      <tr><td>
        <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.4px;color:#B25E3F;text-transform:uppercase;margin-bottom:10px;">Order confirmed</div>
        <h1 style="font-family:Georgia,serif;font-size:28px;line-height:1.25;color:#1F3D2F;margin:0 0 18px;">Your Kalmely is <em style="color:#B25E3F;">on its way.</em></h1>
        <p style="font-family:Georgia,serif;font-size:16px;line-height:1.65;color:#2C3A2F;margin:0 0 18px;">Thank you for ordering. Your payment has been received and a tracking link will reach this inbox within 24 hours.</p>
      </td></tr>
      ${digitalBlock}
      <tr><td style="padding-top:28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8F4EC;border-radius:10px;padding:20px 22px;">
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.2px;color:#8A8378;text-transform:uppercase;padding-bottom:6px;">Order number</td>
            <td style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.2px;color:#8A8378;text-transform:uppercase;padding-bottom:6px;">Estimated delivery</td>
          </tr>
          <tr>
            <td style="font-family:Georgia,serif;font-size:15px;color:#1F3D2F;">${orderId}</td>
            <td style="font-family:Georgia,serif;font-size:15px;color:#1F3D2F;">${eta}</td>
          </tr>${itemRow}
          <tr>
            <td colspan="2" style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.2px;color:#8A8378;text-transform:uppercase;padding:14px 0 6px;">Total paid</td>
          </tr>
          <tr>
            <td colspan="2" style="font-family:Georgia,serif;font-size:15px;color:#1F3D2F;">${amountLabel}</td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding-top:28px;font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#2C3A2F;">
        <strong style="color:#1F3D2F;">What happens next.</strong><br>
        Your Kalmely ships from our EU warehouse within 24 hours. UK delivery is 5–7 business days. You'll receive a tracking link by email as soon as it leaves the warehouse.
      </td></tr>`;

  return emailShell(inner, preheader || 'Your Kalmely is on its way — tracking arrives within 24h.');
}

function buildLeadMagnetHtml({ ebookUrl }) {
  const inner = `
      <tr><td>
        <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1.4px;color:#B25E3F;text-transform:uppercase;margin-bottom:10px;">Your digital guide</div>
        <h1 style="font-family:Georgia,serif;font-size:28px;line-height:1.25;color:#1F3D2F;margin:0 0 18px;">Your 30-Day Migraine <em style="color:#B25E3F;">Tracker.</em></h1>
        <p style="font-family:Georgia,serif;font-size:16px;line-height:1.7;color:#2C3A2F;margin:0 0 22px;">Start tonight. Bring it to your next neurologist visit — most patients shave 30 minutes off the diagnosis conversation.</p>
        <a href="${ebookUrl}" style="display:inline-block;background:#1F3D2F;color:#FBF7F0;font-family:Arial,sans-serif;font-size:14px;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;letter-spacing:.4px;">Download your PDF</a>
        <p style="font-family:Arial,sans-serif;font-size:12px;color:#8A8378;margin:14px 0 0;">If the button doesn't work, copy this link: <span style="color:#1F3D2F;">${ebookUrl}</span></p>
      </td></tr>
      <tr><td style="padding-top:32px;font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#2C3A2F;">
        Over the next few days we'll send you three short notes: the science behind multi-zone air pressure for migraine, a 4-step nightly routine, and a £15 welcome code if you'd like to try Kalmely yourself.<br><br>
        Not interested in the follow-ups? Ignore the next email and we won't write again.
      </td></tr>`;

  return emailShell(inner, 'Your 30-Day Migraine Tracker — download inside.');
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
  const colorsRaw = session.metadata?.colors || '';
  const amountTotal = (session.amount_total || 0) / 100;
  const currency = (session.currency || 'gbp').toUpperCase();
  const entry = SKU_MAP(env)[sku] || {};

  if (email) {
    const orderId = `KAL-${new Date().getFullYear()}-${session.id.slice(-5).toUpperCase()}`;
    const eta = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const amountLabel = `£${amountTotal.toFixed(2)} ${currency}`;
    const productLine = entry.name || 'Kalmely';
    const colorsLine = colorsRaw
      ? colorsRaw.split(',').map(c => c.trim()).filter(Boolean)
          .map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(' + ')
      : '';

    // Digital extra: a free travel guide ships with every sleep mask; the legacy
    // massager bundle still gets the migraine tracker. No ebook on mask orders.
    let digital = null;
    let preheader = 'Your Kalmely is on its way — tracking arrives within 24h.';
    if (entry.includesGuide) {
      digital = {
        eyebrow: 'Your free travel guide',
        title: 'How to sleep on any flight.',
        blurb: 'The habits frequent flyers use to land rested, gathered into one short guide. Yours to keep.',
        url: `${env.SITE_ORIGIN || 'https://kalmely.com'}/guide`,
        pdfUrl: env.GUIDE_PDF_URL || `${env.SITE_ORIGIN || 'https://kalmely.com'}/assets/how-to-sleep-on-any-flight.pdf`,
        btn: 'Download the guide'
      };
      preheader = 'Your Kalmely is on its way, and your free flight-sleep guide is inside.';
    } else if (sku === 'KAL-BUNDLE' && env.EBOOK_PDF_URL) {
      digital = {
        eyebrow: 'Digital guide included',
        title: 'Your 30-Day Migraine Tracker.',
        blurb: 'Start tonight. Bring it to your next neurologist visit, most patients shave 30 minutes off the diagnosis conversation.',
        url: env.EBOOK_PDF_URL,
        btn: 'Download your PDF'
      };
      preheader = 'Your Kalmely is on its way — and here is your 30-Day Migraine Tracker.';
    }

    const html = buildOrderHtml({ orderId, amountLabel, eta, productLine, colorsLine, digital, preheader });
    const subject = 'Your Kalmely is on its way';
    // Attach the guide PDF directly so the customer never depends on a (trackable) link.
    const attachments = digital ? [{ filename: digital.title.replace(/\.$/, '') + '.pdf', path: digital.pdfUrl || digital.url }] : undefined;
    console.log('[order]', JSON.stringify({ email, sku, productLine, colorsLine, guide: !!digital }));
    ctx.waitUntil(sendResendEmail(env, { to: email, subject, html, attachments }));
  }

  return new Response('ok', { status: 200 });
}

// ---------- LEAD MAGNET ----------

async function handleLeadMagnet(request, env, ctx, origin) {
  const { email } = await request.json();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, 400, CORS(origin));
  }
  const ebookUrl = env.EBOOK_PDF_URL || '';
  const html = buildLeadMagnetHtml({ ebookUrl });
  ctx.waitUntil(sendResendEmail(env, {
    to: email,
    subject: 'Your 30-Day Migraine Tracker — download inside',
    html
  }));
  return json({ ok: true }, 202, CORS(origin));
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

    // Temporary: send a REAL preview of the order email (no purchase needed). Key-protected.
    // Uses the same buildOrderHtml + Resend path as the live webhook.
    if (url.pathname === '/api/_preview-order' && request.method === 'GET') {
      if (url.searchParams.get('key') !== 'kalmely_preview_2026') return new Response('forbidden', { status: 403 });
      const to = url.searchParams.get('to');
      if (!to) return json({ error: 'missing ?to=' }, 400);
      const sku = (url.searchParams.get('sku') || 'MASK-2').toUpperCase();
      const entry = SKU_MAP(env)[sku] || {};
      const AMT = { 'MASK-1': '£39.00 GBP', 'MASK-2': '£54.00 GBP', 'MASK-3': '£69.00 GBP' };
      const colorsLine = (url.searchParams.get('colors') || 'black,pink').split(',').map(c => c.trim()).filter(Boolean)
        .map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(' + ');
      const digital = entry.includesGuide ? {
        eyebrow: 'Your free travel guide', title: 'How to sleep on any flight.',
        blurb: 'The habits frequent flyers use to land rested, gathered into one short guide. Yours to keep.',
        url: `${env.SITE_ORIGIN || 'https://kalmely.com'}/guide`,
        pdfUrl: env.GUIDE_PDF_URL || `${env.SITE_ORIGIN || 'https://kalmely.com'}/assets/how-to-sleep-on-any-flight.pdf`,
        btn: 'Download the guide'
      } : null;
      if (url.searchParams.get('inspect') === '1') return json({ guideUrl: digital && digital.url, siteOrigin: env.SITE_ORIGIN, hasGuideEnv: !!env.GUIDE_PDF_URL });
      const html = buildOrderHtml({ orderId: 'KAL-2026-PREVIEW', amountLabel: AMT[sku] || '£54.00 GBP',
        eta: 'within 5–7 days', productLine: entry.name || 'Kalmely', colorsLine, digital,
        preheader: 'Preview of the Kalmely order email.' });
      const attachments = digital ? [{ filename: digital.title.replace(/\.$/, '') + '.pdf', path: digital.pdfUrl || digital.url }] : undefined;
      const subj = url.searchParams.get('subj') || '[Preview] Your Kalmely is on its way';
      const r = await sendResendEmail(env, { to, subject: subj, html, attachments });
      return json({ sent: !!r.ok, status: r.status, to, sku, guide: !!digital });
    }

    return new Response('Not found', { status: 404 });
  }
};
