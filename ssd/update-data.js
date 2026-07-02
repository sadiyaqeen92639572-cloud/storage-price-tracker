/**
 * Storage Price Tracker — SSD Silo Pipeline
 * Targets: external SSD (USB-C/USB-A), compatibility, speed
 * Usage: node update-data.js [--mock] [--full]
 *
 * SECURITY: NEVER hardcode SCRAPER_API_KEY — use env var only
 * Local:  SCRAPER_API_KEY=xxx node update-data.js
 * CI:     GitHub Actions secret SCRAPERAPI_KEY
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const DB_FILE       = path.join(__dirname, 'products-db.json');
const HTML_FILE     = path.join(__dirname, 'index.html');
const CACHE_DIR     = path.join(__dirname, 'api-cache');
const CACHE_TTL_MS  = 15 * 24 * 60 * 60 * 1000; // 15 days
const BUDGET_THRESHOLD = 15; // $/TB threshold for "Best $/TB" tag
const MOCK_MODE     = process.argv.includes('--mock');
const FULL_SCRAPE   = process.argv.includes('--full');
const SCRAPER_KEY   = process.env.SCRAPER_API_KEY || process.env.SCRAPERAPI_KEY;

// ── QUERIES ──────────────────────────────────────────────────────────────────
const QUERIES = [
  'portable external SSD USB-C 2TB',
  'best external SSD speed MB/s comparison',
  'Samsung T7 external SSD price',
  'WD My Passport SSD external',
  'Crucial X8 X9 external SSD',
  'SanDisk Extreme Pro external SSD',
  'external SSD PS5 compatible',
  'external SSD Xbox compatible',
  'NVMe external SSD USB-C 10Gbps',
  'external SSD rugged drop proof',
  'external SSD 1TB 4TB price',
  'Seagate Fast SSD external USB',
  'external SSD Mac compatible Time Machine',
  'external SSD fastest read write 2026',
];

// ── INTERFACE SPEED DB ───────────────────────────────────────────────────────
// Maps USB interface to max theoretical MB/s
const INTERFACE_SPEEDS = {
  'USB4 40Gbps':   5000,
  'USB4 20Gbps':   2500,
  'Thunderbolt 4': 3000,
  'Thunderbolt 3': 2750,
  'USB 3.2 Gen2x2': 2000,
  'USB 3.2 Gen2':  1000,
  'USB 3.2 Gen1':   400,
  'USB 3.1 Gen2':  1000,
  'USB 3.1 Gen1':   400,
  'USB 3.0':        400,
  'USB 2.0':         60,
};

// ── PARSERS ──────────────────────────────────────────────────────────────────
function parsePrice(raw) {
  if (typeof raw === 'number') return raw;
  const s = String(raw || '').replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseCapacityTB(title) {
  const t = title || '';
  // "4TB", "4 TB"
  const tb = t.match(/(\d+(?:\.\d+)?)\s*TB/i);
  if (tb) return parseFloat(tb[1]);
  // "2000GB", "2 GB" (convert)
  const gb = t.match(/(\d+(?:\.\d+)?)\s*GB/i);
  if (gb) return parseFloat(gb[1]) / 1000;
  return 0;
}

function parseReadSpeed(title) {
  const t = title || '';
  // "2000MB/s", "2,000 MB/s"
  const r = t.match(/(\d[\d,]*)\s*MB\s*\/?\s*s/i);
  if (r) return parseInt(r[1].replace(/,/g, ''));
  return 0;
}

function detectInterface(title) {
  const t = title || '';
  if (/USB\s*4.*40\s*Gbps|40\s*Gbps.*USB\s*4/i.test(t))       return 'USB4 40Gbps';
  if (/USB\s*4.*20\s*Gbps|20\s*Gbps.*USB\s*4/i.test(t))       return 'USB4 20Gbps';
  if (/thunderbolt\s*4/i.test(t))                               return 'Thunderbolt 4';
  if (/thunderbolt\s*3/i.test(t))                               return 'Thunderbolt 3';
  if (/USB\s*3\.2\s*Gen\s*2x2/i.test(t))                       return 'USB 3.2 Gen2x2';
  if (/USB\s*3\.2\s*Gen\s*2|10\s*Gbps/i.test(t))               return 'USB 3.2 Gen2';
  if (/USB\s*3\.2\s*Gen\s*1|USB\s*3\.1\s*Gen\s*1/i.test(t))    return 'USB 3.2 Gen1';
  if (/USB\s*3\.1\s*Gen\s*2/i.test(t))                         return 'USB 3.1 Gen2';
  if (/USB\s*3\.0|USB\s*3\b/i.test(t))                         return 'USB 3.0';
  if (/USB\s*2\.0|USB\s*2\b/i.test(t))                         return 'USB 2.0';
  if (/USB\s*C|USB-C/i.test(t))                                 return 'USB 3.2 Gen2'; // assume 10G for USB-C
  return '';
}

function detectFormFactor(title) {
  const t = title || '';
  if (/stick|bar|flash\s*drive|thumb/i.test(t)) return 'Stick';
  if (/portable|pocket|mini|compact/i.test(t))   return 'Portable';
  if (/rugged|armor|tough|drop|shockproof|waterproof/i.test(t)) return 'Rugged';
  if (/desktop/i.test(t))                         return 'Desktop';
  return 'Portable';
}

function detectConnector(title) {
  const t = title || '';
  const connectors = [];
  if (/USB[\s-]C/i.test(t))  connectors.push('USB-C');
  if (/USB[\s-]A/i.test(t))  connectors.push('USB-A');
  if (/lightning/i.test(t))  connectors.push('Lightning');
  if (connectors.length === 0) connectors.push('USB-C');
  return connectors.join('+');
}

function detectCompatibility(title) {
  const t = title || '';
  const compat = [];
  if (/PS5|Playstation\s*5/i.test(t))     compat.push('PS5');
  if (/Xbox/i.test(t))                      compat.push('Xbox');
  if (/Mac|Apple/i.test(t))                compat.push('Mac');
  if (/iPad/i.test(t))                      compat.push('iPad');
  if (/Windows|PC/i.test(t))               compat.push('Windows');
  if (/Android/i.test(t))                   compat.push('Android');
  return compat;
}

function detectWarranty(title) {
  const t = title || '';
  if (/5[\s-]year\s*warranty/i.test(t))    return '5yr';
  if (/5[\s-]yr/i.test(t))                 return '5yr';
  if (/3[\s-]year\s*warranty/i.test(t))    return '3yr';
  if (/3[\s-]yr/i.test(t))                 return '3yr';
  if (/2[\s-]year\s*warranty/i.test(t))    return '2yr';
  if (/lifetime\s*warranty/i.test(t))      return 'Lifetime';
  // Samsung T7/T9: 3yr; SanDisk Extreme Pro: 5yr
  if (/samsung\s*T[0-9]/i.test(title))     return '3yr';
  if (/sandisk\s*extreme\s*pro/i.test(title)) return '5yr';
  if (/sandisk/i.test(title))               return '3yr';
  if (/samsung/i.test(title))              return '3yr';
  if (/crucial/i.test(title))              return '5yr';
  if (/wd|western\s*digital/i.test(title)) return '3yr';
  if (/seagate/i.test(title))              return '3yr';
  return '1yr';
}

function detectCondition(title, vendor) {
  const t = (title + ' ' + (vendor || '')).toLowerCase();
  if (/renewed|refurbished|recertified/i.test(t)) return 'Renewed';
  if (/third.party|3rd.party/i.test(t))           return 'Third-Party';
  return 'Amazon Retail';
}

function detectBrand(title) {
  const brands = ['Samsung', 'SanDisk', 'Western Digital', 'WD', 'Seagate', 'Crucial',
    'Kingston', 'LaCie', 'OWC', 'Sabrent', 'ORICO', 'Lexar', 'Toshiba',
    'Transcend', 'G-Technology', 'G-Drive', 'CalDigit', 'ADATA', 'PNY'];
  for (const b of brands) {
    if (new RegExp('\\b' + b + '\\b', 'i').test(title)) return b;
  }
  return '';
}

// ── TRUST SCORE ──────────────────────────────────────────────────────────────
function trustScore(item) {
  let s = 50;
  // Speed bonus
  if (item.readSpeedMBs >= 2000) s += 15;
  else if (item.readSpeedMBs >= 1000) s += 10;
  else if (item.readSpeedMBs >= 500) s += 5;
  // Warranty
  if (item.warrantyYears === '5yr') s += 15;
  else if (item.warrantyYears === '3yr') s += 8;
  else if (item.warrantyYears === 'Lifetime') s += 10;
  // Condition
  if (item.condition === 'Amazon Retail') s += 10;
  else if (item.condition === 'Renewed') s -= 10;
  // Rating
  if (item.rating >= 4.5) s += 10;
  else if (item.rating >= 4.0) s += 5;
  // Price per TB
  if (item.pricePerTB > 0 && item.pricePerTB <= BUDGET_THRESHOLD) s += 5;
  return Math.min(100, Math.max(0, s));
}

// ── NORMALIZE ────────────────────────────────────────────────────────────────
function normalizeItem(raw) {
  const title = raw.title || raw.name || '';
  const brand  = detectBrand(title);
  const capacityTB = parseCapacityTB(title);
  const price      = parsePrice(raw.price || raw.product_price || 0);
  const pricePerTB = (capacityTB > 0 && price > 0) ? Math.round((price / capacityTB) * 100) / 100 : 0;
  const iface      = detectInterface(title);
  const readSpeed  = parseReadSpeed(title);
  const warrantyYears = detectWarranty(title);
  const condition  = detectCondition(title, raw.vendor || raw.seller || '');
  const compat     = detectCompatibility(title);
  const connector  = detectConnector(title);
  const formFactor = detectFormFactor(title);

  // Tags
  const techTags = [];
  if (iface.includes('USB4') || iface.includes('Thunderbolt')) techTags.push('USB4/TB');
  if (readSpeed >= 2000) techTags.push('2000+ MB/s');
  else if (readSpeed >= 1000) techTags.push('1000+ MB/s');
  else if (readSpeed >= 500) techTags.push('500+ MB/s');
  if (iface) techTags.push(iface);

  const useTags = [];
  if (compat.includes('PS5')) useTags.push('PS5 Ready');
  if (compat.includes('Xbox')) useTags.push('Xbox Ready');
  if (compat.includes('Mac')) useTags.push('Mac Compatible');
  if (formFactor === 'Rugged') useTags.push('Rugged');
  if (capacityTB >= 4) useTags.push('4TB+');

  const condTags = [];
  if (condition === 'Amazon Retail') condTags.push('Amazon Retail');
  if (warrantyYears === '5yr') condTags.push('5yr Warranty');
  else if (warrantyYears === '3yr') condTags.push('3yr Warranty');
  if (condition === 'Renewed') condTags.push('Renewed');
  if (pricePerTB > 0 && pricePerTB <= BUDGET_THRESHOLD) condTags.push('Best $/TB');

  const item = {
    id:            raw.asin || raw.id || `ssd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title,
    brand,
    capacityTB,
    price,
    pricePerTB,
    readSpeedMBs:  readSpeed,
    interface:     iface,
    maxSpeedMBs:   INTERFACE_SPEEDS[iface] || 0,
    connector,
    formFactor,
    warrantyYears,
    condition,
    compatibility: compat,
    rating:        parseFloat(raw.rating || raw.stars || 0) || 0,
    reviews:       parseInt(raw.reviews_count || raw.reviews || 0) || 0,
    imageUrl:      raw.image || raw.thumbnail || raw.product_photo || '',
    amazonUrl:     raw.url || raw.link || raw.product_url || (() => { const id = raw.asin || raw.id || ''; return id.match(/^[A-Z0-9]{10}$/) ? `https://www.amazon.com/dp/${id}` : '#'; })(),
    techTags,
    useTags,
    condTags,
    lastSeen:      new Date().toISOString(),
  };
  item.trustScore = trustScore(item);
  return item;
}

// ── BUILD STATIC ROW ─────────────────────────────────────────────────────────
function speedBadge(speed) {
  if (!speed) return `<span class="badge badge-none">Speed N/A</span>`;
  if (speed >= 2000) return `<span class="badge badge-cert">${speed} MB/s ⚡</span>`;
  if (speed >= 1000) return `<span class="badge badge-ok">${speed} MB/s</span>`;
  return `<span class="badge badge-warn">${speed} MB/s</span>`;
}

function ifaceBadge(iface) {
  if (!iface) return '';
  if (/USB4|Thunderbolt/i.test(iface)) return `<span class="badge badge-cmr">${iface}</span>`;
  if (/Gen2x2|Gen 2x2/i.test(iface))  return `<span class="badge badge-ok">${iface}</span>`;
  if (/Gen2|Gen 2/i.test(iface))       return `<span class="badge badge-cert">${iface}</span>`;
  return `<span class="badge badge-none">${iface}</span>`;
}

function warrantyBadge(w) {
  if (!w) return `<span class="badge badge-none">—</span>`;
  if (w === '5yr' || w === 'Lifetime') return `<span class="badge badge-ok">🔒 ${w}</span>`;
  if (w === '3yr') return `<span class="badge badge-cert">📋 ${w}</span>`;
  return `<span class="badge badge-none">⚠️ ${w}</span>`;
}

function condBadge(c) {
  if (c === 'Amazon Retail') return `<span class="badge badge-ok">✅ Retail</span>`;
  if (c === 'Renewed')       return `<span class="badge badge-warn">♻️ Renewed</span>`;
  return `<span class="badge badge-none">3P Seller</span>`;
}

function scoreBadge(s) {
  if (s >= 75) return `<span class="score-high">${s}</span>`;
  if (s >= 55) return `<span class="score-mid">${s}</span>`;
  return `<span class="score-low">${s}</span>`;
}

function compatBadges(compat) {
  return (compat || []).map(c => `<span class="badge badge-cat">${c}</span>`).join('');
}

function buildStaticRow(item) {
  const ptb  = item.pricePerTB > 0 ? `$${item.pricePerTB.toFixed(2)}` : '—';
  const cap  = item.capacityTB  > 0 ? `${item.capacityTB}TB` : '—';
  const prc  = item.price > 0 ? `$${item.price.toFixed(2)}` : '—';
  const rat  = item.rating > 0 ? `⭐ ${item.rating.toFixed(1)}` : '—';
  const rev  = item.reviews > 0 ? `(${item.reviews.toLocaleString()})` : '';
  const _imgSrc = item.imageUrl || `https://placehold.co/44x44/1e293b/34d399?text=${encodeURIComponent((item.brand||'SSD').slice(0,2).toUpperCase())}`;
  const img = `<img src="${_imgSrc}" alt="${item.brand} ${item.capacityTB}TB SSD" class="product-thumb" loading="lazy" onerror="this.onerror=null;this.src='https://placehold.co/44x44/1e293b/34d399?text=SSD'">`;
  const title = (item.title || '').slice(0, 90) + (item.title?.length > 90 ? '…' : '');

  return `<tr data-id="${item.id}" data-tags="${[...item.techTags,...item.useTags,...item.condTags].join(',')}">
  <td class="col-essential col-img">${img}</td>
  <td class="col-essential col-name">
    <a href="${item.amazonUrl}" target="_blank" rel="nofollow sponsored noopener" class="prod-link">${title}</a>
    <div class="prod-brand">${item.brand || ''}${item.formFactor ? ' · ' + item.formFactor : ''}</div>
  </td>
  <td class="col-essential col-cap">${cap}</td>
  <td class="col-essential col-ptb"><span class="metric-val">${ptb}</span></td>
  <td class="col-essential col-price">${prc}</td>
  <td class="col-essential col-speed">${speedBadge(item.readSpeedMBs)}</td>
  <td class="col-tech col-iface">${ifaceBadge(item.interface)}</td>
  <td class="col-tech col-maxspeed">${item.maxSpeedMBs ? item.maxSpeedMBs + ' MB/s' : '—'}</td>
  <td class="col-tech col-connector">${item.connector || '—'}</td>
  <td class="col-tech col-compat">${compatBadges(item.compatibility)}</td>
  <td class="col-rely col-warranty">${warrantyBadge(item.warrantyYears)}</td>
  <td class="col-rely col-cond">${condBadge(item.condition)}</td>
  <td class="col-rely col-rating">${rat} ${rev}</td>
  <td class="col-val col-trust">${scoreBadge(item.trustScore)}</td>
  <td class="col-essential col-buy"><a href="${item.amazonUrl}" target="_blank" rel="nofollow sponsored noopener" class="buy-btn">Buy →</a></td>
</tr>`;
}

// ── HTML UPDATE ──────────────────────────────────────────────────────────────
function updateHtml(products) {
  if (!fs.existsSync(HTML_FILE)) {
    console.warn(`⚠️  ${HTML_FILE} not found — skipping HTML update`);
    return;
  }
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  // Inject JSON data
  const jsonStr = JSON.stringify(products);
  html = html.replace(
    /\/\* START_JSON_DATA \*\/[\s\S]*?\/\* END_JSON_DATA \*\//,
    `/* START_JSON_DATA */\nconst PRODUCTS_DATA = ${jsonStr};\n/* END_JSON_DATA */`
  );

  // Inject static rows
  const rows = products.map(buildStaticRow).join('\n');
  html = html.replace(
    /<!-- START_TABLE_ROWS -->[\s\S]*?<!-- END_TABLE_ROWS -->/,
    `<!-- START_TABLE_ROWS -->\n${rows}\n            <!-- END_TABLE_ROWS -->`
  );

  // Update stats bar
  const ptbs    = products.map(p => p.pricePerTB).filter(Boolean);
  const fastCnt = products.filter(p => p.readSpeedMBs >= 1000).length;
  const slowCnt = products.filter(p => p.readSpeedMBs > 0 && p.readSpeedMBs < 1000).length;

  html = html.replace(/(<span[^>]*id="stat-total"[^>]*>)([^<]*)(<\/span>)/,  `$1${products.length}$3`);
  html = html.replace(/(<span[^>]*id="stat-lowest"[^>]*>)([^<]*)(<\/span>)/, `$1${ptbs.length ? '$' + Math.min(...ptbs).toFixed(2) + '/TB' : '—'}$3`);
  html = html.replace(/(<span[^>]*id="stat-avg"[^>]*>)([^<]*)(<\/span>)/,    `$1${ptbs.length ? '$' + (ptbs.reduce((a,b)=>a+b,0)/ptbs.length).toFixed(2) + '/TB' : '—'}$3`);
  html = html.replace(/(<span[^>]*id="stat-fast"[^>]*>)([^<]*)(<\/span>)/,   `$1${fastCnt}$3`);
  html = html.replace(/(<span[^>]*id="stat-slow"[^>]*>)([^<]*)(<\/span>)/,   `$1${slowCnt}$3`);

  fs.writeFileSync(HTML_FILE, html, 'utf8');
  console.log(`✅  Updated ${HTML_FILE} with ${products.length} products`);
}

// ── MOCK DATA ────────────────────────────────────────────────────────────────
const MOCK_PRODUCTS_RAW = [
  { asin:'B09B398QCX', title:'Samsung T7 Shield 2TB Portable External Solid State Drive USB 3.2 Gen 2 (10Gbps) — Beige MU-PE2T0K/AM', price:99.99,  rating:4.7, reviews_count:45231, image:'', url:'https://www.amazon.com/dp/B09B398QCX' },
  { asin:'B09BKBP939', title:'Samsung T7 Shield 4TB Portable External SSD USB 3.2 Gen 2 (10Gbps) Ruggedized Case Beige MU-PE4T0K/AM', price:149.99, rating:4.7, reviews_count:45231, image:'', url:'https://www.amazon.com/dp/B09BKBP939' },
  { asin:'B08GTYFC37', title:'Samsung T7 1TB Portable External SSD USB 3.2 Gen 2 (10Gbps) 1000 MB/s Gray MU-PC1T0T/AM', price:89.99,  rating:4.7, reviews_count:91032, image:'', url:'https://www.amazon.com/dp/B08GTYFC37' },
  { asin:'B09DGQ5GDZ', title:'SanDisk 2TB Extreme Pro Portable SSD — Solid State Drive 5yr Warranty 2000MB/s USB-C USB 3.2 Gen 2x2 — SDSSDE81-2T00-G25', price:149.00, rating:4.6, reviews_count:28540, image:'', url:'https://www.amazon.com/dp/B09DGQ5GDZ' },
  { asin:'B08KNLQ2JF', title:'SanDisk 4TB Extreme Portable SSD — 1050MB/s 5yr Warranty USB-C USB 3.2 Gen 2 Rugged SDSSDE61-4T00-G25', price:199.99, rating:4.6, reviews_count:15023, image:'', url:'https://www.amazon.com/dp/B08KNLQ2JF' },
  { asin:'B08F7L33MH', title:'Crucial X8 2TB Portable SSD — Up to 1050MB/s — PS4, Xbox & PlayStation Compatible USB 3.2 CT2000X8SSD9', price:84.99,  rating:4.6, reviews_count:67890, image:'', url:'https://www.amazon.com/dp/B08F7L33MH' },
  { asin:'B09FVVPFJJ', title:'Crucial X9 Pro 4TB Portable SSD for Mac — Up to 1050MB/s 3yr Warranty USB-C USB 3.2 CTMACP4000X9PRO', price:139.99, rating:4.5, reviews_count:8912, image:'', url:'https://www.amazon.com/dp/B09FVVPFJJ' },
  { asin:'B07H4DR7QS', title:'WD My Passport SSD 1TB — Portable External Solid State Drive 1050MB/s USB-C & USB-A 3yr Warranty WDBAGF0010BBL-WESN', price:79.99,  rating:4.5, reviews_count:42110, image:'', url:'https://www.amazon.com/dp/B07H4DR7QS' },
  { asin:'B09HW8G3PZ', title:'WD My Passport SSD 4TB External Solid State Drive 1050MB/s USB-C Windows Mac 3yr Warranty WDBB9G0040BBL-WESN', price:169.99, rating:4.5, reviews_count:18432, image:'', url:'https://www.amazon.com/dp/B09HW8G3PZ' },
  { asin:'B08MFCCCQX', title:'Seagate Fast SSD 1TB External Solid State Drive Portable PC Mac PS5 Xbox USB-C USB-A 3yr Warranty STCM1000400', price:69.99,  rating:4.4, reviews_count:23456, image:'', url:'https://www.amazon.com/dp/B08MFCCCQX' },
  { asin:'B08MJY4FXL', title:'Samsung 2TB T9 Portable SSD 2000MB/s External Solid State Drive USB4 20Gbps Type-C PC Mac iPad MU-PG2T0B/AM', price:129.99, rating:4.6, reviews_count:5923, image:'', url:'https://www.amazon.com/dp/B08MJY4FXL' },
  { asin:'B0C1GJKFBZ', title:'SanDisk Professional Pro-G40 SSD 2TB Thunderbolt 3 2000MB/s Ruggedized Drive for Mac Windows SDPRO3G-2T00-GBAND', price:224.99, rating:4.5, reviews_count:3211, image:'', url:'https://www.amazon.com/dp/B0C1GJKFBZ' },
  { asin:'B0BZ8QZW2J', title:'Crucial X10 Pro 2TB Portable SSD — Up to 2100MB/s USB 3.2 Gen 2x2 Compact External Storage 5yr Warranty CT2000X10PROSSD9', price:109.99, rating:4.6, reviews_count:7834, image:'', url:'https://www.amazon.com/dp/B0BZ8QZW2J' },
  { asin:'B09FKTDM3T', title:'OWC Envoy Pro FX 1TB NVMe Thunderbolt 3 & USB-C Compatible External SSD 2800MB/s For Mac OWCTB3ENV1.0', price:159.99, rating:4.5, reviews_count:2341, image:'', url:'https://www.amazon.com/dp/B09FKTDM3T' },
  { asin:'B0D2PHCC7S', title:'LaCie Rugged SSD Pro 1TB Thunderbolt 3 NVMe 2800MB/s Rugged Portable External SSD STHR1000800 3yr Warranty', price:169.99, rating:4.4, reviews_count:4567, image:'', url:'https://www.amazon.com/dp/B0D2PHCC7S' },
];

// ── SCRAPER API ──────────────────────────────────────────────────────────────
function fetchWithCache(query) {
  const cacheKey = query.replace(/\W+/g, '_').slice(0, 80);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) {
    const { ts, data } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - ts < CACHE_TTL_MS) {
      console.log(`[CACHE] ${query}`);
      return Promise.resolve(data);
    }
  }
  if (!SCRAPER_KEY) throw new Error('SCRAPER_API_KEY not set');
  const url = `https://api.scraperapi.com/structured/amazon/search?api_key=${SCRAPER_KEY}&query=${encodeURIComponent(query)}&country=us`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), data }));
          resolve(data);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  let db = [];
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { db = []; }
  }

  // ── FETCH ──────────────────────────────────────────────────────────────────
  let rawItems = [];
  if (MOCK_MODE) {
    rawItems = MOCK_PRODUCTS_RAW;
    console.log(`[MOCK] Using ${rawItems.length} mock SSD products`);
  } else if (!SCRAPER_KEY) {
    console.warn('⚠️  No SCRAPER_API_KEY — use --mock or set env var');
    rawItems = MOCK_PRODUCTS_RAW;
  } else {
    const queries = FULL_SCRAPE ? QUERIES : QUERIES.slice(0, 5);
    for (const q of queries) {
      try {
        const res = await fetchWithCache(q);
        const items = (res.results || res.organic_results || []).slice(0, 10);
        rawItems.push(...items);
        await new Promise(r => setTimeout(r, 500));
      } catch(e) { console.error(`[ERROR] ${q}: ${e.message}`); }
    }
  }

  // ── NORMALIZE + MERGE ──────────────────────────────────────────────────────
  const byId = {};
  for (const p of db) byId[p.id] = p;

  for (const raw of rawItems) {
    if (!raw.title && !raw.name) continue;
    const item = normalizeItem(raw);
    if (!item.capacityTB) continue; // skip if we can't determine capacity
    const existing = byId[item.id];
    if (existing) {
      Object.assign(existing, item, { lastSeen: item.lastSeen });
    } else {
      byId[item.id] = item;
    }
  }

  db = Object.values(byId);

  // ── RE-ENRICH ──────────────────────────────────────────────────────────────
  for (const p of db) {
    // Re-parse speed (picks up regex fixes)
    const freshSpeed = parseReadSpeed(p.title);
    if (freshSpeed !== p.readSpeedMBs) p.readSpeedMBs = freshSpeed;

    // Re-parse interface
    const freshIface = detectInterface(p.title);
    if (freshIface !== p.interface) {
      p.interface  = freshIface;
      p.maxSpeedMBs = INTERFACE_SPEEDS[freshIface] || 0;
    }

    // Re-parse $/TB
    if (p.capacityTB > 0 && p.price > 0) {
      p.pricePerTB = Math.round((p.price / p.capacityTB) * 100) / 100;
    }

    // Re-compute tags
    const techTags = [];
    if (p.interface?.includes('USB4') || p.interface?.includes('Thunderbolt')) techTags.push('USB4/TB');
    if (p.readSpeedMBs >= 2000) techTags.push('2000+ MB/s');
    else if (p.readSpeedMBs >= 1000) techTags.push('1000+ MB/s');
    else if (p.readSpeedMBs >= 500) techTags.push('500+ MB/s');
    if (p.interface) techTags.push(p.interface);
    p.techTags = techTags;

    const condTags = [];
    if (p.condition === 'Amazon Retail') condTags.push('Amazon Retail');
    if (p.warrantyYears === '5yr') condTags.push('5yr Warranty');
    else if (p.warrantyYears === '3yr') condTags.push('3yr Warranty');
    if (p.condition === 'Renewed') condTags.push('Renewed');
    if (p.pricePerTB > 0 && p.pricePerTB <= BUDGET_THRESHOLD) condTags.push('Best $/TB');
    p.condTags = condTags;

    // Re-compute trust score
    p.trustScore = trustScore(p);
  }

  // ── SORT ──────────────────────────────────────────────────────────────────
  db.sort((a, b) => (a.pricePerTB || 9999) - (b.pricePerTB || 9999));

  // ── SAVE ──────────────────────────────────────────────────────────────────
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  console.log(`✅  Saved ${db.length} products to ${DB_FILE}`);

  // ── STATS ──────────────────────────────────────────────────────────────────
  const ptbs = db.map(p => p.pricePerTB).filter(Boolean);
  const fast = db.filter(p => p.readSpeedMBs >= 1000).length;
  console.log(`📊  Total: ${db.length} | $/TB avg: $${ptbs.length ? (ptbs.reduce((a,b)=>a+b,0)/ptbs.length).toFixed(2) : '—'} | 1000MB/s+: ${fast}`);

  updateHtml(db);
}

main().catch(e => { console.error(e); process.exit(1); });
