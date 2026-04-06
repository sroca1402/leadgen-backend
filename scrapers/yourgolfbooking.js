require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const OUT_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const TARGET_URL = 'https://yourgolfbooking.com/venue-search';
const PLACES_TEXT_SEARCH = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PLACES_DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';

// ─── Step 1: Playwright scrape ─────────────────────────────────────────────────
async function scrapeVenues() {
  console.log('\n[1/4] Launching Playwright → yourgolfbooking.com/venue-search');

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Silence noisy console output from the page
  page.on('console', () => {});
  page.on('pageerror', () => {});

  try {
    console.log('  → Navigating to venue search page...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for venue cards to appear — try several common selectors
    const cardSelectors = [
      '[class*="venue-card"]',
      '[class*="VenueCard"]',
      '[class*="venue_card"]',
      '[data-testid*="venue"]',
      '.venue',
      '[class*="listing"]',
      '[class*="result-item"]',
      '[class*="ResultItem"]',
      'article',
    ];

    let cardSelector = null;
    for (const sel of cardSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        const count = await page.locator(sel).count();
        if (count > 0) {
          cardSelector = sel;
          console.log(`  → Found venue cards using selector: "${sel}" (${count} initial cards)`);
          break;
        }
      } catch {}
    }

    if (!cardSelector) {
      // Fallback: take a screenshot and dump the HTML for debugging
      const debugPath = path.join(OUT_DIR, 'debug_screenshot.png');
      await page.screenshot({ path: debugPath, fullPage: false });
      const html = await page.content();
      fs.writeFileSync(path.join(OUT_DIR, 'debug_page.html'), html);
      console.warn('  ⚠ Could not detect venue cards. Saved debug_screenshot.png and debug_page.html to outputs/');
      await browser.close();
      return [];
    }

    // ── Paginate / Load More ──────────────────────────────────────────────────
    let previousCount = 0;
    let stallRounds = 0;
    const MAX_STALL = 3;

    while (stallRounds < MAX_STALL) {
      // Try clicking a "Load More" button
      const loadMoreSelectors = [
        'button:has-text("Load more")',
        'button:has-text("Load More")',
        'button:has-text("Show more")',
        'button:has-text("See more")',
        'button:has-text("Next")',
        '[class*="load-more"]',
        '[class*="loadMore"]',
        '[class*="LoadMore"]',
        'a:has-text("Load more")',
        'a:has-text("Next page")',
      ];

      let clicked = false;
      for (const sel of loadMoreSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.scrollIntoViewIfNeeded();
          await btn.click();
          await page.waitForTimeout(2500);
          clicked = true;
          break;
        }
      }

      // If no button, try scrolling to trigger infinite scroll
      if (!clicked) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2500);
      }

      const currentCount = await page.locator(cardSelector).count();
      if (currentCount === previousCount) {
        stallRounds++;
      } else {
        console.log(`  → ${currentCount} venues loaded...`);
        stallRounds = 0;
      }
      previousCount = currentCount;
    }

    const totalCards = await page.locator(cardSelector).count();
    console.log(`  → Finished loading. Total cards: ${totalCards}`);

    // ── Extract data from each card ───────────────────────────────────────────
    const venues = await page.evaluate((sel) => {
      const cards = Array.from(document.querySelectorAll(sel));

      return cards.map(card => {
        const text = card.innerText || card.textContent || '';
        const links = Array.from(card.querySelectorAll('a[href]'));

        // Name: usually the first heading or strong element
        const nameEl = card.querySelector('h1,h2,h3,h4,h5,strong,[class*="name"],[class*="title"],[class*="Name"],[class*="Title"]');
        const name = nameEl ? nameEl.innerText.trim() : '';

        // External website link (not the booking site itself)
        const websiteLink = links.find(a => {
          const href = a.href || '';
          return href.startsWith('http') &&
            !href.includes('yourgolfbooking.com') &&
            !href.startsWith('mailto') &&
            !href.startsWith('tel');
        });
        const website = websiteLink ? websiteLink.href.trim() : '';

        // Source URL (detail page link on yourgolfbooking.com)
        const sourceLink = links.find(a => (a.href || '').includes('yourgolfbooking.com'));
        const source_url = sourceLink ? sourceLink.href.trim() : window.location.href;

        // Phone: look for tel: links or phone pattern in text
        const telLink = card.querySelector('a[href^="tel:"]');
        const phone = telLink
          ? telLink.href.replace('tel:', '').trim()
          : (text.match(/\(?\+?[\d\s\-().]{7,15}\d/) || [])[0] || '';

        // Email
        const emailLink = card.querySelector('a[href^="mailto:"]');
        const email = emailLink ? emailLink.href.replace('mailto:', '').trim() : '';

        // Location: look for city/region/country in common elements
        const locationEl = card.querySelector(
          '[class*="location"],[class*="Location"],[class*="city"],[class*="City"],' +
          '[class*="address"],[class*="Address"],[class*="region"],[class*="country"]'
        );
        const locationText = locationEl ? locationEl.innerText.trim() : '';

        // Try to parse city / country from location string (e.g. "Edinburgh, Scotland, UK")
        const locationParts = locationText.split(/[,|\/]/).map(s => s.trim()).filter(Boolean);
        const city = locationParts[0] || '';
        const country = locationParts[locationParts.length - 1] || '';
        const region = locationParts.length > 2 ? locationParts[1] : (locationParts[1] || '');

        return { name, city, region, country, website, phone, email, source_url, _raw_text: text.slice(0, 300) };
      });
    }, cardSelector);

    // ── Visit individual venue pages for richer data ───────────────────────────
    console.log(`\n  → Visiting individual venue pages to extract missing data...`);
    const enrichedVenues = [];
    let visited = 0;

    for (const venue of venues) {
      if (!venue.name) { enrichedVenues.push(venue); continue; }

      // Only visit detail pages on yourgolfbooking.com
      if (!venue.source_url || !venue.source_url.includes('yourgolfbooking.com') || venue.source_url === TARGET_URL) {
        enrichedVenues.push(venue);
        continue;
      }

      try {
        const detailPage = await context.newPage();
        detailPage.on('console', () => {});
        await detailPage.goto(venue.source_url, { waitUntil: 'networkidle', timeout: 30000 });

        const detail = await detailPage.evaluate(() => {
          const text = document.body.innerText || '';

          const telLink = document.querySelector('a[href^="tel:"]');
          const phone = telLink
            ? telLink.href.replace('tel:', '').trim()
            : (text.match(/\(?\+?[\d\s\-().]{7,15}\d/) || [])[0] || '';

          const emailLink = document.querySelector('a[href^="mailto:"]');
          const email = emailLink ? emailLink.href.replace('mailto:', '').trim() : '';

          const websiteLink = Array.from(document.querySelectorAll('a[href]')).find(a => {
            const href = a.href || '';
            return href.startsWith('http') &&
              !href.includes('yourgolfbooking.com') &&
              !href.startsWith('mailto') &&
              !href.startsWith('tel');
          });
          const website = websiteLink ? websiteLink.href.trim() : '';

          const locationEl = document.querySelector(
            '[class*="location"],[class*="Location"],[class*="address"],[class*="Address"],' +
            '[class*="city"],[class*="City"],[class*="region"],[class*="country"]'
          );
          const locationText = locationEl ? locationEl.innerText.trim() : '';

          return { phone, email, website, locationText };
        });

        if (!venue.phone && detail.phone) venue.phone = detail.phone;
        if (!venue.email && detail.email) venue.email = detail.email;
        if (!venue.website && detail.website) venue.website = detail.website;
        if ((!venue.city || !venue.country) && detail.locationText) {
          const parts = detail.locationText.split(/[,|\/]/).map(s => s.trim()).filter(Boolean);
          if (!venue.city) venue.city = parts[0] || '';
          if (!venue.country) venue.country = parts[parts.length - 1] || '';
        }

        await detailPage.close();
        visited++;
        if (visited % 20 === 0) console.log(`    ${visited}/${venues.length} detail pages visited`);

      } catch (err) {
        // Non-fatal: continue with what we have
      }

      enrichedVenues.push(venue);
    }

    console.log(`  → Visited ${visited} detail pages`);
    await browser.close();

    // Deduplicate by name (case-insensitive)
    const seen = new Set();
    const unique = enrichedVenues.filter(v => {
      const key = (v.name || '').toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  → ${unique.length} unique venues extracted`);
    return unique;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ─── Step 2: Google Places enrichment ─────────────────────────────────────────
async function enrichWithPlaces(venues) {
  if (!GOOGLE_API_KEY) {
    console.warn('\n[2/4] GOOGLE_PLACES_API_KEY not set — skipping Places enrichment');
    return venues.map(v => ({ ...v, place_id: '', formatted_address: '' }));
  }

  console.log(`\n[2/4] Enriching ${venues.length} venues with Google Places API...`);
  const limit = pLimit(5); // 5 concurrent requests

  const enriched = await Promise.all(venues.map(v => limit(async () => {
    const query = `${v.name} golf simulator ${v.city || ''}`.trim();

    try {
      // Text Search to get place_id
      const searchResp = await axios.get(PLACES_TEXT_SEARCH, {
        params: { query, key: GOOGLE_API_KEY },
        timeout: 10000,
      });

      const results = searchResp.data?.results || [];
      if (results.length === 0) return { ...v, place_id: '', formatted_address: '' };

      const best = results[0];
      const place_id = best.place_id || '';
      const formatted_address = best.formatted_address || '';
      let places_phone = '';
      let places_website = '';

      // Details call to get phone + website
      if (place_id) {
        const detailResp = await axios.get(PLACES_DETAILS, {
          params: {
            place_id,
            fields: 'formatted_phone_number,website',
            key: GOOGLE_API_KEY,
          },
          timeout: 10000,
        });
        const det = detailResp.data?.result || {};
        places_phone = det.formatted_phone_number || '';
        places_website = det.website || '';
      }

      return {
        ...v,
        place_id,
        formatted_address,
        phone: v.phone || places_phone,
        website: v.website || places_website,
      };

    } catch (err) {
      // Quota/network error — return venue unchanged
      return { ...v, place_id: '', formatted_address: '' };
    }
  })));

  const enrichedCount = enriched.filter(v => v.place_id).length;
  console.log(`  → Matched ${enrichedCount}/${venues.length} venues in Google Places`);
  return enriched;
}

// ─── Helpers: CSV writer ───────────────────────────────────────────────────────
function escapeCSV(val) {
  const s = String(val === null || val === undefined ? '' : val).replace(/"/g, '""');
  return `"${s}"`;
}

function writeCSV(filePath, headers, rows) {
  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(h => escapeCSV(row[h] ?? '')).join(',')),
  ];
  fs.writeFileSync(filePath, lines.join('\n'));
  console.log(`  ✓ Saved ${path.basename(filePath)} (${rows.length} rows)`);
}

// ─── Step 3: Save venues_raw.json ─────────────────────────────────────────────
function saveRaw(venues) {
  const outPath = path.join(OUT_DIR, 'venues_raw.json');
  fs.writeFileSync(outPath, JSON.stringify(venues, null, 2));
  console.log(`  ✓ Saved venues_raw.json (${venues.length} venues)`);
}

// ─── Step 4: Save venues_enriched.csv ─────────────────────────────────────────
function saveEnriched(venues) {
  const headers = ['name', 'city', 'country', 'address', 'phone', 'website', 'source_url'];
  const rows = venues.map(v => ({
    name: v.name,
    city: v.city || '',
    country: v.country || '',
    address: v.formatted_address || '',
    phone: v.phone || '',
    website: v.website || '',
    source_url: v.source_url || '',
  }));
  writeCSV(path.join(OUT_DIR, 'venues_enriched.csv'), headers, rows);
  return rows;
}

// ─── Step 5: Save apollo_import.csv ───────────────────────────────────────────
function saveApollo(enrichedRows) {
  const headers = [
    'Company Name',
    'Company Website',
    'City',
    'State',
    'Country',
    'Phone',
    'Lead Source',
    'Outreach Sequence',
  ];

  const rows = enrichedRows.map(v => {
    // Try to split "city, state" if combined (common for US/UK entries)
    const cityParts = (v.city || '').split(',').map(s => s.trim());
    const city = cityParts[0] || '';
    const state = cityParts[1] || '';

    return {
      'Company Name': v.name,
      'Company Website': v.website,
      'City': city,
      'State': state,
      'Country': v.country,
      'Phone': v.phone,
      'Lead Source': 'YourGolfBooking',
      'Outreach Sequence': 'Golf Sim - PBP Cold',
    };
  });

  writeCSV(path.join(OUT_DIR, 'apollo_import.csv'), headers, rows);
  return rows;
}

// ─── Step 6: Save no_website.csv ──────────────────────────────────────────────
function saveNoWebsite(enrichedRows) {
  const noWebsite = enrichedRows.filter(v => !v.website || v.website.trim() === '');
  if (noWebsite.length === 0) {
    console.log('  ✓ All venues have a website — no_website.csv not created');
    return 0;
  }

  const headers = ['name', 'city', 'country', 'address', 'phone', 'source_url'];
  writeCSV(path.join(OUT_DIR, 'no_website.csv'), headers, noWebsite);
  return noWebsite.length;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== YourGolfBooking Venue Scraper ===');
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Google Places: ${GOOGLE_API_KEY ? 'enabled' : 'disabled (set GOOGLE_PLACES_API_KEY)'}\n`);

  // Step 1 — Scrape
  let venues = [];
  try {
    venues = await scrapeVenues();
  } catch (err) {
    console.error('Scrape error:', err.message);
    process.exit(1);
  }

  if (venues.length === 0) {
    console.error('No venues scraped. Check outputs/debug_page.html and debug_screenshot.png for clues.');
    process.exit(1);
  }

  // Save raw immediately (before enrichment, so data is never lost)
  console.log('\n[3/4] Saving raw results...');
  saveRaw(venues);

  // Step 2 — Google Places enrichment
  const enriched = await enrichWithPlaces(venues);

  // Step 3 — Write output files
  console.log('\n[4/4] Writing output files...');
  const enrichedRows = saveEnriched(enriched);
  saveApollo(enrichedRows);
  const missingWebsiteCount = saveNoWebsite(enrichedRows);

  // ── Summary ────────────────────────────────────────────────────────────────
  const withWebsite = enrichedRows.filter(v => v.website).length;
  const placesMatched = enriched.filter(v => v.place_id).length;

  console.log('\n════════════════════════════════════');
  console.log('  Summary');
  console.log('════════════════════════════════════');
  console.log(`  Total venues scraped   : ${venues.length}`);
  console.log(`  Enriched via Places    : ${placesMatched}`);
  console.log(`  With website           : ${withWebsite}`);
  console.log(`  Missing website        : ${missingWebsiteCount}`);
  console.log('────────────────────────────────────');
  console.log(`  Output files (outputs/)`);
  console.log(`    venues_raw.json`);
  console.log(`    venues_enriched.csv`);
  console.log(`    apollo_import.csv`);
  if (missingWebsiteCount > 0) console.log(`    no_website.csv`);
  console.log('════════════════════════════════════\n');
})();
