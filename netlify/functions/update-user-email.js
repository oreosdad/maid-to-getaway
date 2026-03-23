// Netlify serverless function: update-user-email
// Uses service role key to update email in Supabase auth.users
// Called from admin portal to change a user's email address
//
// Deploy at: /.netlify/functions/update-user-email

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Verify caller is authenticated admin (basic check via secret header)
  const secret = event.headers['x-admin-secret'];
  if (secret !== process.env.ICAL_SYNC_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const { userId, newEmail } = JSON.parse(event.body || '{}');
  if (!userId || !newEmail) {
    return { statusCode: 400, body: 'Missing userId or newEmail' };
  }

  // Use service role key to update auth.users
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
    email: newEmail,
    email_confirm: true
  });

  if (authError) {
    return { statusCode: 500, body: JSON.stringify({ error: authError.message }) };
  }

  // Also update profiles table
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ email: newEmail })
    .eq('id', userId);

  if (profileError) {
    return { statusCode: 500, body: JSON.stringify({ error: profileError.message }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true })
  };
};
