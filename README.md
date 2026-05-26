# Kalmely — kalmely.com

Drug-free migraine relief. Wireless head massager with Multi-Zone Air Therapy™ + graphene heat. Built for the moments when even your hair hurts.

## Estructura

```
web-kalmely/
├── index.html              # Landing principal (8 secciones)
├── cart.html               # Carrito + checkout Stripe (placeholder)
├── thank-you.html          # Post-purchase confirmation
├── privacy.html            # GDPR/UK GDPR
├── terms.html              # Terms of sale (UK Consumer Rights compliant)
├── refund-policy.html      # 30-day refund-keep details
├── shipping-policy.html    # EU warehouse, 5–7 days UK, free
├── contact.html            # Contact form (Web3Forms-ready)
├── assets/
│   ├── favicon-kalmely.png # 64x64 PNG
│   └── legal.css           # Shared CSS for legal pages
└── README.md
```

## Stack

- HTML5 semántico + CSS3 (zero frameworks; sin Tailwind, sin build step)
- JavaScript vanilla, sin dependencias
- Fuentes: Newsreader (serif headlines) + Inter (sans body) vía Google Fonts
- Schema.org Product + FAQPage JSON-LD inline
- Lazy-loaded images preparado (placeholder boxes con instrucción de reemplazo)

## Reemplazos obligatorios antes de lanzar

### 1. Imágenes (ya integradas, listas para sustituir por fotos del sample)

| Archivo | Dónde se usa | Descripción actual |
|---|---|---|
| `hero-product.jpg` (900x911) | Hero visual + integrado con blend multiply | Producto extraído del catálogo de referencia. Sustituir por foto del sample con luz natural |
| `lifestyle-wearing.jpg` (900x1004) | Sección Validation (allodynia) | Persona con producto puesto. Sustituir por shoot UGC-style real con sujeto UK |
| `product-square.jpg` (700x737) | Cart + Thank-you | Producto solo sobre fondo cream. Sustituir por sample tras shoot |
| `og-kalmely.jpg` (1200x630) | Open Graph (compartir en redes) | Producto centrado sobre fondo off-white. Regenerar con la foto definitiva |

> Las imágenes actuales están procesadas con multiply blend para integrarse con el fondo cream — al sustituirlas mantén el background neutro de la foto, no de un studio fondo blanco puro.

### 2. Información legal en privacy.html, terms.html, contact.html

Buscar `[REPLACE: ...]` y sustituir:
- Registered UK address
- Companies House number
- Helpdesk provider (Help Scout, Front, Zendesk…)

### 3. Stripe Checkout (cart.html)

En `cart.html`, función `checkout` (línea ~190):

```html
<!-- Cargar Stripe.js -->
<script src="https://js.stripe.com/v3/"></script>
<script>
const stripe = Stripe('pk_live_TU_CLAVE_PUBLICA');

document.getElementById('checkout').addEventListener('click', async () => {
  if (window.fbq) fbq('track', 'InitiateCheckout', { value: bundle.price * qty, currency: 'USD' });
  const skuToPrice = {
    'KAL-1': 'price_REEMPLAZAR_ID_1',
    'KAL-2': 'price_REEMPLAZAR_ID_2',
    'KAL-3': 'price_REEMPLAZAR_ID_3'
  };
  const { error } = await stripe.redirectToCheckout({
    lineItems: [{ price: skuToPrice[sku], quantity: qty }],
    mode: 'payment',
    successUrl: 'https://kalmely.com/thank-you',
    cancelUrl: 'https://kalmely.com/cart?sku=' + sku
  });
  if (error) alert(error.message);
});
</script>
```

Crear los 3 products + 3 prices recurring=false en Stripe Dashboard, copiar los `price_xxx` IDs.

### 4. Klarna

Klarna se activa automáticamente como método de pago si lo habilitas en Stripe Dashboard → Payment methods → Klarna. No requiere código adicional.

### 5. Contact form (contact.html)

Usando **Web3Forms** (gratis hasta 250 envíos/mes):
1. Ir a https://web3forms.com → crear access key con email `hello@kalmely.com`
2. En `contact.html`, función `submitForm`, descomentar el bloque Web3Forms y pegar la key

