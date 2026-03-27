require('dotenv').config();
const { ApifyClient } = require('apify-client');
const fs = require('fs');
const path = require('path');

const client = new ApifyClient({ token: process.env.APIFY_API_KEY });
const OUT_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// ─── golfsimmap.com state pages ────────────────────────────────────────────────
const US_STATES = [
  'florida', 'texas', 'california', 'new-york', 'illinois',
  'georgia', 'ohio', 'pennsylvania', 'north-carolina', 'colorado',
  'washington', 'tennessee', 'nevada', 'minnesota', 'oregon',
  'massachusetts', 'michigan', 'missouri', 'indiana', 'arizona',
  'virginia', 'new-jersey', 'maryland', 'wisconsin', 'utah',
  'connecticut', 'kentucky', 'kansas', 'iowa', 'nebraska',
];

const GOLFSIMMAP_URLS = US_STATES.map(s => ({
  url: `https://golfsimmap.com/venue/us/${s}`,
  userData: { state: s },
}));

// Additional directories
const DIRECTORY_URLS = [
  { url: 'https://golfindoornearme.com/', userData: { source: 'golfindoornearme' } },
  { url: 'https://swinglix.com/golf-simulator/find-golf-simulator-near-you/', userData: { source: 'swinglix' } },
  { url: 'https://golfsimspot.com/find-a-golf-simulator/', userData: { source: 'golfsimspot' } },
];

// ─── Booking platform detection ────────────────────────────────────────────────
const BOOKING_SIGNALS = {
  Square: ['square.site', 'squareup.com', 'square pos'],
  Toast: ['toasttab.com', 'toast pos', 'toast.com'],
  Playbypoint: ['playbypoint'],
  CourtReserve: ['courtreserve'],
  Mindbody: ['mindbodyonline', 'mindbody'],
  Acuity: ['acuityscheduling'],
  Calendly: ['calendly'],
  Lightspeed: ['lightspeed'],
  ResNexus: ['resnexus'],
  FareHarbor: ['fareharbor'],
  Skedda: ['skedda'],
  SimplyBook: ['simplybook'],
  'Golf Genius': ['golfgenius'],
  Tee-Commerce: ['teecommerce'],
};

function detectSoftware(text = '') {
  const lower = text.toLowerCase();
  for (const [name, patterns] of Object.entries(BOOKING_SIGNALS)) {
    if (patterns.some(p => lower.includes(p))) return name;
  }
  return 'Unknown';
}

// ─── Feature extraction ────────────────────────────────────────────────────────
function detectFnB(text = '') {
  const lower = text.toLowerCase();
  return ['bar', 'restaurant', 'food', 'menu', 'drinks', 'cocktail', 'beer', 'wine', 'kitchen', 'bistro', 'snack', 'grill'].some(w => lower.includes(w));
}

function detectSocial(text = '') {
  const lower = text.toLowerCase();
  return ['league', 'tournament', 'event', 'corporate', 'birthday', 'party', 'social', 'date night', 'happy hour', 'group', 'private event'].some(w => lower.includes(w));
}

function extractBays(text = '') {
  const match = text.match(/(\d+)\s*(bay|simulator|screen|stall)/i);
  return match ? parseInt(match[1]) : null;
}

function extractPhone(text = '') {
  const match = text.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  return match ? match[0] : null;
}

function scorePriority(venue) {
  if (venue.fnb && venue.bays >= 3) return 'HIGH';
  if (venue.social_focus) return 'HIGH';
  return 'MEDIUM';
}

