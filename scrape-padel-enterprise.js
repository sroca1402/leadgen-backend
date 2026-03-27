require('dotenv').config();
const { ApifyClient } = require('apify-client');
const fs = require('fs');
const path = require('path');

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });
const OUT_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// ─── Target sources ────────────────────────────────────────────────────────────
const CHAIN_PAGES = [
  'https://padellands.com/en/chains-of-clubs-in-europe/',
  'https://padellands.com/en/pistas-de-padel/europa/netherlands/',
  'https://padellands.com/en/pistas-de-padel/europa/france/',
  'https://padellands.com/en/pistas-de-padel/europa/germany/',
  'https://padellands.com/en/pistas-de-padel/europa/sweden/',
  'https://padellands.com/en/pistas-de-padel/europa/belgium/',
  'https://padellands.com/en/pistas-de-padel/europa/austria/',
  'https://padellands.com/en/pistas-de-padel/europa/united-kingdom/',
  'https://padellands.com/en/pistas-de-padel/otros-paises/australia/',
];

const GOOGLE_SEARCHES = [
  'multi location padel club chain Switzerland Playtomic',
  'padel club group Germany multiple locations 2025',
  'padel club chain France multiple locations réseau',
  'padel club chain Netherlands operator 2025',
  'padel club chain Belgium multiple locations',
  'padel club chain UK multiple venues operator 2025',
  'padel club chain Sweden franchise 2025',
  'padel club chain Austria multiple locations Wien',
  'padel club UAE Dubai multiple locations operator',
  'padel club Australia multiple locations chain Sydney Melbourne',
  'multi location padel operator Europe Playtomic booking 2025',
  'padel franchise expansion investment 2025 2026 Europe',
  '"padel" "locations" "academy" "leagues" Europe operator',
  'site:padel-magazine.co.uk "multiple" OR "chain" OR "expansion" padel club',
];

// ─── Known operators (seed data + reference) ───────────────────────────────────
const KNOWN_OPERATORS = [
  { brand: 'Padelta', website: 'https://padelta.ch', countries: 'Switzerland', current_software: 'Playtomic', priority: 'HIGH', notes: 'DEMO BOOKED. 10+ Swiss locations.' },
  { brand: '4PADEL', website: 'https://4padel.com', countries: 'France, Germany', priority: 'MEDIUM', notes: '70+ locations. Likely proprietary tech.' },
  { brand: 'PadelShot', website: 'https://padelshot.fr', countries: 'France', priority: 'HIGH', notes: 'Raised €5M. 11+ clubs. No software mentioned publicly.' },
  { brand: 'Game4Padel', website: 'https://game4padel.com', countries: 'UK, Spain, Australia, New Zealand', priority: 'HIGH', notes: "UK's largest. 23+ venues. Doubling 2025." },
  { brand: 'The Padellers', website: 'https://www.thepadellers.nl', countries: 'Netherlands, Germany', current_software: 'Playtomic', priority: 'HIGH', notes: '24 NL locations → 30. Also Germany.' },
  { brand: 'Peakz Padel', website: 'https://peakzpadel.nl', countries: 'Netherlands', priority: 'HIGH', notes: '8 centers. Formerly Play Padel Club.' },
  { brand: 'Padel Zenter', website: 'https://www.padelzenter.se', countries: 'Sweden, Italy', priority: 'HIGH', notes: 'Founded by Zlatan. Franchising 2026.' },
  { brand: 'PDLU (PDL + Padel United)', website: 'https://pdlu.com', countries: 'Sweden, Denmark, Finland, Norway, Switzerland', priority: 'MEDIUM', notes: 'World largest. 118 halls. Likely custom tech.' },
  { brand: 'Padeldome', website: '', countries: 'Austria', current_software: 'etennis', priority: 'HIGH', notes: '4 Vienna locations. etennis = displaceable.' },
  { brand: 'PADELZONE', website: 'https://padelzone.at', countries: 'Austria', current_software: 'Eversports', priority: 'HIGH', notes: '5+ Vienna + Wiener Neustadt. Eversports = displaceable.' },
  { brand: 'Padelbase', website: 'https://www.padelbase.at', countries: 'Austria', priority: 'MEDIUM', notes: 'Austria-wide chain.' },
  { brand: 'Padel Pro UAE', website: 'https://padelpro.ae', countries: 'UAE', priority: 'HIGH', notes: '3 Dubai locations. Academy + leagues.' },
  { brand: 'World Padel Academy (WPA)', website: 'https://wpa.ae', countries: 'UAE', priority: 'HIGH', notes: '4 locations (Dubai, Abu Dhabi, Sharjah, Khor Fakkan).' },
  { brand: 'Padel Kingdom', website: 'https://thepadelkingdom.com', countries: 'UAE, Bahrain', priority: 'HIGH', notes: '3 locations 2 countries.' },
  { brand: 'Top Padel Sports Club', website: 'https://toppadelsc.com', countries: 'UAE', priority: 'HIGH', notes: '3 locations Dubai + Sharjah.' },
  { brand: 'Indoor Padel Australia', website: 'https://www.indoorpadel.com.au', countries: 'Australia', priority: 'HIGH', notes: '2 Sydney locations. Largest in AU.' },
  { brand: 'Racquet Club', website: 'https://racquetclub.com.au', countries: 'Australia', current_software: 'Playtomic', priority: 'HIGH', notes: 'Sydney + Canberra. Playtomic confirmed.' },
  { brand: 'Game4Padel Australia', website: 'https://game4padel.com.au', countries: 'Australia', priority: 'HIGH', notes: '2 Melbourne locations.' },
  { brand: 'Padel Haus', website: 'https://padel.haus', countries: 'USA', priority: 'HIGH', notes: 'Playbypoint social proof. $18M funded. 7 locations.' },
];

