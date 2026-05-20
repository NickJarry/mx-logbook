export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  async function sbFetch(path, options = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...options,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
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
      const { email, password, plan } = req.body;
      const data = await sbAuth('/signup', { email, password });
      if (data.error) return res.status(400).json({ error: data.error.message || data.msg });
      const uid = data.user?.id || data.id;
      if (uid) {
        const code = Math.random().toString(36).substring(2,8).toUpperCase();
        await sbFetch('/profiles', {
          method: 'POST',
          body: JSON.stringify({ id: uid, email, plan: plan || 'trial', trial_start: new Date().toISOString(), referral_code: code })
        });
      }
      return res.status(200).json({ user: data.user || data, session: data.session });
    }

    if (type === 'auth_login') {
      const { email, password } = req.body;
      const data = await sbAuth('/token?grant_type=password', { email, password });
      if (data.error) return res.status(400).json({ error: data.error.message || data.msg || 'Login failed' });
      const profiles = await sbFetch(`/profiles?id=eq.${data.user?.id}&select=*`);
      return res.status(200).json({ user: data.user, session: data, profile: profiles[0] });
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
      const profiles = await sbFetch(`/profiles?id=eq.${user_id}&select=referral_code`);
      const referrals = await sbFetch(`/referrals?referrer_id=eq.${user_id}&select=*`);
      return res.status(200).json({ referral_code: profiles[0]?.referral_code, referrals: Array.isArray(referrals) ? referrals : [] });
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
