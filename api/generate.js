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
    return r.json();
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
        const companyPlans = ['shop','team','proshop','enterprise'];
        const isCompany = companyPlans.includes(plan);
        const codeBase = Math.random().toString(36).substring(2,8).toUpperCase();
        const newCode = isCompany ? `CO-${codeBase}` : codeBase;

        await sbFetch('/profiles', {
          method: 'POST',
          body: JSON.stringify({
            id: uid, email,
            plan: plan || 'trial',
            trial_start: new Date().toISOString(),
            referral_code: newCode,
            subscription_status: 'trialing'
          })
        });

        // Process referral code if provided
        if (referral_code) {
          const referrerProfile = await sbFetch(`/profiles?referral_code=eq.${referral_code}&select=id,plan,referral_code`);
          const referrer = referrerProfile[0];

          if (referrer) {
            const planValues = {
              trial: 0, solo: 9.99, pro: 16.99,
              shop: 149, team: 299, proshop: 499, enterprise: 899
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
              <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:20px;">Your 7-day free trial has started. Generate your first logbook entry at <a href="https://mx-logbook.com" style="color:#00e5a0;">mx-logbook.com</a>.</p>
              <p style="font-size:13px;color:#555;line-height:1.8;">Your card will be charged after your trial ends on ${new Date(Date.now() + 7*24*60*60*1000).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}. Cancel anytime before then and you won't be charged.</p>
              <div style="margin-top:28px;padding-top:20px;border-top:1px solid #222;font-family:monospace;font-size:11px;color:#555;">
                Questions? Reply to this email or contact hello@mx-logbook.com
              </div>
            </div>
          `
        }).catch(() => {}); // Don't block signup if email fails
      }

      return res.status(200).json({ user: data.user || data, session: data.session });
    }

    if (type === 'auth_login') {
      const { email, password } = req.body;
      const data = await sbAuth('/token?grant_type=password', { email, password });
      if (data.error) return res.status(400).json({ error: data.error.message || data.msg || 'Login failed' });
      const profiles = await sbFetch(`/profiles?id=eq.${data.user?.id}&select=*`);
      const profile = profiles[0];

      // Check if account is cancelled or unpaid
      if (profile) {
        if (profile.plan === 'cancelled') {
          return res.status(403).json({ error: 'Your subscription has been cancelled. Please resubscribe at mx-logbook.com to regain access.' });
        }
        if (profile.subscription_status === 'past_due') {
          return res.status(403).json({ error: 'Your payment is past due. Please update your billing information to continue.' });
        }
        if (profile.subscription_status === 'unpaid') {
          return res.status(403).json({ error: 'Your account has been suspended due to a failed payment. Please update your billing information.' });
        }
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
      const planSeats = { shop:10, team:25, proshop:50, enterprise:100 };
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
      return res.status(200).json({ success: true });
    }

    if (type === 'create_portal_session') {
      const { customer_email } = req.body;
      const searchResp = await fetch(`https://api.stripe.com/v1/customers/search?query=email:"${customer_email}"`, {
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
      });
      const searchData = await searchResp.json();
      const customer = searchData.data?.[0];

      // No Stripe customer yet — they're on a free trial that hasn't been charged
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

    if (type === 'check_access') {
      const { email } = req.body;
      if (!user_id && !email) return res.status(200).json({ blocked: true, message: 'Session expired. Please log in again.' });
      const profiles = await sbFetch(`/profiles?id=eq.${user_id}&select=plan,subscription_status,cancelled_at`);
      const profile = profiles[0];

      // No profile found — account was deleted or never created
      if (!profile) {
        return res.status(200).json({ blocked: true, message: 'Account not found. Please sign up again at mx-logbook.com.' });
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

      return res.status(200).json({ blocked: false, plan: profile.plan });
    }

    if (type === 'send_alert') {
      // Internal error alert — sends to you only
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

    if (type === 'send_trial_ending') {
      const { email, trial_end_date } = req.body;
      await sendEmail({
        to: email,
        subject: 'Your MX-Logbook trial ends in 3 days',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0d0d0d;color:#f0f0f0;padding:32px;border-radius:8px;">
            <div style="font-family:monospace;font-size:14px;color:#00e5a0;letter-spacing:3px;margin-bottom:24px;">MX-LOGBOOK</div>
            <h1 style="font-size:22px;font-weight:700;text-transform:uppercase;margin-bottom:12px;">Your trial ends in 3 days.</h1>
            <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:20px;">Your free trial ends on <strong style="color:#fff;">${trial_end_date || 'soon'}</strong>. After that your card will be charged for your selected plan.</p>
            <p style="font-size:15px;color:#999;line-height:1.8;margin-bottom:24px;">If you want to cancel before being charged, log in to your account and cancel from the dashboard.</p>
            <a href="https://mx-logbook.com" style="display:inline-block;background:#00e5a0;color:#0a0a0a;font-family:monospace;font-size:13px;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:600;">Go to MX-Logbook</a>
            <div style="margin-top:28px;padding-top:20px;border-top:1px solid #222;font-family:monospace;font-size:11px;color:#555;">
              Questions? Reply to this email or contact hello@mx-logbook.com
            </div>
          </div>
        `
      });
      return res.status(200).json({ success: true });
    }

    if (type === 'get_founding_spots') {
      // Count how many accounts are on each company plan
      const MAX_SPOTS = 10;
      const plans = ['shop','team','proshop','enterprise'];
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
        body: JSON.stringify({ id: user_id, email, plan: plan || 'trial', trial_start: new Date().toISOString(), referral_code: code, subscription_status: 'trialing' })
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
