// Netlify function: reset-password
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ICAL_SYNC_SECRET     = process.env.ICAL_SYNC_SECRET;

async function authAdminRequest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey': SUPABASE_SERVICE_KEY
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

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

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ── RESET PASSWORD ──
  if (!action || action === 'reset') {
    if (!userId || !newPassword) return { statusCode: 400, body: JSON.stringify({ error: 'Missing params' }) };
    const { ok, data } = await authAdminRequest('PUT', `/users/${userId}`, { password: newPassword });
    if (!ok) return { statusCode: 400, body: JSON.stringify({ error: data.message || JSON.stringify(data) }) };
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── UPDATE EMAIL ──
  if (action === 'update_email') {
    if (!userId || !email) return { statusCode: 400, body: JSON.stringify({ error: 'Missing params' }) };
    const { ok, data } = await authAdminRequest('PUT', `/users/${userId}`, { email, email_confirm: true });
    if (!ok) return { statusCode: 400, body: JSON.stringify({ error: data.message || JSON.stringify(data) }) };
    const { error: profileErr } = await db.from('profiles').update({ email }).eq('id', userId);
    if (profileErr) return { statusCode: 400, body: JSON.stringify({ error: profileErr.message }) };
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── DELETE USER ──
  if (action === 'delete_user') {
    if (!userId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId' }) };
    const { ok, status, data } = await authAdminRequest('DELETE', `/users/${userId}`);
    // 404 means not in auth — that's fine, profile-only user
    if (!ok && status !== 404) {
      return { statusCode: 400, body: JSON.stringify({ error: data.message || JSON.stringify(data) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, not_in_auth: status === 404 }) };
  }

  // ── GRANT LOGIN TO EXISTING PROFILE ──
  if (action === 'create_auth') {
    if (!userId || !email || !newPassword) return { statusCode: 400, body: JSON.stringify({ error: 'Missing params' }) };
    const { ok, data } = await authAdminRequest('POST', '/users', {
      email, password: newPassword, email_confirm: true,
      user_metadata: { full_name: name || '' }
    });
    if (!ok) return { statusCode: 400, body: JSON.stringify({ error: data.message || JSON.stringify(data) }) };
    const newAuthId = data.id;
    await db.from('profiles').delete().eq('id', newAuthId);
    await db.from('job_assignments').update({ cleaner_id: newAuthId }).eq('cleaner_id', userId);
    const { error: profileErr } = await db.from('profiles').update({ id: newAuthId, email }).eq('id', userId);
    if (profileErr) return { statusCode: 200, body: JSON.stringify({ success: true, warning: profileErr.message }) };
    return { statusCode: 200, body: JSON.stringify({ success: true, newAuthId }) };
  }

  // ── CREATE NEW USER ──
  if (action === 'create_user') {
    if (!email || !newPassword) return { statusCode: 400, body: JSON.stringify({ error: 'Missing params' }) };
    const { ok, data } = await authAdminRequest('POST', '/users', {
      email, password: newPassword, email_confirm: true,
      user_metadata: { full_name: name || '' }
    });
    if (!ok) return { statusCode: 400, body: JSON.stringify({ error: data.message || JSON.stringify(data) }) };
    return { statusCode: 200, body: JSON.stringify({ success: true, userId: data.id }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
};
