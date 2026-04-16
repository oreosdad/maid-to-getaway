// Netlify function: reset-password
// Auth: verifies caller is a logged-in admin via JWT — no shared secret in HTML
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

async function verifyAdminJWT(jwt) {
  if (!jwt) return false;
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  // Get user from JWT
  const { data: { user }, error } = await db.auth.getUser(jwt);
  if (error || !user) return false;
  // Check they're an admin in profiles
  const { data: profile } = await db.from('profiles').select('role, notification_prefs').eq('id', user.id).single();
  if (!profile) return false;
  const roles = profile.notification_prefs?.roles || [];
  return profile.role === 'admin' || roles.includes('admin');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { jwt, action, userId, email, newPassword, name } = body;

  // Verify caller is a logged-in admin
  const isAdmin = await verifyAdminJWT(jwt);
  if (!isAdmin) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized — admin access required' }) };
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
    const { ok, status } = await authAdminRequest('PUT', `/users/${userId}`, { email, email_confirm: true });
    if (!ok && status !== 404) console.error('Auth email update failed');
    const { error: profileErr } = await db.from('profiles').update({ email }).eq('id', userId);
    if (profileErr) return { statusCode: 400, body: JSON.stringify({ error: profileErr.message }) };
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── DELETE USER ──
  if (action === 'delete_user') {
    if (!userId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId' }) };
    const { ok, status } = await authAdminRequest('DELETE', `/users/${userId}`);
    if (!ok && status !== 404) return { statusCode: 400, body: JSON.stringify({ error: 'Could not delete from auth' }) };
    await db.from('job_assignments').delete().eq('cleaner_id', userId);
    const { error: profErr } = await db.from('profiles').delete().eq('id', userId);
    if (profErr) return { statusCode: 400, body: JSON.stringify({ error: 'Profile delete failed: ' + profErr.message }) };
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
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
