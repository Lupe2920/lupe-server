const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const path = require('path');
const https = require('https');
const app = express();

// ── KEEP ALIVE ──
setInterval(() => {
  https.get('https://lupe-server.onrender.com', (res) => {
    console.log('Keep alive ping:', res.statusCode);
  }).on('error', (e) => {
    console.log('Keep alive error:', e.message);
  });
}, 14 * 60 * 1000);

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static('public'));

// ── BOOKINGS FILE ──
const BOOKINGS_FILE = path.join('/tmp', 'bookings.json');

function loadBookings() {
  try {
    if (fs.existsSync(BOOKINGS_FILE)) {
      return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
    }
  } catch(e) { console.log('Error loading bookings:', e.message); }
  return [];
}

function saveBookings(bookings) {
  try {
    fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  } catch(e) { console.log('Error saving bookings:', e.message); }
}

// ── PROMO TRACKING ──
const PROMO_FILE = path.join('/tmp', 'promos.json');

function loadPromos() {
  try {
    if (fs.existsSync(PROMO_FILE)) return JSON.parse(fs.readFileSync(PROMO_FILE, 'utf8'));
  } catch(e) {}
  return { LAUNCH10: 0 };
}

function savePromos(promos) {
  try { fs.writeFileSync(PROMO_FILE, JSON.stringify(promos)); } catch(e) {}
}

// ── ICAL CACHE ──
const ICAL_URLS = {
  heavenly: 'https://www.airbnb.com/calendar/ical/737148180379804560.ics?t=5e68645b953444b7b2734b72f9f910bd&locale=en-AU',
  nua: 'https://www.airbnb.com/calendar/ical/1132966183263705313.ics?t=e186ffa51db245fe8db08ebbc27a5c20&locale=en-AU'
};
const icalCache = { heavenly: null, nua: null, heavenlyAt: 0, nuaAt: 0 };
const CACHE_TTL = 30 * 60 * 1000;

async function fetchIcal(prop) {
  const now = Date.now();
  if (icalCache[prop] && (now - icalCache[prop+'At']) < CACHE_TTL) {
    return icalCache[prop];
  }
  try {
    const res = await fetch(ICAL_URLS[prop]);
    const text = await res.text();
    if (text && text.includes('VCALENDAR')) {
      icalCache[prop] = text;
      icalCache[prop+'At'] = now;
      return text;
    }
  } catch(e) { console.log('iCal fetch error:', e.message); }
  return icalCache[prop] || null;
}

function parseIcalDates(ical) {
  const blocked = [];
  if (!ical) return blocked;
  ical.split('BEGIN:VEVENT').forEach(ev => {
    const s = ev.match(/DTSTART[^:]*:(\d{8})/);
    const e = ev.match(/DTEND[^:]*:(\d{8})/);
    if (s && e) {
      let cur = new Date(s[1].slice(0,4)+'-'+s[1].slice(4,6)+'-'+s[1].slice(6,8)+'T00:00:00');
      const end = new Date(e[1].slice(0,4)+'-'+e[1].slice(4,6)+'-'+e[1].slice(6,8)+'T00:00:00');
      while (cur < end) {
        blocked.push(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 1);
      }
    }
  });
  return blocked;
}

// ── GET AIRBNB BLOCKED DATES ──
app.get('/airbnb-dates/:prop', async (req, res) => {
  const prop = req.params.prop;
  if (!['heavenly','nua'].includes(prop)) return res.status(400).json({error:'Invalid property'});
  const ical = await fetchIcal(prop);
  const dates = parseIcalDates(ical);
  res.json({ prop, dates });
});

// ── ALL BLOCKED DATES (server bookings + airbnb) ──
app.get('/all-blocked-dates', async (req, res) => {
  const [heavenlyIcal, nuaIcal] = await Promise.all([fetchIcal('heavenly'), fetchIcal('nua')]);
  const bookings = loadBookings();
  const serverDates = { heavenly: [], nua: [] };
  bookings.forEach(b => {
    if (b.property && b.checkin && b.checkout) {
      const p = b.property.toLowerCase().includes('heavenly') ? 'heavenly' : 'nua';
      let cur = new Date(b.checkin + 'T00:00:00');
      const end = new Date(b.checkout + 'T00:00:00');
      while (cur < end) {
        serverDates[p].push(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 1);
      }
    }
  });
  res.json({
    heavenly: [...new Set([...parseIcalDates(heavenlyIcal), ...serverDates.heavenly])],
    nua: [...new Set([...parseIcalDates(nuaIcal), ...serverDates.nua])]
  });
});

