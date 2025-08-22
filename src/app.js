import express from 'express';
import pg from 'pg';
import Stripe from 'stripe';

const app = express();
app.use(express.json());

// Postgres (Supabase)
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Helpers
const toDate = (s) => new Date(`${s}T00:00:00.000Z`);
const nightsBetween = (a, b) => Math.ceil((toDate(b) - toDate(a)) / 86400000);
const bad = (msg) => ({ ok: false, error: msg });

async function getProperty({ id, slug }) {
  if (!id && !slug) return null;
  const q = id
    ? { sql: `select id, slug, name, currency, price_per_night_cents from properties where id = $1`, args: [id] }
    : { sql: `select id, slug, name, currency, price_per_night_cents from properties where slug = $1`, args: [slug] };
  const r = await pool.query(q.sql, q.args);
  return r.rowCount ? r.rows[0] : null;
}

// GET /availability?property_slug=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// oppure: ?property_id=...
app.get('/availability', async (req, res) => {
  try {
    const { property_slug, property_id, from, to } = req.query;
    if (!from || !to) return res.status(400).json(bad('from/to mancanti'));
    const prop = await getProperty({ id: property_id, slug: property_slug });
    if (!prop) return res.status(404).json(bad('property non trovata'));

    const { rows } = await pool.query(
      `select id, checkin, checkout, status
       from reservations
       where property_id = $1
         and status in ('pending','paid')
         and not (checkout <= $2 or checkin >= $3)
       order by checkin asc`,
      [prop.id, from, to]
    );

    res.json({
      ok: true,
      property: { id: prop.id, slug: prop.slug, name: prop.name },
      range: { from, to },
      occupied: rows.map(r => ({ id: r.id, checkin: r.checkin, checkout: r.checkout, status: r.status }))
    });
  } catch (e) {
    res.status(500).json(bad(e.message));
  }
});

// POST /quote  { property_slug|property_id, checkin, checkout, guests? }
app.post('/quote', async (req, res) => {
  try {
    const { property_slug, property_id, checkin, checkout } = req.body || {};
    if (!checkin || !checkout) return res.status(400).json(bad('checkin/checkout mancanti'));
    if (toDate(checkout) <= toDate(checkin)) return res.status(400).json(bad('checkout deve essere > checkin'));

    const prop = await getProperty({ id: property_id, slug: property_slug });
    if (!prop) return res.status(404).json(bad('property non trovata'));

    const nights = nightsBetween(checkin, checkout);
    const amountCents = nights * Number(prop.price_per_night_cents || 0);

    res.json({
      ok: true,
      property: { id: prop.id, slug: prop.slug, name: prop.name },
      checkin, checkout, nights,
      currency: prop.currency || 'EUR',
      price_per_night_cents: Number(prop.price_per_night_cents),
      total_cents: amountCents,
      total_formatted: `${(amountCents / 100).toFixed(2)} ${prop.currency || 'EUR'}`
    });
  } catch (e) {
    res.status(500).json(bad(e.message));
  }
});

// POST /checkout { property_slug|property_id, checkin, checkout, email, guests? }
app.post('/checkout', async (req, res) => {
  const client = await pool.connect();
  try {
    const { property_slug, property_id, checkin, checkout, email, guests = 1 } = req.body || {};
    if (!email) return res.status(400).json(bad('email mancante'));
    if (!checkin || !checkout) return res.status(400).json(bad('checkin/checkout mancanti'));
    if (toDate(checkout) <= toDate(checkin)) return res.status(400).json(bad('checkout deve essere > checkin'));

    const prop = await getProperty({ id: property_id, slug: property_slug });
    if (!prop) return res.status(404).json(bad('property non trovata'));

    // conflitti
    const conflicts = await client.query(
      `select 1 from reservations
       where property_id = $1
         and status in ('pending','paid')
         and not (checkout <= $2 or checkin >= $3)`,
      [prop.id, checkin, checkout]
    );
    if (conflicts.rowCount > 0) { return res.status(409).json(bad('date non disponibili')); }

    const nights = nightsBetween(checkin, checkout);
    const amountCents = nights * Number(prop.price_per_night_cents || 0);
    const currency = (prop.currency || 'EUR').toLowerCase();

    await client.query('BEGIN');
    const ins = await client.query(
      `insert into reservations (property_id, checkin, checkout, guests, email, status)
       values ($1,$2,$3,$4,$5,'pending') returning id`,
      [prop.id, checkin, checkout, guests, email]
    );
    const reservationId = ins.rows[0].id;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}&reservation_id=${reservationId}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel?reservation_id=${reservationId}`,
      customer_email: email,
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: `Soggiorno: ${prop.name}`,
            description: `${checkin} → ${checkout} · ${nights} notti`
          },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      metadata: {
        reservation_id: reservationId,
        property_id: prop.id,
        property_slug: prop.slug,
        checkin, checkout
      }
    });

    await client.query('COMMIT');
    res.status(201).json({ ok: true, reservation_id: reservationId, checkout_url: session.url, amount_cents: amountCents, currency: currency.toUpperCase() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json(bad(e.message));
  } finally {
    client.release();
  }
});

export default app;
