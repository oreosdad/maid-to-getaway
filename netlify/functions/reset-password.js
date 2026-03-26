// Netlify function: reset-password
// Also handles creating auth accounts for existing tracking-only profiles
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

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ACTION: reset password for existing auth user
  if (action === 'reset' || (!action && userId && newPassword)) {
    const { error } = await db.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) {
      console.error('updateUserById error:', error.message);
      return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ACTION: create auth account for existing tracking-only profile
  if (action === 'create_auth' && email && newPassword && userId) {
    // Create auth user with the existing profile UUID
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: newPassword,
      email_confirm: true,
      user_metadata: { full_name: name || '' }
    });
    if (error) {
      console.error('createUser error:', error.message);
      return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }

    const newAuthId = data.user.id;

    // Update profiles row to use the new auth UUID
    // First update the profile's id to match auth
    const { error: profileErr } = await db.from('profiles')
      .update({ id: newAuthId, email })
      .eq('id', userId);

    if (profileErr) {
      console.error('profile update error:', profileErr.message);
      // Auth user was created but profile update failed — still return success with note
      return { statusCode: 200, body: JSON.stringify({ success: true, warning: 'Auth created but profile ID mismatch — update manually. New auth ID: ' + newAuthId }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, newAuthId }) };
  }

  // ACTION: create brand new user (auth + profile)
  if (action === 'create_user' && email && newPassword) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: newPassword,
      email_confirm: true,
      user_metadata: { full_name: name || '' }
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ success: true, userId: data.user.id }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action or missing parameters' }) };
};
