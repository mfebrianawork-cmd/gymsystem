# Gym System

A small gym management app: members, membership plans, subscriptions, payments and front-desk check-ins, with a web UI.

Built with Node.js, Express and Node's built-in SQLite (`node:sqlite`), so there is no database server to install.

## Features

- **Dashboard**: member count, active memberships, today's check-ins, revenue this month, and memberships expiring in the next 7 days.
- **Members**: add, edit, search, deactivate and delete members; view each member's membership history, payments and recent check-ins.
- **Plans**: define plans by duration and price (for example Day Pass, Monthly, Annual); retire plans you no longer sell.
- **Selling memberships**: sell a plan and record its payment in one step. Renewals stack: buying again before the current membership ends starts the new period the day after it.
- **Check-in**: search a member and check them in. Check-in is refused if the member is inactive or has no current membership.
- **Payments**: a log of all payments (cash, card or transfer).

## Getting started

Requires Node.js 22.13 or newer.

```bash
npm install
npm run seed   # optional: sample plans and members
npm start      # http://localhost:3000
```

Configuration via environment variables:

| Variable  | Default       | Purpose                  |
|-----------|---------------|--------------------------|
| `PORT`    | `3000`        | HTTP port                |
| `DB_FILE` | `data/gym.db` | SQLite database location |

Run the tests with `npm test`.

## API

All endpoints are JSON under `/api`. Money is in cents; dates are `YYYY-MM-DD` (UTC).

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/dashboard` | Summary stats |
| GET    | `/api/members?q=` | List/search members |
| POST   | `/api/members` | Create member (`first_name`, `last_name`, `email`, optional `phone`, `birth_date`, `status`) |
| GET    | `/api/members/:id` | Member with subscriptions, payments and check-ins |
| PATCH  | `/api/members/:id` | Update member |
| DELETE | `/api/members/:id` | Delete member and their history |
| POST   | `/api/members/:id/subscriptions` | Sell a plan (`plan_id`, optional `start_date`, `method`, `payment: false` to skip recording a payment) |
| GET    | `/api/plans` | List plans |
| POST   | `/api/plans` | Create plan (`name`, `duration_days`, `price_cents`, optional `description`) |
| PATCH  | `/api/plans/:id` | Update plan, e.g. `{ "active": false }` to retire it |
| GET    | `/api/payments` | Latest 200 payments |
| POST   | `/api/payments` | Record an extra payment (`member_id`, `amount_cents`, `method`, `note`) |
| GET    | `/api/checkins?date=` | Check-ins for a day (default today) |
| POST   | `/api/checkins` | Check a member in (`member_id`); `409` if not allowed |

## Project layout

```
src/db.js       database schema and connection
src/app.js      Express app and API routes
src/server.js   entry point
src/seed.js     sample data
public/         web UI (plain HTML/CSS/JS)
test/           API tests (node:test)
```

## Not included yet

There is no login or staff accounts yet, so only run it on a trusted network. Natural next steps: staff authentication, class scheduling and bookings, and trainer management.
