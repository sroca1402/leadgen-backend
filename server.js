require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const pLimit = require('p-limit');
const { ApifyClient } = require('apify-client');
const app = express();
app.use(cors());
app.use(express.json());
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const APIFY_API_KEY = process.env.APIFY_API_KEY;
const BOOKING_PLATFORMS = [
  { name: 'Playbypoint', patterns: ['playbypoint.com', 'playbypoint'] },
  { name: 'CourtReserve', patterns: ['courtreserve.com'] },
  { name: 'Mindbody', patterns: ['mindbodyonline.com', 'mindbody'] },
  { name: 'ClubSpark', patterns: ['clubspark'] },
  { name: 'Acuity Scheduling', patterns: ['acuityscheduling.com'] },
  { name: 'Calendly', patterns: ['calendly.com'] },
  { name: 'Square', patterns: ['square.site', 'squareup.com'] },
  { name: 'Shopify', patterns: ['myshopify.com'] },
  { name: 'WooCommerce', patterns: ['woocommerce'] },
  { name: 'SimplyBook', patterns: ['simplybook.me'] },
  { name: 'FareHarbor', patterns: ['fareharbor.com'] },
  { name: 'Skedda', patterns: ['skedda.com'] },
];
function detectPlatform(html) {
  const lower = html.toLowerCase();
  for (const p of BOOKING_PLATFORMS) {
    for (const pat of p.patterns) {
      if (lower.includes(pat)) return { platform: p.name, confidence: 'medium', evidence: [pat] };
    }
  }
  return { platform: 'Unknown', confidence: 'low', evidence: [] };
}
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
async function fetchHTML(url) {
  const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5 });
  return res.data;
}
async function getEmail(baseUrl) {
  if (!baseUrl) return null;
  try {
    const html = await fetchHTML(baseUrl);
    const $ = cheerio.load(html);
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().toLowerCase();
      if (['contact','about','info'].some(k => text.includes(k) || (href||'').includes(k))) links.push(href);
    });
    const pages = [html];
    const limit = pLimit(2);
    const extra = await Promise.all([...new Set(links)].slice(0,2).map(link => limit(async () => {
      try { return await fetchHTML(link.startsWith('http') ? link : new URL(link, baseUrl).href); } catch { return ''; }
    })));
    pages.push(...extra);
    const emails = [...new Set((pages.join('\n').match(EMAIL_REGEX)||[]))].filter(e => !e.includes('.png'));
    return emails[0] || null;
  } catch { return null; }
}
async function enrichWithApollo(website) {
  if (!APOLLO_API_KEY || !website) return null;
  try {
    const domain = new URL(website).hostname.replace('www.', '');
    const res = await axios.post('https://api.apollo.io/v1/mixed_people/search', {
      api_key: APOLLO_API_KEY,
      q_organization_domains: domain,
      page: 1,
      per_page: 5,
      person_titles: ['owner','founder','director','manager','president','ceo','operator'],
    }, { timeout: 10000 });
    const people = res.data?.people || [];
    if (people.length === 0) return null;
    const priority = ['owner','founder','ceo','president','director','manager','operator'];
    const sorted = people.sort((a, b) => {
      const aS = priority.findIndex(t => (a.title||'').toLowerCase().includes(t));
      const bS = priority.findIndex(t => (b.title||'').toLowerCase().includes(t));
      return (aS===-1?99:aS) - (bS===-1?99:bS);
    });
    const p = sorted[0];
    return {
      contactName: [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
      contactTitle: p.title || null,
      contactEmail: p.email || null,
      contactLinkedIn: p.linkedin_url || null,
      apolloEnriched: true,
    };
  } catch(e) { console.error('Apollo error:', e.message); return null; }
}
async function enrichWithApify(website) {
  if (!APIFY_API_KEY || !website) return null;
  try {
    const client = new ApifyClient({ token: APIFY_API_KEY });
    const run = await client.actor('vdrmDgJS7SqYMqBHc').call({
      startUrls: [{ url: website }],
      maxRequestsPerCrawl: 5,
    });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    if (!items || items.length === 0) return null;
    const item = items[0];
    return {
      contactEmail: item.emails?.[0] || null,
      apifyEnriched: true,
    };
  } catch(e) { console.error('Apify error:', e.message); return null; }
}
async function searchPlaces(query) {
  const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', { params: { query, key: GOOGLE_MAPS_API_KEY } });
  return res.data.results || [];
}
async function getDetails(placeId) {
  const res = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
    params: { place_id: placeId, fields: 'name,formatted_address,website,international_phone_number,rating,user_ratings_total,url,address_components', key: GOOGLE_MAPS_API_KEY }
  });
  return res.data.result || {};
}
function parseCity(ac=[]) { for (const c of ac) { if (c.types.includes('locality')) return c.long_name; } return ''; }
function parseRegion(ac=[]) { const c = ac.find(c => c.types.includes('administrative_area_level_1')); return c ? c.long_name : ''; }
function parseCountry(ac=[]) { const c = ac.find(c => c.types.includes('country')); return c ? c.long_name : ''; }
app.post('/api/generate-leads', async (req, res) => {
  const { location } = req.body;
  const country = location;
  if (!country) return res.status(400).json({ error: 'Location required' });
  if (!GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not set' });
  const queries = [
    { q: `padel club in ${country}`, category: 'Padel' },
    { q: `pickleball club in ${country}`, category: 'Pickleball' },
    { q: `golf simulator in ${country}`, category: 'Golf Simulator' },
  ];
  const seen = new Set();
  const raw = [];
  for (const { q, category } of queries) {
    try {
      const results = await searchPlaces(q);
      for (const r of results) {
        if (seen.has(r.place_id)) continue;
        seen.add(r.place_id);
        raw.push({ place_id: r.place_id, category, basic: r });
      }
    } catch(e) { console.error(e.message); }
  }
  const limit = pLimit(3);
  const enriched = await Promise.all(raw.map(lead => limit(async () => {
    let d = {};
    try { d = await getDetails(lead.place_id); } catch {}
    const website = d.website || null;
    const ac = d.address_components || [];
    let email = null;
    if (website) try { email = await getEmail(website); } catch {}
    let booking = { platform: 'Unknown', confidence: 'low', evidence: [] };
    if (website) try { booking = detectPlatform(await fetchHTML(website)); } catch {}
    let apollo = null;
    if (website) apollo = await enrichWithApollo(website);
    let apify = null;
    if (website && !apollo?.contactEmail && !email) apify = await enrichWithApify(website);
    return {
      id: lead.place_id, name: d.name || lead.basic.name, category: lead.category,
      phone: d.international_phone_number || null,
      email: apollo?.contactEmail || apify?.contactEmail || email,
      website, address: d.formatted_address || lead.basic.formatted_address || null,
      city: parseCity(ac), region: parseRegion(ac), country: parseCountry(ac) || country,
      rating: d.rating || lead.basic.rating || null,
      reviews: d.user_ratings_total || lead.basic.user_ratings_total || null,
      mapsLink: d.url || `https://www.google.com/maps/place/?q=place_id:${lead.place_id}`,
      bookingPlatform: booking.platform, platformConfidence: booking.confidence, platformEvidence: booking.evidence,
      contactName: apollo?.contactName || null, contactTitle: apollo?.contactTitle || null,
      contactEmail: apollo?.contactEmail || apify?.contactEmail || null, contactLinkedIn: apollo?.contactLinkedIn || null,
      apolloEnriched: apollo?.apolloEnriched || false,
      apifyEnriched: apify?.apifyEnriched || false,
    };
  })));
  res.json({ leads: enriched, total: enriched.length });
});
app.get('/api/health', (_, res) => res.json({ status: 'ok' }));
app.listen(3001, () => console.log('LeadGen backend running on port 3001'));
