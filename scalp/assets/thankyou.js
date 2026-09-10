/* Receipt data comes from the paid Stripe session, never from URL prices or a stale cart. */
(function () {
  'use strict';
  const sessionId = new URLSearchParams(location.search).get('session_id');
  const api = 'https://kalmely-api.julioruizbayarri.workers.dev/api/checkout-summary';
  const $ = id => document.getElementById(id);
  const heading = $('tyHeading'), intro = $('tyIntro'), retry = $('tyRetry');
  let busy = false, attempts = 0, tracked = false;
  const contact = ' <a href="mailto:hello@kalmely.com">hello@kalmely.com</a>.';
  function trackPaid(data) {
    if (tracked || data.state !== 'paid') return;
    tracked = true;
    const key = 'kalmely_purchase_' + sessionId;
    try { if (localStorage.getItem(key)) return; } catch (_) {}
    const value = data.amount / 100;
    if (window.fbq) window.fbq('track', 'Purchase', {
      value, currency: data.currency, content_ids: [data.sku],
      content_type: 'product', content_name: data.product
    }, { eventID: sessionId });
    if (window.gtag) window.gtag('event', 'purchase', {
      value, currency: data.currency, transaction_id: sessionId,
      items: [{ item_id: data.sku, item_name: data.product, price: value, quantity: 1 }]
    });
    try {
      localStorage.setItem(key, '1');
      ['kalmely_last_purchase', 'kalmely_bag', 'kalmely_pack', 'kalmely_colors'].forEach(k => localStorage.removeItem(k));
    } catch (_) {}
  }
  function showPaid(data) {
    const labels = { preparing: 'Twoje zamówienie jest w przygotowaniu.', shipped: 'Twoje zamówienie zostało wysłane.', delivered: 'Twoje zamówienie oznaczono jako doręczone.' };
    heading.textContent = labels[data.status] || labels.preparing;
    $('tyEyebrow').textContent = 'Płatność potwierdzona';
    intro.innerHTML = 'Dziękujemy! Potwierdzenie zamówienia i e-book wysyłamy na adres podany przy płatności. Jeśli nie dotrą w ciągu 10 minut, sprawdź spam lub napisz na' + contact;
    const image = $('tyProductImg').querySelector('img');
    image.src = data.image;
    image.alt = data.product + (data.gifts ? ' · ' + data.gifts : '');
    $('tyProductTitle').textContent = data.product;
    $('tyProductGifts').textContent = data.gifts ? 'W zestawie: ' + data.gifts : '';
    $('tyProductImg').hidden = false;
    $('tyProductSummary').hidden = false;
    $('tyCard').hidden = false;
    $('tyDigital').hidden = false;
    $('tyNext').hidden = false;
    $('order-num').textContent = data.number;
    $('tyAmount').textContent = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: data.currency }).format(data.amount / 100);
    const months = Number(data.sku.slice(-1)) * 2;
    $('tyOrderType').textContent = data.subscription ? 'Subskrypcja · co ' + months + ' mies.' : 'Zakup jednorazowy';
    $('tySubscription').hidden = !data.subscription;
    $('tyTrackingText').textContent = data.status === 'preparing' ? 'Numer śledzenia pojawi się po nadaniu.' : 'Aktualne informacje znajdziesz w statusie zamówienia.';
    if (data.statusUrl) {
      const url = new URL(data.statusUrl);
      if (url.protocol === 'https:' && url.pathname === '/order') {
        $('tyStatusLink').href = url.href;
        $('tyStatusLink').hidden = false;
      }
    }
    retry.hidden = true;
    trackPaid(data);
  }
  async function load() {
    if (busy) return;
    busy = true; retry.disabled = true; attempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error('receipt unavailable');
      if (data.state === 'paid' && ['SCALP-1', 'SCALP-2', 'SCALP-3'].includes(data.sku) && ['PLN', 'USD'].includes(data.currency) && Number.isInteger(data.amount) && data.amount >= 0) {
        showPaid(data);
        // The payment can arrive just before the order webhook. Refresh the status link briefly.
        if (!data.statusUrl && attempts < 4) setTimeout(load, 2500);
      } else {
        heading.textContent = 'Czekamy na potwierdzenie płatności.';
        $('tyEyebrow').textContent = 'Płatność w toku';
        intro.innerHTML = 'Potwierdzenie zamówienia i e-book otrzymasz po zaksięgowaniu płatności. Nie musisz składać drugiego zamówienia. W razie pytań napisz na' + contact;
        retry.hidden = false;
        if (attempts < 4) setTimeout(load, 2500);
      }
    } catch (_) {
      if (!$('tyCard').hidden) return; // Keep a previously confirmed receipt visible.
      heading.textContent = 'Sprawdź potwierdzenie w e-mailu.';
      $('tyEyebrow').textContent = 'Status zamówienia';
      intro.innerHTML = 'Nie możemy teraz pobrać szczegółów zamówienia. To nie oznacza, że płatność się nie udała. Sprawdź e-mail z potwierdzeniem lub napisz na' + contact;
      retry.hidden = false;
    } finally {
      clearTimeout(timeout); busy = false; retry.disabled = false;
    }
  }
  retry.addEventListener('click', () => { attempts = 0; load(); });
  if (/^cs_(live|test)_[A-Za-z0-9_]{8,230}$/.test(sessionId || '')) load();
  else {
    heading.textContent = 'Szczegóły Twojego zamówienia.';
    $('tyEyebrow').textContent = 'Kalmely';
    intro.innerHTML = 'Otwórz tę stronę po zakończeniu płatności albo sprawdź prywatny link w e-mailu z potwierdzeniem. Potrzebujesz pomocy? Napisz na' + contact;
  }
})();