// ─── Step 1: Crawl padellands.com chain pages ───────────────────────────────────
async function scrapePadelLands() {
  console.log('\n[1/3] Crawling padellands.com chain pages...');
  const run = await client.actor('apify/website-content-crawler').call({
    startUrls: CHAIN_PAGES.map(url => ({ url })),
    maxCrawlPages: CHAIN_PAGES.length,
    crawlerType: 'playwright:chrome',
    maxCrawlDepth: 0,
    removeCookieWarnings: true,
    outputFormats: ['text'],
  }, { waitSecs: 300 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`  → Got ${items.length} pages from padellands.com`);
  return items;
}

// ─── Step 2: Google Search for each country/query ──────────────────────────────
async function scrapeGoogleSearches() {
  console.log('\n[2/3] Running Google Search scrapes...');
  const run = await client.actor('apify/google-search-scraper').call({
    queries: GOOGLE_SEARCHES.join('\n'),
    maxPagesPerQuery: 2,
    resultsPerPage: 10,
    languageCode: 'en',
    countryCode: 'us',
  }, { waitSecs: 300 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`  → Got ${items.length} search result pages`);
  return items;
}

// ─── Step 3: Visit operator websites to detect software + extract info ──────────
async function scrapeOperatorWebsites(websites) {
  const validUrls = [...new Set(websites.filter(Boolean))].slice(0, 30);
  if (validUrls.length === 0) return [];
  console.log(`\n[3/3] Crawling ${validUrls.length} operator websites for platform detection...`);

  const run = await client.actor('apify/website-content-crawler').call({
    startUrls: validUrls.map(url => ({ url })),
    maxCrawlPages: validUrls.length * 2,
    crawlerType: 'playwright:chrome',
    maxCrawlDepth: 1,
    outputFormats: ['text'],
  }, { waitSecs: 600 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`  → Got ${items.length} pages from operator websites`);
  return items;
}

// ─── Parse helpers ─────────────────────────────────────────────────────────────
const BOOKING_SIGNALS = {
  Playtomic: ['playtomic'],
  CourtReserve: ['courtreserve'],
  Eversports: ['eversports'],
  etennis: ['etennis'],
  Mindbody: ['mindbodyonline', 'mindbody'],
  ClubSpark: ['clubspark'],
  Skedda: ['skedda'],
  Playbypoint: ['playbypoint'],
};
function detectSoftware(text = '') {
  const lower = text.toLowerCase();
  for (const [name, patterns] of Object.entries(BOOKING_SIGNALS)) {
    if (patterns.some(p => lower.includes(p))) return name;
  }
  return 'Unknown';
}

const FEATURE_SIGNALS = {
  academy: ['academy', 'coaching', 'lessons', 'training'],
  leagues: ['league', 'liga', 'competition'],
  tournaments: ['tournament', 'torneo', 'tournoi'],
  events: ['event', 'corporate', 'birthday', 'party', 'privatisation'],
  shop: ['shop', 'boutique', 'merchandise', 'apparel', 'equipment'],
  memberships: ['membership', 'abonnement', 'mitgliedschaft'],
  fb: ['bar', 'restaurant', 'food', 'drinks', 'menu', 'bistro', 'cafe'],
};
function extractFeatures(text = '') {
  const lower = text.toLowerCase();
  return Object.entries(FEATURE_SIGNALS)
    .filter(([, patterns]) => patterns.some(p => lower.includes(p)))
    .map(([name]) => name);
}

function scorePriority(operator) {
  let score = 0;
  if (operator.locations_count >= 2) score++;
  if (operator.current_software && operator.current_software !== 'Unknown') score++;
  if ((operator.features || '').includes('academy')) score++;
  if ((operator.features || '').includes('leagues') || (operator.features || '').includes('tournaments')) score++;
  if ((operator.features || '').includes('events')) score++;
  return score >= 3 ? 'HIGH' : 'MEDIUM';
}

// ─── Extract new operators from Google search results ──────────────────────────
function extractOperatorsFromSearch(searchItems) {
  const found = new Map();

  for (const item of searchItems) {
    const results = item.organicResults || [];
    for (const r of results) {
      const url = r.url || '';
      const title = r.title || '';
      const desc = r.description || '';
      const combined = `${title} ${desc}`.toLowerCase();

      // Skip directories, news sites, generic listings
      if (!url || ['google.com', 'wikipedia', 'youtube', 'facebook.com/pages', 'yelp.com', 'tripadvisor'].some(s => url.includes(s))) continue;

      // Must mention padel + location/club signals
      if (!combined.includes('padel')) continue;
      if (!['club', 'center', 'centre', 'location', 'venue', 'court', 'complex'].some(s => combined.includes(s))) continue;

      // Extract domain as key
      let domain;
      try { domain = new URL(url).hostname.replace('www.', ''); } catch { continue; }
      if (found.has(domain)) continue;

      // Try to detect location count
      let locCount = 1;
      const locMatch = combined.match(/(\d+)\s*(location|club|venue|center|site|court)/);
      if (locMatch) locCount = parseInt(locMatch[1]);

      const features = extractFeatures(combined);
      const software = detectSoftware(combined);

      found.set(domain, {
        brand: title.split('|')[0].split('-')[0].split('–')[0].trim().slice(0, 60),
        locations_count: locCount,
        countries: '',
        website: url.startsWith('http') ? `https://${domain}` : url,
        current_software: software,
        contact: '',
        features: features.join('; '),
        priority: 'MEDIUM',
        notes: desc.slice(0, 150),
        _source: 'google_search',
      });
    }
  }
  return [...found.values()];
}

// ─── Extract operators from padellands.com pages ───────────────────────────────
function extractOperatorsFromPadelLands(pageItems) {
  const found = [];
  for (const item of pageItems) {
    const text = item.text || item.markdown || '';
    if (!text.includes('padel')) continue;

    // Look for club/chain names followed by location counts
    const lines = text.split('\n').filter(l => l.trim().length > 5);
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (!lower.includes('padel')) continue;

      const locMatch = lower.match(/(\d+)\s*(location|club|venue|center|centre|court|hall)/);
      if (locMatch && parseInt(locMatch[1]) >= 2) {
        found.push({
          brand: line.replace(/[*#\[\]]/g, '').trim().slice(0, 80),
          locations_count: parseInt(locMatch[1]),
          countries: item.url?.includes('netherlands') ? 'Netherlands' :
            item.url?.includes('france') ? 'France' :
            item.url?.includes('germany') ? 'Germany' :
            item.url?.includes('sweden') ? 'Sweden' :
            item.url?.includes('belgium') ? 'Belgium' :
            item.url?.includes('austria') ? 'Austria' :
            item.url?.includes('united-kingdom') ? 'UK' : 'Europe',
          website: '',
          current_software: detectSoftware(lower),
          contact: '',
          features: extractFeatures(lower).join('; '),
          priority: 'MEDIUM',
          notes: line.trim().slice(0, 150),
          _source: 'padellands',
        });
      }
    }
  }
  return found;
}

// ─── Enrich known operators with crawled website data ─────────────────────────
function enrichKnownOperators(websiteItems) {
  const byDomain = new Map();
  for (const item of websiteItems) {
    try {
      const domain = new URL(item.url).hostname.replace('www.', '');
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain).push(item.text || item.markdown || '');
    } catch {}
  }

  return KNOWN_OPERATORS.map(op => {
    let domain;
    try { domain = new URL(op.website).hostname.replace('www.', ''); } catch { domain = null; }

    const pages = domain ? (byDomain.get(domain) || []) : [];
    const combined = pages.join('\n');

    const detectedSoftware = detectSoftware(combined);
    const features = extractFeatures(combined);

    const enriched = {
      ...op,
      locations_count: op.locations_count || '?',
      current_software: op.current_software || (detectedSoftware !== 'Unknown' ? detectedSoftware : 'Unknown'),
      features: features.length ? features.join('; ') : (op.features || ''),
    };
    enriched.priority = op.priority || scorePriority(enriched);
    return enriched;
  });
}

// ─── Deduplicate and merge all operators ──────────────────────────────────────
function mergeOperators(known, fromSearch, fromPadelLands) {
  const all = [...known];
  const knownDomains = new Set(known.map(o => {
    try { return new URL(o.website).hostname.replace('www.', ''); } catch { return null; }
  }).filter(Boolean));

  for (const op of [...fromSearch, ...fromPadelLands]) {
    let domain;
    try { domain = new URL(op.website).hostname.replace('www.', ''); } catch { domain = null; }
    if (domain && knownDomains.has(domain)) continue;
    if (op.locations_count < 2) continue; // must have 2+ locations
    op.priority = scorePriority(op);
    all.push(op);
    if (domain) knownDomains.add(domain);
  }

  // Sort: HIGH first, then by location count desc
  return all.sort((a, b) => {
    if (a.priority === 'HIGH' && b.priority !== 'HIGH') return -1;
    if (b.priority === 'HIGH' && a.priority !== 'HIGH') return 1;
    return (parseInt(b.locations_count) || 0) - (parseInt(a.locations_count) || 0);
  });
}

// ─── Save outputs ──────────────────────────────────────────────────────────────
function saveCSV(operators) {
  const headers = ['brand', 'locations_count', 'countries', 'website', 'current_software', 'contact', 'features', 'priority', 'notes'];
  const rows = operators.map(o =>
    headers.map(h => `"${(String(o[h] || '')).replace(/"/g, "'")}"`)
  );
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'enterprise_padel_accounts.csv'), csv);
  console.log(`\n✓ Saved enterprise_padel_accounts.csv (${operators.length} operators)`);
}

function saveJSON(operators, meta) {
  const out = { meta, accounts: operators };
  fs.writeFileSync(path.join(OUT_DIR, 'enterprise_padel_accounts.json'), JSON.stringify(out, null, 2));
  console.log(`✓ Saved enterprise_padel_accounts.json`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.APIFY_API_KEY) { console.error('APIFY_API_KEY not set'); process.exit(1); }

  console.log('=== Playbypoint Enterprise Padel Lead Scraper ===');
  console.log('Targeting: EU + UAE + Australia multi-location padel operators\n');

  let padelLandsItems = [], searchItems = [], websiteItems = [];

  // Run padellands + Google searches in parallel
  try {
    [padelLandsItems, searchItems] = await Promise.all([
      scrapePadelLands().catch(e => { console.error('PadelLands error:', e.message); return []; }),
      scrapeGoogleSearches().catch(e => { console.error('Google search error:', e.message); return []; }),
    ]);
  } catch (e) {
    console.error('Parallel scrape error:', e.message);
  }

  // Then visit operator websites
  const websitesToVisit = KNOWN_OPERATORS.map(o => o.website).filter(Boolean);
  websiteItems = await scrapeOperatorWebsites(websitesToVisit).catch(e => {
    console.error('Website crawl error:', e.message);
    return [];
  });

  // Parse + merge
  const fromSearch = extractOperatorsFromSearch(searchItems);
  const fromPadelLands = extractOperatorsFromPadelLands(padelLandsItems);
  const enrichedKnown = enrichKnownOperators(websiteItems);
  const allOperators = mergeOperators(enrichedKnown, fromSearch, fromPadelLands);

  console.log(`\n=== Results ===`);
  console.log(`Known operators enriched: ${enrichedKnown.length}`);
  console.log(`New from Google search: ${fromSearch.length}`);
  console.log(`New from PadelLands: ${fromPadelLands.length}`);
  console.log(`Total unique operators: ${allOperators.length}`);
  console.log(`HIGH priority: ${allOperators.filter(o => o.priority === 'HIGH').length}`);

  const meta = {
    generated_at: new Date().toISOString(),
    total_operators: allOperators.length,
    high_priority: allOperators.filter(o => o.priority === 'HIGH').length,
    medium_priority: allOperators.filter(o => o.priority === 'MEDIUM').length,
    sources: ['padellands.com', 'google-search', 'operator-websites'],
    pitch: 'Replace Playtomic/Eversports/etennis with Playbypoint all-in-one: bookings + memberships + F&B + leagues + multi-location dashboard',
  };

  saveCSV(allOperators);
  saveJSON(allOperators, meta);
  console.log('\nDone!');
})();