// ─── Step 1: Scrape golfsimmap.com state pages ─────────────────────────────────
async function scrapeGolfSimMap() {
  console.log(`\n[1/3] Scraping golfsimmap.com (${US_STATES.length} state pages) with Apify Playwright...`);

  const run = await client.actor('apify/website-content-crawler').call({
    startUrls: GOLFSIMMAP_URLS,
    maxCrawlPages: US_STATES.length,
    crawlerType: 'playwright:chrome',
    maxCrawlDepth: 0,
    outputFormats: ['text', 'markdown'],
    removeCookieWarnings: true,
  }, { waitSecs: 600 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`  → Got ${items.length} state pages`);
  return items;
}

// ─── Step 2: Scrape other directories ─────────────────────────────────────────
async function scrapeDirectories() {
  console.log('\n[2/3] Scraping golfindoornearme, swinglix, golfsimspot...');

  const run = await client.actor('apify/website-content-crawler').call({
    startUrls: DIRECTORY_URLS,
    maxCrawlPages: 20,
    crawlerType: 'playwright:chrome',
    maxCrawlDepth: 2,
    outputFormats: ['text'],
    removeCookieWarnings: true,
  }, { waitSecs: 300 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`  → Got ${items.length} directory pages`);
  return items;
}

// ─── Step 3: Detect booking platform on venue websites ────────────────────────
async function enrichVenueWebsites(venues) {
  const websitesToCheck = venues
    .filter(v => v.website && v.priority === 'HIGH')
    .map(v => v.website)
    .slice(0, 50);

  if (websitesToCheck.length === 0) return [];

  console.log(`\n[3/3] Detecting booking platforms on ${websitesToCheck.length} HIGH priority venue websites...`);

  const run = await client.actor('apify/website-content-crawler').call({
    startUrls: websitesToCheck.map(url => ({ url })),
    maxCrawlPages: websitesToCheck.length,
    crawlerType: 'playwright:chrome',
    maxCrawlDepth: 0,
    outputFormats: ['text'],
  }, { waitSecs: 600 });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`  → Checked ${items.length} venue websites`);
  return items;
}

// ─── Parse golfsimmap.com content ─────────────────────────────────────────────
function parseGolfSimMapPage(item) {
  const text = item.text || item.markdown || '';
  const state = US_STATES.find(s => item.url?.includes(s)) || 'unknown';
  const stateFormatted = state.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const venues = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let currentVenue = null;
  for (const line of lines) {
    // Venue names typically are title-cased lines with "golf" or "sim" or common venue words
    const isVenueName = line.length > 3 && line.length < 100 &&
      /^[A-Z]/.test(line) &&
      !line.startsWith('http') &&
      (line.toLowerCase().includes('golf') ||
       line.toLowerCase().includes('sim') ||
       line.toLowerCase().includes('lounge') ||
       line.toLowerCase().includes('studio') ||
       line.toLowerCase().includes('club') ||
       line.toLowerCase().includes('range') ||
       line.toLowerCase().includes('bay'));

    const urlMatch = line.match(/https?:\/\/[^\s]+/);
    const phoneMatch = line.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);

    if (isVenueName && !urlMatch && !phoneMatch) {
      if (currentVenue) venues.push(currentVenue);
      currentVenue = {
        venue_name: line,
        city: '', state: stateFormatted,
        website: null, phone: null, bays: null,
        fnb: false, social_focus: false, software_noted: 'Unknown',
        source_url: item.url, priority: 'MEDIUM', notes: '',
        _raw: line,
      };
    } else if (currentVenue) {
      if (urlMatch) currentVenue.website = urlMatch[0].replace(/[,)>]$/, '');
      if (phoneMatch) currentVenue.phone = phoneMatch[0];
      const bays = extractBays(line);
      if (bays) currentVenue.bays = bays;
      if (detectFnB(line)) currentVenue.fnb = true;
      if (detectSocial(line)) currentVenue.social_focus = true;
      currentVenue._raw += ' ' + line;
    }
  }
  if (currentVenue) venues.push(currentVenue);

  return venues.filter(v => v.venue_name && v.venue_name.length > 3);
}

// ─── Parse other directory pages ──────────────────────────────────────────────
function parseDirectoryPage(item) {
  const text = item.text || '';
  const source = item.url || '';
  const venues = [];

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length < 5 || line.length > 120) continue;
    const lower = line.toLowerCase();
    if (!lower.includes('golf') && !lower.includes('sim')) continue;
    if (/^[A-Z]/.test(line) && !line.startsWith('http')) {
      venues.push({
        venue_name: line,
        city: '', state: '',
        website: null, phone: extractPhone(text),
        bays: extractBays(text),
        fnb: detectFnB(text), social_focus: detectSocial(text),
        software_noted: 'Unknown',
        source_url: source, priority: 'MEDIUM', notes: '',
      });
    }
  }
  return venues;
}

