export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  if (req.method === 'POST') {
    const { secret } = req.body || {};
    if (secret !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  } else if (req.method !== 'GET') {
    return res.status(405).end();
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  // Founding plan prices in cents (one free month = one month credit)
  const PLAN_PRICES_CENTS = {
    pro:        1999,
    shop:       29900,
    proshop:    59900,
    enterprise: 99900
  };

  const PLAN_LABELS = {
    pro:        'Pro ($19.99/mo)',
    shop:       'Shop ($299/mo)',
    proshop:    'Shop Pro ($599/mo)',
    enterprise: 'Enterprise ($999/mo)'
  };

  async function sbFetch(path, options = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...options,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const text = await r.text();
    try { return text ? JSON.parse(text) : {}; } catch(e) { return {}; }
  }

  async function getStripeCustomerByEmail(email) {
    const r = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
    });
    const data = await r.json();
    return data.data?.[0] || null;
  }

  async function applyStripeCredit(customerId, amountCents, description) {
    const r = await fetch(`https://api.stripe.com/v1/customers/${customerId}/balance_transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        amount: String(-Math.abs(amountCents)),
        currency: 'usd',
        description
      }).toString()
    });
    return r.json();
  }

  async function sendRewardEmail(email, referrerPlan, referredEmail) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MX-Logbook <hello@mx-logbook.com>',
        to: email,
        subject: 'You earned a free month on MX-Logbook',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
            <div style="font-size:13px;color:#00e5a0;letter-spacing:2px;margin-bottom:8px;font-family:monospace;">MX-LOGBOOK</div>
            <h1 style="font-size:24px;margin-bottom:16px;">You earned a free month.</h1>
            <p style="color:#666;line-height:1.7;margin-bottom:16px;">
              Someone you referred to MX-Logbook (${referredEmail}) has been an active subscriber for 3 months. As a thank you, we have applied one free month of your <strong>${PLAN_LABELS[referrerPlan] || referrerPlan}</strong> plan as a credit to your account.
            </p>
            <p style="color:#666;line-height:1.7;margin-bottom:24px;">
              The credit will automatically apply to your next invoice. No action needed.
            </p>
            <p style="color:#999;font-size:12px;">MX-Logbook -- Maintenance documentation for the trades.</p>
          </div>
        `
      })
    });
  }

  const results = { credited: [], skipped: [], errors: [] };

  try {
    // Get all pending referral rewards
    const rewards = await sbFetch('/referral_rewards?status=eq.pending&select=*');
    const rewardList = Array.isArray(rewards) ? rewards : [];

    for (const reward of rewardList) {
      try {
        if (!reward.referred_id || !reward.referrer_id) {
          results.skipped.push({ id: reward.id, reason: 'missing ids' });
          continue;
        }

        // Check referred user's profile -- active + trial_start 3+ months ago
        const referredProfiles = await sbFetch(`/profiles?id=eq.${reward.referred_id}&select=email,subscription_status,trial_start,plan`);
        const referred = Array.isArray(referredProfiles) ? referredProfiles[0] : null;

        if (!referred) {
          results.skipped.push({ id: reward.id, reason: 'referred user not found' });
          continue;
        }

        if (referred.subscription_status !== 'active') {
          results.skipped.push({ id: reward.id, reason: `referred user not active: ${referred.subscription_status}` });
          continue;
        }

        const trialStart = new Date(referred.trial_start);
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        if (trialStart > threeMonthsAgo) {
          results.skipped.push({ id: reward.id, reason: 'referred user has not reached 3 months yet' });
          continue;
        }

        // Get referrer profile for email + plan
        const referrerProfiles = await sbFetch(`/profiles?id=eq.${reward.referrer_id}&select=email,plan,subscription_status`);
        const referrer = Array.isArray(referrerProfiles) ? referrerProfiles[0] : null;

        if (!referrer || !referrer.email) {
          results.skipped.push({ id: reward.id, reason: 'referrer profile not found' });
          continue;
        }

        if (referrer.subscription_status !== 'active') {
          results.skipped.push({ id: reward.id, reason: `referrer not active: ${referrer.subscription_status}` });
          continue;
        }

        const creditAmountCents = PLAN_PRICES_CENTS[referrer.plan];
        if (!creditAmountCents) {
          results.skipped.push({ id: reward.id, reason: `no price defined for referrer plan: ${referrer.plan}` });
          continue;
        }

        // Find referrer's Stripe customer
        const stripeCustomer = await getStripeCustomerByEmail(referrer.email);
        if (!stripeCustomer) {
          results.skipped.push({ id: reward.id, reason: `no Stripe customer found for ${referrer.email}` });
          continue;
        }

        // Apply credit
        const creditResult = await applyStripeCredit(
          stripeCustomer.id,
          creditAmountCents,
          `MX-Logbook referral reward -- 1 free month (referred: ${referred.email})`
        );

        if (creditResult.error) {
          results.errors.push({ id: reward.id, error: creditResult.error.message });
          continue;
        }

        // Update referral_rewards row
        const now = new Date().toISOString();
        await fetch(`${SUPABASE_URL}/rest/v1/referral_rewards?id=eq.${reward.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            status: 'credited',
            qualified_at: now,
            paid_at: now,
            free_months_earned: 1
          })
        });

        // Send reward email to referrer
        await sendRewardEmail(referrer.email, referrer.plan, referred.email);

        results.credited.push({ id: reward.id, referrer: referrer.email, referred: referred.email, credit_cents: creditAmountCents });
        console.log(`Referral: credited ${referrer.email} for referring ${referred.email} -- ${creditAmountCents} cents`);

      } catch(e) {
        results.errors.push({ id: reward.id, error: e.message });
        console.error(`Referral error for reward ${reward.id}:`, e.message);
      }
    }
  } catch(e) {
    console.error('Referral cron error:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log('Referral cron complete:', JSON.stringify(results));
  return res.status(200).json({ success: true, ...results });
}
