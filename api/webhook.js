export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  // Read raw body for Stripe signature verification
  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  // Verify Stripe signature
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Manual HMAC verification (no Stripe SDK needed)
    const crypto = await import('crypto');
    const parts = sig.split(',');
    const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
    const stripeSignature = parts.find(p => p.startsWith('v1=')).split('v1=')[1];
    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSig = crypto.default
      .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
      .update(signedPayload)
      .digest('hex');

    if (expectedSig !== stripeSignature) {
      console.error('Webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Webhook verification error:', err.message);
    return res.status(400).json({ error: 'Webhook verification failed' });
  }

  // Helper to update Supabase profile
  async function updateProfile(email, updates) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(updates)
    });
    return r.json();
  }

  // Helper to get customer email from Stripe
  async function getCustomerEmail(customerId) {
    const r = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
    });
    const data = await r.json();
    return data.email;
  }

  try {
    const obj = event.data?.object;

    switch (event.type) {

      // Subscription cancelled
      case 'customer.subscription.deleted': {
        const email = await getCustomerEmail(obj.customer);
        if (email) {
          await updateProfile(email, {
            plan: 'cancelled',
            cancelled_at: new Date().toISOString()
          });
          console.log(`Cancelled plan for ${email}`);
        }
        break;
      }

      // New subscription created — activate account + check card fingerprint
      case 'customer.subscription.created': {
        const email = await getCustomerEmail(obj.customer);
        if (!email) break;

        // Activate the account - flip pending_payment to trialing or active
        const newStatus = obj.status === 'trialing' ? 'trialing' : 'active';
        const priceId = obj.items?.data?.[0]?.price?.id;
        const planMap = {
          [process.env.STRIPE_PRICE_SOLO]:       'solo',
          [process.env.STRIPE_PRICE_PRO]:        'pro',
          [process.env.STRIPE_PRICE_SHOP]:       'shop',
          [process.env.STRIPE_PRICE_PROSHOP]:    'proshop',
          [process.env.STRIPE_PRICE_ENTERPRISE]: 'enterprise',
        };
        const plan = planMap[priceId];
        const updates = { subscription_status: newStatus };
        if (plan) updates.plan = plan;
        await updateProfile(email, updates);
        console.log(`Activated account for ${email}: ${newStatus}${plan ? ', plan: ' + plan : ''}`);

        // Only do fingerprint check for trials
        if (obj.status !== 'trialing') break;

        try {
          const pmResp = await fetch(`https://api.stripe.com/v1/customers/${obj.customer}/payment_methods?type=card&limit=1`, {
            headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
          });
          const pmData = await pmResp.json();
          const fingerprint = pmData.data?.[0]?.card?.fingerprint;

          if (fingerprint) {
            const existing = await fetch(`${SUPABASE_URL}/rest/v1/trial_fingerprints?fingerprint=eq.${fingerprint}&select=email`, {
              headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
            });
            const existingData = await existing.json();

            if (existingData?.length) {
              const previousEmail = existingData[0].email;
              if (previousEmail !== email) {
                // Card was used for a trial before — end trial immediately
                console.log(`Card reuse detected: ${email} used same card as ${previousEmail}. Ending trial.`);
                await fetch(`https://api.stripe.com/v1/subscriptions/${obj.id}`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({ 'trial_end': 'now' }).toString()
                });
                await fetch(`${process.env.VERCEL_URL || 'https://mx-logbook.com'}/api/generate`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: 'send_alert',
                    subject: 'Trial abuse attempt detected',
                    message: `${email} attempted to start a new trial using a card previously used by ${previousEmail}.`,
                    error_data: { new_email: email, previous_email: previousEmail, fingerprint }
                  })
                }).catch(() => {});
              }
            }
          }
        } catch(e) {
          console.log('Fingerprint check error:', e.message);
        }
        break;
      }

      // Subscription updated (e.g. trial ended, plan changed, paused)
      case 'customer.subscription.updated': {
        const email = await getCustomerEmail(obj.customer);
        if (!email) break;
        const status = obj.status;
        // Map Stripe statuses to our plan field
        if (status === 'active') {
          // Get plan name from Stripe price metadata if available
          const priceId = obj.items?.data?.[0]?.price?.id;
          const planMap = {
            [process.env.STRIPE_PRICE_SOLO]:       'solo',
            [process.env.STRIPE_PRICE_PRO]:        'pro',
            [process.env.STRIPE_PRICE_SHOP]:       'shop',
              [process.env.STRIPE_PRICE_PROSHOP]:    'proshop',
            [process.env.STRIPE_PRICE_ENTERPRISE]: 'enterprise',
          };
          const plan = planMap[priceId] || 'pro';
          await updateProfile(email, { plan, subscription_status: 'active' });
        } else if (status === 'past_due') {
          await updateProfile(email, { subscription_status: 'past_due' });
        } else if (status === 'paused') {
          await updateProfile(email, { subscription_status: 'paused' });
        } else if (status === 'unpaid') {
          await updateProfile(email, { plan: 'cancelled', subscription_status: 'unpaid' });
        }
        console.log(`Updated subscription status for ${email}: ${status}`);
        break;
      }

      // Trial ending soon - just flag it in the profile
      case 'customer.subscription.trial_will_end': {
        const email = await getCustomerEmail(obj.customer);
        if (email) {
          await updateProfile(email, { trial_ending_soon: true });
          console.log(`Trial ending soon for ${email}`);
        }
        break;
      }

      // Payment failed — flag the account
      case 'invoice.payment_failed': {
        const email = obj.customer_email || await getCustomerEmail(obj.customer);
        if (email) {
          await updateProfile(email, { subscription_status: 'past_due' });
          console.log(`Payment failed for ${email}`);
        }
        break;
      }

      // Payment succeeded — make sure account is active + store card fingerprint
      case 'invoice.paid': {
        const email = obj.customer_email || await getCustomerEmail(obj.customer);
        if (email) {
          await updateProfile(email, { subscription_status: 'active' });
          console.log(`Payment succeeded for ${email}`);
        }

        // Store card fingerprint to prevent trial abuse
        try {
          const customerId = obj.customer;
          if (customerId) {
            // Get payment methods for this customer
            const pmResp = await fetch(`https://api.stripe.com/v1/customers/${customerId}/payment_methods?type=card&limit=1`, {
              headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
            });
            const pmData = await pmResp.json();
            const fingerprint = pmData.data?.[0]?.card?.fingerprint;
            if (fingerprint && email) {
              // Check if this fingerprint already exists
              const existing = await fetch(`${SUPABASE_URL}/rest/v1/trial_fingerprints?fingerprint=eq.${fingerprint}&select=id`, {
                headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
              });
              const existingData = await existing.json();
              if (!existingData?.length) {
                // Store new fingerprint
                await fetch(`${SUPABASE_URL}/rest/v1/trial_fingerprints`, {
                  method: 'POST',
                  headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ fingerprint, customer_id: customerId, email })
                });
                console.log(`Stored card fingerprint for ${email}`);
              } else {
                console.log(`Known card fingerprint for ${email} — already on file`);
              }
            }
          }
        } catch(fpErr) {
          console.log('Fingerprint storage error:', fpErr.message);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Handler error: ' + err.message });
  }
}