// ── WARM UP CACHE ON START ──
setTimeout(() => {
  fetchIcal('heavenly');
  fetchIcal('nua');
  console.log('Warming iCal cache...');
}, 3000);

// ── CHECK PROMO ──
app.post('/check-promo', (req, res) => {
  const { code } = req.body;
  const promos = loadPromos();
  if (code === 'LAUNCH10') {
    const used = promos['LAUNCH10'] || 0;
    if (used >= 5) return res.json({ valid: false, message: 'Sorry — this offer has expired. All 5 spots have been claimed!' });
    return res.json({ valid: true, discount: 99, skipBond: true, label: '🎉 Launch special — 99% off (spot '+(used+1)+' of 5)', used, remaining: 5-used });
  }
  res.json({ valid: false, message: 'Invalid promo code' });
});

// ── USE PROMO ──
app.post('/use-promo', (req, res) => {
  const { code } = req.body;
  const promos = loadPromos();
  if (code === 'LAUNCH10') {
    promos['LAUNCH10'] = (promos['LAUNCH10'] || 0) + 1;
    savePromos(promos);
    return res.json({ success: true, used: promos['LAUNCH10'] });
  }
  res.json({ success: false });
});

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasKey: !!process.env.STRIPE_SECRET_KEY });
});

// ── GET BOOKED DATES ──
app.get('/booked-dates', (req, res) => {
  const bookings = loadBookings();
  const result = { heavenly: [], nua: [] };
  bookings.forEach(b => {
    if (b.property && b.checkin && b.checkout) {
      const prop = b.property.toLowerCase().includes('heavenly') ? 'heavenly' : 'nua';
      let cur = new Date(b.checkin + 'T00:00:00');
      const end = new Date(b.checkout + 'T00:00:00');
      while (cur < end) {
        const ymd = cur.toISOString().split('T')[0];
        result[prop].push(ymd);
        cur.setDate(cur.getDate() + 1);
      }
    }
  });
  res.json(result);
});

// ── SAVE BOOKING ──
app.post('/save-booking', (req, res) => {
  const bookings = loadBookings();
  const booking = { ...req.body, booked_at: new Date().toISOString() };
  bookings.push(booking);
  saveBookings(bookings);
  res.json({ success: true });
});

// ── ADMIN PAGE ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lupe2025';

