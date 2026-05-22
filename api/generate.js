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

            // Also record in legacy referrals table
            await sbFetch('/referrals', {
              method: 'POST',
              body: JSON.stringify({
                referrer_id: referrer.id,
                referred_email: email,
                referred_id: uid
              })
            }).catch(() => {});
          }
        }
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
      const team = await sbFetch(`/profiles?company_id=eq.${company_id}&select=email,role,created_at`);
      return res.status(200).json({ team: Array.isArray(team) ? team : [] });
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
      if (!customer) return res.status(400).json({ error: 'No billing account found for this email.' });
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
      if (!user_id && !email) return res.status(200).json({ blocked: false });
      const profiles = await sbFetch(`/profiles?id=eq.${user_id}&select=plan,subscription_status,cancelled_at`);
      const profile = profiles[0];
      if (!profile) return res.status(200).json({ blocked: false });

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
