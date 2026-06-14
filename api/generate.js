export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  async function sbFetch(path, options = {}) {
    const key = (options.method === 'POST' || options.method === 'PATCH' || options.method === 'DELETE')
      ? (process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY)
      : SUPABASE_KEY;
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...options,
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(options.headers || {})
      }
    });
    const text = await r.text();
    try { return text ? JSON.parse(text) : {}; } catch(e) { console.log('sbFetch parse error:', text); return {}; }
  }

  async function sbAuth(path, body) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  // Email helper using Resend
  async function sendEmail({ to, subject, html }) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MX-Logbook <hello@mx-logbook.com>',
        to,
        subject,
        html
      })
    });
    return r.json();
  }

  try {
    const { type, user_id } = req.body;
    
    if (type === 'auth_signup') {
      const { email, password, plan, referral_code } = req.body;
      const data = await sbAuth('/signup', { email, password });
      if (data.error) return res.status(400).json({ error: data.error.message || data.msg });
      const uid = data.user?.id || data.id;

      if (uid) {
        // Generate plan-prefixed referral code
        const companyPlans = ['shop','proshop','enterprise'];
        const isCompany = companyPlans.includes(plan);
        const codeBase = Math.random().toString(36).substring(2,8).toUpperCase();
        const newCode = isCompany ? `CO-${codeBase}` : codeBase;

        // Insert profile using raw SQL via Supabase RPC to bypass REST API issues
        const insertResult = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
          method: 'POST',
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            id: uid, email,
            plan: plan || 'pro',
            trial_start: new Date().toISOString(),
            referral_code: newCode,
            subscription_status: 'pending_payment',
            company_id: isCompany ? uid : null,
            role: isCompany ? 'admin' : null
          })
        });
        console.log('Profile insert status:', insertResult.status, 'for', email);
        if (!insertResult.ok) {
          const errText = await insertResult.text();
          console.error('Profile insert failed:', errText);
        }

        // Create company row for company plan signups
        if (isCompany) {
          await fetch(`${process.env.SUPABASE_URL}/rest/v1/companies`, {
            method: 'POST',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              id: uid,
              name: email,
              plan: plan,
              admin_id: uid,
              spots_used: 1
            })
          });
        }

        // Process referral code if provided
        if (referral_code) {
          const referrerProfile = await sbFetch(`/profiles?referral_code=eq.${referral_code}&select=id,plan,referral_code`);
          const referrer = referrerProfile[0];

          if (referrer) {
            const planValues = {
              trial: 0, pro: 19.99,
              shop: 299, proshop: 599, enterprise: 999
            };
            const referrerValue = planValues[referrer.plan] || 0;
            const referredValue = planValues[plan] || 0;

            // Reward only if referred plan >= referrer plan
            const qualifies = referredValue >= referrerValue && referrerValue > 0;

            await sbFetch('/referral_rewards', {
              method: 'POST',
              body: JSON.stringify({
                referrer_id: referrer.id,
                referred_id: uid,
                referrer_plan: referrer.plan,
                referred_plan: plan || 'trial',
                reward_value: qualifies ? referrerValue : 0,
                status: qualifies ? 'pending' : 'ineligible',
                referrer_code: referral_code
              })
            });


          }
        }
      }

      // Send welcome email
      if (data.user || data.id) {
        sendEmail({
          to: email,
          subject: 'Welcome to MX-Logbook',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0d0d0d;color:#f0f0f0;padding:32px;border-radius:8px;">
              <div style="font-family:monospace;font-size:14px;color:#00e5a0;letter-spacing:3px;margin-bottom:24px;">MX-LOGBOOK</div>
              <h1 style="font-family:Arial,sans-serif;font-size:24px;font-weight:700;text-transform:uppercase;margin-bottom:12px;">You're in.</h1>
              <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:20px;">Your 3-day free trial has started. Generate your first logbook entry at <a href="https://mx-logbook.com" style="color:#00e5a0;">mx-logbook.com</a>.</p>
              <p style="font-size:13px;color:#555;line-height:1.8;">Your card will be charged after your trial ends on ${new Date(Date.now() + 3*24*60*60*1000).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}. Cancel anytime before then and you won't be charged.</p>
              <div style="margin-top:28px;padding-top:20px;border-top:1px solid #222;font-family:monospace;font-size:11px;color:#555;">
                Questions? Reply to this email or contact hello@mx-logbook.com
              </div>
            </div>
          `
        }).catch(() => {}); // Don't block signup if email fails
      }

      return res.status(200).json({ user: data.user || data, session: data.session });
    }

    if (type === 'password_reset') {
      const { email } = req.body;
      const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      if (r.ok) return res.status(200).json({ success: true });
      const err = await r.json();
      return res.status(400).json({ error: err.msg || err.message || 'Failed to send reset email.' });
    }

    if (type === 'password_update') {
      // Used when user clicks reset link from email (has access_token)
      const { password, access_token } = req.body;
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });
      if (r.ok) return res.status(200).json({ success: true });
      const err = await r.json();
      return res.status(400).json({ error: err.msg || err.message || 'Password update failed.' });
    }

    if (type === 'password_change') {
      // Used by logged-in user changing their password from dashboard
      const { email, password } = req.body;
      // Get user token via admin API
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      // Use admin update endpoint
      const profiles = await sbFetch(`/profiles?email=eq.${encodeURIComponent(email)}&select=id`);
      const uid = profiles[0]?.id;
      if (!uid) return res.status(400).json({ error: 'User not found.' });
      const update = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
        method: 'PUT',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });
      
      const err = await update.json();
      return res.status(400).json({ error: err.msg || err.message || 'Password change failed.' });
    }

    if (type === 'auth_login') {
      const { email, password } = req.body;
      const data = await sbAuth('/token?grant_type=password', { email, password });
      if (data.error) return res.status(400).json({ error: data.error.message || data.msg || 'Login failed' });
      // Fetch profile with retry
      let profile = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const profiles = await sbFetch(`/profiles?id=eq.${data.user?.id}&select=*`);
        profile = profiles[0];
        if (profile) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 800));
      }

      if (!profile) {
        return res.status(403).json({ error: 'No account found. Please sign up at mx-logbook.com.' });
      }

      // Check subscription status
      if (profile.subscription_status === 'pending_payment') {
  // Pass through as trialing - webhook will update within seconds
  return res.status(200).json({ user: data.user, session: data, profile: { ...profile, subscription_status: 'trialing' } });
}
      if (profile.plan === 'cancelled') {
        return res.status(403).json({ error: 'Your subscription has been cancelled. Please resubscribe at mx-logbook.com to regain access.' });
      }
      if (profile.subscription_status === 'past_due') {
        return res.status(403).json({ error: 'Your payment is past due. Please update your billing information to continue.' });
      }
      if (profile.subscription_status === 'unpaid') {
        return res.status(403).json({ error: 'Your account has been suspended due to a failed payment. Please update your billing information.' });
      }

      return res.status(200).json({ user: data.user, session: data, profile });
    }

    if (type === 'save_entry') {
      const { content, entry_type, tail_number, aircraft, session_id, company_id } = req.body;
      await sbFetch('/entries', {
        method: 'POST',
        body: JSON.stringify({ user_id, company_id: company_id || null, entry_type, tail_number, aircraft, content, session_id: session_id || null })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'get_entries') {
      const data = await sbFetch(`/entries?user_id=eq.${user_id}&order=created_at.desc&limit=100`);
      return res.status(200).json({ entries: Array.isArray(data) ? data : [] });
    }

    if (type === 'get_referrals') {
      const profiles = await sbFetch(`/profiles?id=eq.${user_id}&select=referral_code,plan`);
      const referrals = await sbFetch(`/referral_rewards?referrer_id=eq.${user_id}&select=*&order=created_at.desc`);
      return res.status(200).json({
        referral_code: profiles[0]?.referral_code,
        plan: profiles[0]?.plan,
        referrals: Array.isArray(referrals) ? referrals : []
      });
    }

    if (type === 'get_team') {
      const { company_id } = req.body;
      if (!company_id) return res.status(200).json({ team: [] });
      const team = await sbFetch(`/profiles?company_id=eq.${company_id}&select=id,email,role,created_at`);
      // Get entry counts per member
      const teamWithCounts = await Promise.all((Array.isArray(team) ? team : []).map(async m => {
        const entries = await sbFetch(`/entries?user_id=eq.${m.id}&select=id`);
        return { ...m, entry_count: Array.isArray(entries) ? entries.length : 0 };
      }));
      return res.status(200).json({ team: teamWithCounts });
    }

    if (type === 'invite_member') {
      const { company_id, email, role, plan } = req.body;
      if (!email) return res.status(400).json({ error: 'Missing required fields.' });
if (!company_id) return res.status(400).json({ error: 'Account setup is still in progress. Please log out, log back in, and try again.' });

      // Check seat limit
      const planSeats = { shop: 5, proshop: 10, enterprise: 25 };
      const seats = planSeats[plan] || 5;
      const existing = await sbFetch(`/profiles?company_id=eq.${company_id}&select=id`);
      const companyRow = await fetch(`${process.env.SUPABASE_URL}/rest/v1/companies?id=eq.${company_id}&select=admin_id`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      }).then(r => r.json());
      const adminId = companyRow[0]?.admin_id;
      const nonAdminCount = Array.isArray(existing) ? existing.filter(p => p.id !== adminId).length : 0;
      if (nonAdminCount >= seats) {
        return res.status(400).json({ error: `Seat limit reached (${seats} for ${plan} plan).` });
      }

      // Check if already on a team
      const existingUser = await sbFetch(`/profiles?email=eq.${encodeURIComponent(email)}&select=id,company_id`);
      if (existingUser[0]?.company_id) {
        return res.status(400).json({ error: 'This user is already on a team.' });
      }

      // Expire any existing pending invites for this email+company (ignore errors)
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/mechanic_invites?invited_email=eq.${encodeURIComponent(email)}&company_id=eq.${company_id}&status=eq.pending`, {
          method: 'PATCH',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'expired' })
        });
      } catch(e) {}

      // Create invite record
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
      const inviteResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/mechanic_invites`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ company_id, invited_email: email, role: role || 'mechanic', invited_by: user_id, expires_at: expiresAt, status: 'pending' })
      });
      const inviteRaw = await inviteResp.text();
      let invite = null;
      try {
        const parsed = JSON.parse(inviteRaw);
        invite = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch(e) {}
      if (!invite?.token) {
        console.error('mechanic_invites insert failed:', inviteRaw);
        return res.status(500).json({ error: 'Could not create invite.' });
      }

      // Get company name for email
      const companyResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/companies?id=eq.${company_id}&select=name`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      const companyRows = await companyResp.json();
      const companyName = companyRows[0]?.name || 'your team';

      const inviteUrl = `https://mx-logbook.com/invite.html?token=${invite.token}`;
      const roleLabels = { mechanic: 'Mechanic', lead: 'Lead Mechanic', inspector: 'Inspector / IA', admin: 'Admin' };

      await sendEmail({
        to: email,
        subject: `You've been invited to join ${companyName} on MX-Logbook`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0d0d0d;color:#f0f0f0;padding:32px;border-radius:8px;">
            <div style="font-family:monospace;font-size:14px;color:#00e5a0;letter-spacing:3px;margin-bottom:24px;">MX-LOGBOOK</div>
            <h1 style="font-size:22px;font-weight:700;text-transform:uppercase;margin-bottom:12px;">You've been invited.</h1>
            <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:8px;">You've been invited to join <strong style="color:#fff;">${companyName}</strong> on MX-Logbook as a <strong style="color:#fff;">${roleLabels[role] || role}</strong>.</p>
            <p style="font-size:13px;color:#666;line-height:1.8;margin-bottom:24px;">This invite expires in 72 hours.</p>
            <a href="${inviteUrl}" style="display:inline-block;background:#00e5a0;color:#0a0a0a;font-family:monospace;font-size:13px;padding:14px 28px;border-radius:4px;text-decoration:none;font-weight:600;letter-spacing:1px;">ACCEPT INVITE</a>
            <p style="font-size:12px;color:#444;line-height:1.8;margin-top:20px;">Or copy this link: <span style="color:#00e5a0;">${inviteUrl}</span></p>
            <div style="margin-top:28px;padding-top:20px;border-top:1px solid #222;font-family:monospace;font-size:11px;color:#555;">
              Questions? Contact hello@mx-logbook.com
            </div>
          </div>
        `
      }).catch(() => {});

      return res.status(200).json({ success: true });
    }

    if (type === 'get_invite') {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: 'Missing token.' });
      const inviteResp1 = await fetch(`${process.env.SUPABASE_URL}/rest/v1/mechanic_invites?token=eq.${token}&select=*`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      const invites = await inviteResp1.json();
      const invite = Array.isArray(invites) ? invites[0] : null;
      if (!invite) return res.status(400).json({ error: 'Invite not found.' });
      if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite has already been used or has expired.' });
      if (new Date(invite.expires_at) < new Date()) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/mechanic_invites?token=eq.${token}`, {
          method: 'PATCH',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'expired' })
        });
        return res.status(400).json({ error: 'This invite has expired. Please ask your admin to send a new invite.' });
      }
      const companyResp2 = await fetch(`${process.env.SUPABASE_URL}/rest/v1/companies?id=eq.${invite.company_id}&select=name,plan`, {         headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }       });       const companyRows = await companyResp2.json();
      const company = companyRows[0] || {};
      return res.status(200).json({ invite: { ...invite, company_name: company.name || '', company_plan: company.plan || '' } });
    }

    if (type === 'accept_invite') {
      const { token, password } = req.body;
      if (!token || !password) return res.status(400).json({ error: 'Missing required fields.' });

      // Validate invite
      const inviteResp2 = await fetch(`${process.env.SUPABASE_URL}/rest/v1/mechanic_invites?token=eq.${token}&select=*`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      const invites = await inviteResp2.json();
      const invite = Array.isArray(invites) ? invites[0] : null;
      if (!invite) return res.status(400).json({ error: 'Invite not found.' });
      if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite has already been used or expired.' });
      if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired.' });

      const email = invite.invited_email;

      // Check if user already exists in auth
      const existingProfile = await sbFetch(`/profiles?email=eq.${encodeURIComponent(email)}&select=id,company_id`);
      let uid;

      if (existingProfile[0]) {
        // User exists — just update their company and role
        uid = existingProfile[0].id;
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, {
          method: 'PATCH',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ company_id: invite.company_id, role: invite.role })
        });
      } else {
        // Create new auth user
        const signupData = await sbAuth('/signup', { email, password });
        if (signupData.error) return res.status(400).json({ error: signupData.error.message || 'Could not create account.' });
        uid = signupData.user?.id || signupData.id;
        if (!uid) return res.status(500).json({ error: 'Could not create account.' });

        // Create profile
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles`, {
          method: 'POST',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            id: uid, email,
            plan: 'mechanic',
            company_id: invite.company_id,
            role: invite.role || 'mechanic',
            referral_code: code,
            subscription_status: 'active',
            trial_start: new Date().toISOString()
          })
        });
      }

      // Mark invite as accepted
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/mechanic_invites?token=eq.${token}`, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'accepted', accepted_at: new Date().toISOString() })
      });

      // Log in the new user
      const loginData = await sbAuth('/token?grant_type=password', { email, password });
      if (loginData.error) return res.status(200).json({ success: true, message: 'Account created. Please log in at mx-logbook.com.' });

      return res.status(200).json({ success: true, user: loginData.user, session: loginData, email, role: invite.role, company_id: invite.company_id });
    }

    if (type === 'update_member_role') {
      const { member_id, role } = req.body;
      await sbFetch(`/profiles?id=eq.${member_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'remove_member') {
      const { member_id, company_id } = req.body;
      await sbFetch(`/profiles?id=eq.${member_id}&company_id=eq.${company_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ company_id: null, role: 'mechanic' })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'save_feedback') {
      const { email, plan, reason, comment } = req.body;
      await sbFetch('/cancellation_feedback', {
        method: 'POST',
        body: JSON.stringify({ user_id: user_id || null, email, plan, reason, comment })
      });
      await sendEmail({
        to: 'hello@mx-logbook.com',
        subject: `Cancellation: ${email} (${plan})`,
        html: `
          <div style="font-family:monospace;max-width:560px;margin:0 auto;padding:24px;background:#0d0d0d;color:#f0f0f0;border-radius:8px;border:1px solid #333;">
            <div style="color:#00e5a0;font-size:13px;letter-spacing:2px;margin-bottom:16px;">MX-LOGBOOK CANCELLATION</div>
            <p style="margin-bottom:8px;"><strong>Email:</strong> ${email}</p>
            <p style="margin-bottom:8px;"><strong>Plan:</strong> ${plan}</p>
            <p style="margin-bottom:8px;"><strong>Reason:</strong> ${reason}</p>
            <p style="margin-bottom:8px;"><strong>Comment:</strong> ${comment || 'None'}</p>
            <p style="color:#555;font-size:11px;margin-top:16px;">${new Date().toISOString()}</p>
          </div>
        `
      }).catch(() => {});
      return res.status(200).json({ success: true });
    }

    if (type === 'create_portal_session') {
      const { customer_email } = req.body;
      const searchResp = await fetch(`https://api.stripe.com/v1/customers/search?query=email:"${customer_email}"`, {
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
      });
      const searchData = await searchResp.json();
      const customer = searchData.data?.[0];

      // No Stripe customer yet - they're on a free trial that hasn't been charged
      // Just cancel in Supabase directly and send them a confirmation
      if (!customer) {
        await sbFetch(`/profiles?email=eq.${encodeURIComponent(customer_email)}`, {
          method: 'PATCH',
          body: JSON.stringify({ plan: 'cancelled', cancelled_at: new Date().toISOString(), subscription_status: 'cancelled' })
        });
        await sendEmail({
          to: customer_email,
          subject: 'Your MX-Logbook trial has been cancelled',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0d0d0d;color:#f0f0f0;padding:32px;border-radius:8px;">
              <div style="font-family:monospace;font-size:14px;color:#00e5a0;letter-spacing:3px;margin-bottom:24px;">MX-LOGBOOK</div>
              <h1 style="font-size:22px;font-weight:700;text-transform:uppercase;margin-bottom:12px;">Trial cancelled.</h1>
              <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:20px;">Your free trial has been cancelled. You will not be charged. Your account will remain active until your trial period ends.</p>
              <p style="font-size:13px;color:#555;line-height:1.8;">If you change your mind, you can resubscribe anytime at <a href="https://mx-logbook.com" style="color:#00e5a0;">mx-logbook.com</a>.</p>
            </div>
          `
        }).catch(() => {});
        return res.status(200).json({ cancelled: true, message: 'Your trial has been cancelled. You will not be charged.' });
      }

      const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ 'customer': customer.id, 'return_url': 'https://mx-logbook.com' }).toString()
      });
      const session = await portalResp.json();
      if (session.error) return res.status(400).json({ error: session.error.message });
      return res.status(200).json({ url: session.url });
    }

    if (type === 'save_tech_info') {
      const { tech_name, cert_num } = req.body;
      const full_name = tech_name;
      const cert_number = cert_num;
      if (!user_id) return res.status(400).json({ error: 'Not logged in.' });
      await sbFetch(`/profiles?id=eq.${user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ full_name: full_name || null, cert_number: cert_number || null })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'save_aircraft') {
      const { tail_number, aircraft_model } = req.body;
      if (!user_id || !tail_number) return res.status(400).json({ error: 'Missing required fields.' });
      // Upsert -- update if tail exists for this user, insert if not
      const existing = await sbFetch(`/user_aircraft?user_id=eq.${user_id}&tail_number=eq.${encodeURIComponent(tail_number)}&select=id`);
      if (existing?.length) {
        await sbFetch(`/user_aircraft?user_id=eq.${user_id}&tail_number=eq.${encodeURIComponent(tail_number)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ aircraft_model: aircraft_model || null, last_used: new Date().toISOString() })
        });
      } else {
        await sbFetch('/user_aircraft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id, tail_number, aircraft_model: aircraft_model || null, last_used: new Date().toISOString() })
        });
      }
      return res.status(200).json({ success: true });
    }

    if (type === 'get_aircraft') {
      if (!user_id) return res.status(200).json({ aircraft: [] });
      const rows = await sbFetch(`/user_aircraft?user_id=eq.${user_id}&order=last_used.desc&select=tail_number,aircraft_model,last_used`);
      return res.status(200).json({ aircraft: rows || [] });
    }

    if (type === 'check_access') {
      const { email } = req.body;
      if (!user_id && !email) return res.status(200).json({ blocked: false });
      let profilesResp;
      if (user_id) {
        profilesResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}&select=plan,subscription_status,cancelled_at,created_at,full_name,cert_number,company_id,role`, {
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
        });
      } else {
        profilesResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=plan,subscription_status,cancelled_at,created_at,full_name,cert_number,company_id,role`, {
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
        });
      }
      const profiles = await profilesResp.json();
      const profile = Array.isArray(profiles) ? profiles[0] : null;

      // No profile found - account was deleted or never created
      if (!profile) {
        return res.status(200).json({ blocked: true, message: 'Account not found. Please sign up again at mx-logbook.com.' });
      }

      if (profile.subscription_status === 'pending_payment') {
  const createdAt = profile.created_at ? new Date(profile.created_at).getTime() : 0;
  const ageSeconds = (Date.now() - createdAt) / 1000;
  if (ageSeconds < 30) {
    return res.status(200).json({ blocked: false, plan: profile.plan, subscription_status: 'trialing', tech_name: profile.full_name || null, cert_num: profile.cert_number || null, role: profile.role || null });
  }
  return res.status(200).json({ blocked: true, message: 'Payment not completed. Please complete your signup at mx-logbook.com to activate your account.' });
}
      if (profile.plan === 'cancelled') {
        return res.status(200).json({ blocked: true, message: 'Your subscription has been cancelled. Please resubscribe at mx-logbook.com to continue.' });
      }
      if (profile.plan === 'company_cancelled') {
        return res.status(200).json({ blocked: true, message: 'Access denied. Please contact your company\'s administrator.' });
      }
      if (profile.subscription_status === 'past_due') {
        return res.status(200).json({ blocked: true, message: 'Your payment is past due. Please update your billing information to continue.' });
      }
      if (profile.subscription_status === 'unpaid') {
        return res.status(200).json({ blocked: true, message: 'Your account has been suspended due to a failed payment. Please update your billing information.' });
      }

      return res.status(200).json({ blocked: false, plan: profile.plan, subscription_status: profile.subscription_status || null, tech_name: profile.full_name || null, cert_num: profile.cert_number || null, company_id: profile.company_id || null, role: profile.role || null });
    }

    if (type === 'send_alert') {
      // Internal error alert - sends to you only
      const { subject, message, error_data } = req.body;
      await sendEmail({
        to: 'hello@mx-logbook.com',
        subject: `[MX-Logbook Alert] ${subject || 'Site Error'}`,
        html: `
          <div style="font-family:monospace;max-width:560px;margin:0 auto;padding:24px;background:#1a0000;color:#f0f0f0;border-radius:8px;border:1px solid #ff4444;">
            <div style="color:#ff4444;font-size:14px;letter-spacing:2px;margin-bottom:16px;">⚠ MX-LOGBOOK ALERT</div>
            <h2 style="font-size:18px;margin-bottom:12px;">${subject || 'Site Error'}</h2>
            <p style="color:#ccc;line-height:1.8;margin-bottom:16px;">${message || 'An error occurred.'}</p>
            ${error_data ? `<pre style="background:#000;padding:12px;border-radius:4px;font-size:11px;color:#ff8888;overflow:auto;">${JSON.stringify(error_data, null, 2)}</pre>` : ''}
            <p style="color:#666;font-size:11px;margin-top:16px;">Time: ${new Date().toISOString()}</p>
          </div>
        `
      });
      return res.status(200).json({ success: true });
    }


    if (type === 'change_plan') {
      const { customer_email, new_price_id, current_plan, new_plan } = req.body;

      // Find Stripe customer
      const searchResp = await fetch(`https://api.stripe.com/v1/customers/search?query=email:"${customer_email}"`, {
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
      });
      const searchData = await searchResp.json();
      const customer = searchData.data?.[0];
      // No Stripe customer - promo code account, just update Supabase directly
      if (!customer) {
        await sbFetch(`/profiles?email=eq.${encodeURIComponent(customer_email)}`, {
          method: 'PATCH',
          body: JSON.stringify({ plan: new_plan })
        });
        return res.status(200).json({ success: true, new_plan });
      }

      // Get active subscription
      const subsResp = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=1`, {
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
      });
      const subsData = await subsResp.json();
      // Also check trialing
      const trialResp = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=trialing&limit=1`, {
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
      });
      const trialData = await trialResp.json();
      const subscription = subsData.data?.[0] || trialData.data?.[0];
      if (!subscription) return res.status(400).json({ error: 'No active subscription found. Please contact hello@mx-logbook.com.' });

      const subscriptionItemId = subscription.items.data[0]?.id;
      if (!subscriptionItemId) return res.status(400).json({ error: 'Could not find subscription item.' });

      // Switch to new founding rate price
      const updateResp = await fetch(`https://api.stripe.com/v1/subscriptions/${subscription.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          'items[0][id]': subscriptionItemId,
          'items[0][price]': new_price_id,
          'proration_behavior': 'always_invoice',
          'billing_cycle_anchor': 'unchanged'
        }).toString()
      });
      const updateData = await updateResp.json();
      if (updateData.error) return res.status(400).json({ error: updateData.error.message });

      // Update plan in Supabase
      await sbFetch(`/profiles?email=eq.${encodeURIComponent(customer_email)}`, {
        method: 'PATCH',
        body: JSON.stringify({ plan: new_plan })
      });

      // Send confirmation email
      const planLabels = { pro:'Pro ($19.99/mo)', shop:'Shop ($299/mo)', proshop:'Shop Pro ($599/mo)', enterprise:'Enterprise ($999/mo)' };
      await sendEmail({
        to: customer_email,
        subject: 'Your MX-Logbook plan has been updated',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0d0d0d;color:#f0f0f0;padding:32px;border-radius:8px;">
            <div style="font-family:monospace;font-size:14px;color:#00e5a0;letter-spacing:3px;margin-bottom:24px;">MX-LOGBOOK</div>
            <h1 style="font-size:22px;font-weight:700;text-transform:uppercase;margin-bottom:12px;">Plan updated.</h1>
            <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:20px;">You have switched to the <strong style="color:#fff;">${planLabels[new_plan] || new_plan}</strong> plan at the founding rate. This rate is locked in for as long as your account remains active.</p>
            <a href="https://mx-logbook.com" style="display:inline-block;background:#00e5a0;color:#0a0a0a;font-family:monospace;font-size:13px;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:600;">Go to MX-Logbook</a>
          </div>
        `
      }).catch(() => {});

      return res.status(200).json({ success: true, new_plan });
    }


    if (type === 'save_running_report') {
      const { user_id, report_id, tail_number, aircraft, entries, status } = req.body;
      if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
      if (report_id) {
        // Update existing report
        const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?id=eq.${report_id}&user_id=eq.${user_id}`, {
          method: 'PATCH',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ entries: JSON.stringify(entries), status: status || 'active', updated_at: new Date().toISOString() })
        });
        const updated = await patchResp.json();
        return res.status(200).json({ report: Array.isArray(updated) ? updated[0] : updated });
      } else {
        // Create new report
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        const created = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports`, {
          method: 'POST',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ user_id, tail_number: tail_number || '', aircraft: aircraft || '', entries: JSON.stringify(entries || []), status: 'active', is_saved: false, expires_at: expiresAt })
        });
        const data = await created.json();
        return res.status(200).json({ report: Array.isArray(data) ? data[0] : data });
      }
    }
