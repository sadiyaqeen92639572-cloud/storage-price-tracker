/**
 * HDD Internal Drive Price Tracker — update-data.js
 * Scrapes Amazon via ScraperAPI, detects CMR/SMR, injects into index.html
 * Usage: node update-data.js [--mock] [--full]
 */
'use strict';
const fs   = require('fs');
const path = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const SCRAPER_API_KEY  = process.env.SCRAPER_API_KEY || null;
const DB_FILE          = path.join(__dirname, 'products-db.json');
const HTML_FILE        = path.join(__dirname, 'index.html');
const CACHE_DIR        = path.join(__dirname, 'api-cache');
const CACHE_TTL_MS     = 15 * 24 * 60 * 60 * 1000; // 15 days
const USE_MOCK         = process.argv.includes('--mock') || !SCRAPER_API_KEY;
const FULL_MODE        = process.argv.includes('--full');
const MAX_PAGES        = FULL_MODE ? 3 : 1;
const BUDGET_THRESHOLD = 20; // $/TB "Best $/TB" filter threshold

const QUERIES = [
  'WD Red Plus NAS hard drive',
  'Seagate IronWolf NAS hard drive',
  'CMR hard drive NAS RAID',
  'WD Gold enterprise hard drive',
  'Seagate Exos internal hard drive',
  'Toshiba N300 NAS hard drive',
  'internal hard drive 8TB best price',
  'internal hard drive 12TB',
  'internal hard drive 4TB CMR',
  'Amazon renewed internal hard drive nas',
  'WD Blue internal hard drive',
  'Seagate Barracuda internal hard drive',
];

// ── CMR/SMR DATABASE ────────────────────────────────────────────────────────
// Maps model number prefixes → technology type
const CMR_SMR_MODEL_DB = {
  // WD Red Plus (all CMR)
  'WD20EFZX': 'SMR', 'WD40EFZX': 'SMR', 'WD60EFZX': 'SMR', 'WD80EFZX': 'SMR',
  'WD20EFAX': 'SMR', 'WD40EFAX': 'SMR', 'WD60EFAX': 'SMR', 'WD80EFAX': 'SMR',
  // WD Red Plus CMR
  'WD20EFRX': 'CMR', 'WD30EFRX': 'CMR', 'WD40EFRX': 'CMR', 'WD60EFRX': 'CMR',
  'WD80EFBX': 'CMR', 'WD100EFBX': 'CMR', 'WD120EFBX': 'CMR', 'WD160EFGX': 'CMR',
  'WD20EFPX': 'CMR', 'WD40EFPX': 'CMR', 'WD60EFPX': 'CMR', 'WD80EFPX': 'CMR',
  // WD Gold (all CMR)
  'WD2004FBYZ': 'CMR', 'WD4003FRYZ': 'CMR', 'WD6003FRYZ': 'CMR',
  'WD8004FRYZ': 'CMR', 'WD102KRYZ': 'CMR', 'WD121KRYZ': 'CMR', 'WD181KRYZ': 'CMR',
  // WD Purple Pro (CMR)
  'WD8001PURP': 'CMR', 'WD121PURP': 'CMR', 'WD141PURP': 'CMR',
  // WD Blue (mostly CMR but some SMR)
  'WD10EZEX': 'CMR', 'WD20EZAZ': 'SMR', 'WD40EZAZ': 'SMR',
  // Seagate IronWolf (all CMR)
  'ST4000VN006': 'CMR', 'ST6000VN006': 'CMR', 'ST8000VN004': 'CMR',
  'ST10000VN0008': 'CMR', 'ST12000VN0008': 'CMR', 'ST16000VN001': 'CMR',
  'ST18000VN006': 'CMR', 'ST20000VN008': 'CMR',
  // Seagate IronWolf Pro (all CMR)
  'ST4000NE001': 'CMR', 'ST8000NE001': 'CMR', 'ST12000NE0008': 'CMR',
  'ST16000NE000': 'CMR', 'ST18000NE000': 'CMR',
  // Seagate Exos (all CMR)
  'ST8000NM004A': 'CMR', 'ST10000NM017B': 'CMR', 'ST12000NM001G': 'CMR',
  'ST16000NM001G': 'CMR', 'ST18000NM000J': 'CMR', 'ST20000NM007D': 'CMR',
  // Seagate Barracuda (mixed — specific models)
  'ST4000DM004': 'SMR', 'ST6000DM003': 'SMR', 'ST8000DM004': 'CMR',
  // Toshiba N300 (all CMR)
  'HDWG480': 'CMR', 'HDWG460': 'CMR', 'HDWG440': 'CMR', 'HDWG180': 'CMR',
  'HDWG160': 'CMR', 'HDWG11A': 'CMR',
};

