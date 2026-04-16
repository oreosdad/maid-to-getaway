// Netlify serverless function: sync-ical
// Runs on a schedule (or via webhook) to pull Airbnb/VRBO iCal feeds
// and create jobs in Supabase for any new bookings found.
//
// Deploy at: /.netlify/functions/sync-ical
// Schedule:  Add to netlify.toml (see below)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // use service role key for server-side writes
const SYNC_SECRET      = process.env.ICAL_SYNC_SECRET; // optional: protect the endpoint

// ── iCal parser (no dependencies needed) ──
function parseIcal(text) {
  const events = [];
  const lines  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Unfold long lines (RFC 5545)
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  let current = null;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT'   ) { if (current) events.push(current); current = null; continue; }
    if (!current) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).split(';')[0].toUpperCase();
    const val = line.slice(colon + 1).trim();

    if (key === 'DTSTART') current.dtstart = parseIcalDate(val);
    if (key === 'DTEND')   current.dtend   = parseIcalDate(val);
    if (key === 'SUMMARY') current.summary = val;
    if (key === 'UID')     current.uid     = val;
    if (key === 'STATUS')  current.status  = val;
  }

  return events;
}

function parseIcalDate(val) {
  // Handles DATE (20260319) and DATETIME (20260319T120000Z)
  const d = val.replace(/[TZ]/g, '').trim();
  const year  = d.slice(0, 4);
  const month = d.slice(4, 6);
  const day   = d.slice(6, 8);
  return `${year}-${month}-${day}`;
}

function isBlockedEvent(summary) {
  // Airbnb and VRBO use these summary strings for blocked/unavailable dates
  const s = (summary || '').toLowerCase();
  return s.includes('not available') || s.includes('airbnb') === false && s === 'blocked';
}

// ── Pay date calc: Friday of the week AFTER the cleaning ──
function calcPayDate(scheduledDate) {
  if (!scheduledDate) return null;
  const d   = new Date(scheduledDate + 'T12:00:00');
  const dow = d.getDay(); // 0=Sun…6=Sat
  const daysToAdd = [5, 11, 10, 9, 8, 7, 6][dow]; // precomputed offsets
  const pay = new Date(d);
  pay.setDate(d.getDate() + daysToAdd);
  return pay.toISOString().split('T')[0];
}

// ── Main handler ──
exports.handler = async (event) => {
  // Optional: protect with a secret token
  if (SYNC_SECRET) {
    const token = event.headers['x-sync-secret'] || event.queryStringParameters?.secret;
    if (token !== SYNC_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Supabase env vars' }) };
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Load all active properties that have iCal URLs
  const { data: properties, error: propErr } = await db
    .from('properties')
    .select('id, name, airbnb_ical_url, vrbo_ical_url, default_charge_cents, default_payout_cents, default_checkout_time, default_checkin_time')
    .eq('is_active', true);

  if (propErr) {
    console.error('Error loading properties:', propErr);
    return { statusCode: 500, body: JSON.stringify({ error: propErr.message }) };
  }

  const results = { created: 0, skipped: 0, errors: [] };

  for (const prop of properties) {
    const feeds = [];
    if (prop.airbnb_ical_url) feeds.push({ url: prop.airbnb_ical_url, source: 'airbnb' });
    if (prop.vrbo_ical_url)   feeds.push({ url: prop.vrbo_ical_url,   source: 'vrbo'   });

    for (const feed of feeds) {
      let icalText;
      try {
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': 'MaidToGetaway-iCalSync/1.0' },
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        icalText = await res.text();
      } catch (err) {
        console.error(`Fetch failed for ${prop.name} (${feed.source}):`, err.message);
        results.errors.push(`${prop.name} (${feed.source}): ${err.message}`);
        continue;
      }

      const events = parseIcal(icalText);
      const today  = new Date().toISOString().split('T')[0];

      for (const evt of events) {
        // Skip blocked/unavailable markers — only process guest bookings
        if (!evt.dtstart || !evt.uid) continue;
        if (isBlockedEvent(evt.summary)) continue;
        if (evt.status === 'CANCELLED') continue;

        // Cleaning date = DTEND (checkout day — when cleaner comes in)
        // Filter on cleanDate not dtstart — guest may have checked in before today
        const cleanDate = evt.dtend || evt.dtstart;

        // Only sync jobs where the cleaning date is today or in the future
        if (cleanDate < today) continue;

        // Check if a job for this UID already exists
        const { data: existing } = await db
          .from('jobs')
          .select('id')
          .eq('ical_uid', evt.uid)
          .maybeSingle();

        if (existing) { results.skipped++; continue; }

        // Build guest checkout/checkin datetimes using property defaults
        const checkoutDT = prop.default_checkout_time
          ? `${evt.dtstart}T${prop.default_checkout_time}`
          : null;
        const checkinDT = prop.default_checkin_time
          ? `${cleanDate}T${prop.default_checkin_time}`
          : null;

        // Detect short window (< 8 hrs between checkout and check-in)
        let isShortWindow = false;
        if (checkoutDT && checkinDT) {
          const gapHrs = (new Date(checkinDT) - new Date(checkoutDT)) / 36e5;
          if (gapHrs < 8) isShortWindow = true;
        }

        const { error: insertErr } = await db.from('jobs').insert({
          property_id:     prop.id,
          scheduled_date:  cleanDate,
          guest_checkout:  checkoutDT,
          guest_checkin:   checkinDT,
          status:          'unassigned',
          source:          feed.source,
          ical_uid:        evt.uid,
          ical_summary:    evt.summary || null,
          is_short_window: isShortWindow,
          charge_cents:    prop.default_charge_cents || null,
          payout_cents:    prop.default_payout_cents || null,
          cleaner_pay_date: calcPayDate(cleanDate),
          notes:           evt.summary ? `Booking: ${evt.summary}` : null
        });

        if (insertErr) {
          console.error(`Insert failed for ${prop.name}:`, insertErr.message);
          results.errors.push(`${prop.name}: ${insertErr.message}`);
        } else {
          results.created++;
          console.log(`Created job: ${prop.name} on ${cleanDate} (${feed.source})`);
        }
      }
    }
  }

  console.log('iCal sync complete:', results);
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'iCal sync complete',
      ...results,
      timestamp: new Date().toISOString()
    })
  };
};
