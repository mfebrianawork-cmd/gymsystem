const path = require('node:path');
const express = require('express');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_METHODS = ['cash', 'card', 'transfer'];

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

function isValidDate(value) {
  return DATE_RE.test(value) && toDateString(new Date(`${value}T00:00:00Z`)) === value;
}

function requireString(body, field, { required = true, max = 200 } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${field} is required`);
  if (trimmed.length > max) throw new HttpError(400, `${field} is too long`);
  return trimmed || null;
}

function requireInt(body, field, { required = true, min = 0 } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${field} must be an integer >= ${min}`);
  return n;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid id');
  return id;
}

function validateMember(body, { partial = false } = {}) {
  const out = {};
  const has = (f) => !partial || body[f] !== undefined;
  if (has('first_name')) out.first_name = requireString(body, 'first_name', { max: 100 });
  if (has('last_name')) out.last_name = requireString(body, 'last_name', { max: 100 });
  if (has('email')) {
    out.email = requireString(body, 'email', { max: 200 }).toLowerCase();
    if (!EMAIL_RE.test(out.email)) throw new HttpError(400, 'email is invalid');
  }
  if (has('phone')) out.phone = requireString(body, 'phone', { required: false, max: 40 });
  if (has('birth_date')) {
    out.birth_date = requireString(body, 'birth_date', { required: false });
    if (out.birth_date && !isValidDate(out.birth_date)) throw new HttpError(400, 'birth_date must be YYYY-MM-DD');
  }
  if (has('status')) {
    out.status = requireString(body, 'status', { required: false }) ?? 'active';
    if (!['active', 'inactive'].includes(out.status)) throw new HttpError(400, 'status must be active or inactive');
  }
  return out;
}

function validatePlan(body, { partial = false } = {}) {
  const out = {};
  const has = (f) => !partial || body[f] !== undefined;
  if (has('name')) out.name = requireString(body, 'name', { max: 100 });
  if (has('duration_days')) out.duration_days = requireInt(body, 'duration_days', { min: 1 });
  if (has('price_cents')) out.price_cents = requireInt(body, 'price_cents', { min: 0 });
  if (has('description')) out.description = requireString(body, 'description', { required: false, max: 500 });
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return out;
}

