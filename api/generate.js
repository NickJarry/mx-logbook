import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { type, messages, user_id, entry_type, tail_number, aircraft } = req.body;

    if (type === 'auth_signup') {
      const { email, password, plan } = req.body;
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return res.status(400).json({ error: error.message });
      if (data.user) {
        const code = Math.random().toString(36).substring(2,8).toUpperCase();
        await supabase.from('profiles').insert({
          id: data.user.id,
          email,
          plan: plan || 'trial',
          trial_start: new Date().toISOString(),
          referral_code: code
        });
      }
      return res.status(200).json({ user: data.user, session: data.session });
    }

    if (type === 'auth_login') {
      const { email, password } = req.body;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ user: data.user, session: data.session });
    }

    if (type === 'save_entry') {
      const { content, session_id, company_id } = req.body;
      const { error } = await supabase.from('entries').insert({
        user_id,
        company_id: company_id || null,
        entry_type,
        tail_number,
        aircraft,
        content,
        session_id: session_id || null
      });
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    if (type === 'get_entries') {
      const { data, error } = await supabase
        .from('entries')
        .select('*')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ entries: data });
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
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
