const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;
let clock;

beforeEach(async () => {
  clock = new Date('2026-03-10T12:00:00Z');
  const app = createApp(openDatabase(':memory:'), { now: () => clock });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}/api`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

async function setup() {
  const plan = (await call('POST', '/plans', { name: 'Monthly', duration_days: 30, price_cents: 5000 })).data;
  const member = (await call('POST', '/members', { first_name: 'Alex', last_name: 'Doe', email: 'Alex@Example.com' })).data;
  return { plan, member };
}

test('creates and lists members, normalising email', async () => {
  const { member } = await setup();
  assert.equal(member.email, 'alex@example.com');
  assert.equal(member.status, 'active');

  const list = await call('GET', '/members?q=ale');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].has_active_plan, false);
});

test('rejects invalid member input and duplicate email', async () => {
  await setup();
  assert.equal((await call('POST', '/members', { first_name: 'A', last_name: 'B', email: 'nope' })).status, 400);
  assert.equal((await call('POST', '/members', { last_name: 'B', email: 'b@x.io' })).status, 400);
  const dup = await call('POST', '/members', { first_name: 'A', last_name: 'B', email: 'alex@example.com' });
  assert.equal(dup.status, 409);
});

test('updates and deletes a member', async () => {
  const { member } = await setup();
  const updated = await call('PATCH', `/members/${member.id}`, { phone: '555-1234', status: 'inactive' });
  assert.equal(updated.data.phone, '555-1234');
  assert.equal(updated.data.status, 'inactive');
  assert.equal((await call('DELETE', `/members/${member.id}`)).status, 204);
  assert.equal((await call('GET', `/members/${member.id}`)).status, 404);
});

test('selling a plan creates a subscription and payment', async () => {
  const { plan, member } = await setup();
  const sub = await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id, method: 'card' });
  assert.equal(sub.status, 201);
  assert.equal(sub.data.start_date, '2026-03-10');
  assert.equal(sub.data.end_date, '2026-04-08');

  const detail = (await call('GET', `/members/${member.id}`)).data;
  assert.equal(detail.active_subscription.id, sub.data.id);
  assert.equal(detail.payments.length, 1);
  assert.equal(detail.payments[0].amount_cents, 5000);
  assert.equal(detail.payments[0].method, 'card');
});

test('renewals stack after the current membership ends', async () => {
  const { plan, member } = await setup();
  await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id });
  const renewal = await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id });
  assert.equal(renewal.data.start_date, '2026-04-09');
  assert.equal(renewal.data.end_date, '2026-05-08');
});

test('cannot sell a retired plan', async () => {
  const { plan, member } = await setup();
  await call('PATCH', `/plans/${plan.id}`, { active: false });
  const res = await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id });
  assert.equal(res.status, 400);
});

test('check-in requires an active membership', async () => {
  const { plan, member } = await setup();
  const denied = await call('POST', '/checkins', { member_id: member.id });
  assert.equal(denied.status, 409);
  assert.match(denied.data.error, /no active membership/);

  await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id });
  const ok = await call('POST', '/checkins', { member_id: member.id });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.subscription.plan_name, 'Monthly');

  const today = await call('GET', '/checkins');
  assert.equal(today.data.length, 1);
});

test('check-in is refused once the membership expires', async () => {
  const { plan, member } = await setup();
  await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id });
  clock = new Date('2026-04-09T08:00:00Z');
  const res = await call('POST', '/checkins', { member_id: member.id });
  assert.equal(res.status, 409);
});

test('inactive members cannot check in', async () => {
  const { plan, member } = await setup();
  await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id });
  await call('PATCH', `/members/${member.id}`, { status: 'inactive' });
  const res = await call('POST', '/checkins', { member_id: member.id });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /inactive/);
});

test('dashboard summarises the gym', async () => {
  const { plan, member } = await setup();
  await call('POST', `/members/${member.id}/subscriptions`, { plan_id: plan.id });
  await call('POST', '/checkins', { member_id: member.id });
  await call('POST', '/payments', { member_id: member.id, amount_cents: 1500, method: 'cash', note: 'Towel' });

  clock = new Date('2026-04-03T09:00:00Z');
  const d = (await call('GET', '/dashboard')).data;
  assert.equal(d.total_members, 1);
  assert.equal(d.active_memberships, 1);
  assert.equal(d.checkins_today, 0);
  assert.equal(d.expiring_soon.length, 1);
  assert.equal(d.expiring_soon[0].end_date, '2026-04-08');
});

test('unknown API routes return 404 JSON', async () => {
  const res = await call('GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'not found');
});