if (type === 'release_running_report') {
      const { report_id } = req.body;
      if (!user_id || !report_id) return res.status(400).json({ error: 'Missing params.' });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?id=eq.${report_id}&user_id=eq.${user_id}`, {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ status: 'released', is_saved: true, expires_at: null, released_at: new Date().toISOString() })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'get_released_reports') {
      if (!user_id) return res.status(200).json({ reports: [] });
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?user_id=eq.${user_id}&status=eq.released&order=released_at.desc&limit=100&select=id,tail_number,aircraft,entries,released_at,updated_at`, {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
        }
      });
      const reports = await resp.json();
      return res.status(200).json({ reports: Array.isArray(reports) ? reports : [] });
    }
    if (type === 'get_running_reports') {
      const { user_id } = req.body;
      if (!user_id) return res.status(200).json({ reports: [] });
      const now = new Date().toISOString();
      // Get all reports -- both saved and unexpired unsaved
      const reports = await sbFetch(`/running_reports?user_id=eq.${user_id}&status=neq.released&order=updated_at.desc&select=id,tail_number,aircraft,status,created_at,updated_at,entries,is_saved,expires_at,aog_session_id`);
      const filtered = Array.isArray(reports) ? reports.filter(r => r.is_saved || !r.expires_at || r.expires_at > now) : [];
      return res.status(200).json({ reports: filtered });
    }

    if (type === 'save_report_permanent') {
      const { report_id } = req.body;
      if (!user_id || !report_id) return res.status(400).json({ error: 'Missing params.' });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?id=eq.${report_id}&user_id=eq.${user_id}`, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ is_saved: true, expires_at: null, status: 'saved' })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'delete_entry') {
      const { entry_id } = req.body;
      if (!user_id || !entry_id) return res.status(400).json({ error: 'Missing params.' });
      await sbFetch(`/entries?id=eq.${entry_id}&user_id=eq.${user_id}`, {
        method: 'DELETE',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'delete_running_report') {
      const { user_id, report_id } = req.body;
      if (!user_id || !report_id) return res.status(400).json({ error: 'Missing params' });
      await sbFetch(`/running_reports?id=eq.${report_id}&user_id=eq.${user_id}`, {
        method: 'DELETE',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'get_founding_spots') {
      // Count how many accounts are on each company plan
      const MAX_SPOTS = 10;
      const plans = ['shop','proshop','enterprise'];
      const spots = {};
      await Promise.all(plans.map(async plan => {
        const rows = await sbFetch(`/profiles?plan=eq.${plan}&select=id`);
        const used = Array.isArray(rows) ? rows.length : 0;
        spots[plan] = Math.max(0, MAX_SPOTS - used);
      }));
      return res.status(200).json({ spots });
    }

    if (type === 'get_company_records') {
      const { company_id } = req.body;
      if (!company_id) return res.status(200).json({ records: [] });

      const svcHeaders = {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      };

      // Get all team member IDs + emails for this company
      const teamResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?company_id=eq.${company_id}&select=id,email`, { headers: svcHeaders });
      const team = await teamResp.json().catch(() => []);
      const memberMap = {};
      (Array.isArray(team) ? team : []).forEach(m => { memberMap[m.id] = m.email; });
      const ids = Object.keys(memberMap);
      if (!ids.length) return res.status(200).json({ records: [] });

      // 1. Individual entries for all team members
      const entriesResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/entries?user_id=in.(${ids.join(',')})&order=created_at.desc&limit=200`, { headers: svcHeaders });
      const entriesRaw = await entriesResp.json().catch(() => []);
      const entries = (Array.isArray(entriesRaw) ? entriesRaw : []).map(e => ({
        ...e,
        _type: 'entry',
        mechanic_email: memberMap[e.user_id] || ''
      }));

      // 2. Saved running reports for all team members
      const runningResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?user_id=in.(${ids.join(',')})&is_saved=eq.true&order=updated_at.desc&limit=200&select=id,tail_number,aircraft,status,created_at,updated_at,entries,user_id`, { headers: svcHeaders });
      const runningRaw = await runningResp.json().catch(() => []);
      const running = (Array.isArray(runningRaw) ? runningRaw : []).map(r => ({
        ...r,
        _type: 'running',
        mechanic_email: memberMap[r.user_id] || ''
      }));

      // 3. Closed AOG sessions for this company
      const aogResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?company_id=eq.${company_id}&status=eq.closed&order=updated_at.desc&limit=200&select=id,tail_number,aircraft,status,created_at,updated_at,closed_at,entries,created_by`, { headers: svcHeaders });
      const aogRaw = await aogResp.json().catch(() => []);
      const aog = (Array.isArray(aogRaw) ? aogRaw : []).map(s => ({
        ...s,
        _type: 'aog',
        mechanic_email: memberMap[s.created_by] || ''
      }));

      // Merge all, sort newest first
      const all = [...entries, ...running, ...aog].sort((a, b) =>
        new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)
      );
      return res.status(200).json({ records: all });
    }

    if (type === 'get_company_plan') {
      const { company_id } = req.body;
      if (!company_id) return res.status(200).json({ plan: null, name: null });
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/companies?id=eq.${company_id}&select=plan,name`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      const data = await resp.json();
      return res.status(200).json({ plan: data[0]?.plan || null, name: data[0]?.name || null });
    }

    if (type === 'update_company_name') {
      const { company_id, name } = req.body;
      if (!company_id || !name) return res.status(400).json({ error: 'Missing required fields.' });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/companies?id=eq.${company_id}`, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ name })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'get_company_aog') {
      const { company_id } = req.body;
      if (!company_id) return res.status(200).json({ sessions: [] });
      const team = await sbFetch(`/profiles?company_id=eq.${company_id}&select=id,email`);
      const memberMap = {};
      (Array.isArray(team) ? team : []).forEach(m => { memberMap[m.id] = m.email; });
      const sessionsResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?company_id=eq.${company_id}&status=eq.active&order=created_at.desc&limit=50`, {   headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } }); const sessions = await sessionsResp.json();
      const enriched = (Array.isArray(sessions) ? sessions : []).map(s => {
        const entries = (() => { try { return JSON.parse(s.entries || '[]'); } catch(e) { return []; } })();
        const enrichedEntries = entries.map(e => ({
          ...e,
          user_email: memberMap[e.user_id] || ''
        }));
        return {
          ...s,
          mechanic_email: memberMap[s.created_by] || '',
          entries: JSON.stringify(enrichedEntries)
        };
      });
      return res.status(200).json({ sessions: enriched });
    }

    if (type === 'get_or_create_profile') {
      const { email, plan } = req.body;
      const existing = await sbFetch(`/profiles?id=eq.${user_id}&select=*`);
      if (existing[0]) return res.status(200).json({ profile: existing[0] });
      const code = Math.random().toString(36).substring(2,8).toUpperCase();
      const created = await sbFetch('/profiles', {
        method: 'POST',
        body: JSON.stringify({ id: user_id, email, plan: plan || 'trial', trial_start: new Date().toISOString(), referral_code: code, subscription_status: 'pending_payment' })
      });
      return res.status(200).json({ profile: created[0] });
    }

    if (type === 'create_aog_session') {
      const { company_id, tail_number, aircraft } = req.body;
      if (!user_id) return res.status(200).json({ error: 'Missing user_id' });
      const created = await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions`, {
        method: 'POST',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ created_by: user_id, company_id: company_id || null, tail_number: tail_number || null, aircraft: aircraft || null, entries: '[]', status: 'active' })
      });
      const data = await created.json();
      return res.status(200).json({ session: Array.isArray(data) ? data[0] : data });
    }

    if (type === 'add_aog_entry') {
      const { session_id, entry_text, tech_name, cert_num, time } = req.body;
      if (!session_id || !entry_text) return res.status(200).json({ error: 'Missing required fields' });
     const existingResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?id=eq.${session_id}&select=entries`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      const existing = await existingResp.json();
      const current = Array.isArray(existing) ? existing[0] : existing;
      const entries = (() => { try { return JSON.parse(current?.entries || '[]'); } catch(e) { return []; } })();
      const now = new Date();
      entries.push({
        user_id,
        tech_name: tech_name || null,
        cert_num: cert_num || null,
        text: entry_text,
        time: time || null,
        created_at: now.toISOString()
      });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?id=eq.${session_id}`, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ entries: JSON.stringify(entries), updated_at: now.toISOString() })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'close_aog_session') {
      const { session_id } = req.body;
      if (!session_id) return res.status(200).json({ error: 'Missing session_id' });
      const svcHeaders = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
      // Close the AOG session
      const closedAt = new Date().toISOString();
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?id=eq.${session_id}`, {
        method: 'PATCH',
        headers: { ...svcHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({ status: 'closed', closed_at: closedAt, updated_at: closedAt })
      });
      // Fetch the AOG session to get its entries, tail number, and aircraft
      const aogResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?id=eq.${session_id}&select=entries,tail_number,aircraft,company_id`, { headers: svcHeaders });
      const aogData = await aogResp.json();
      const aog = aogData?.[0];
      if (aog && user_id) {
        // Create a running report carrying over the AOG entries
        const aogNote = { time: closedAt.substring(11,16).replace(':','')+'Z', initials: 'AOG', text: `AOG session resolved at ${closedAt.substring(11,16)}Z. Aircraft may require additional work before release.`, type: 'AOG Report', raw: true };
        const entries = (() => { try { return JSON.parse(aog.entries || '[]'); } catch(e) { return []; } })();
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports`, {
          method: 'POST',
          headers: { ...svcHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            user_id,
            tail_number: aog.tail_number,
            aircraft: aog.aircraft,
            entries: JSON.stringify([...entries, aogNote]),
            status: 'active',
            is_saved: true,
            expires_at: null,
            aog_session_id: session_id,
            created_at: closedAt,
            updated_at: closedAt
          })
        });
      }
      return res.status(200).json({ success: true });
    }