function detectCMRSMR(title, asin) {
  const t = (title || '').toLowerCase();
  if (/\bCMR\b/i.test(title) || /conventional magnetic/i.test(t)) return 'CMR';
  if (/\bSMR\b/i.test(title) || /shingled magnetic/i.test(t)) return 'SMR';
  // Name-based (reliable)
  if (/wd red plus/i.test(t))   return 'CMR';
  if (/wd red\b(?!\s*plus)/i.test(t)) return 'SMR';
  if (/wd gold/i.test(t))       return 'CMR';
  if (/wd purple pro/i.test(t)) return 'CMR';
  if (/ironwolf\b/i.test(t))    return 'CMR';
  if (/ironwolf pro/i.test(t))  return 'CMR';
  if (/seagate exos/i.test(t))  return 'CMR';
  if (/toshiba n300/i.test(t))  return 'CMR';
  if (/toshiba mg\d/i.test(t))  return 'CMR';
  if (/wd blue/i.test(t))       return 'CMR'; // most WD Blue are CMR
  if (/wd green/i.test(t))      return 'SMR';
  if (/barracuda\b(?!\s*pro)/i.test(t)) return 'Unknown';
  return 'Unknown';
}

function parseCapacityTB(title) {
  const tb = title.match(/(\d+(?:\.\d+)?)\s*TB\b/i);
  if (tb) return parseFloat(tb[1]);
  const gb = title.match(/(\d+(?:\.\d+)?)\s*GB\b/i);
  if (gb && parseFloat(gb[1]) >= 500) return parseFloat(gb[1]) / 1000;
  const te = title.match(/(\d+(?:\.\d+)?)\s*terabyte/i);
  if (te) return parseFloat(te[1]);
  return 0;
}

function parseRPM(title) {
  const m = title.match(/(\d{4})\s*RPM/i);
  if (m) return parseInt(m[1]);
  if (/7200/i.test(title)) return 7200;
  if (/5900/i.test(title)) return 5900;
  if (/5400/i.test(title)) return 5400;
  return null;
}

function parseCache(title) {
  const m = title.match(/(\d+)\s*MB\s*cache/i);
  if (m) return parseInt(m[1]);
  return null;
}

function parseWarranty(title) {
  if (/5[\s-]?year/i.test(title)) return '5yr';
  if (/3[\s-]?year/i.test(title)) return '3yr';
  if (/2[\s-]?year/i.test(title)) return '2yr';
  if (/1[\s-]?year/i.test(title)) return '1yr';
  return null;
}

function parsePrice(raw) {
  if (typeof raw === 'number') return raw;
  const m = String(raw || '').match(/[\d]+(?:\.[\d]+)?/);
  return m ? parseFloat(m[0]) : 0;
}

function detectCategory(title) {
  const t = title.toLowerCase();
  if (/exos|enterprise|gold\b|datacenter|server/i.test(t)) return 'Enterprise';
  if (/ironwolf|nas\b|n300|red plus|red pro/i.test(t))     return 'NAS';
  if (/purple|surveillance|cctv/i.test(t))                 return 'Surveillance';
  if (/gaming|black\b/i.test(t))                           return 'Gaming';
  return 'Desktop';
}

function detectCondition(title, vendor) {
  if (/renewed|refurb|recertified/i.test(title)) return 'Renewed';
  if (vendor && /amazon/i.test(vendor))          return 'Amazon Retail';
  return 'Third-Party';
}

