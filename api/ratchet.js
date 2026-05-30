export default async function handler(req, res) {
  // Allow manual trigger via POST with secret, or automated cron
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

  const MARKET_PRICES = {
    shop:       'price_1Tcs3cF0p7ZYm2D2gUC1CfaW',  // $599/mo
    proshop:    'price_1Tcs3xF0p7ZYm2D2XIpjn6j0',  // $1,199/mo
    enterprise: 'price_1Tcs4KF0p7ZYm2D281i2nTKq',  // $2,000/mo
  };

  const MARKET_LABELS = {
    shop:       '$599/mo',
    proshop:    '$1,199/mo',
    enterprise: '$2,000/mo',
  };

  const PLAN_LABELS = {
    shop:       'Shop',
    proshop:    'Shop Pro',
    enterprise: 'Enterprise',
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
    return r.json();
  }

  async function getStripeCustomer(email) {
    const r = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
    });
    const data = await r.json();
    return data.data?.[0] || null;
  }

  async function getActiveSubscription(customerId) {
    const r = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=1`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
    });
    const data = await r.json();
    return data.data?.[0] || null;
  }

  async function sendWarningEmail(email, plan, newPrice) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MX-Logbook <hello@mx-logbook.com>',
        to: email,
        subject: 'Your founding rate ends in 14 days',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
            <div style="font-size:13px;color:#00e5a0;letter-spacing:2px;margin-bottom:8px;font-family:monospace;">MX-LOGBOOK</div>
            <h1 style="font-size:24px;margin-bottom:16px;">Your founding rate ends in 14 days</h1>
            <p style="color:#666;line-height:1.7;margin-bottom:16px;">
              You signed up as a founding member of MX-Logbook two years ago, and we've honored your locked-in rate ever since. That 2-year founding period is coming to an end.
            </p>
            <p style="color:#666;line-height:1.7;margin-bottom:16px;">
              In 14 days, your <strong>${PLAN_LABELS[plan]}</strong> plan will move to the current market rate of <strong>${newPrice}</strong>.
            </p>
            <p style="color:#666;line-height:1.7;margin-bottom:24px;">
              No action is needed. Your subscription will continue uninterrupted. If you have any questions, reply to this email or contact us at hello@mx-logbook.com.
            </p>
            <p style="color:#999;font-size:12px;">MX-Logbook &mdash; Maintenance documentation for the trades.</p>
          </div>
        `
      })
    });
  }

  async function migrateSubscription(email, plan, newPriceId) {
    const customer = await getStripeCustomer(email);
    if (!customer) {
      console.log(`Ratchet: No Stripe customer found for ${email}`);
      return false;
    }

    const subscription = await getActiveSubscription(customer.id);
    if (!subscription) {
      console.log(`Ratchet: No active subscription found for ${email}`);
      return false;
    }

    const subscriptionItemId = subscription.items.data[0].id;

    // Update the subscription to the new price at next billing cycle
    const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subscription.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'items[0][id]': subscriptionItemId,
        'items[0][price]': newPriceId,
        'proration_behavior': 'none',
        'billing_cycle_anchor': 'unchanged'
      }).toString()
    });

    const data = await r.json();
    if (data.error) {
      console.error(`Ratchet: Stripe migration failed for ${email}:`, data.error.message);
      return false;
    }

    console.log(`Ratchet: Migrated ${email} (${plan}) to market rate`);
    return true;
  }

  async function sendMigrationEmail(email, plan, newPrice) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'MX-Logbook <hello@mx-logbook.com>',
        to: email,
        subject: 'Your plan has been updated to market rate',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
            <div style="font-size:13px;color:#00e5a0;letter-spacing:2px;margin-bottom:8px;font-family:monospace;">MX-LOGBOOK</div>
            <h1 style="font-size:24px;margin-bottom:16px;">Your plan has been updated</h1>
            <p style="color:#666;line-height:1.7;margin-bottom:16px;">
              Your 2-year founding rate period has ended. Your <strong>${PLAN_LABELS[plan]}</strong> plan has been updated to the current market rate of <strong>${newPrice}</strong>, effective at your next billing cycle.
            </p>
            <p style="color:#666;line-height:1.7;margin-bottom:16px;">
              Thank you for being a founding member. Your support helped build MX-Logbook from the ground up.
            </p>
            <p style="color:#666;line-height:1.7;margin-bottom:24px;">
              If you have any questions, reply to this email or contact us at hello@mx-logbook.com.
            </p>
            <p style="color:#999;font-size:12px;">MX-Logbook &mdash; Maintenance documentation for the trades.</p>
          </div>
        `
      })
    });
  }

  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const warningDate = new Date(twoYearsAgo);
  warningDate.setDate(warningDate.getDate() + 14); // 14 days before 2-year mark

  const results = { warnings_sent: [], migrations_done: [], errors: [] };

  try {
    // Get all company plan profiles
    const profiles = await sbFetch(`/profiles?plan=in.(shop,proshop,enterprise)&subscription_status=eq.active&select=id,email,plan,trial_start`);

    for (const profile of profiles) {
      if (!profile.trial_start || !profile.email) continue;

      const startDate = new Date(profile.trial_start);
      const twoYearMark = new Date(startDate);
      twoYearMark.setFullYear(twoYearMark.getFullYear() + 2);

      const daysUntilMigration = Math.round((twoYearMark - now) / (1000 * 60 * 60 * 24));

      // Send warning email 14 days before migration
      if (daysUntilMigration === 14) {
        try {
          await sendWarningEmail(profile.email, profile.plan, MARKET_LABELS[profile.plan]);
          results.warnings_sent.push(profile.email);
          console.log(`Ratchet: Warning sent to ${profile.email}`);
        } catch(e) {
          results.errors.push({ email: profile.email, error: 'Warning email failed: ' + e.message });
        }
      }

      // Migrate on the 2-year mark
      if (daysUntilMigration === 0) {
        try {
          const newPriceId = MARKET_PRICES[profile.plan];
          const success = await migrateSubscription(profile.email, profile.plan, newPriceId);
          if (success) {
            await sendMigrationEmail(profile.email, profile.plan, MARKET_LABELS[profile.plan]);
            results.migrations_done.push(profile.email);
          }
        } catch(e) {
          results.errors.push({ email: profile.email, error: 'Migration failed: ' + e.message });
        }
      }
    }
  } catch(e) {
    console.error('Ratchet error:', e.message);
    return res.status(500).json({ error: e.message });
  }

  console.log('Ratchet complete:', JSON.stringify(results));
  return res.status(200).json({ success: true, ...results });
}