Alternativas: Formspree, Netlify Forms, propio endpoint serverless.

### 6. Analytics + Pixel

En `<head>` de cada página añadir:

```html
<!-- Meta Pixel -->
<script>
!function(f,b,e,v,n,t,s){...}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', 'PIXEL_ID');
</script>
<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=PIXEL_ID&ev=PageView&noscript=1"/></noscript>

<!-- Google Analytics 4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-XXXXXXX');
</script>
```

El JS de `index.html` ya llama `track()` con `PageView`, `AddToCart`, `ViewContent` — empezarán a registrarse en cuanto el pixel esté inicializado.

El cookie banner ya respeta consent: hasta que el usuario clica "Accept all", `track()` registra pero los scripts del pixel no están cargados.

## Deploy en Cloudflare Pages

```bash
# 1. Iniciar repo
cd web-kalmely
git init
git add .
git commit -m "Initial Kalmely landing"

# 2. Crear repo en GitHub (web)
# https://github.com/new → kalmely-web (private)

# 3. Conectar y push
git remote add origin git@github.com:TU_USUARIO/kalmely-web.git
git branch -M main
git push -u origin main

# 4. En Cloudflare Pages:
# - Create project → Connect to Git → seleccionar kalmely-web
# - Framework: None
# - Build command: (dejar vacío)
# - Build output: . (raíz)
# - Deploy
```

Cloudflare entrega URL `*.pages.dev` inmediatamente. Para conectar `kalmely.com`:
1. Custom domains → Add → `kalmely.com`
2. Apuntar el A record / CNAME donde Cloudflare indique
3. SSL automático

## CRO ya implementado

- [x] Sticky bottom-bar CTA mobile (aparece tras scrollear el hero)
- [x] Exit-intent popup desktop con código RELIEF15
- [x] Schema.org Product (3 offers, aggregateRating)
- [x] Schema.org FAQPage (10 preguntas con respuestas estructuradas)
- [x] Cookie consent banner GDPR/UK compliant
- [x] Pixel events placeholders: `PageView`, `ViewContent`, `AddToCart`, `InitiateCheckout`
- [x] Trust micro-copy en hero (rating, money-back, shipping)
- [x] Bundle staircase con strikethrough + Klarna line
- [x] Comparison table competidores
- [x] Health disclaimer footer (FTC/UK ASA compliant)

## Compliance checklist

- [x] FTC disclaimer en footer
- [x] No "cure/treat/heal" en copy — solo "ease", "soothe", "designed for relief"
- [x] Cookie banner GDPR explicito
- [x] Privacy policy menciona Meta Pixel + Stripe + Klarna
- [x] Edad mínima 18+ en Terms of Sale
- [x] Refund policy 30 días (cumple UK Consumer Rights Act 2015 + supera el mínimo 14 días)
- [x] "Not FDA cleared" honestidad en FAQ
- [x] No mención de AliExpress ni China en ningún punto del sitio

## Testing antes de lanzar

```bash
# Local server
cd web-kalmely
python3 -m http.server 8080
# Abrir http://localhost:8080
```

Comprobaciones obligatorias:
- [ ] Hard refresh → todo aparece
- [ ] Back/forward del navegador → todo sigue apareciendo
- [ ] Scroll rápido al fondo y vuelta arriba → nada se queda invisible
- [ ] Mobile (DevTools 375px) → sin scroll horizontal, sticky CTA aparece
- [ ] `prefers-reduced-motion: reduce` activo → todo visible sin animar
- [ ] DevTools Lighthouse → mobile score > 90

## Voice notes

- Tone: premium-clinical British, NO spa-day wellness
- Validation > sales pressure
- Lead con dolor del avatar, NO con features del producto
- Headlines max 8 palabras
- Mobile body text 16–17px, line-height 1.6
- Lexicon migraine: cutaneous allodynia, central sensitization, scalp tenderness, trigeminal nerve, rescue dose
- Permitido: "ease", "soothe", "designed for relief", "may help reduce", "drug-free"
- Prohibido: "cure", "treat", "abort migraine", "heal your migraine"
