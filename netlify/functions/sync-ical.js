// Netlify serverless function: sync-ical
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SYNC_SECRET       = process.env.ICAL_SYNC_SECRET;

function parseIcal(text) {
  const events = [];
  const lines  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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
    if (line === 'END:VEVENT')   { if (current) events.push(current); current = null; continue; }
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
  const d = val.replace(/[TZ]/g, '').trim();
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
}

function isBlockedEvent(summary) {
  const s = (summary || '').toLowerCase();
  return s.includes('not available') || (s.includes('airbnb') === false && s === 'blocked');
}

function calcPayDate(scheduledDate) {
  if (!scheduledDate) return null;
  const d = new Date(scheduledDate + 'T12:00:00');
  const daysToAdd = [5, 11, 10, 9, 8, 7, 6][d.getDay()];
  const pay = new Date(d);
  pay.setDate(d.getDate() + daysToAdd);
  return pay.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  // Accept either the sync secret (scheduled runs) or an admin JWT (manual trigger)
  const token  = event.headers['x-sync-secret'] || event.queryStringParameters?.secret;
  const jwt    = event.headers['x-admin-jwt'];
  let authorized = false;

  if (SYNC_SECRET && token === SYNC_SECRET) {
    authorized = true;
  } else if (jwt) {
    // Verify JWT is a valid admin
    const authDb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: { user } } = await authDb.auth.getUser(jwt);
    if (user) {
      const { data: profile } = await authDb.from('profiles').select('role, notification_prefs').eq('id', user.id).single();
      if (profile && (profile.role === 'admin' || (profile.notification_prefs?.roles || []).includes('admin'))) {
        authorized = true;
      }
    }
  }

  if (!authorized) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing Supabase env vars' }) };
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const today = new Date().toISOString().split('T')[0];

  // Load properties
  const { data: properties, error: propErr } = await db
    .from('properties')
    .select('id, name, airbnb_ical_url, vrbo_ical_url, default_charge_cents, default_payout_cents, default_checkout_time, default_checkin_time')
    .eq('is_active', true);
  if (propErr) return { statusCode: 500, body: JSON.stringify({ error: propErr.message }) };

  // Load property groups with roles
  const { data: groupMembers } = await db.from('property_group_members').select('property_id, group_id, role');
  const groupMap = {};    // propId -> [sibling propIds]
  const roleMap  = {};    // propId -> 'parent' | 'unit'
  if (groupMembers) {
    const byGroup = {};
    groupMembers.forEach(m => {
      if (!byGroup[m.group_id]) byGroup[m.group_id] = [];
      byGroup[m.group_id].push(m.property_id);
      roleMap[m.property_id] = m.role || 'unit';
    });
    Object.values(byGroup).forEach(members => {
      members.forEach(propId => {
        groupMap[propId] = members.filter(id => id !== propId);
      });
    });
  }

  const results = { created: 0, skipped: 0, errors: [] };

  // ── PASS 1: Fetch ALL iCal feeds and build a complete map of bookings ──
  // jobsByPropDate[propId|cleanDate] = { checkoutDT, checkinDT, validEvents, prop, feed }
  const allFeedData = []; // array of { prop, feed, validEvents }
  const jobsByPropDate = {};

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

      const allEvents = parseIcal(icalText);

      // Handle cancellations immediately in Pass 1
      const cancelledEvents = allEvents.filter(e => e.uid && e.status === 'CANCELLED');
      for (const evt of cancelledEvents) {
        const { data: existingJob } = await db.from('jobs').select('id, deleted_at').eq('ical_uid', evt.uid).maybeSingle();
        if (existingJob && !existingJob.deleted_at) {
          await db.from('jobs').update({
            deleted_at: new Date().toISOString(),
            deleted_reason: `Booking cancelled via ${feed.source === 'airbnb' ? 'Airbnb' : 'VRBO'}`
          }).eq('id', existingJob.id);
          console.log(`Soft deleted cancelled job: ${prop.name} (${feed.source}) UID: ${evt.uid}`);
        }
      }

      const validEvents = allEvents
        .filter(e => e.dtstart && e.uid && !isBlockedEvent(e.summary) && e.status !== 'CANCELLED')
        .sort((a, b) => (a.dtstart < b.dtstart ? -1 : 1));

      allFeedData.push({ prop, feed, validEvents });

      // Populate jobsByPropDate for all future events
      for (const evt of validEvents) {
        const cleanDate = evt.dtend || evt.dtstart;
        if (cleanDate < today) continue;

        const checkoutDT = prop.default_checkout_time ? `${cleanDate}T${prop.default_checkout_time}` : null;

        // Find next booking in same feed
        const nextBooking = validEvents.find(e =>
          e.uid !== evt.uid && e.dtstart >= cleanDate && !isBlockedEvent(e.summary)
        );
        const nextCheckinDate = nextBooking ? nextBooking.dtstart : null;
        const checkinDT = nextCheckinDate && prop.default_checkin_time
          ? `${nextCheckinDate}T${prop.default_checkin_time}`
          : prop.default_checkin_time
          ? `${cleanDate}T${prop.default_checkin_time}`
          : null;

        // guest_arrivalDT = when the NEW guests arrive for THIS booking = cleanDate + checkin_time
        const guest_arrivalDT = prop.default_checkin_time ? `${cleanDate}T${prop.default_checkin_time}` : null;

        const key = `${prop.id}|${cleanDate}`;
        if (!jobsByPropDate[key] || (checkinDT && new Date(checkinDT) < new Date(jobsByPropDate[key].checkinDT || '9999'))) {
          jobsByPropDate[key] = { checkoutDT, checkinDT, guest_arrivalDT, propId: prop.id };
        }
      }
    }
  }

  // ── PASS 2: Create jobs using the complete map for cross-property detection ──
  for (const { prop, feed, validEvents } of allFeedData) {
    for (const evt of validEvents) {
      const cleanDate = evt.dtend || evt.dtstart;
      if (cleanDate < today) continue;

      // Check if job already exists
      const { data: existing } = await db.from('jobs').select('id, deleted_at').eq('ical_uid', evt.uid).maybeSingle();

      // Handle cancellations — soft delete the job if it exists and isn't already deleted
      if (evt.status === 'CANCELLED') {
        if (existing && !existing.deleted_at) {
          await db.from('jobs').update({
            deleted_at: new Date().toISOString(),
            deleted_reason: `Booking cancelled via ${feed.source === 'airbnb' ? 'Airbnb' : 'VRBO'}`
          }).eq('id', existing.id);
          console.log(`Soft deleted cancelled job: ${prop.name} (${feed.source}) UID: ${evt.uid}`);
          results.created--; // offset the skipped++ below
        }
        results.skipped++;
        continue;
      }

      if (existing) { results.skipped++; continue; }

      const key = `${prop.id}|${cleanDate}`;
      const ownTimes = jobsByPropDate[key] || {};
      let checkoutDT = ownTimes.checkoutDT || null;
      let checkinDT  = ownTimes.checkinDT  || null;

      // Cross-property: find earliest sibling checkin within 8hrs of our checkout
      let effectiveCheckinDT = checkinDT;
      let isShortWindow = false;

      if (checkoutDT && checkinDT) {
        const gap = (new Date(checkinDT) - new Date(checkoutDT)) / 36e5;
        if (gap >= 0 && gap < 8) isShortWindow = true;
      }

      if (groupMap[prop.id]) {
        const siblings = groupMap[prop.id];

        // Query DB for sibling jobs within 30 days of cleanDate
        const lookAheadDate = new Date(cleanDate + 'T12:00:00');
        lookAheadDate.setDate(lookAheadDate.getDate() + 30);
        const lookAheadStr = lookAheadDate.toISOString().split('T')[0];

        const { data: siblingJobs } = await db
          .from('jobs')
          .select('property_id, scheduled_date, guest_checkout, guest_checkin, guest_arrival')
          .in('property_id', siblings)
          .gte('scheduled_date', cleanDate)
          .lte('scheduled_date', lookAheadStr)
          .is('deleted_at', null)
          .order('scheduled_date', { ascending: true });

        // Build sibling property checkin time map for arrival calculation
        const sibPropCheckinMap = {};
        for (const sibId of siblings) {
          const sibProp = properties.find(p => p.id === sibId);
          if (sibProp?.default_checkin_time) sibPropCheckinMap[sibId] = sibProp.default_checkin_time;
        }

        // Also check jobsByPropDate for jobs being created this sync run
        const allSibJobs = [...(siblingJobs || [])];
        for (const sibId of siblings) {
          for (let d = 0; d <= 30; d++) {
            const ld = new Date(cleanDate + 'T12:00:00');
            ld.setDate(ld.getDate() + d);
            const ldStr = ld.toISOString().split('T')[0];
            const inMemory = jobsByPropDate[`${sibId}|${ldStr}`];
            if (inMemory && !allSibJobs.find(j => j.property_id === sibId && j.scheduled_date === ldStr)) {
              allSibJobs.push({
                property_id: sibId,
                scheduled_date: ldStr,
                guest_checkout: inMemory.checkoutDT,
                guest_arrival: inMemory.guest_arrivalDT
              });
            }
          }
        }

        const myRole = roleMap[prop.id] || 'unit';

        for (const sibJob of allSibJobs) {
          const sibRole = roleMap[sibJob.property_id] || 'unit';

          // Relevance rules:
          // - unit only cares about parent (Entire Duplex) arrivals
          // - parent (Entire) cares about all siblings (both units)
          const relevant = myRole === 'parent' || sibRole === 'parent';
          if (!relevant) continue;

          const sibArrival = sibJob.guest_arrival ||
            (sibPropCheckinMap[sibJob.property_id]
              ? `${sibJob.scheduled_date}T${sibPropCheckinMap[sibJob.property_id]}`
              : null);
          const sibCheckout = sibJob.guest_checkout;

          if (sibArrival && checkoutDT) {
            const gap = (new Date(sibArrival) - new Date(checkoutDT)) / 36e5;
            if (gap >= 0) {
              if (gap < 8) isShortWindow = true;
              if (!effectiveCheckinDT || new Date(sibArrival) < new Date(effectiveCheckinDT)) {
                effectiveCheckinDT = sibArrival;
              }
            }
          }
          if (sibCheckout && checkinDT) {
            const gap = (new Date(checkinDT) - new Date(sibCheckout)) / 36e5;
            if (gap >= 0 && gap < 8) isShortWindow = true;
          }
        }
      }

      const finalCheckinDT = effectiveCheckinDT;
      const autoPetFee = feed.source === 'vrbo' || (evt.summary || '').toLowerCase().includes('pet');

      const { error: insertErr } = await db.from('jobs').insert({
        property_id:      prop.id,
        scheduled_date:   cleanDate,
        guest_checkout:   checkoutDT,
        guest_checkin:    finalCheckinDT,
        guest_arrival:    prop.default_checkin_time ? `${cleanDate}T${prop.default_checkin_time}` : null,
        status:           'unassigned',
        source:           feed.source,
        ical_uid:         evt.uid,
        ical_summary:     evt.summary || null,
        is_short_window:  isShortWindow,
        pet_fee_required: autoPetFee,
        charge_cents:     prop.default_charge_cents || null,
        payout_cents:     prop.default_payout_cents || null,
        cleaner_pay_date: calcPayDate(cleanDate),
        notes:            evt.summary ? `Booking: ${evt.summary}` : null
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

  // If any errors occurred, log them as maintenance requests so admin sees the badge
  if (results.errors.length > 0) {
    const errorNote = `iCal sync errors at ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}:\n` +
      results.errors.map(e => `• ${e}`).join('\n');
    // Use first available property_id since property_id is required
    const firstProp = properties?.[0];
    if (firstProp) {
      await db.from('maintenance_requests').insert({
        property_id: firstProp.id,
        category: 'other',
        notes: errorNote,
        status: 'open'
      });
    }
    console.error('Sync errors logged to maintenance_requests:', results.errors);
  }

  console.log('iCal sync complete:', results);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'iCal sync complete', ...results, timestamp: new Date().toISOString() })
  };
};