app.get('/admin', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) {
    return res.send(`
      <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F7F4EF">
        <div style="text-align:center">
          <h2 style="font-family:Georgia,serif;color:#0F1923">Lupe Accommodations</h2>
          <p style="color:#8A8278;margin-bottom:20px">Admin access required</p>
          <form onsubmit="window.location.href='/admin?password='+document.getElementById('p').value;return false">
            <input id="p" type="password" placeholder="Password" style="padding:12px 16px;border:1.5px solid #ddd;border-radius:10px;font-size:15px;margin-right:8px">
            <button type="submit" style="padding:12px 20px;background:#0F1923;color:white;border:none;border-radius:10px;font-size:15px;cursor:pointer">Enter</button>
          </form>
        </div>
      </body></html>
    `);
  }
  const bookings = loadBookings();
  const rows = bookings.map(b => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:12px 8px">${b.booking_ref||'—'}</td>
      <td style="padding:12px 8px">${b.property||'—'}</td>
      <td style="padding:12px 8px">${b.checkin||'—'}</td>
      <td style="padding:12px 8px">${b.checkout||'—'}</td>
      <td style="padding:12px 8px">${b.name||'—'}</td>
      <td style="padding:12px 8px">${b.email||'—'}</td>
      <td style="padding:12px 8px">${b.phone||'—'}</td>
      <td style="padding:12px 8px">${b.guests||'—'}</td>
      <td style="padding:12px 8px;font-weight:600;color:#2C5F4A">$${b.deposit||'—'}</td>
      <td style="padding:12px 8px;font-size:12px;color:#8A8278">${b.extras||'None'}</td>
      <td style="padding:12px 8px">
        <button onclick="sendConfirmation(${JSON.stringify(b).replace(/"/g,'&quot;')})" style="background:#2C5F4A;color:white;border:none;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:sans-serif" id="btn-${b.booking_ref||'x'}">
          📧 Send confirmation
        </button>
      </td>
    </tr>
  `).reverse().join('');
  res.send(`
    <html><head><meta charset="UTF-8"><title>Lupe Bookings</title></head>
    <body style="font-family:sans-serif;margin:0;background:#F7F4EF;padding:24px">
      <div style="max-width:1400px;margin:0 auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
          <h1 style="font-family:Georgia,serif;color:#0F1923;margin:0">🌺 Lupe Bookings</h1>
          <span style="background:#0F1923;color:white;padding:8px 16px;border-radius:100px;font-size:13px">${bookings.length} booking${bookings.length!==1?'s':''}</span>
        </div>
        <div style="background:white;border-radius:16px;overflow:auto;box-shadow:0 2px 20px rgba(0,0,0,0.06)">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:#0F1923;color:white">
                <th style="padding:14px 8px;text-align:left">Ref</th>
                <th style="padding:14px 8px;text-align:left">Property</th>
                <th style="padding:14px 8px;text-align:left">Check-in</th>
                <th style="padding:14px 8px;text-align:left">Check-out</th>
                <th style="padding:14px 8px;text-align:left">Guest</th>
                <th style="padding:14px 8px;text-align:left">Email</th>
                <th style="padding:14px 8px;text-align:left">Phone</th>
                <th style="padding:14px 8px;text-align:left">Guests</th>
                <th style="padding:14px 8px;text-align:left">Deposit</th>
                <th style="padding:14px 8px;text-align:left">Extras</th>
                <th style="padding:14px 8px;text-align:left">Confirmation</th>
              </tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="11" style="padding:40px;text-align:center;color:#8A8278">No bookings yet</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </body>
    <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
    <script>
    emailjs.init("kmMmwZoCdFN4gKhH9");
    async function sendConfirmation(b){
      const btn=document.getElementById('btn-'+(b.booking_ref||'x'));
      btn.textContent='Sending...';btn.disabled=true;btn.style.background='#8A8278';
      const isHeavenly=(b.property||'').toLowerCase().includes('heavenly');
      const template=isHeavenly?'template_4oq7bmk':'template_rboo8yr';
      const params={
        guest_name:b.name||'Guest',
        email:b.email||'',
        guest_email:b.email||'',
        order_id:b.booking_ref||'',
        guest_phone:b.phone||'',
        property:b.property||'',
        checkin:b.checkin||'',
        checkout:b.checkout||'',
        nights:b.nights||'',
        guests:b.guests||'',
        total:b.total||'',
        deposit:b.deposit||'',
        balance:b.balance||'',
        booking_ref:b.booking_ref||'',
        cancellation_policy:b.cancellation_policy||'',
        requests:b.requests||'None',
        extras:b.extras||'None',
        extras_total:b.extras_total||'0'
      };
      try{
        await emailjs.send('service_04guqam',template,params,'kmMmwZoCdFN4gKhH9');
        btn.textContent='✅ Sent!';btn.style.background='#2C5F4A';
        setTimeout(()=>{btn.textContent='📧 Send confirmation';btn.disabled=false;},3000);
      }catch(err){
        btn.textContent='❌ Failed — try again';btn.style.background='#C0392B';btn.disabled=false;
        console.error('EmailJS error:',err);
      }
    }
    </script>
    </html>
  `);
});

// ── PAYMENT INTENT ──
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, metadata } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Invalid amount' });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency || 'aud',
      metadata: metadata || {},
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch(err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lupe server running on port ${PORT}`);
  console.log(`Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
});
