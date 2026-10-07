// Fills the database with a few plans and members so the app has something to show.
const { openDatabase } = require('./db');
const { addDays, toDateString } = require('./app');

const db = openDatabase();
const today = toDateString(new Date());

if (db.prepare('SELECT COUNT(*) AS n FROM plans').get().n > 0) {
  console.log('Database already has data; skipping seed.');
  process.exit(0);
}

const plans = [
  ['Day Pass', 1, 1000, 'Single-day access'],
  ['Monthly', 30, 5000, 'Unlimited access for 30 days'],
  ['Quarterly', 90, 13500, 'Unlimited access for 90 days'],
  ['Annual', 365, 48000, 'Unlimited access for a full year'],
];
const insertPlan = db.prepare('INSERT INTO plans (name, duration_days, price_cents, description) VALUES (?, ?, ?, ?)');
const planIds = plans.map((p) => Number(insertPlan.run(...p).lastInsertRowid));

const members = [
  ['Alex', 'Johnson', 'alex@example.com', '555-0101', 1, -10],
  ['Sam', 'Lee', 'sam@example.com', '555-0102', 2, -85],
  ['Jordan', 'Smith', 'jordan@example.com', '555-0103', 1, -40],
  ['Taylor', 'Brown', 'taylor@example.com', '555-0104', 3, -100],
  ['Riley', 'Garcia', 'riley@example.com', '555-0105', null, 0],
];
const insertMember = db.prepare('INSERT INTO members (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)');
const insertSub = db.prepare('INSERT INTO subscriptions (member_id, plan_id, start_date, end_date) VALUES (?, ?, ?, ?)');
const insertPayment = db.prepare(
  'INSERT INTO payments (member_id, subscription_id, amount_cents, method, paid_at, note) VALUES (?, ?, ?, ?, ?, ?)',
);

for (const [first, last, email, phone, planIndex, startOffset] of members) {
  const memberId = Number(insertMember.run(first, last, email, phone).lastInsertRowid);
  if (planIndex === null) continue;
  const [name, days, price] = plans[planIndex];
  const start = addDays(today, startOffset);
  const end = addDays(start, days - 1);
  const subId = Number(insertSub.run(memberId, planIds[planIndex], start, end).lastInsertRowid);
  insertPayment.run(memberId, subId, price, 'card', `${start} 09:00:00`, `${name} (${start} to ${end})`);
}

console.log(`Seeded ${plans.length} plans and ${members.length} members.`);
