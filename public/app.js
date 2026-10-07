const $ = (sel) => document.querySelector(sel);

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const fullName = (m) => `${m.first_name} ${m.last_name}`;

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2500);
}

function rows(tbody, items, render, columns) {
  $(tbody).innerHTML = items.length
    ? items.map(render).join('')
    : `<tr><td class="empty" colspan="${columns}">Nothing here yet</td></tr>`;
}

function membershipBadge(m) {
  if (m.has_active_plan) return `<span class="badge ok">Until ${esc(m.membership_end)}</span>`;
  if (m.membership_end) return `<span class="badge bad">Expired ${esc(m.membership_end)}</span>`;
  return '<span class="badge warn">None</span>';
}

// ---------- Navigation ----------

const loaders = {
  dashboard: loadDashboard,
  checkin: loadCheckins,
  members: loadMembers,
  plans: loadPlans,
  payments: loadPayments,
};

function show(view) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  loaders[view]().catch((err) => toast(err.message));
}

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- Dashboard ----------

async function loadDashboard() {
  const d = await api('/dashboard');
  $('#stats').innerHTML = [
    ['Members', d.total_members],
    ['Active memberships', d.active_memberships],
    ['Check-ins today', d.checkins_today],
    ['Revenue this month', money(d.revenue_this_month_cents)],
  ]
    .map(([label, value]) => `<div class="stat"><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`)
    .join('');
  rows(
    '#expiring',
    d.expiring_soon,
    (m) => `<tr class="clickable" data-member="${m.id}"><td>${esc(fullName(m))}</td><td>${esc(m.email)}</td><td>${esc(m.end_date)}</td></tr>`,
    3,
  );
}

// ---------- Check-in ----------

let checkinMatches = [];

$('#checkin-search').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  if (q.length < 2) return;
  checkinMatches = await api(`/members?q=${encodeURIComponent(q)}`);
  $('#checkin-options').innerHTML = checkinMatches
    .map((m) => `<option value="${esc(`${fullName(m)} <${m.email}>`)}"></option>`)
    .join('');
});

$('#checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#checkin-search');
  const value = input.value.trim();
  const member =
    checkinMatches.find((m) => `${fullName(m)} <${m.email}>` === value) ||
    (checkinMatches.length === 1 ? checkinMatches[0] : null);
  const result = $('#checkin-result');
  if (!member) {
    result.innerHTML = '<div class="result bad">Pick a member from the list.</div>';
    return;
  }
  try {
    const c = await api('/checkins', { method: 'POST', body: { member_id: member.id } });
    result.innerHTML = `<div class="result ok">Welcome, ${esc(fullName(member))}! ${esc(c.subscription.plan_name)} valid until ${esc(c.subscription.end_date)}.</div>`;
    input.value = '';
    loadCheckins();
  } catch (err) {
    result.innerHTML = `<div class="result bad">${esc(fullName(member))}: ${esc(err.message)}</div>`;
  }
});

async function loadCheckins() {
  const list = await api('/checkins');
  rows(
    '#checkins',
    list,
    (c) => `<tr class="clickable" data-member="${c.member_id}"><td>${esc(c.checked_in_at.slice(11, 16))}</td><td>${esc(fullName(c))}</td></tr>`,
    2,
  );
}

// ---------- Members ----------

let searchTimer;
$('#member-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMembers, 200);
});

async function loadMembers() {
  const q = $('#member-search').value.trim();
  const list = await api(`/members?q=${encodeURIComponent(q)}`);
  rows(
    '#members',
    list,
    (m) => `<tr class="clickable" data-member="${m.id}">
      <td>${esc(fullName(m))}</td><td>${esc(m.email)}</td><td>${esc(m.phone)}</td>
      <td>${membershipBadge(m)}</td>
      <td><span class="badge ${m.status === 'active' ? 'ok' : 'warn'}">${esc(m.status)}</span></td></tr>`,
    5,
  );
}

let editingMemberId = null;

function openMemberForm(member = null) {
  editingMemberId = member?.id ?? null;
  const form = $('#member-form');
  form.reset();
  $('#member-error').textContent = '';
  $('#member-dialog-title').textContent = member ? 'Edit member' : 'New member';
  if (member) {
    for (const field of ['first_name', 'last_name', 'email', 'phone', 'birth_date', 'status']) {
      form.elements[field].value = member[field] ?? '';
    }
  }
  $('#member-dialog').showModal();
}

$('#new-member').addEventListener('click', () => openMemberForm());

$('#member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const saved = editingMemberId
      ? await api(`/members/${editingMemberId}`, { method: 'PATCH', body })
      : await api('/members', { method: 'POST', body });
    $('#member-dialog').close();
    toast('Member saved');
    loadMembers();
    if (editingMemberId) openMemberDetail(saved.id);
  } catch (err) {
    $('#member-error').textContent = err.message;
  }
});