if (type === 'update_aog_entries') {
      const { session_id, entries } = req.body;
      if (!session_id) return res.status(200).json({ error: 'Missing session_id' });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?id=eq.${session_id}`, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ entries: JSON.stringify(entries), updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ success: true });
    }
    if (type === 'check_turnover_access') {
      const { company_id } = req.body;
      if (!company_id) return res.status(200).json({ allowed: false });
      const profileResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}&select=plan,role`, {
        headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
      });
      const profiles = await profileResp.json();
      const profile = profiles?.[0];
      if (!profile) return res.status(200).json({ allowed: false });
      const allowedPlans = ['proshop', 'enterprise', 'mechanic', 'lead', 'inspector', 'admin'];
      // For invited members, check their company owner's plan
      if (['mechanic','lead','inspector','admin'].includes(profile.plan)) {
        const ownerResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?company_id=eq.${company_id}&select=plan&order=created_at.asc&limit=1`, {
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }
        });
        const owners = await ownerResp.json();
        const ownerPlan = owners?.[0]?.plan;
        const allowed = ['proshop','enterprise'].includes(ownerPlan);
        return res.status(200).json({ allowed, plan: profile.plan, role: profile.role || null });
      }
      const allowed = ['proshop','enterprise'].includes(profile.plan);
      return res.status(200).json({ allowed, plan: profile.plan, role: profile.role || null });
    }

    if (type === 'get_turnover_reports') {
      const { company_id } = req.body;
      if (!company_id) return res.status(200).json({ reports: [] });
      const svcH = { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/turnover_reports?company_id=eq.${company_id}&order=created_at.desc&limit=20`, { headers: svcH });
      const reports = await resp.json();
      let releasedTails = [];
      try {
        const teamResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?company_id=eq.${company_id}&select=id`, { headers: svcH });
        const team = await teamResp.json();
        const ids = (Array.isArray(team) ? team : []).map(m => m.id);
        if (ids.length) {
          const rrResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?user_id=in.(${ids.join(',')})&status=eq.released&select=tail_number`, { headers: svcH });
          const rr = await rrResp.json();
          releasedTails = [...new Set((Array.isArray(rr) ? rr : []).map(r => r.tail_number).filter(Boolean))];
        }
      } catch(e) {
        console.log('get_turnover_reports: released tails fetch failed:', e.message);
      }
      return res.status(200).json({ reports: Array.isArray(reports) ? reports : [], releasedTails });
    }

    if (type === 'update_turnover_item') {
      const { report_id, company_id, items } = req.body;
      if (!report_id || !company_id) return res.status(400).json({ error: 'Missing fields.' });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/turnover_reports?id=eq.${report_id}&company_id=eq.${company_id}`, {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ items, updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'generate_turnover') {
      const { company_id, shift, lead_notes } = req.body;
      if (!company_id || !shift) return res.status(400).json({ error: 'Missing required fields.' });

      const svcHeaders = {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      };

      // Get last turnover report timestamp
      const lastResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/turnover_reports?company_id=eq.${company_id}&order=created_at.desc&limit=1&select=created_at`, {
        headers: svcHeaders
      });
      const lastReports = await lastResp.json().catch(() => []);
      const lastCreated = lastReports?.[0]?.created_at || new Date(new Date().setUTCHours(0,0,0,0)).toISOString();
      const sinceClause = `&created_at=gt.${encodeURIComponent(lastCreated)}`;

      // Get all team member IDs for this company
      const teamResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?company_id=eq.${company_id}&select=id,email`, { headers: svcHeaders });
      const team = await teamResp.json();
      const memberMap = {};
      (Array.isArray(team) ? team : []).forEach(m => { memberMap[m.id] = m.email; });
      const ids = Object.keys(memberMap);
      
      let entriesText = '';
      let newEntriesCount = 0;

      if (ids.length) {
        // Get entries since last turnover
        const entriesResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/entries?user_id=in.(${ids.join(',')})${sinceClause}&order=created_at.desc&limit=100`, { headers: svcHeaders });
        const entries = await entriesResp.json().catch(() => []);
        newEntriesCount = Array.isArray(entries) ? entries.length : 0;
        if (newEntriesCount > 0) {
          entriesText = entries.map(e => `[${e.entry_type||'Entry'}] ${memberMap[e.user_id]||''} — ${e.tail_number||''}: ${e.content||''}`).join('\n');
        }

        // Get active AOG sessions
        const aogResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?company_id=eq.${company_id}&status=eq.active&select=id,tail_number,aircraft,created_at`, { headers: svcHeaders });
        const aogSessions = await aogResp.json().catch(() => []);
        const aogItems = (Array.isArray(aogSessions) ? aogSessions : []).map(s => ({
          id: s.id,
          title: `AOG — ${s.tail_number||'Unknown'}${s.aircraft ? ' · ' + s.aircraft : ''}`,
          category: 'aog',
          tag: 'aog',
          checked: false,
          notes: `Active since ${s.created_at ? new Date(s.created_at).toLocaleDateString() : 'unknown'}`
        }));

        // Get active running reports (always include, no time filter)
        const activeRunningResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?user_id=in.(${ids.join(',')})&status=eq.active&order=updated_at.desc&limit=50&select=id,tail_number,aircraft,entries,user_id,is_saved,status,released_at`, { headers: svcHeaders });
        const activeRunning = await activeRunningResp.json().catch(() => []);

        // Get released running reports since last turnover only
        const releasedClause = `&released_at=gt.${encodeURIComponent(lastCreated)}`;
        const releasedRunningResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports?user_id=in.(${ids.join(',')})&status=eq.released${releasedClause}&order=released_at.desc&limit=50&select=id,tail_number,aircraft,entries,user_id,is_saved,status,released_at`, { headers: svcHeaders });
        const releasedRunning = await releasedRunningResp.json().catch(() => []);         console.log('releasedRunning:', JSON.stringify(releasedRunning));

        const runningRaw = [...(Array.isArray(activeRunning) ? activeRunning : []), ...(Array.isArray(releasedRunning) ? releasedRunning : [])];

        // Fetch AOG closed_at for any reports that came from an AOG session
        const aogSessionIds = runningRaw.filter(r => r.aog_session_id).map(r => r.aog_session_id);
        const aogClosedAtMap = {};
        if (aogSessionIds.length > 0) {
          const aogResp2 = await fetch(`${process.env.SUPABASE_URL}/rest/v1/aog_sessions?id=in.(${aogSessionIds.join(',')})&select=id,closed_at`, { headers: svcHeaders });
          const aogData2 = await aogResp2.json().catch(() => []);
          (Array.isArray(aogData2) ? aogData2 : []).forEach(a => { aogClosedAtMap[a.id] = a.closed_at; });
        }

        // Split released and active reports — handle separately
        const activeReports = runningRaw.filter(r => r.status !== 'released');
        const releasedReports = runningRaw.filter(r => r.status === 'released');

        // Active reports — split entries by AOG closed_at if applicable
        // Entries before AOG closed_at → completed, entries after → in progress (sent to Claude)
        const forcedCompletedFromActive = [];
        const activeRunningText = activeReports.map(r => {
          const rEntries = (() => { try { return JSON.parse(r.entries || '[]'); } catch(e) { return []; } })();
          const aogClosedAt = r.aog_session_id ? aogClosedAtMap[r.aog_session_id] : null;
          if (aogClosedAt) {
            const cutoff = new Date(aogClosedAt);
            const beforeAOG = rEntries.filter(e => e.created_at && new Date(e.created_at) <= cutoff);
            const afterAOG = rEntries.filter(e => !e.created_at || new Date(e.created_at) > cutoff);
            // Force pre-AOG entries to completed
            beforeAOG.filter(e => e.text || e.content).forEach((e, i) => {
              forcedCompletedFromActive.push({
                id: `aog_${r.id}_${i}`,
                title: `${r.tail_number||'Unknown'} - ${(e.text || e.content || '')}`,
                category: 'completed',
                tag: null,
                notes: 'AOG work completed',
                checked: false
              });
            });
            // Post-AOG entries go to Claude
            const postAOGText = afterAOG.map(e => e.content || e.text || '').filter(Boolean).join(' | ');
            return postAOGText ? `[Running Report - Active/In Progress] ${memberMap[r.user_id]||''} — ${r.tail_number||''}: ${postAOGText}` : null;
          }
          return `[Running Report - Active/In Progress] ${memberMap[r.user_id]||''} — ${r.tail_number||''}: ${rEntries.map(e => e.content || e.text || '').filter(Boolean).join(' | ')}`;
        }).filter(Boolean).join('\n');
        if (activeRunningText) entriesText = entriesText ? entriesText + '\n' + activeRunningText : activeRunningText;

        // Released reports — only entries from this shift (after lastCreated) are forced to completed
        const forcedCompletedItems = [
          ...forcedCompletedFromActive,
          ...releasedReports.flatMap(r => {
            const rEntries = (() => { try { return JSON.parse(r.entries || '[]'); } catch(e) { return []; } })();
            const cutoff = new Date(lastCreated);
            const releasedAt = r.released_at ? new Date(r.released_at) : null;
            const shiftEntries = rEntries.filter(e => {
              if (!e.text && !e.content) return false;
              const entryTime = e.created_at ? new Date(e.created_at) : null;
              if (!entryTime) return true;
              const afterLastTurnover = entryTime > cutoff;
              const beforeOrAtRelease = !releasedAt || entryTime <= releasedAt;
              return afterLastTurnover && beforeOrAtRelease;
            });
            return shiftEntries.map((e, i) => ({
              id: `rel_${r.id}_${i}`,
              title: `${r.tail_number||'Unknown'} - ${(e.text || e.content || '')}`,
              category: 'completed',
              tag: null,
              notes: null,
              checked: false
            }));
          })
        ];

        newEntriesCount += runningRaw.length;

        // Ask Claude to generate summary + structured items
        const prompt = `You are an aviation maintenance shift lead writing a formal shift turnover report.