function detectHelium(title, capacityTB) {
  if (/helium/i.test(title)) return true;
  if (capacityTB >= 14)      return true; // most ≥14TB drives use helium
  return false;
}

function trustScore(item) {
  let score = 40;
  if (item.cmrSmr === 'CMR')     score += 20;
  if (item.cmrSmr === 'SMR')     score -= 10;
  if (item.warranty === '5yr')   score += 15;
  else if (item.warranty === '3yr') score += 8;
  if (item.category === 'NAS')   score += 10;
  if (item.condition === 'Amazon Retail') score += 10;
  if (item.condition === 'Renewed')       score -= 5;
  if (item.rating >= 4.5)        score += 10;
  else if (item.rating >= 4.0)   score += 5;
  return Math.min(100, Math.max(0, score));
}

function normalizeItem(raw) {
  const title    = raw.title || raw.name || '';
  const price    = parsePrice(raw.price || raw.price_string);
  const capacityTB = parseCapacityTB(title);
  const cmrSmr   = detectCMRSMR(title, raw.asin || raw.id);
  const rpm      = parseRPM(title);
  const cacheVal = parseCache(title);
  const warranty = parseWarranty(title);
  const category = detectCategory(title);
  const helium   = detectHelium(title, capacityTB);
  const condition= detectCondition(title, raw.seller_name || '');
  const pricePerTB = (price > 0 && capacityTB > 0) ? Math.round((price / capacityTB) * 100) / 100 : null;

  const techTags = [];
  if (cmrSmr !== 'Unknown') techTags.push(cmrSmr);
  if (rpm) techTags.push(`${rpm} RPM`);
  if (helium) techTags.push('Helium');

  const useTags = [];
  if (['NAS', 'Enterprise'].includes(category)) useTags.push('NAS-Ready');
  if (cmrSmr === 'CMR') useTags.push('RAID Safe');
  if (category === 'Enterprise') useTags.push('Enterprise');
  if (category === 'Desktop') useTags.push('Desktop');
  if (category === 'Surveillance') useTags.push('Surveillance');

  const condTags = [];
  if (warranty === '5yr') condTags.push('5yr Warranty');
  else if (warranty === '3yr') condTags.push('3yr Warranty');
  if (condition === 'Amazon Retail') condTags.push('Amazon Retail');
  if (condition === 'Renewed') condTags.push('Renewed');
  if (pricePerTB && pricePerTB <= BUDGET_THRESHOLD) condTags.push('Best $/TB');

  const item = {
    id:          raw.asin || raw.id || raw.product_id,
    title,
    brand:       raw.brand || (title.split(' ')[0]),
    asin:        raw.asin || '',
    asinUrl:     raw.product_url || raw.url || (() => { const id = raw.asin || raw.id || ''; return id.match(/^[A-Z0-9]{10}$/) ? `https://www.amazon.com/dp/${id}` : '#'; })(),
    image:       raw.image || raw.main_image || '',
    price,
    capacityTB,
    pricePerTB,
    cmrSmr,
    rpm,
    cache:       cacheVal,
    warranty,
    category,
    helium,
    condition,
    techTags,
    useTags,
    condTags,
    rating:      parseFloat(raw.rating || 0) || 0,
    reviewCount: parseInt(raw.reviews_count || raw.reviews || 0) || 0,
    trustScore:  0, // filled below
  };
  item.trustScore = trustScore(item);
  return item;
}

