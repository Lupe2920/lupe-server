const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// ── CORS — allow requests from any origin (needed for Tiiny.host) ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static('public'));

// Health check — keeps server alive, confirms it's running
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Lupe Accommodations payment server is running ✓' });
});

// Create Stripe PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, metadata } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe not configured on server' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // dollars to cents
      currency: currency || 'aud',
      metadata: metadata || {},
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lupe server running on port ${PORT}`);
  console.log(`Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
});
