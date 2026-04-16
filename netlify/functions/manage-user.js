// netlify/functions/manage-user.js
// Handles privileged user operations requiring Supabase service role:
//   create_auth  — create auth account + link to existing profile
//   reset_pw     — set a new password for an existing user
//   delete_user  — permanently delete from auth (profile deletion handled client-side)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET        = process.env.ICAL_SYNC_SECRET; // reuse existing secret

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Auth check
  const secret = event.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { action, userId, email, password, name } = body;

  // ── CREATE AUTH — link existing profile to a new auth account ──
  if (action === 'create_auth') {
    if (!userId || !email || !password) {
      return { statusCode: 400, body: JSON.stringify({ error: 'userId, email, and password required' }) };
    }

    // Check if auth account already exists for this email
    const { data: existingList } = await db.auth.admin.listUsers();
    const existing = existingList?.users?.find(u => u.email === email);
    if (existing) {
      // If it's already linked to this profile, just return success
      if (existing.id === userId) {
        return { statusCode: 200, body: JSON.stringify({ success: true, userId, alreadyExists: true }) };
      }
      return { statusCode: 409, body: JSON.stringify({ error: `Email ${email} is already used by another account` }) };
    }

    // Create auth user with the EXISTING profile's UUID
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip email confirmation
      user_metadata: { full_name: name || '' }
    });

    if (createErr) {
      return { statusCode: 400, body: JSON.stringify({ error: createErr.message }) };
    }

    const newAuthId = created.user.id;

    // If the auth UUID differs from the profile UUID, we need to relink
    // (Supabase generates its own UUID for new auth users)
    if (newAuthId !== userId) {
      // Update the profile to use the new auth UUID
      // First update job_assignments foreign keys
      const { error: jaErr } = await db.from('job_assignments')
        .update({ cleaner_id: newAuthId })
        .eq('cleaner_id', userId);
      if (jaErr) console.error('job_assignments update error:', jaErr.message);

      // Delete any auto-created blank profile for the new auth ID
      await db.from('profiles').delete().eq('id', newAuthId);

      // Update the existing profile ID
      const { error: profErr } = await db.from('profiles')
        .update({ id: newAuthId, email })
        .eq('id', userId);

      if (profErr) {
        // Rollback: delete the auth user we just created
        await db.auth.admin.deleteUser(newAuthId);
        return { statusCode: 500, body: JSON.stringify({ error: 'Profile relink failed: ' + profErr.message }) };
      }
    } else {
      // Same UUID — just update the email on the profile
      await db.from('profiles').update({ email }).eq('id', userId);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, userId: newAuthId }) };
  }

  // ── RESET PASSWORD ──
  if (action === 'reset_pw') {
    if (!userId || !password) {
      return { statusCode: 400, body: JSON.stringify({ error: 'userId and password required' }) };
    }
    if (password.length < 6) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) };
    }
    const { error } = await db.auth.admin.updateUserById(userId, { password });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── DELETE USER ──
  if (action === 'delete_user') {
    if (!userId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'userId required' }) };
    }
    const { error } = await db.auth.admin.deleteUser(userId);
    if (error && !error.message.includes('not found')) {
      return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
};