// ── MOCK DATA ────────────────────────────────────────────────────────────────
const MOCK_PRODUCTS = [
  { id: 'B08WK1KZSP', title: 'WD Red Plus 8TB NAS Internal Hard Drive - 5400 RPM, SATA 6 Gb/s, CMR, 256 MB Cache, 3.5"', price: 129.99, brand: 'WD', rating: 4.6, reviews_count: 8420, image: 'https://m.media-amazon.com/images/I/71HXaVVrJtL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B08TNT7H3T', title: 'WD Red Plus 12TB NAS Internal Hard Drive CMR - 7200 RPM, SATA 6 Gb/s, 256 MB Cache, 3.5" - WD120EFBX', price: 214.99, brand: 'WD', rating: 4.5, reviews_count: 3210, image: 'https://m.media-amazon.com/images/I/71HXaVVrJtL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B07H289S7C', title: 'WD Red Plus 4TB NAS Internal Hard Drive - 5400 RPM, SATA 6 Gb/s, CMR, 128 MB Cache', price: 79.99, brand: 'WD', rating: 4.6, reviews_count: 12350, image: 'https://m.media-amazon.com/images/I/71HXaVVrJtL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B084ZV4DXB', title: 'Seagate IronWolf 8TB NAS Internal Hard Drive HDD – CMR 3.5 Inch SATA 6Gb/s 7200 RPM 256MB Cache for RAID Network Attached Storage', price: 154.99, brand: 'Seagate', rating: 4.6, reviews_count: 15600, image: 'https://m.media-amazon.com/images/I/61IFiCG9-zL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B07999WTNT', title: 'Seagate IronWolf 4TB NAS Internal Hard Drive CMR HDD – 3.5 Inch SATA 6Gb/s 5900 RPM 64MB Cache', price: 84.99, brand: 'Seagate', rating: 4.6, reviews_count: 22100, image: 'https://m.media-amazon.com/images/I/61IFiCG9-zL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B07H5MD2GK', title: 'Seagate IronWolf 12TB NAS Internal Hard Drive CMR 7200RPM 256MB Cache SATA 6 Gb/s 3.5"', price: 199.99, brand: 'Seagate', rating: 4.6, reviews_count: 5430, image: 'https://m.media-amazon.com/images/I/61IFiCG9-zL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B07FP4Q3HB', title: 'WD Gold 8TB Enterprise Class Internal Hard Drive - 7200 RPM Class, SATA 6 Gb/s, 256 MB Cache, CMR, 5 Year Warranty', price: 189.99, brand: 'WD', rating: 4.7, reviews_count: 2890, image: 'https://m.media-amazon.com/images/I/51Wg-zLgfzL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B01LYVX0H5', title: 'Seagate Exos X18 18TB Enterprise HDD CMR Internal Hard Drive – 3.5 Inch Hyperscale SATA 6Gb/s 7200 RPM 256MB Cache', price: 279.99, brand: 'Seagate', rating: 4.5, reviews_count: 1240, image: 'https://m.media-amazon.com/images/I/51-3BQ5i0ZL._AC_SL300_.jpg', seller_name: 'Seagate Direct' },
  { id: 'B0812G55GS', title: 'Toshiba N300 8TB NAS 3.5-Inch Internal Hard Drive - CMR SATA 6.0 GB/s 7200 RPM 256 MB Cache', price: 144.99, brand: 'Toshiba', rating: 4.5, reviews_count: 4120, image: 'https://m.media-amazon.com/images/I/61ZGQ8FXHQL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B08VM17BSJ', title: 'WD Red 4TB NAS Internal Hard Drive - 5400 RPM, SATA 6 Gb/s, SMR, 256 MB Cache, 3.5"', price: 69.99, brand: 'WD', rating: 4.3, reviews_count: 9800, image: 'https://m.media-amazon.com/images/I/71HXaVVrJtL._AC_SL300_.jpg', seller_name: 'Third Party Seller' },
  { id: 'B07H5HDJBX', title: 'Seagate Barracuda 4TB Internal Hard Drive HDD – 3.5 Inch SATA 6 Gb/s 5400 RPM 256MB Cache', price: 64.99, brand: 'Seagate', rating: 4.4, reviews_count: 31200, image: 'https://m.media-amazon.com/images/I/61IFiCG9-zL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B09ZP4MJGX', title: 'Seagate Exos 12TB Enterprise HDD CMR Internal Hard Drive 7200 RPM 256MB Cache SATA 6Gb/s', price: 209.99, brand: 'Seagate', rating: 4.6, reviews_count: 890, image: 'https://m.media-amazon.com/images/I/51-3BQ5i0ZL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B0B2RHJJGH', title: 'WD Purple Pro 8TB Surveillance Internal Hard Drive CMR - 7200 RPM, SATA 6 Gb/s, 256 MB Cache, 3.5"', price: 149.99, brand: 'WD', rating: 4.5, reviews_count: 1560, image: 'https://m.media-amazon.com/images/I/51Wg-zLgfzL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
  { id: 'B0BXRNWCDY', title: 'Seagate IronWolf 16TB NAS Internal Hard Drive CMR 7200 RPM SATA 6Gb/s 256MB Cache - Renewed', price: 179.99, brand: 'Seagate', rating: 4.4, reviews_count: 340, image: 'https://m.media-amazon.com/images/I/61IFiCG9-zL._AC_SL300_.jpg', seller_name: 'Amazon Renewed' },
  { id: 'B07XWP5BK5', title: 'WD Blue 4TB PC Hard Drive - 5400 RPM, CMR, SATA 6 Gb/s, 256 MB Cache, 3.5"', price: 69.99, brand: 'WD', rating: 4.5, reviews_count: 18900, image: 'https://m.media-amazon.com/images/I/61HQIxPRriL._AC_SL300_.jpg', seller_name: 'Amazon.com' },
];

// ── STATIC ROW BUILDER ───────────────────────────────────────────────────────
function cmrBadge(v) {
  if (v === 'CMR')     return '<span class="badge badge-cmr">✅ CMR</span>';
  if (v === 'SMR')     return '<span class="badge badge-smr">⚠️ SMR</span>';
  return '<span class="badge badge-unk">❓ Unknown</span>';
}
function raidBadge(cmr) {
  return cmr === 'CMR'
    ? '<span class="badge badge-ok">🛡️ RAID Safe</span>'
    : '<span class="badge badge-warn">⚠️ Caution</span>';
}
function condBadge(c) {
  if (c === 'Amazon Retail')  return '<span class="badge badge-ok">✅ Amazon Retail</span>';
  if (c === 'Renewed')        return '<span class="badge badge-warn">♻️ Renewed</span>';
  return '<span class="badge badge-none">3rd Party</span>';
}
function heliumBadge(h) {
  return h ? '<span class="badge badge-cert">💨 Helium</span>' : '';
}
function warrantyBadge(w) {
  if (!w) return '<span class="badge badge-none">—</span>';
  return w === '5yr'
    ? `<span class="badge badge-ok">🔒 ${w}</span>`
    : `<span class="badge badge-cert">${w}</span>`;
}
function scoreBadge(s) {
  const cls = s >= 70 ? 'score-high' : s >= 45 ? 'score-mid' : 'score-low';
  return `<span class="${cls}">${s}</span>`;
}

function buildStaticRow(item) {
  const nameSafe  = (item.title || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const shortName = nameSafe.length > 80 ? nameSafe.slice(0, 80) + '…' : nameSafe;
  const allTags   = [...item.techTags, ...item.useTags, ...item.condTags].join(' ');

  return `<tr data-id="${item.id}" data-cat="${item.category}" data-tags="${allTags}"
    data-cmr="${item.cmrSmr}" data-ptb="${item.pricePerTB || 9999}" data-rating="${item.rating}">
  <td class="col-essential col-img"><img src="${item.image}" alt="${item.brand}" loading="lazy" class="product-thumb" onerror="this.style.display='none'"></td>
  <td class="col-essential col-name">
    <a href="${item.asinUrl}" target="_blank" rel="nofollow sponsored" class="prod-link">${shortName}</a>
    <div class="prod-brand">${item.brand}</div>
  </td>
  <td class="col-essential col-cap">${item.capacityTB > 0 ? item.capacityTB + ' TB' : '—'}</td>
  <td class="col-essential col-ptb">${item.pricePerTB ? '<span class="metric-val">$' + item.pricePerTB.toFixed(2) + '</span><span class="metric-unit">/TB</span>' : '—'}</td>
  <td class="col-essential col-price">$${item.price > 0 ? item.price.toFixed(2) : '—'}</td>
  <td class="col-essential col-cmr">${cmrBadge(item.cmrSmr)}</td>
  <td class="col-tech col-rpm">${item.rpm ? item.rpm.toLocaleString() + ' RPM' : '—'}</td>
  <td class="col-tech col-cache">${item.cache ? item.cache + ' MB' : '—'}</td>
  <td class="col-tech col-helium">${heliumBadge(item.helium)}</td>
  <td class="col-tech col-cat"><span class="badge badge-cat">${item.category}</span></td>
  <td class="col-rely col-raid">${raidBadge(item.cmrSmr)}</td>
  <td class="col-rely col-warranty">${warrantyBadge(item.warranty)}</td>
  <td class="col-rely col-cond">${condBadge(item.condition)}</td>
  <td class="col-rely col-rating">${item.rating > 0 ? '⭐ ' + item.rating.toFixed(1) + ' <span style="color:var(--text-muted);font-size:0.75rem;">(' + item.reviewCount.toLocaleString() + ')</span>' : '—'}</td>
  <td class="col-val col-trust">${scoreBadge(item.trustScore)}</td>
  <td class="col-essential col-buy">
    <a href="${item.asinUrl}" target="_blank" rel="nofollow sponsored" class="buy-btn">Buy ↗</a>
  </td>
</tr>`;
}

// ── HTML INJECTION ───────────────────────────────────────────────────────────
function updateHtml(products) {
  if (!fs.existsSync(HTML_FILE)) { console.log('⚠️  index.html not found — skipping HTML update'); return; }
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  // JSON data
  const s1 = '/* START_JSON_DATA */'; const e1 = '/* END_JSON_DATA */';
  html = html.slice(0, html.indexOf(s1)) +
    `${s1}\n        const PRODUCTS_DATA = ${JSON.stringify(products, null, 6)};\n        ${e1}` +
    html.slice(html.indexOf(e1) + e1.length);

  // Static rows
  const s2 = '<!-- START_TABLE_ROWS -->'; const e2 = '<!-- END_TABLE_ROWS -->';
  html = html.slice(0, html.indexOf(s2)) +
    `${s2}\n${products.map(buildStaticRow).join('\n')}\n            ${e2}` +
    html.slice(html.indexOf(e2) + e2.length);

  // Stats bar
  const ptbs   = products.map(p => p.pricePerTB).filter(Boolean);
  const cmrCnt = products.filter(p => p.cmrSmr === 'CMR').length;
  const smrCnt = products.filter(p => p.cmrSmr === 'SMR').length;
  const lowest = ptbs.length ? Math.min(...ptbs).toFixed(2) : '0.00';
  const avg    = ptbs.length ? (ptbs.reduce((a,b)=>a+b,0)/ptbs.length).toFixed(2) : '0.00';
  html = html.replace(/(<span class="stat-val" id="stat-total">)[^<]*/, `$1${products.length}`);
  html = html.replace(/(<span class="stat-val" id="stat-lowest">)[^<]*/, `$1$${lowest}/TB`);
  html = html.replace(/(<span class="stat-val" id="stat-avg">)[^<]*/,   `$1$${avg}/TB`);
  html = html.replace(/(<span class="stat-val" id="stat-cmr">)[^<]*/,   `$1${cmrCnt}`);
  html = html.replace(/(<span class="stat-val" id="stat-smr">)[^<]*/,   `$1${smrCnt}`);

  fs.writeFileSync(HTML_FILE, html);
  console.log(`💾 index.html updated — ${products.length} drives`);
}

// ── API CACHE ────────────────────────────────────────────────────────────────
async function fetchWithCache(query, page) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key  = `${query.replace(/[^a-z0-9]/gi,'_').toLowerCase()}_p${page}`;
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < CACHE_TTL_MS) { console.log(`💾 Cache HIT: ${key}`); return JSON.parse(fs.readFileSync(file,'utf8')); }
  }
  console.log(`📡 Fetching: ${query} p${page}`);
  const url  = `https://api.scraperapi.com/structured/amazon/search?api_key=${SCRAPER_API_KEY}&query=${encodeURIComponent(query)}&page=${page}&country=us`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];
  const knownIds = new Set(db.map(p => p.id));
  console.log(`📦 DB: ${db.length} drives loaded`);

  if (USE_MOCK) {
    console.log('🎭 Mock mode — using built-in data');
    for (const raw of MOCK_PRODUCTS) {
      if (knownIds.has(raw.id)) continue;
      knownIds.add(raw.id);
      db.push(normalizeItem(raw));
    }
  } else {
    for (const query of QUERIES) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        try {
          const data  = await fetchWithCache(query, page);
          const items = data.results || data.products || data.items || [];
          let added = 0;
          for (const raw of items) {
            const id = raw.asin || raw.product_id;
            if (!id || knownIds.has(id)) continue;
            // Filter: must be internal HDD (not external, not SSD)
            const t = (raw.title || '').toLowerCase();
            if (!/internal hard drive|internal hdd/i.test(t) && !/\b(nas|sata).*(hdd|hard drive)/i.test(t)) continue;
            if (/external|portable|usb|ssd|solid state/i.test(t)) continue;
            knownIds.add(id);
            db.push(normalizeItem(raw));
            added++;
          }
          if (added) console.log(`   ✅ +${added} from "${query}" p${page}`);
        } catch (e) { console.error(`   ⚠️ "${query}" p${page}:`, e.message); }
      }
    }
  }

  // Re-enrichment pass — backfill existing DB entries
  let enriched = 0;
  for (const p of db) {
    // Fix broken asinUrl (e.g. '#' from mock data using id field)
    if (!p.asinUrl || p.asinUrl === '#') {
      const aid = p.asin || p.id || '';
      p.asinUrl = aid.match(/^[A-Z0-9]{10}$/) ? `https://www.amazon.com/dp/${aid}` : '#';
    }
    const freshCMR = detectCMRSMR(p.title, p.asin);
    if (freshCMR !== p.cmrSmr) { p.cmrSmr = freshCMR; enriched++; }
    const freshCap = parseCapacityTB(p.title);
    if (freshCap && freshCap !== p.capacityTB) {
      p.capacityTB = freshCap;
      p.pricePerTB = p.price > 0 ? Math.round((p.price / freshCap) * 100) / 100 : null;
      enriched++;
    }
    // Rebuild tags
    p.techTags = [];
    if (p.cmrSmr !== 'Unknown') p.techTags.push(p.cmrSmr);
    if (p.rpm) p.techTags.push(`${p.rpm} RPM`);
    if (p.helium) p.techTags.push('Helium');
    p.useTags = [];
    if (['NAS','Enterprise'].includes(p.category)) p.useTags.push('NAS-Ready');
    if (p.cmrSmr === 'CMR') p.useTags.push('RAID Safe');
    if (p.category === 'Enterprise') p.useTags.push('Enterprise');
    if (p.category === 'Desktop')    p.useTags.push('Desktop');
    if (p.category === 'Surveillance') p.useTags.push('Surveillance');
    p.condTags = [];
    if (p.warranty === '5yr') p.condTags.push('5yr Warranty');
    else if (p.warranty === '3yr') p.condTags.push('3yr Warranty');
    if (p.condition === 'Amazon Retail') p.condTags.push('Amazon Retail');
    if (p.condition === 'Renewed')       p.condTags.push('Renewed');
    if (p.pricePerTB && p.pricePerTB <= BUDGET_THRESHOLD) p.condTags.push('Best $/TB');
    p.trustScore = trustScore(p);
  }
  if (enriched) console.log(`🔄 Re-enriched ${enriched} fields`);

  // Sort by $/TB ascending (best value first)
  db.sort((a,b) => (a.pricePerTB||9999) - (b.pricePerTB||9999));

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  console.log(`💾 products-db.json saved — ${db.length} drives`);

  updateHtml(db);
  console.log(`✅ Done! ${db.length} internal hard drives tracked.`);
}

main().catch(console.error);
