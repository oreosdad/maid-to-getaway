// Netlify function: reset-password
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ICAL_SYNC_SECRET     = process.env.ICAL_SYNC_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { secret, action, userId, email, newPassword, name } = body;

  if (secret !== ICAL_SYNC_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server config missing' }) };
  }

  // Reset password — call Supabase Auth Admin REST API directly
  if (!action || action === 'reset') {
    if (!userId || !newPassword) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or newPassword' }) };
    }

    const url = `${SUPABASE_URL}/auth/v1/admin/users/${userId}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY
      },
      body: JSON.stringify({ password: newPassword })
    });

    const data = await res.json();
    console.log('REST reset response:', res.status, JSON.stringify(data));

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || data.msg || JSON.stringify(data) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // Create auth account for existing tracking-only profile
  if (action === 'create_auth') {
    if (!userId || !email || !newPassword) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing params' }) };
    }

    const url = `${SUPABASE_URL}/auth/v1/admin/users`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY
      },
      body: JSON.stringify({
        email,
        password: newPassword,
        email_confirm: true,
        user_metadata: { full_name: name || '' }
      })
    });

    const data = await res.json();
    console.log('REST create_auth response:', res.status, JSON.stringify(data));

    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || data.msg || JSON.stringify(data) }) };
    }

    const newAuthId = data.id;

    // Update the profile to use the new auth UUID
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { error: profileErr } = await db.from('profiles').update({ id: newAuthId, email }).eq('id', userId);
    if (profileErr) {
      return { statusCode: 200, body: JSON.stringify({ success: true, warning: 'Auth created but profile not updated: ' + profileErr.message + ' — new auth ID: ' + newAuthId }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, newAuthId }) };
  }

  // Create brand new user
  if (action === 'create_user') {
    if (!email || !newPassword) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing email or password' }) };
    }

    const url = `${SUPABASE_URL}/auth/v1/admin/users`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY
      },
      body: JSON.stringify({
        email,
        password: newPassword,
        email_confirm: true,
        user_metadata: { full_name: name || '' }
      })
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || data.msg || JSON.stringify(data) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, userId: data.id }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
};
