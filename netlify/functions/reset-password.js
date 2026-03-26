// Netlify function: reset-password
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ICAL_SYNC_SECRET     = process.env.ICAL_SYNC_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { secret, email, userId, newPassword } = body;

  if (secret !== ICAL_SYNC_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server config error' }) };
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Set password directly by userId
  if (userId && newPassword) {
    const { error } = await db.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ success: true, mode: 'password_set' }) };
  }

  // Send reset email via recovery link
  if (email) {
    const { data, error } = await db.auth.admin.generateLink({
      type: 'recovery',
      email: email,
      options: { redirectTo: 'https://maidtogetaway.com/login.html' }
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };

    // Return the magic link in case email doesn't send — admin can copy/share it
    const link = data?.properties?.action_link;
    return { statusCode: 200, body: JSON.stringify({ success: true, mode: 'email_sent', link }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Missing email or userId+newPassword' }) };
};