Shift: ${shift}
${lead_notes ? `Lead notes: ${lead_notes}` : ''}
${entriesText ? `Activity since last turnover:\n${entriesText}` : 'No logged entries since last turnover.'}

Each line above represents work performed. Running reports use " | " to separate individual tasks on the same aircraft.

Generate a JSON response with exactly this structure:
{
  "summary": "2-4 sentence plain language shift narrative covering all aircraft",
  "items": [
    {
      "id": "unique_string",
      "title": "TAIL_NUMBER - brief description of this specific task",
      "category": "completed|inprogress|deferred",
      "tag": "rts|deferred|null",
      "notes": "additional context or null",
      "checked": false
    }
  ]
}

Rules:
- Create ONE item per individual task — split pipe-separated entries into separate items
- Each item title must start with the tail number
- category rules: "completed" = work finished, tests passed, AC serviceable; "inprogress" = work started but not finished, awaiting parts, needs further action; "deferred" = explicitly deferred to another base or shift
- tag: "rts" only if aircraft was explicitly returned to service; "deferred" if explicitly deferred; otherwise null
- Never combine tasks from different entries into one item
- Never infer completion — if the entry says "needs inspection" or "awaiting parts" it is inprogress, not completed
- Lead notes are forward-looking instructions from the outgoing shift lead, not records of completed work. If lead notes mention requirements, cautions, or tasks for the incoming shift, create an inprogress item for each one so it carries forward until resolved. If the note references a specific tail number, use that tail number as the item prefix (e.g. "AALI - ETOPS check required"). If the note is a shop-wide instruction not tied to a specific aircraft, use "NOTE" as the prefix (e.g. "NOTE - Crew rest ends at 0600")
- Return ONLY valid JSON, no markdown, no explanation`;

        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }]
          })
        });
        const aiData = await aiResp.json();
        const aiText = aiData.content?.[0]?.text || '{}';

        let summary = '';
        let items = [];
        try {
          const parsed = JSON.parse(aiText.replace(/```json|```/g, '').trim());
          summary = parsed.summary || '';
          items = [...(parsed.items || []), ...aogItems, ...forcedCompletedItems];
        } catch(e) {
          summary = 'Shift turnover generated.';
          items = [...aogItems, ...forcedCompletedItems];
        }

        // Save to Supabase
        const leadProfile = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}&select=email`, { headers: svcHeaders });
        const leadData = await leadProfile.json();
        const leadEmail = leadData?.[0]?.email || '';

        await fetch(`${process.env.SUPABASE_URL}/rest/v1/turnover_reports`, {
          method: 'POST',
          headers: { ...svcHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            company_id,
            created_by: user_id,
            shift,
            summary,
            items: JSON.stringify(items),
            status: 'active',
            new_entries_count: newEntriesCount,
            lead_email: leadEmail
          })
        });

        return res.status(200).json({ success: true });
      }

      return res.status(200).json({ success: true });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ ...req.body, model: 'claude-sonnet-4-5' })
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