// ─── Apply software detection from website crawls ─────────────────────────────
function applyPlatformDetection(venues, websiteItems) {
  const byDomain = new Map();
  for (const item of websiteItems) {
    try {
      const domain = new URL(item.url).hostname.replace('www.', '');
      byDomain.set(domain, (item.text || '') + (item.markdown || ''));
    } catch {}
  }

  return venues.map(v => {
    if (!v.website) return v;
    try {
      const domain = new URL(v.website).hostname.replace('www.', '');
      const pageText = byDomain.get(domain) || '';
      if (pageText) {
        const sw = detectSoftware(pageText);
        if (sw !== 'Unknown') v.software_noted = sw;
        if (detectFnB(pageText)) v.fnb = true;
        if (detectSocial(pageText)) v.social_focus = true;
        const bays = extractBays(pageText);
        if (bays && !v.bays) v.bays = bays;
      }
    } catch {}
    v.priority = scorePriority(v);
    return v;
  });
}

// ─── Save outputs ──────────────────────────────────────────────────────────────
function saveCSV(venues) {
  const headers = ['venue_name', 'city', 'state', 'website', 'phone', 'bays', 'fnb', 'social_focus', 'software_noted', 'source_url', 'priority', 'notes'];
  const rows = venues.map(v =>
    headers.map(h => `"${String(v[h] !== null && v[h] !== undefined ? v[h] : '').replace(/"/g, "'")}"`)
  );
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'golf_sim_leads.csv'), csv);
  console.log(`\n✓ Saved golf_sim_leads.csv (${venues.length} venues)`);
}

function saveJSON(venues, meta) {
  fs.writeFileSync(path.join(OUT_DIR, 'golf_sim_leads_raw.json'), JSON.stringify({ meta, venues }, null, 2));
  console.log(`✓ Saved golf_sim_leads_raw.json`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.APIFY_API_KEY) { console.error('APIFY_API_KEY not set'); process.exit(1); }

  console.log('=== Playbypoint Golf Simulator Lead Scraper ===');
  console.log(`Targeting: ${US_STATES.length} US states + 3 directories\n`);

  // Parallel: scrape golfsimmap state pages + other directories
  const [simMapItems, directoryItems] = await Promise.all([
    scrapeGolfSimMap().catch(e => { console.error('GolfSimMap error:', e.message); return []; }),
    scrapeDirectories().catch(e => { console.error('Directory error:', e.message); return []; }),
  ]);

  // Parse venues
  let allVenues = [];
  for (const item of simMapItems) {
    allVenues.push(...parseGolfSimMapPage(item));
  }
  for (const item of directoryItems) {
    allVenues.push(...parseDirectoryPage(item));
  }

  // Deduplicate by name
  const seen = new Set();
  allVenues = allVenues.filter(v => {
    const key = v.venue_name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Set initial priority
  allVenues = allVenues.map(v => ({ ...v, priority: scorePriority(v) }));

  console.log(`\nParsed ${allVenues.length} unique venues. Enriching HIGH priority...`);

  // Enrich HIGH priority venues
  const websiteItems = await enrichVenueWebsites(allVenues).catch(e => {
    console.error('Enrichment error:', e.message);
    return [];
  });

  allVenues = applyPlatformDetection(allVenues, websiteItems);

  // Final priority sort
  allVenues.sort((a, b) => {
    if (a.priority === 'HIGH' && b.priority !== 'HIGH') return -1;
    if (b.priority === 'HIGH' && a.priority !== 'HIGH') return 1;
    return 0;
  });

  const high = allVenues.filter(v => v.priority === 'HIGH').length;
  const byState = {};
  for (const v of allVenues) byState[v.state] = (byState[v.state] || 0) + 1;

  console.log('\n=== Results ===');
  console.log(`Total venues: ${allVenues.length}`);
  console.log(`HIGH priority: ${high}`);
  console.log(`MEDIUM priority: ${allVenues.length - high}`);
  console.log('Per state:', Object.entries(byState).sort((a,b) => b[1]-a[1]).slice(0,10).map(([s,n]) => `${s}: ${n}`).join(', '));

  const meta = {
    generated_at: new Date().toISOString(),
    total_venues: allVenues.length,
    high_priority: high,
    states_covered: Object.keys(byState).length,
    sources: ['golfsimmap.com', 'golfindoornearme.com', 'swinglix.com', 'golfsimspot.com'],
    pitch: 'Replace Square/Toast patchwork with Playbypoint: bay reservations + membership + F&B in one platform',
  };

  saveCSV(allVenues);
  saveJSON(allVenues, meta);
  console.log('\nDone!');
})();
