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
            company_id: isCompany ? uid : null
          })
        });
        console.log('Profile insert status:', insertResult.status, 'for', email);
        if (!insertResult.ok) {
          const errText = await insertResult.text();
          console.error('Profile insert failed:', errText);
        }

        // Process referral code if provided
        if (referral_code) {
          const referrerProfile = await sbFetch(`/profiles?referral_code=eq.${referral_code}&select=id,plan,referral_code`);
          const referrer = referrerProfile[0];

          if (referrer) {
            const planValues = {
              trial: 0, pro: 19.99,
              shop: 149, proshop: 499, enterprise: 899
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
      if (update.ok) return res.status(200).json({ success: true });
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
      if (!company_id) return res.status(400).json({ error: 'No company ID found. Company plans only.' });

      // Check seat limit
      const planSeats = { shop:5, proshop:10, enterprise:25 };
      const seats = planSeats[plan] || 10;
      const existing = await sbFetch(`/profiles?company_id=eq.${company_id}&select=id`);
      if (Array.isArray(existing) && existing.length >= seats) {
        return res.status(400).json({ error: `Seat limit reached (${seats} for ${plan} plan). Upgrade to add more mechanics.` });
      }

      // Check if user already exists
      const existingUser = await sbFetch(`/profiles?email=eq.${encodeURIComponent(email)}&select=id,company_id`);
      if (existingUser[0]) {
        if (existingUser[0].company_id) return res.status(400).json({ error: 'This user is already on a team.' });
        // Add existing user to company
        await sbFetch(`/profiles?id=eq.${existingUser[0].id}`, {
          method: 'PATCH',
          body: JSON.stringify({ company_id, role: role || 'mechanic' })
        });
      }

      // Send invite email
      await sendEmail({
        to: email,
        subject: 'You have been invited to join a team on MX-Logbook',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0d0d0d;color:#f0f0f0;padding:32px;border-radius:8px;">
            <div style="font-family:monospace;font-size:14px;color:#00e5a0;letter-spacing:3px;margin-bottom:24px;">MX-LOGBOOK</div>
            <h1 style="font-size:22px;font-weight:700;text-transform:uppercase;margin-bottom:12px;">You've been invited.</h1>
            <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:24px;">You've been added to a team on MX-Logbook as a <strong style="color:#fff;">${role || 'mechanic'}</strong>. Sign in or create an account to get started.</p>
            <a href="https://mx-logbook.com" style="display:inline-block;background:#00e5a0;color:#0a0a0a;font-family:monospace;font-size:13px;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:600;">Go to MX-Logbook</a>
            <div style="margin-top:28px;padding-top:20px;border-top:1px solid #222;font-family:monospace;font-size:11px;color:#555;">
              Questions? Contact hello@mx-logbook.com
            </div>
          </div>
        `
      }).catch(() => {});

      return res.status(200).json({ success: true });
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

    if (type === 'scan_log') {
      const { image_data, media_type } = req.body;
      if (!image_data) return res.status(400).json({ error: 'No image provided.' });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_data }
              },
              {
                type: 'text',
                text: 'This is a handwritten aviation maintenance log entry. Transcribe the handwritten text exactly as written, preserving all technical details, part numbers, times, and abbreviations. If any words are unclear, make your best interpretation based on aviation maintenance context. Output only the transcribed text, nothing else.'
              }
            ]
          }]
        })
      });

      const data = await response.json();
      const text = data.content?.[0]?.text || '';
      if (!text) return res.status(500).json({ error: 'Could not read image.' });
      return res.status(200).json({ text });
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
      // Look up by user_id if available, otherwise by email
      let profiles;
      if (user_id) {
        profiles = await sbFetch(`/profiles?id=eq.${user_id}&select=plan,subscription_status,cancelled_at,created_at,full_name,cert_number`);
      } else {
        profiles = await sbFetch(`/profiles?email=eq.${encodeURIComponent(email)}&select=plan,subscription_status,cancelled_at,created_at,full_name,cert_number`);
      }
      const profile = profiles[0];

      // No profile found - account was deleted or never created
      if (!profile) {
        return res.status(200).json({ blocked: true, message: 'Account not found. Please sign up again at mx-logbook.com.' });
      }

      if (profile.subscription_status === 'pending_payment') {
  const createdAt = profile.created_at ? new Date(profile.created_at).getTime() : 0;
  const ageSeconds = (Date.now() - createdAt) / 1000;
  if (ageSeconds < 30) {
    return res.status(200).json({ blocked: false, plan: profile.plan, subscription_status: 'trialing', tech_name: profile.full_name || null, cert_num: profile.cert_number || null });
  }
  return res.status(200).json({ blocked: true, message: 'Payment not completed. Please complete your signup at mx-logbook.com to activate your account.' });
}
      if (profile.plan === 'cancelled') {
        return res.status(200).json({ blocked: true, message: 'Your subscription has been cancelled. Please resubscribe at mx-logbook.com to continue.' });
      }
      if (profile.subscription_status === 'past_due') {
        return res.status(200).json({ blocked: true, message: 'Your payment is past due. Please update your billing information to continue.' });
      }
      if (profile.subscription_status === 'unpaid') {
        return res.status(200).json({ blocked: true, message: 'Your account has been suspended due to a failed payment. Please update your billing information.' });
      }

      return res.status(200).json({ blocked: false, plan: profile.plan, subscription_status: profile.subscription_status || null, tech_name: profile.full_name || null, cert_num: profile.cert_number || null });
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
        const updated = await sbFetch(`/running_reports?id=eq.${report_id}&user_id=eq.${user_id}`, {
          method: 'PATCH',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ entries: JSON.stringify(entries), status: status || 'active', updated_at: new Date().toISOString() })
        });
        return res.status(200).json({ report: Array.isArray(updated) ? updated[0] : updated });
      } else {
        // Create new report
        const created = await fetch(`${process.env.SUPABASE_URL}/rest/v1/running_reports`, {
          method: 'POST',
          headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ user_id, tail_number: tail_number || '', aircraft: aircraft || '', entries: JSON.stringify(entries || []), status: 'active' })
        });
        const data = await created.json();
        return res.status(200).json({ report: Array.isArray(data) ? data[0] : data });
      }
    }

    if (type === 'get_running_reports') {
      const { user_id } = req.body;
      if (!user_id) return res.status(200).json({ reports: [] });
      const reports = await sbFetch(`/running_reports?user_id=eq.${user_id}&order=updated_at.desc&select=id,tail_number,aircraft,status,created_at,updated_at,entries`);
      return res.status(200).json({ reports: Array.isArray(reports) ? reports : [] });
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

    if (type === 'get_company_entries') {
      const { company_id, limit } = req.body;
      if (!company_id) return res.status(200).json({ entries: [] });
      // Get all team member IDs
      const team = await sbFetch(`/profiles?company_id=eq.${company_id}&select=id,email`);
      const memberMap = {};
      (Array.isArray(team) ? team : []).forEach(m => { memberMap[m.id] = m.email; });
      const ids = Object.keys(memberMap);
      if (!ids.length) return res.status(200).json({ entries: [] });
      // Get entries for all team members
      const entries = await sbFetch(`/entries?user_id=in.(${ids.join(',')})&order=created_at.desc&limit=${limit||100}`);
      const enriched = (Array.isArray(entries) ? entries : []).map(e => ({
        ...e,
        mechanic_email: memberMap[e.user_id] || ''
      }));
      return res.status(200).json({ entries: enriched });
    }

    if (type === 'get_company_aog') {
      const { company_id } = req.body;
      if (!company_id) return res.status(200).json({ sessions: [] });
      const team = await sbFetch(`/profiles?company_id=eq.${company_id}&select=id,email`);
      const memberMap = {};
      (Array.isArray(team) ? team : []).forEach(m => { memberMap[m.id] = m.email; });
      const ids = Object.keys(memberMap);
      if (!ids.length) return res.status(200).json({ sessions: [] });
      const sessions = await sbFetch(`/aog_sessions?user_id=in.(${ids.join(',')})&order=created_at.desc&limit=50`);
      const enriched = (Array.isArray(sessions) ? sessions : []).map(s => ({
        ...s,
        mechanic_email: memberMap[s.user_id] || ''
      }));
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