async function openMemberDetail(id) {
  const [m, plans] = await Promise.all([api(`/members/${id}`), api('/plans')]);
  const active = m.active_subscription;
  const planOptions = plans
    .filter((p) => p.active)
    .map((p) => `<option value="${p.id}">${esc(p.name)} (${p.duration_days} days, ${money(p.price_cents)})</option>`)
    .join('');

  $('#detail').innerHTML = `
    <h2>${esc(fullName(m))}</h2>
    <p>${esc(m.email)}${m.phone ? ` · ${esc(m.phone)}` : ''}<br>
      Status: <span class="badge ${m.status === 'active' ? 'ok' : 'warn'}">${esc(m.status)}</span>
      ${active ? `· <span class="badge ok">${esc(active.plan_name)} until ${esc(active.end_date)}</span>` : '· <span class="badge bad">No active membership</span>'}
    </p>
    <div class="actions" style="justify-content:flex-start">
      <button class="small" id="detail-checkin">Check in</button>
      <button class="small secondary" id="detail-edit">Edit</button>
      <button class="small secondary" id="detail-delete">Delete</button>
    </div>

    <h2>Sell membership</h2>
    ${planOptions ? `<form id="sell-form" class="inline">
      <select name="plan_id">${planOptions}</select>
      <select name="method"><option value="cash">Cash</option><option value="card">Card</option><option value="transfer">Transfer</option></select>
      <button type="submit" class="small">Sell &amp; record payment</button>
    </form>` : '<p>No active plans. Add one under Plans.</p>'}

    <h2>Membership history</h2>
    <div class="table-wrap"><table><tbody>${
      m.subscriptions.map((s) => `<tr><td>${esc(s.plan_name)}</td><td>${esc(s.start_date)} → ${esc(s.end_date)}</td></tr>`).join('') ||
      '<tr><td class="empty">None</td></tr>'
    }</tbody></table></div>

    <h2>Payments</h2>
    <div class="table-wrap"><table><tbody>${
      m.payments.map((p) => `<tr><td>${esc(p.paid_at.slice(0, 10))}</td><td>${money(p.amount_cents)}</td><td>${esc(p.method)}</td></tr>`).join('') ||
      '<tr><td class="empty">None</td></tr>'
    }</tbody></table></div>

    <h2>Recent check-ins</h2>
    <div class="table-wrap"><table><tbody>${
      m.checkins.map((c) => `<tr><td>${esc(c.checked_in_at)}</td></tr>`).join('') || '<tr><td class="empty">None</td></tr>'
    }</tbody></table></div>

    <div class="actions"><button class="secondary" data-close>Close</button></div>`;

  const dialog = $('#detail-dialog');
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  $('#detail-edit').addEventListener('click', () => {
    dialog.close();
    openMemberForm(m);
  });

  $('#detail-delete').addEventListener('click', async () => {
    if (!confirm(`Delete ${fullName(m)} and all their history?`)) return;
    await api(`/members/${m.id}`, { method: 'DELETE' });
    dialog.close();
    toast('Member deleted');
    refreshCurrent();
  });

  $('#detail-checkin').addEventListener('click', async () => {
    try {
      await api('/checkins', { method: 'POST', body: { member_id: m.id } });
      toast(`${fullName(m)} checked in`);
      openMemberDetail(m.id);
    } catch (err) {
      toast(err.message);
    }
  });

  $('#sell-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const s = await api(`/members/${m.id}/subscriptions`, { method: 'POST', body: { ...body, plan_id: Number(body.plan_id) } });
      toast(`${s.plan_name} sold: ${s.start_date} → ${s.end_date}`);
      openMemberDetail(m.id);
      refreshCurrent();
    } catch (err) {
      toast(err.message);
    }
  });

  if (!dialog.open) dialog.showModal();
}

function refreshCurrent() {
  const current = document.querySelector('nav button.active').dataset.view;
  loaders[current]().catch((err) => toast(err.message));
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-member]');
  if (row) openMemberDetail(Number(row.dataset.member)).catch((err) => toast(err.message));
});

// ---------- Plans ----------

async function loadPlans() {
  const list = await api('/plans');
  rows(
    '#plans',
    list,
    (p) => `<tr>
      <td>${esc(p.name)}</td><td>${p.duration_days} days</td><td>${money(p.price_cents)}</td><td>${esc(p.description)}</td>
      <td><span class="badge ${p.active ? 'ok' : 'warn'}">${p.active ? 'active' : 'retired'}</span></td>
      <td><button class="small secondary" data-toggle-plan="${p.id}" data-active="${p.active}">${p.active ? 'Retire' : 'Reactivate'}</button></td></tr>`,
    6,
  );
}

$('#plans').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-toggle-plan]');
  if (!btn) return;
  await api(`/plans/${btn.dataset.togglePlan}`, { method: 'PATCH', body: { active: btn.dataset.active !== '1' } });
  loadPlans();
});

$('#plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await api('/plans', {
      method: 'POST',
      body: {
        name: f.name,
        duration_days: Number(f.duration_days),
        price_cents: Math.round(Number(f.price) * 100),
        description: f.description,
      },
    });
    e.target.reset();
    toast('Plan added');
    loadPlans();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Payments ----------

async function loadPayments() {
  const list = await api('/payments');
  rows(
    '#payments',
    list,
    (p) => `<tr class="clickable" data-member="${p.member_id}">
      <td>${esc(p.paid_at.slice(0, 16))}</td><td>${esc(fullName(p))}</td><td>${money(p.amount_cents)}</td>
      <td>${esc(p.method)}</td><td>${esc(p.note)}</td></tr>`,
    5,
  );
}

show('dashboard');
