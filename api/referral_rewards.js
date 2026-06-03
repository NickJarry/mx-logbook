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

  const PLAN_VALUES = { pro: 19.99, shop: 299, proshop: 599, enterprise: 999 };
  const PLAN_LABELS = { pro: 'Pro', shop: 'Shop', proshop: 'Shop Pro', enterprise: 'Enterprise' };
  const PLAN_ORDER = ['pro', 'shop', 'proshop', 'enterprise'];

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
    return r.json();
  }

  async function getStripeCustomer(email) {
    const r = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
    });
    const data = await r.json();
    return data.data?.[0] || null;
  }

  async function applyStripeCredit(customerId, amount, description) {
    const r = await fetch('https://api.stripe.com/v1/customers/' + customerId + '/balance_transactions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        amount: String(-Math.round(amount * 100)), // negative = credit
        currency: 'usd',
        description
      }).toString()
    });
    return r.json();
  }

  async function sendRewardEmail(email, referrerPlan, creditAmount, totalMonths) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'MX-Logbook <hello@mx-logbook.com>',
        to: email,
        subject: 'You earned a free month on MX-Logbook',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
            <div style="font-size:13px;color:#00e5a0;letter-spacing:2px;margin-bottom:8px;font-family:monospace;">MX-LOGBOOK</div>
            <h1 style="font-size:24px;margin-bottom:16px;">You earned a free month.</h1>
            <p style="color:#666;line-height:1.7;margin-bottom:16px;">
              Someone you referred has been an active ${PLAN_LABELS[referrerPlan] || ''} subscriber for 60 days. As a thank you, we've applied a <strong>$${creditAmount.toFixed(2)} credit</strong> to your account -- that's one free month on us.
            </p>
            <p style="color:#666;line-height:1.7;margin-bottom:16px;">
              The credit will automatically apply to your next billing cycle. No action needed.
            </p>
            <div style="background:#0d0d0d;border:0.5px solid #333;border-radius:8px;padding:16px;margin-bottom:16px;font-family:monospace;">
              <div style="color:#00e5a0;font-size:12px;margin-bottom:4px;">TOTAL FREE MONTHS EARNED</div>
              <div style="color:#fff;font-size:28px;font-weight:700;">${totalMonths}</div>
            </div>
            <p style="color:#666;line-height:1.7;margin-bottom:24px;">
              Keep sharing your referral code to earn more free months. Every referral counts.
            </p>
            <p style="color:#999;font-size:12px;">MX-Logbook -- Maintenance documentation for the trades.</p>
          </div>
        `
      })
    });
  }

  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const results = { rewards_paid: [], skipped: [], errors: [] };

  try {
    // Get all pending referrals where referred user paid 60+ days ago
    const pending = await sbFetch(
      `/referral_rewards?status=eq.pending&paid_at=lte.${sixtyDaysAgo.toISOString()}&select=id,referrer_id,referred_id,referrer_plan,referred_plan,reward_value`
    );

    for (const reward of (Array.isArray(pending) ? pending : [])) {
      try {
        // Get referrer profile
        const referrerProfiles = await sbFetch(`/profiles?id=eq.${reward.referrer_id}&select=email,plan,highest_plan,subscription_status`);
        const referrer = referrerProfiles[0];
        if (!referrer || !referrer.email) { results.skipped.push({ id: reward.id, reason: 'No referrer profile' }); continue; }

        // Get referred profile to verify still on qualifying plan
        const referredProfiles = await sbFetch(`/profiles?id=eq.${reward.referred_id}&select=plan,subscription_status`);
        const referred = referredProfiles[0];
        if (!referred) { results.skipped.push({ id: reward.id, reason: 'No referred profile' }); continue; }

        // Referred user must still be on active paid plan >= referrer's highest_plan
        const referrerHighest = referrer.highest_plan || reward.referrer_plan;
        const referredPlanIdx = PLAN_ORDER.indexOf(referred.plan);
        const referrerHighestIdx = PLAN_ORDER.indexOf(referrerHighest);
        const stillQualifies = referred.subscription_status === 'active' && referredPlanIdx >= referrerHighestIdx;

        if (!stillQualifies) {
          await sbFetch(`/referral_rewards?id=eq.${reward.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'ineligible' })
          });
          results.skipped.push({ id: reward.id, reason: 'Referred user downgraded or inactive' });
          continue;
        }

        // Apply Stripe credit -- use referrer's highest_plan value
        const creditAmount = PLAN_VALUES[referrerHighest] || PLAN_VALUES[reward.referrer_plan] || reward.reward_value;
        const customer = await getStripeCustomer(referrer.email);
        if (!customer) { results.errors.push({ id: reward.id, error: 'No Stripe customer' }); continue; }

        const credit = await applyStripeCredit(customer.id, creditAmount, `MX-Logbook referral reward -- 1 free month`);
        if (credit.error) { results.errors.push({ id: reward.id, error: credit.error.message }); continue; }

        // Mark reward as redeemed
        await sbFetch(`/referral_rewards?id=eq.${reward.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'redeemed', reward_paid_at: now.toISOString(), reward_value: creditAmount })
        });

        // Count total free months earned by this referrer
        const allRedeemed = await sbFetch(`/referral_rewards?referrer_id=eq.${reward.referrer_id}&status=eq.redeemed&select=id`);
        const totalMonths = Array.isArray(allRedeemed) ? allRedeemed.length : 1;

        // Send congratulatory email
        await sendRewardEmail(referrer.email, referrerHighest, creditAmount, totalMonths);

        results.rewards_paid.push({ email: referrer.email, credit: creditAmount, total_months: totalMonths });
        console.log(`Referral reward paid: ${referrer.email} -- $${creditAmount} credit (${totalMonths} total months)`);

      } catch(e) {
        results.errors.push({ id: reward.id, error: e.message });
      }
    }
  } catch(e) {
    console.error('Referral rewards error:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log('Referral rewards complete:', JSON.stringify(results));
  return res.status(200).json({ success: true, ...results });
}
