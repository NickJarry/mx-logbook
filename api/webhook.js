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
            [process.env.STRIPE_PRICE_TEAM]:       'team',
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

      // Trial ending in 3 days — flag it so we can send a reminder email later
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

      // Payment succeeded — make sure account is active
      case 'invoice.paid': {
        const email = obj.customer_email || await getCustomerEmail(obj.customer);
        if (email) {
          await updateProfile(email, { subscription_status: 'active' });
          console.log(`Payment succeeded for ${email}`);
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
