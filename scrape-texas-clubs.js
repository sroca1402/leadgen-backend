/**
 * scrape-texas-clubs.js
 *
 * Finds padel & pickleball clubs opening soon or recently opened in Texas.
 * Sources:
 *   1. Google Places API  – places text-search + place details
 *   2. SerpAPI            – organic Google Search results
 *
 * Outputs: /output/texas_opening_clubs.csv
 * Requires env vars:
 *   GOOGLE_PLACES_API_KEY  (optional – skipped when absent)
 *   SERPAPI_KEY            (optional – skipped when absent)
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SERP_KEY   = process.env.SERPAPI_KEY;

const OUT_DIR  = path.join(__dirname, 'output');
const OUT_FILE = path.join(OUT_DIR, 'texas_opening_clubs.csv');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Search queries ────────────────────────────────────────────────────────────
const PLACES_QUERIES = [
  'padel club Texas',
  'padel court Texas',
  'pickleball club Texas',
  'pickleball facility Texas',
  'padel sports club Texas opening 2025 2026',
];

const SERP_QUERIES = [
  'padel club opening soon Texas 2025 OR 2026',
  'new padel facility Texas 2026',
  'pickleball club opening Texas 2026',
  '"padel court" Texas opening 2026',
  '"pickleball club" Texas "opening soon"',
  '"padel club" Texas "coming soon"',
  'new pickleball club Texas 2025 2026',
  '"padel" "Texas" "fall 2026" OR "spring 2026" OR "2026"',
];

// ─── Status detection ──────────────────────────────────────────────────────────
const OPENING_SOON_SIGNALS = [
  'opening soon', 'coming soon', 'opens soon', 'open soon',
  'fall 2026', 'spring 2026', 'summer 2026', 'winter 2026',
  '2026', 'fall 2025', 'spring 2025', 'opening 2025', 'opening 2026',
  'under construction', 'grand opening', 'pre-opening', 'pre opening',
  'soft open', 'coming in 2026', 'expected to open',
];

const RECENTLY_OPENED_SIGNALS = [
  'recently opened', 'now open', 'just opened', 'newly opened',
  'new location', 'opened in 2024', 'opened in 2025',
  'grand opening', 'ribbon cutting',
];

function detectStatus(text = '') {
  const lower = text.toLowerCase();
  if (OPENING_SOON_SIGNALS.some(s => lower.includes(s))) return 'Opening Soon';
  if (RECENTLY_OPENED_SIGNALS.some(s => lower.includes(s)))  return 'Recently Opened';
  return 'Unknown';
}

function detectSport(text = '') {
  const lower = text.toLowerCase();
  const hasPadel      = lower.includes('padel');
  const hasPickleball = lower.includes('pickleball');
  if (hasPadel && hasPickleball) return 'Padel & Pickleball';
  if (hasPadel)      return 'Padel';
  if (hasPickleball) return 'Pickleball';
  return 'Unknown';
}

function extractPhone(text = '') {
  const m = text.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  return m ? m[0].trim() : '';
}

function extractCity(addressComponents = []) {
  const locality = addressComponents.find(c => c.types.includes('locality'));
  if (locality) return locality.long_name;
  const adminArea = addressComponents.find(c => c.types.includes('administrative_area_level_2'));
  return adminArea ? adminArea.long_name.replace(' County', '') : '';
}

function texasCity(address = '') {
  // Rough extraction from formatted_address string when components unavailable
  const match = address.match(/,\s*([^,]+),\s*TX/i);
  return match ? match[1].trim() : '';
}

function normalise(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Google Places ─────────────────────────────────────────────────────────────
async function placesTextSearch(query) {
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
  const results = [];
  let pageToken = null;

  do {
    const params = { query, key: PLACES_KEY, region: 'us' };
    if (pageToken) params.pagetoken = pageToken;

    const { data } = await axios.get(url, { params, timeout: 15000 });

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn(`  Places API error for "${query}": ${data.status} – ${data.error_message || ''}`);
      break;
    }

    for (const place of (data.results || [])) {
      // Filter to Texas only
      const addr = place.formatted_address || '';
      if (!addr.match(/,\s*TX\b/i) && !addr.toLowerCase().includes('texas')) continue;

      results.push({
        place_id: place.place_id,
        name:     place.name,
        address:  addr,
        city:     texasCity(addr),
        sport:    detectSport(place.name + ' ' + (place.types || []).join(' ')),
        status:   detectStatus(place.name + ' ' + addr),
        source:   `Google Places – "${query}"`,
      });
    }

    pageToken = data.next_page_token || null;
    if (pageToken) await sleep(2000); // Places API requires a short delay
  } while (pageToken);

  return results;
}

async function placesDetails(placeId) {
  const url = 'https://maps.googleapis.com/maps/api/place/details/json';
  const fields = 'name,formatted_address,address_components,website,formatted_phone_number,editorial_summary,opening_hours';
  try {
    const { data } = await axios.get(url, {
      params: { place_id: placeId, fields, key: PLACES_KEY },
      timeout: 15000,
    });
    return data.result || {};
  } catch (e) {
    console.warn(`  Details fetch failed for ${placeId}: ${e.message}`);
    return {};
  }
}

async function runPlacesScraper() {
  if (!PLACES_KEY) {
    console.log('  GOOGLE_PLACES_API_KEY not set – skipping Places API.');
    return [];
  }

  const allPlaces = [];
  for (const query of PLACES_QUERIES) {
    console.log(`  [Places] Searching: "${query}"`);
    try {
      const results = await placesTextSearch(query);
      console.log(`    → ${results.length} Texas results`);
      allPlaces.push(...results);
    } catch (e) {
      console.warn(`    Error: ${e.message}`);
    }
    await sleep(500);
  }

  // Deduplicate by place_id before fetching details
  const seen = new Set();
  const unique = allPlaces.filter(p => {
    if (seen.has(p.place_id)) return false;
    seen.add(p.place_id);
    return true;
  });

  console.log(`  Fetching details for ${unique.length} unique places…`);
  const enriched = [];
  for (const place of unique) {
    const det = await placesDetails(place.place_id);
    const components = det.address_components || [];
    const city = components.length ? extractCity(components) : place.city;
    const summary = (det.editorial_summary?.overview || '') + ' ' +
                    (det.opening_hours?.weekday_text?.join(' ') || '');

    const status = detectStatus(place.name + ' ' + summary) !== 'Unknown'
      ? detectStatus(place.name + ' ' + summary)
      : place.status;

    enriched.push({
      name:    det.name || place.name,
      sport:   detectSport((det.name || place.name) + ' ' + summary),
      city:    city || place.city,
      website: det.website || '',
      phone:   det.formatted_phone_number || '',
      status,
      source:  place.source,
    });
    await sleep(200);
  }

  return enriched;
}

// ─── SerpAPI ───────────────────────────────────────────────────────────────────
async function serpSearch(query) {
  const url = 'https://serpapi.com/search.json';
  try {
    const { data } = await axios.get(url, {
      params: {
        q:       query,
        engine:  'google',
        api_key: SERP_KEY,
        gl:      'us',
        hl:      'en',
        num:     20,
      },
      timeout: 20000,
    });
    return data;
  } catch (e) {
    console.warn(`  SerpAPI error for "${query}": ${e.message}`);
    return {};
  }
}

// Patterns to pull venue names + optional city from organic text
const VENUE_PATTERNS = [
  // "Club Name (City, TX)" or "Club Name - Houston, TX"
  /([A-Z][A-Za-z0-9\s&'.\-]{3,50})\s*[\(–\-]\s*([A-Za-z\s]+),?\s*TX/g,
  // "opens in Dallas" / "opening in Austin"
  /([A-Z][A-Za-z0-9\s&'.\-]{3,50})\s+(?:opens?|opening)\s+in\s+([A-Za-z\s]+),?\s*(?:Texas|TX)/gi,
];

function parseVenuesFromText(text, sourceUrl, queryContext) {
  const venues = [];
  const statusFromContext = detectStatus(queryContext + ' ' + text);
  const sportFromContext  = detectSport(queryContext + ' ' + text);

  for (const re of VENUE_PATTERNS) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const name = m[1].trim();
      const city = (m[2] || '').trim();
      if (name.split(' ').length < 2) continue; // skip single-word non-names
      venues.push({
        name,
        sport:   sportFromContext !== 'Unknown' ? sportFromContext : detectSport(name),
        city,
        website: '',
        phone:   extractPhone(text),
        status:  statusFromContext,
        source:  sourceUrl,
      });
    }
  }
  return venues;
}

function extractFromSerpResult(result, query) {
  const title   = result.title   || '';
  const snippet = result.snippet || '';
  const link    = result.link    || '';
  const fullText = title + ' ' + snippet;

  // Must mention Texas and (padel or pickleball)
  const hasTX    = /texas|,\s*TX\b/i.test(fullText);
  const hasSport = /padel|pickleball/i.test(fullText);
  if (!hasTX || !hasSport) return [];

  // Try structured extraction first
  const venues = parseVenuesFromText(fullText, link, query);

  // Fallback: treat the title itself as a venue if it looks like one
  if (venues.length === 0) {
    const sport  = detectSport(fullText);
    const status = detectStatus(fullText);
    const city   = texasCity(snippet) || texasCity(title) || '';
    // Extract website from snippet if present
    const websiteMatch = snippet.match(/https?:\/\/[^\s,)]+/);
    const website = websiteMatch ? websiteMatch[0] : link;
    const phone   = extractPhone(snippet);

    // Only include if title looks like a venue/club name (not a generic article)
    const cleanTitle = title.replace(/\s*[-|].*$/, '').trim();
    if (
      cleanTitle.length > 5 &&
      cleanTitle.length < 80 &&
      /padel|pickleball|club|court|center|centre/i.test(cleanTitle)
    ) {
      venues.push({ name: cleanTitle, sport, city, website, phone, status, source: link });
    }
  }

  return venues;
}

async function runSerpScraper() {
  if (!SERP_KEY) {
    console.log('  SERPAPI_KEY not set – skipping SerpAPI.');
    return [];
  }

  const allVenues = [];

  for (const query of SERP_QUERIES) {
    console.log(`  [SerpAPI] Searching: "${query}"`);
    const data = await serpSearch(query);
    const organicResults = data.organic_results || [];
    console.log(`    → ${organicResults.length} organic results`);

    for (const result of organicResults) {
      const venues = extractFromSerpResult(result, query);
      allVenues.push(...venues);
    }

    // Also scan knowledge graph / local results if present
    for (const local of (data.local_results?.places || [])) {
      const text = (local.title || '') + ' ' + (local.description || '') + ' ' + (local.address || '');
      if (!/texas|,\s*TX\b/i.test(text)) continue;
      if (!/padel|pickleball/i.test(text)) continue;
      allVenues.push({
        name:    local.title || '',
        sport:   detectSport(text),
        city:    texasCity(local.address || ''),
        website: local.website || '',
        phone:   local.phone   || extractPhone(text),
        status:  detectStatus(text + ' ' + query),
        source:  local.website || `SerpAPI – "${query}"`,
      });
    }

    await sleep(1200); // respect SerpAPI rate limits
  }

  return allVenues;
}

// ─── Deduplication & enrichment ────────────────────────────────────────────────
function deduplicateAndMerge(records) {
  const map = new Map();

  for (const r of records) {
    const key = normalise(r.name);
    if (!key || key.length < 4) continue;

    if (!map.has(key)) {
      map.set(key, { ...r });
    } else {
      // Merge – prefer non-empty / more specific values
      const existing = map.get(key);
      if (!existing.website && r.website) existing.website = r.website;
      if (!existing.phone   && r.phone)   existing.phone   = r.phone;
      if (!existing.city    && r.city)     existing.city    = r.city;
      if (existing.status === 'Unknown' && r.status !== 'Unknown') existing.status = r.status;
      if (existing.sport === 'Unknown'  && r.sport  !== 'Unknown')  existing.sport  = r.sport;
    }
  }

  return Array.from(map.values());
}

// ─── CSV helpers ───────────────────────────────────────────────────────────────
function csvEscape(val = '') {
  const s = String(val).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function writeCSV(records) {
  const HEADERS = ['Club Name', 'Sport', 'City', 'Website', 'Phone', 'Status', 'Source URL'];
  const lines   = [HEADERS.join(',')];

  for (const r of records) {
    lines.push([
      csvEscape(r.name),
      csvEscape(r.sport),
      csvEscape(r.city),
      csvEscape(r.website),
      csvEscape(r.phone),
      csvEscape(r.status),
      csvEscape(r.source),
    ].join(','));
  }

  fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf-8');
  console.log(`\nCSV saved → ${OUT_FILE}  (${records.length} rows)`);
}

// ─── Summary ───────────────────────────────────────────────────────────────────
function printSummary(records) {
  console.log('\n════════════════════════════════════════════');
  console.log('  SUMMARY – Texas Padel & Pickleball Clubs');
  console.log('════════════════════════════════════════════');
  console.log(`  Total results: ${records.length}`);

  // By sport
  const bySport = {};
  for (const r of records) bySport[r.sport] = (bySport[r.sport] || 0) + 1;
  console.log('\n  By Sport:');
  for (const [sport, count] of Object.entries(bySport).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${sport.padEnd(25)} ${count}`);
  }

  // By city
  const byCity = {};
  for (const r of records) {
    const city = r.city || 'Unknown';
    byCity[city] = (byCity[city] || 0) + 1;
  }
  const topCities = Object.entries(byCity).sort((a,b) => b[1]-a[1]).slice(0, 20);
  console.log('\n  By City (top 20):');
  for (const [city, count] of topCities) {
    console.log(`    ${city.padEnd(25)} ${count}`);
  }

  // By status
  const byStatus = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log('\n  By Status:');
  for (const [status, count] of Object.entries(byStatus).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${status.padEnd(25)} ${count}`);
  }

  console.log('\n════════════════════════════════════════════\n');
}

// ─── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Texas Padel & Pickleball Club Scraper');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Google Places API : ${PLACES_KEY ? 'enabled' : 'disabled (set GOOGLE_PLACES_API_KEY)'}`);
  console.log(`  SerpAPI           : ${SERP_KEY   ? 'enabled' : 'disabled (set SERPAPI_KEY)'}`);
  console.log('');

  if (!PLACES_KEY && !SERP_KEY) {
    console.error('ERROR: No API keys configured. Set GOOGLE_PLACES_API_KEY and/or SERPAPI_KEY in .env');
    process.exit(1);
  }

  console.log('▶ Phase 1 – Google Places API');
  const placesResults = await runPlacesScraper();
  console.log(`  Collected ${placesResults.length} places records.\n`);

  console.log('▶ Phase 2 – SerpAPI Google Search');
  const serpResults = await runSerpScraper();
  console.log(`  Collected ${serpResults.length} serp records.\n`);

  console.log('▶ Phase 3 – Deduplicating & merging…');
  const combined = [...placesResults, ...serpResults];
  const deduped  = deduplicateAndMerge(combined);
  console.log(`  ${combined.length} total → ${deduped.length} unique clubs`);

  writeCSV(deduped);
  printSummary(deduped);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
