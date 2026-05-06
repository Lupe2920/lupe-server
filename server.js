const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('Lupe Accommodations payment server is running ✓'));

// Create payment intent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, metadata } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
