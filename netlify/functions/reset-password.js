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
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { secret, userId, newPassword } = body;

  console.log('reset-password called, userId:', userId, 'hasPassword:', !!newPassword);

  if (secret !== ICAL_SYNC_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!userId || !newPassword) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or newPassword' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing env vars, URL:', !!SUPABASE_URL, 'KEY:', !!SUPABASE_SERVICE_KEY);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server config missing' }) };
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // First verify the user exists in auth
  const { data: userData, error: getUserError } = await db.auth.admin.getUserById(userId);
  if (getUserError || !userData?.user) {
    console.error('getUserById error:', getUserError?.message, 'userId:', userId);
    return { statusCode: 404, body: JSON.stringify({ error: 'User not found in auth: ' + (getUserError?.message || 'no user') }) };
  }

  console.log('Found user:', userData.user.email);

  const { error } = await db.auth.admin.updateUserById(userId, { password: newPassword });
  if (error) {
    console.error('updateUserById error:', error.message);
    return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