function createApp(db, { now = () => new Date() } = {}) {
  const app = express();
  app.use(express.json());

  const today = () => toDateString(now());

  // Run fn inside a transaction, rolling back on any error.
  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getMember(id) {
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!member) throw new HttpError(404, 'member not found');
    return member;
  }

  function getPlan(id) {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    if (!plan) throw new HttpError(404, 'plan not found');
    return plan;
  }

  function activeSubscription(memberId, date = today()) {
    return db
      .prepare(
        `SELECT s.*, p.name AS plan_name FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         WHERE s.member_id = ? AND s.start_date <= ? AND s.end_date >= ?
         ORDER BY s.end_date DESC LIMIT 1`,
      )
      .get(memberId, date, date);
  }

  function update(table, id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) throw new HttpError(400, 'no fields to update');
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  }

  function insert(table, fields) {
    const keys = Object.keys(fields);
    const placeholders = keys.map(() => '?').join(', ');
    const result = db
      .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`)
      .run(...keys.map((k) => fields[k]));
    return Number(result.lastInsertRowid);
  }

  // ---------- Members ----------

  app.get('/api/members', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const like = `%${q}%`;
    const date = today();
    const rows = db
      .prepare(
        `SELECT m.*,
           (SELECT MAX(s.end_date) FROM subscriptions s WHERE s.member_id = m.id) AS membership_end,
           EXISTS (SELECT 1 FROM subscriptions s
                   WHERE s.member_id = m.id AND s.start_date <= ? AND s.end_date >= ?) AS has_active_plan
         FROM members m
         WHERE ? = '' OR m.first_name LIKE ? OR m.last_name LIKE ? OR m.email LIKE ? OR m.phone LIKE ?
         ORDER BY m.last_name, m.first_name`,
      )
      .all(date, date, q, like, like, like, like);
    res.json(rows.map((r) => ({ ...r, has_active_plan: Boolean(r.has_active_plan) })));
  });

  app.post('/api/members', (req, res) => {
    const fields = validateMember(req.body ?? {});
    const id = insert('members', fields);
    res.status(201).json(getMember(id));
  });

  app.get('/api/members/:id', (req, res) => {
    const id = parseId(req.params.id);
    const member = getMember(id);
    const subscriptions = db
      .prepare(
        `SELECT s.*, p.name AS plan_name FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id WHERE s.member_id = ? ORDER BY s.start_date DESC`,
      )
      .all(id);
    const payments = db
      .prepare('SELECT * FROM payments WHERE member_id = ? ORDER BY paid_at DESC')
      .all(id);
    const checkins = db
      .prepare('SELECT * FROM checkins WHERE member_id = ? ORDER BY checked_in_at DESC LIMIT 20')
      .all(id);
    res.json({ ...member, active_subscription: activeSubscription(id) ?? null, subscriptions, payments, checkins });
  });

  app.patch('/api/members/:id', (req, res) => {
    const id = parseId(req.params.id);
    getMember(id);
    update('members', id, validateMember(req.body ?? {}, { partial: true }));
    res.json(getMember(id));
  });

  app.delete('/api/members/:id', (req, res) => {
    const id = parseId(req.params.id);
    getMember(id);
    db.prepare('DELETE FROM members WHERE id = ?').run(id);
    res.status(204).end();
  });

  // ---------- Plans ----------

  app.get('/api/plans', (req, res) => {
    res.json(db.prepare('SELECT * FROM plans ORDER BY active DESC, duration_days').all());
  });

  app.post('/api/plans', (req, res) => {
    const fields = validatePlan(req.body ?? {});
    const id = insert('plans', fields);
    res.status(201).json(getPlan(id));
  });

  app.patch('/api/plans/:id', (req, res) => {
    const id = parseId(req.params.id);
    getPlan(id);
    update('plans', id, validatePlan(req.body ?? {}, { partial: true }));
    res.json(getPlan(id));
  });

  // ---------- Subscriptions ----------

  // Sell a plan to a member. If they already have time left, the new period
  // starts the day after the current one ends so renewals stack.
  app.post('/api/members/:id/subscriptions', (req, res) => {
    const memberId = parseId(req.params.id);
    const body = req.body ?? {};
    getMember(memberId);
    const plan = getPlan(requireInt(body, 'plan_id', { min: 1 }));
    if (!plan.active) throw new HttpError(400, 'plan is not active');

    let startDate = requireString(body, 'start_date', { required: false });
    if (startDate) {
      if (!isValidDate(startDate)) throw new HttpError(400, 'start_date must be YYYY-MM-DD');
    } else {
      const { last_end: lastEnd } = db
        .prepare('SELECT MAX(end_date) AS last_end FROM subscriptions WHERE member_id = ?')
        .get(memberId);
      startDate = lastEnd && lastEnd >= today() ? addDays(lastEnd, 1) : today();
    }
    const endDate = addDays(startDate, plan.duration_days - 1);

    const pay = body.payment !== false;
    let method = 'cash';
    if (pay && body.method !== undefined) {
      method = body.method;
      if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, `method must be one of ${PAYMENT_METHODS.join(', ')}`);
    }

    const subscription = transaction(() => {
      const subscriptionId = insert('subscriptions', {
        member_id: memberId,
        plan_id: plan.id,
        start_date: startDate,
        end_date: endDate,
      });
      if (pay) {
        insert('payments', {
          member_id: memberId,
          subscription_id: subscriptionId,
          amount_cents: plan.price_cents,
          method,
          note: `${plan.name} (${startDate} to ${endDate})`,
        });
      }
      db.prepare("UPDATE members SET status = 'active' WHERE id = ?").run(memberId);
      return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId);
    });
    res.status(201).json({ ...subscription, plan_name: plan.name });
  });

  // ---------- Payments ----------

  app.get('/api/payments', (req, res) => {
    const rows = db
      .prepare(
        `SELECT p.*, m.first_name, m.last_name FROM payments p
         JOIN members m ON m.id = p.member_id ORDER BY p.paid_at DESC, p.id DESC LIMIT 200`,
      )
      .all();
    res.json(rows);
  });

  app.post('/api/payments', (req, res) => {
    const body = req.body ?? {};
    const memberId = requireInt(body, 'member_id', { min: 1 });
    getMember(memberId);
    const method = body.method ?? 'cash';
    if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, `method must be one of ${PAYMENT_METHODS.join(', ')}`);
    const id = insert('payments', {
      member_id: memberId,
      amount_cents: requireInt(body, 'amount_cents', { min: 0 }),
      method,
      note: requireString(body, 'note', { required: false, max: 500 }),
    });
    res.status(201).json(db.prepare('SELECT * FROM payments WHERE id = ?').get(id));
  });

  // ---------- Check-ins ----------

  app.get('/api/checkins', (req, res) => {
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : today();
    if (!isValidDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const rows = db
      .prepare(
        `SELECT c.*, m.first_name, m.last_name FROM checkins c
         JOIN members m ON m.id = c.member_id
         WHERE date(c.checked_in_at) = ? ORDER BY c.checked_in_at DESC, c.id DESC`,
      )
      .all(date);
    res.json(rows);
  });

  app.post('/api/checkins', (req, res) => {
    const memberId = requireInt(req.body ?? {}, 'member_id', { min: 1 });
    const member = getMember(memberId);
    if (member.status !== 'active') throw new HttpError(409, 'member is inactive');
    const subscription = activeSubscription(memberId);
    if (!subscription) throw new HttpError(409, 'member has no active membership');
    const id = insert('checkins', {
      member_id: memberId,
      checked_in_at: now().toISOString().replace('T', ' ').slice(0, 19),
    });
    res.status(201).json({
      ...db.prepare('SELECT * FROM checkins WHERE id = ?').get(id),
      member,
      subscription,
    });
  });

  // ---------- Dashboard ----------

  app.get('/api/dashboard', (req, res) => {
    const date = today();
    const monthStart = `${date.slice(0, 7)}-01`;
    const soon = addDays(date, 7);
    const one = (sql, ...params) => Object.values(db.prepare(sql).get(...params))[0];

    res.json({
      date,
      total_members: one('SELECT COUNT(*) FROM members'),
      active_memberships: one(
        `SELECT COUNT(DISTINCT member_id) FROM subscriptions WHERE start_date <= ? AND end_date >= ?`,
        date,
        date,
      ),
      checkins_today: one('SELECT COUNT(*) FROM checkins WHERE date(checked_in_at) = ?', date),
      revenue_this_month_cents: one(
        'SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE date(paid_at) >= ? AND date(paid_at) <= ?',
        monthStart,
        date,
      ),
      // Members whose latest membership ends within the next 7 days.
      expiring_soon: db
        .prepare(
          `SELECT m.id, m.first_name, m.last_name, m.email, MAX(s.end_date) AS end_date
           FROM members m JOIN subscriptions s ON s.member_id = m.id
           GROUP BY m.id HAVING MAX(s.end_date) BETWEEN ? AND ?
           ORDER BY end_date`,
        )
        .all(date, soon),
    });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message)) {
      const field = err.message.split('.').pop();
      return res.status(409).json({ error: `${field} already exists` });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp, addDays, toDateString };
