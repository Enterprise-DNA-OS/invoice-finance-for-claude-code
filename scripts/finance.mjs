#!/usr/bin/env node
// invoice-finance-for-claude-code: the one CLI. Claude Code slash commands call
// this; so can you.
//
//   node scripts/finance.mjs <command> [args] [--flags] [--json]
//   npm run finance -- <command> ...
//
// Run with no arguments (or `help`) for the command list.
//
// This system holds an invoice finance lender's book: clients, debtors,
// schedules of invoices, verification, notices of assignment, advances and
// releases, collections, credit notes, disputes, recourse, fees and each
// client's funds in use. It records money the bank has already moved; it never
// moves any. It records registrations and credit decisions; it never makes one.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb, REPO_ROOT } from './lib/db.mjs';
import { parseCsv, pick } from './lib/csv.mjs';
import { table as fmtTable, price, isoDate, truncate, heading as fmtHeading } from './lib/format.mjs';

// Print helpers: columns as [key, label, format]. Money and percentages align right.
function table(rows, cols) {
  console.log(fmtTable(rows, cols.map(([key, label, format]) => ({ key, label, format, align: format === $ || format === pct ? 'right' : 'left' }))));
}
function heading(text) { console.log(fmtHeading(text)); }

// ---------------------------------------------------------------- arguments

const BOOL_FLAGS = new Set(['json', 'help', 'open', 'apply', 'dry-run', 'ineligible', 'all']);

function parseArgv(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name; let value;
      if (eq > -1) { name = a.slice(2, eq); value = a.slice(eq + 1); }
      else {
        name = a.slice(2);
        const next = argv[i + 1];
        if (BOOL_FLAGS.has(name) || next === undefined || next.startsWith('--')) value = true;
        else value = argv[++i];
      }
      flags[name] = value;
    } else args.push(a);
  }
  return { args, flags };
}

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

const num = (v) => Number(v ?? 0);
const str = (v) => (v === true || v === undefined || v === null ? '' : String(v));

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseDate(v, what = 'date') {
  if (!v || v === true) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const lower = s.toLowerCase();
  if (lower === 'today') return today();
  if (lower === 'yesterday') return addDays(today(), -1);
  if (lower === 'tomorrow') return addDays(today(), 1);
  // Australian and New Zealand exports write DD/MM/YYYY.
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  throw new CliError(`"${v}" is not a ${what}. Use YYYY-MM-DD.`);
}

function parseMoney(v, what = 'amount') {
  if (v === undefined || v === null || v === '' || v === true) throw new CliError(`Give the ${what} in dollars, for example 2500 or 12500.50.`);
  const s = String(v).replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ''));
  if (!Number.isFinite(n)) throw new CliError(`"${v}" is not an amount.`);
  return Math.round((neg ? -n : n) * 100);
}

function actorOf(flags) {
  const a = str(flags.actor) || process.env.FINANCE_ACTOR || '';
  if (!a.trim()) throw new CliError('Name who is doing this: --actor="Your name" (or set FINANCE_ACTOR). Every change is recorded against a person.');
  return a.trim();
}

let CURRENCY = 'AUD';
const $ = (cents) => price(cents, CURRENCY);
const pct = (v) => (v === null || v === undefined ? '' : `${Number(v).toFixed(1)}%`);

// ---------------------------------------------------------------- lookups

const RESOLVERS = {
  client: {
    from: 'clients c',
    cols: 'c.*',
    exact: 'lower(c.code) = lower($1) or lower(c.name) = lower($1) or lower(coalesce(c.business_number, \'\')) = lower($1)',
    fuzzy: 'c.code ilike $1 or c.name ilike $1',
    label: (r) => `${r.code}  ${r.name} (${r.status})`,
  },
  debtor: {
    from: 'debtors c',
    cols: 'c.*',
    exact: 'lower(c.name) = lower($1) or lower(coalesce(c.business_number, \'\')) = lower($1)',
    fuzzy: 'c.name ilike $1',
    label: (r) => `${r.name} (${r.status})`,
  },
  invoice: {
    from: 'invoices c join clients k on k.id = c.client_id join debtors d on d.id = c.debtor_id',
    cols: 'c.*, k.code as client_code, d.name as debtor_name',
    exact: 'lower(c.invoice_no) = lower($1) or lower(k.code || \':\' || c.invoice_no) = lower($1)',
    fuzzy: 'c.invoice_no ilike $1',
    label: (r) => `${r.client_code}:${r.invoice_no}  ${r.debtor_name} ${$(r.face_cents)}`,
  },
};

async function resolve(db, kind, ref) {
  const r = RESOLVERS[kind];
  if (!ref) throw new CliError(`Name the ${kind}.`);
  let rows = await db.query(`select ${r.cols} from ${r.from} where ${r.exact}`, [ref]);
  if (!rows.length && /^[0-9a-f-]{6,}$/i.test(ref)) rows = await db.query(`select ${r.cols} from ${r.from} where c.id::text like $1`, [`${ref.toLowerCase()}%`]);
  if (!rows.length) rows = await db.query(`select ${r.cols} from ${r.from} where ${r.fuzzy} limit 20`, [`%${ref}%`]);
  if (!rows.length) throw new CliError(`No ${kind} matches "${ref}".`);
  if (rows.length > 1) {
    throw new CliError(`"${ref}" matches ${rows.length} ${kind} records. Be more specific:\n${rows.map((x) => `  ${r.label(x)}`).join('\n')}`);
  }
  return rows[0];
}

async function record(db, actor, action, subject, detail = null) {
  await db.query('insert into history (actor, action, subject, detail) values ($1, $2, $3, $4)', [actor, action, subject, detail ? JSON.stringify(detail) : null]);
}

async function settings(db) {
  const [s] = await db.query('select * from settings');
  if (!s) throw new CliError('No settings row. Run npm run demo for the demo, or insert your lender details into settings first.');
  CURRENCY = s.currency;
  return s;
}

async function tx(db, fn) {
  await db.exec('BEGIN');
  try {
    const out = await fn();
    await db.exec('COMMIT');
    return out;
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------- output

function out(flags, data, human) {
  if (flags.json) { console.log(JSON.stringify(data, null, 2)); return; }
  human(data);
}

// ---------------------------------------------------------------- reads: clients and debtors

async function cmdClients(db, { flags }) {
  const where = flags.all ? '' : "where p.status <> 'exited'";
  const rows = await db.query(`select p.code, p.name, p.status, p.facility_type, p.facility_limit_cents, p.advance_pct, p.ledger_cents, p.eligible_cents, p.funds_in_use_cents, p.available_cents, c.manager
    from v_availability p join clients c on c.id = p.client_id ${where} order by p.code`);
  out(flags, rows, (r) => {
    heading(`Clients (${r.length})`);
    table(r, [
      ['code', 'Code'], ['name', 'Client'], ['status', 'Status'], ['facility_type', 'Facility'],
      ['facility_limit_cents', 'Limit', $], ['ledger_cents', 'Ledger', $], ['funds_in_use_cents', 'In use', $], ['available_cents', 'Can draw', $], ['manager', 'Manager'],
    ]);
  });
}

async function cmdClient(db, { args, flags }) {
  const c = await resolve(db, 'client', args[0]);
  const [position] = await db.query('select * from v_availability where client_id = $1', [c.id]);
  const ineligible = await db.query(`select ineligible_reason as reason, count(*)::int as invoices, sum(open_cents)::bigint as open_cents from v_eligibility where client_id = $1 and ineligible_reason is not null group by 1 order by 3 desc`, [c.id]);
  const concentration = await db.query('select debtor_name, eligible_cents, share_pct, limit_pct, excess_cents from v_concentration where client_id = $1 order by eligible_cents desc', [c.id]);
  const debtors = await db.query(`select d.name, cd.noa_sent_on, cd.noa_acknowledged_on, coalesce(sum(b.open_cents) filter (where b.open_cents > 0), 0)::bigint as open_cents
    from client_debtors cd join debtors d on d.id = cd.debtor_id left join v_invoice_balance b on b.client_id = cd.client_id and b.debtor_id = cd.debtor_id
    where cd.client_id = $1 group by d.name, cd.noa_sent_on, cd.noa_acknowledged_on order by 4 desc`, [c.id]);
  const audits = await db.query('select done_on, findings, actor from field_audits where client_id = $1 order by done_on desc', [c.id]);
  const notes = await db.query('select created_at, body, actor from notes where client_id = $1 order by created_at desc limit 10', [c.id]);
  const data = { client: c, position, ineligible, concentration, debtors, audits, notes };
  out(flags, data, (d) => {
    heading(`${c.code}  ${c.name}`);
    console.log(`  ${c.status}, ${c.facility_type} facility, limit ${$(c.facility_limit_cents)}, advance ${c.advance_pct}%, discount ${c.discount_pct}% per 30 days, service ${c.service_fee_pct}%`);
    console.log(`  Due diligence: ${c.cdd_completed_on || 'not done'} (review ${c.cdd_review_due || 'not set'}). Security: ${c.ppsr_reference || 'not registered'}${c.ppsr_expires_on ? `, ends ${c.ppsr_expires_on}` : ''}. Last audit ${c.last_audit_on || 'never'}, next ${c.next_audit_due || 'not set'}.`);
    console.log(`\n  Ledger ${$(d.position.ledger_cents)}  less ineligible ${$(d.position.ineligible_cents)}  less concentration ${$(d.position.concentration_excess_cents)}  = eligible ${$(d.position.eligible_cents)}`);
    console.log(`  Drawing base ${$(d.position.drawing_base_cents)}  less funds in use ${$(d.position.funds_in_use_cents)}  = ${num(d.position.available_cents) < 0 ? `OVER-ADVANCED by ${$(-num(d.position.available_cents))}` : `can draw ${$(d.position.available_cents)}`}`);
    if (d.ineligible.length) { console.log('\n  Ineligible'); table(d.ineligible, [['reason', 'Reason'], ['invoices', 'Invoices'], ['open_cents', 'Open', $]]); }
    if (d.concentration.length) { console.log('\n  Debtor concentration'); table(d.concentration, [['debtor_name', 'Debtor'], ['eligible_cents', 'Eligible', $], ['share_pct', 'Share', pct], ['limit_pct', 'Limit', pct], ['excess_cents', 'Excess', $]]); }
    if (d.debtors.length) { console.log('\n  Debtors and notices of assignment'); table(d.debtors, [['name', 'Debtor'], ['open_cents', 'Open', $], ['noa_sent_on', 'Notice sent'], ['noa_acknowledged_on', 'Acknowledged']]); }
    if (d.notes.length) { console.log('\n  Notes'); for (const n of d.notes) console.log(`  ${isoDate(n.created_at)}  ${n.actor}: ${n.body}`); }
  });
}

async function cmdDebtors(db, { flags }) {
  const rows = await db.query('select debtor_name as name, status, clients, credit_limit_cents, open_cents, overdue_cents from v_exposure order by open_cents desc, debtor_name');
  out(flags, rows, (r) => {
    heading(`Debtors (${r.length})`);
    table(r, [['name', 'Debtor'], ['status', 'Status'], ['clients', 'Clients'], ['credit_limit_cents', 'Limit', $], ['open_cents', 'Open', $], ['overdue_cents', 'Overdue', $]]);
  });
}

async function cmdDebtor(db, { args, flags }) {
  const d = await resolve(db, 'debtor', args[0]);
  const invoices = await db.query(`select k.code as client, b.invoice_no, b.invoice_date, b.due_date, b.face_cents, b.open_cents, b.days_past_due, b.verified_on, b.disputed_on
    from v_invoice_balance b join clients k on k.id = b.client_id where b.debtor_id = $1 and b.open_cents > 0 order by b.invoice_date`, [d.id]);
  const paid = await db.query(`select avg(c.received_on - i.due_date)::numeric(6,1) as avg_days_late, count(*)::int as payments
    from collections c join invoices i on i.id = c.invoice_id where i.debtor_id = $1`, [d.id]);
  const notes = await db.query('select created_at, body, actor from notes where debtor_id = $1 order by created_at desc limit 10', [d.id]);
  const data = { debtor: d, invoices, payments: paid[0], notes };
  out(flags, data, (x) => {
    heading(`${d.name} (${d.status})`);
    console.log(`  Terms ${d.terms_days} days. Limit ${d.credit_limit_cents == null ? 'none set' : $(d.credit_limit_cents)}. ${x.payments.payments} payments recorded, on average ${x.payments.avg_days_late ?? 'n/a'} days after due.`);
    table(x.invoices, [['client', 'Client'], ['invoice_no', 'Invoice'], ['invoice_date', 'Dated'], ['due_date', 'Due'], ['open_cents', 'Open', $], ['days_past_due', 'Days late'], ['verified_on', 'Verified'], ['disputed_on', 'Disputed']]);
    for (const n of x.notes) console.log(`  ${isoDate(n.created_at)}  ${n.actor}: ${n.body}`);
  });
}

// ---------------------------------------------------------------- reads: the book

async function cmdPosition(db, { flags }) {
  const rows = await db.query(`select code, name, status, ledger_cents, ineligible_cents, concentration_excess_cents, eligible_cents, drawing_base_cents, funds_in_use_cents, available_cents
    from v_availability where status in ('active', 'watch') order by available_cents`);
  const total = rows.reduce((a, r) => ({ in_use: a.in_use + num(r.funds_in_use_cents), available: a.available + Math.max(num(r.available_cents), 0), over: a.over + Math.max(-num(r.available_cents), 0) }), { in_use: 0, available: 0, over: 0 });
  out(flags, { clients: rows, total }, (d) => {
    heading(`Position today: ${$(d.total.in_use)} in use, ${$(d.total.available)} available to draw`);
    table(d.clients, [['code', 'Client'], ['ledger_cents', 'Ledger', $], ['ineligible_cents', 'Ineligible', $], ['concentration_excess_cents', 'Conc. excess', $], ['drawing_base_cents', 'Drawing base', $], ['funds_in_use_cents', 'In use', $], ['available_cents', 'Can draw', (v) => (num(v) < 0 ? `OVER ${$(-num(v))}` : $(v))]]);
    if (d.total.over) console.log(`  ${d.clients.filter((c) => num(c.available_cents) < 0).length} client(s) over-advanced by ${$(d.total.over)} in total. Run "client <code>" for the reasons.`);
  });
}

async function cmdInvoices(db, { args, flags }) {
  const params = [];
  const where = ['b.open_cents > 0'];
  if (args[0]) { const c = await resolve(db, 'client', args[0]); params.push(c.id); where.push(`b.client_id = $${params.length}`); }
  if (flags.ineligible) where.push('e.ineligible_reason is not null');
  const rows = await db.query(`select k.code as client, b.invoice_no, d.name as debtor, b.invoice_date, b.due_date, b.face_cents, b.open_cents, b.age_days, e.ineligible_reason
    from v_invoice_balance b join clients k on k.id = b.client_id join debtors d on d.id = b.debtor_id left join v_eligibility e on e.invoice_id = b.id
    where ${where.join(' and ')} order by k.code, b.invoice_date`, params);
  out(flags, rows, (r) => {
    heading(`Open invoices (${r.length}), ${$(r.reduce((a, x) => a + num(x.open_cents), 0))}`);
    table(r, [['client', 'Client'], ['invoice_no', 'Invoice'], ['debtor', 'Debtor', (v) => truncate(v, 30)], ['invoice_date', 'Dated'], ['open_cents', 'Open', $], ['age_days', 'Age'], ['ineligible_reason', 'Not counted because']]);
  });
}

async function cmdSchedules(db, { flags }) {
  const where = flags.open ? "where s.status = 'received'" : '';
  const rows = await db.query(`select k.code as client, s.ref, s.received_on, s.status, count(i.id)::int as invoices, coalesce(sum(i.face_cents), 0)::bigint as face_cents,
      count(i.id) filter (where i.face_cents >= st.verify_over_cents and i.verified_on is null)::int as to_verify,
      (current_date - s.received_on) as days_waiting
    from schedules s join clients k on k.id = s.client_id left join invoices i on i.schedule_id = s.id cross join settings st ${where}
    group by k.code, s.id, st.verify_over_cents order by s.received_on desc`);
  out(flags, rows, (r) => {
    heading(`Schedules (${r.length})`);
    table(r, [['client', 'Client'], ['ref', 'Schedule'], ['received_on', 'Received'], ['status', 'Status'], ['invoices', 'Invoices'], ['face_cents', 'Face', $], ['to_verify', 'To verify']]);
  });
}

async function cmdVerifyQueue(db, { flags }) {
  const rows = await db.query(`select k.code as client, i.invoice_no, d.name as debtor, d.contact_name, d.contact_email, d.phone, i.invoice_date, i.face_cents, s.ref as schedule, s.status as schedule_status
    from invoices i join clients k on k.id = i.client_id join debtors d on d.id = i.debtor_id left join schedules s on s.id = i.schedule_id cross join settings st
    where i.verified_on is null and i.face_cents >= st.verify_over_cents and invoice_open_cents(i.id) > 0 and i.recoursed_on is null
    order by (s.status = 'funded') desc, i.face_cents desc`);
  out(flags, rows, (r) => {
    heading(`To verify with the debtor (${r.length})`);
    table(r, [['client', 'Client'], ['invoice_no', 'Invoice'], ['debtor', 'Debtor', (v) => truncate(v, 28)], ['face_cents', 'Face', $], ['schedule', 'Schedule'], ['schedule_status', 'Schedule is'], ['contact_email', 'Contact']]);
    if (r.some((x) => x.schedule_status === 'funded')) console.log('  Invoices on a funded schedule were paid against without verification: verify them first.');
  });
}

async function cmdAgeing(db, { args, flags }) {
  const params = [];
  let where = '';
  if (args[0]) { const c = await resolve(db, 'client', args[0]); params.push(c.id); where = 'where client_id = $1'; }
  const rows = await db.query(`select client_code as client, d0_30_cents, d31_60_cents, d61_90_cents, d90_plus_cents, total_cents from v_ageing ${where} order by client_code`, params);
  out(flags, rows, (r) => {
    heading('Ageing from invoice date');
    table(r, [['client', 'Client'], ['d0_30_cents', '0-30', $], ['d31_60_cents', '31-60', $], ['d61_90_cents', '61-90', $], ['d90_plus_cents', '90+', $], ['total_cents', 'Total', $]]);
  });
}

async function cmdConcentration(db, { flags }) {
  const rows = await db.query('select client_code as client, debtor_name as debtor, eligible_cents, share_pct, limit_pct, excess_cents from v_concentration where excess_cents > 0 order by excess_cents desc');
  out(flags, rows, (r) => {
    heading(`Debtors over the concentration limit (${r.length}), ${$(r.reduce((a, x) => a + num(x.excess_cents), 0))} not counted`);
    table(r, [['client', 'Client'], ['debtor', 'Debtor'], ['eligible_cents', 'Eligible', $], ['share_pct', 'Share', pct], ['limit_pct', 'Limit', pct], ['excess_cents', 'Excess', $]]);
  });
}

async function cmdExposure(db, { flags }) {
  const rows = await db.query(`select debtor_name as debtor, status, clients, credit_limit_cents, open_cents, overdue_cents,
      case when credit_limit_cents is not null and open_cents > credit_limit_cents then open_cents - credit_limit_cents else 0 end::bigint as over_limit_cents
    from v_exposure where open_cents > 0 order by open_cents desc`);
  out(flags, rows, (r) => {
    heading('Exposure by debtor, across every client');
    table(r, [['debtor', 'Debtor'], ['status', 'Status'], ['clients', 'Clients'], ['open_cents', 'Open', $], ['credit_limit_cents', 'Limit', $], ['over_limit_cents', 'Over limit', $], ['overdue_cents', 'Overdue', $]]);
  });
}

async function cmdDilution(db, { flags }) {
  const rows = await db.query(`select code as client, invoiced_cents, credited_cents, round(100.0 * credited_cents / nullif(invoiced_cents, 0), 1) as dilution_pct, dilution_watch_pct
    from v_dilution where invoiced_cents > 0 order by 4 desc nulls last`);
  out(flags, rows, (r) => {
    heading('Dilution, last 90 days (credit notes against invoices raised)');
    table(r, [['client', 'Client'], ['invoiced_cents', 'Invoiced', $], ['credited_cents', 'Credited', $], ['dilution_pct', 'Dilution', (v, row) => `${pct(v)}${num(v) > num(row.dilution_watch_pct) ? '  over watch level' : ''}`]]);
  });
}

async function cmdMisdirected(db, { flags }) {
  const rows = await db.query('select client_code as client, client_name, debtor_name as debtor, invoice_no, received_on, amount_cents, days_held, misdirected_days from v_misdirected order by days_held desc');
  out(flags, rows, (r) => {
    heading(`Debtor payments held by the client (${r.length}), ${$(r.reduce((a, x) => a + num(x.amount_cents), 0))}`);
    table(r, [['client', 'Client'], ['debtor', 'Debtor'], ['invoice_no', 'Invoice'], ['received_on', 'Paid to client'], ['amount_cents', 'Amount', $], ['days_held', 'Days held']]);
  });
}

async function cmdDisputes(db, { flags }) {
  const rows = await db.query(`select k.code as client, b.invoice_no, d.name as debtor, b.open_cents, b.disputed_on, (current_date - b.disputed_on) as days_open, b.dispute_reason
    from v_invoice_balance b join clients k on k.id = b.client_id join debtors d on d.id = b.debtor_id
    where b.disputed_on is not null and b.dispute_resolved_on is null and b.open_cents > 0 order by b.disputed_on`);
  out(flags, rows, (r) => {
    heading(`Open disputes (${r.length})`);
    table(r, [['client', 'Client'], ['invoice_no', 'Invoice'], ['debtor', 'Debtor', (v) => truncate(v, 28)], ['open_cents', 'Open', $], ['days_open', 'Days'], ['dispute_reason', 'Reason', (v) => truncate(v, 50)]]);
  });
}

async function cmdAccount(db, { args, flags }) {
  const c = await resolve(db, 'client', args[0]);
  const rows = await db.query(`select entry_on, kind, fee_kind, ref, amount_cents, sum(amount_cents) over (order by entry_on, created_at, id) as balance_cents, actor
    from account_entries where client_id = $1 order by entry_on, created_at, id`, [c.id]);
  out(flags, { client: c.code, entries: rows }, (d) => {
    heading(`${c.code} client account: funds in use`);
    table(d.entries, [['entry_on', 'Date'], ['kind', 'Kind'], ['fee_kind', 'Fee'], ['ref', 'Reference', (v) => truncate(v, 32)], ['amount_cents', 'Amount', $], ['balance_cents', 'In use', $]]);
  });
}

async function cmdHistory(db, { flags }) {
  const rows = await db.query('select at, actor, action, subject from history order by at desc, id desc limit $1', [num(flags.limit) || 30]);
  out(flags, rows, (r) => { heading('History'); table(r, [['at', 'When', isoDate], ['actor', 'Who'], ['action', 'What'], ['subject', 'On']]); });
}

// ---------------------------------------------------------------- calendar, compliance, attention

async function cmdCalendar(db, { flags }) {
  const days = num(flags.days) || 60;
  const rows = await db.query(`
    select c.ppsr_expires_on as on_date, c.code as subject, 'Security registration ends' as what from clients c where c.status <> 'exited' and c.ppsr_expires_on between current_date and current_date + $1::int
    union all select c.cdd_review_due, c.code, 'Due diligence review due' from clients c where c.status <> 'exited' and c.cdd_review_due <= current_date + $1::int
    union all select c.next_audit_due, c.code, 'Field audit due' from clients c where c.status <> 'exited' and c.next_audit_due <= current_date + $1::int
    union all select e.invoice_date + t.rec_days + 1, e.client_code || ':' || e.invoice_no, 'Passes ' || t.rec_days || ' days, stops counting (' || e.open_cents / 100 || ' open)'
      from v_eligibility e join v_client_terms t on t.id = e.client_id where e.ineligible_reason is null and e.invoice_date + t.rec_days + 1 between current_date and current_date + least($1::int, 30)
    union all select b.due_date, k.code || ':' || b.invoice_no, 'Debtor payment due from ' || d.name from v_invoice_balance b join clients k on k.id = b.client_id join debtors d on d.id = b.debtor_id
      where b.open_cents > 0 and b.due_date between current_date and current_date + least($1::int, 14)
    order by 1`, [days]);
  out(flags, rows, (r) => {
    heading(`Coming up in the next ${days} days (${r.length})`);
    table(r, [['on_date', 'Date', (v) => `${v}${v < today() ? ' (overdue)' : ''}`], ['subject', 'Client or invoice'], ['what', 'What']]);
  });
}

async function complianceFindings(db, s) {
  const f = [];
  const add = (level, rule, source, subject, detail) => f.push({ level, rule, source, subject, detail });
  const PPSA = 'Personal Property Securities Act 2009 (Cth)';

  for (const r of await db.query(`select c.code, f.funds_in_use_cents from clients c join v_funds_in_use f on f.client_id = c.id where c.ppsr_registered_on is null and (c.status in ('active', 'watch') or f.funds_in_use_cents > 0)`)) {
    add('breach', 'Security over the receivables not registered', `${PPSA} s 12(3)(a): a transfer of an account is a security interest`, r.code, `Funded or active with no PPSR registration recorded (${$(r.funds_in_use_cents)} in use)`);
  }
  for (const r of await db.query(`select c.code, c.ppsr_expires_on, f.funds_in_use_cents from clients c join v_funds_in_use f on f.client_id = c.id where c.status <> 'exited' and c.ppsr_expires_on is not null and c.ppsr_expires_on <= current_date + $1::int`, [s.ppsr_warn_days])) {
    add(r.ppsr_expires_on <= today() ? 'breach' : 'due', 'Registration end time', `${PPSA} s 153: a registration ends at its stated end time`, r.code, `Registration ends ${r.ppsr_expires_on} with ${$(r.funds_in_use_cents)} in use. Renew it before then.`);
  }
  for (const r of await db.query(`select k.code, d.name, count(*)::int as invoices, sum(b.open_cents)::bigint as open_cents
      from v_invoice_balance b join clients k on k.id = b.client_id join debtors d on d.id = b.debtor_id join schedules sc on sc.id = b.schedule_id
      left join client_debtors cd on cd.client_id = b.client_id and cd.debtor_id = b.debtor_id
      where k.facility_type = 'disclosed' and sc.status = 'funded' and b.open_cents > 0 and cd.noa_sent_on is null group by k.code, d.name`)) {
    add('breach', 'Funded invoices with no notice of assignment', `${PPSA} s 80(7): the debtor may keep paying the client until it receives the notice`, `${r.code} / ${r.name}`, `${r.invoices} funded invoice(s), ${$(r.open_cents)}, and no notice sent`);
  }
  for (const r of await db.query(`select k.code, d.name, i.invoice_no, col.received_on, col.amount_cents, cd.noa_sent_on
      from collections col join invoices i on i.id = col.invoice_id join clients k on k.id = i.client_id join debtors d on d.id = i.debtor_id
      left join client_debtors cd on cd.client_id = i.client_id and cd.debtor_id = i.debtor_id
      where col.paid_to = 'client' and col.passed_on_on is null and cd.noa_sent_on is not null and col.received_on > cd.noa_sent_on`)) {
    add('breach', 'Debtor paid the client after notice', `${PPSA} s 80(7) and (8): after notice, payment to the lender discharges the debtor`, `${r.code} / ${r.name}`, `${r.invoice_no}: ${$(r.amount_cents)} paid to the client on ${r.received_on}, after the notice of ${r.noa_sent_on}. Recover it from the client and tell the debtor where to pay.`);
  }
  for (const r of await db.query(`select code, cdd_review_due from clients where status in ('active', 'watch') and cdd_review_due < current_date`)) {
    add('breach', 'Ongoing due diligence review overdue', 'Your AML/CTF programme under the Anti-Money Laundering and Counter-Terrorism Financing Act 2006 (Cth): review cycle in settings', r.code, `Review was due ${r.cdd_review_due}`);
  }
  for (const r of await db.query(`select code from clients where status = 'onboarding' and cdd_completed_on is null`)) {
    add('info', 'Due diligence before funding', 'Your AML/CTF programme: the database refuses an advance until due diligence is recorded', r.code, 'Onboarding, due diligence not finished. No funding yet.');
  }
  for (const r of await db.query(`select k.code, i.invoice_no, i.face_cents from invoices i join clients k on k.id = i.client_id join schedules sc on sc.id = i.schedule_id cross join settings st
      where sc.status = 'funded' and i.verified_on is null and i.face_cents >= st.verify_over_cents and invoice_open_cents(i.id) > 0`)) {
    add('breach', 'Funded without verification', `Credit policy: verify every invoice of ${$(s.verify_over_cents)} or more before funding`, `${r.code}:${r.invoice_no}`, `${$(r.face_cents)} funded, never verified with the debtor`);
  }
  for (const r of await db.query(`select code, next_audit_due from clients where status in ('active', 'watch') and next_audit_due < current_date`)) {
    add('breach', 'Field audit overdue', `Credit policy: audit each client's books every ${s.audit_months} months`, r.code, `Audit was due ${r.next_audit_due}`);
  }
  for (const r of await db.query(`select code, ppsr_reference from clients where status = 'exited' and ppsr_reference is not null and ppsr_discharged_on is null`)) {
    add('due', 'Registration still on the register after exit', `${PPSA}: amend or discharge a registration that no longer secures anything`, r.code, `Exited, registration ${r.ppsr_reference} not recorded as discharged (finance ppsr ${r.code} --discharged=YYYY-MM-DD)`);
  }
  const order = { breach: 0, due: 1, info: 2 };
  return f.sort((a, b) => order[a.level] - order[b.level]);
}

async function cmdCompliance(db, { flags }) {
  const s = await settings(db);
  const rows = await complianceFindings(db, s);
  out(flags, rows, (r) => {
    heading(`Compliance: ${r.filter((x) => x.level === 'breach').length} breach(es), ${r.filter((x) => x.level === 'due').length} due`);
    table(r, [['level', 'Level'], ['subject', 'Client'], ['rule', 'Rule'], ['detail', 'Detail', (v) => truncate(v, 70)]]);
    console.log('  Sources for each rule: docs/compliance.md. Not legal advice.');
  });
}

async function attentionItems(db, s) {
  const items = [];
  const add = (level, subject, what) => items.push({ level, subject, what });
  for (const r of await db.query(`select code, available_cents from v_availability where available_cents < 0 and status in ('active', 'watch') order by available_cents`)) {
    const reasons = await db.query(`select ineligible_reason as reason, sum(open_cents)::bigint as cents from v_eligibility where client_id = (select id from clients where code = $1) and ineligible_reason is not null group by 1 order by 2 desc limit 2`, [r.code]);
    const [held] = await db.query('select coalesce(sum(amount_cents), 0)::bigint as cents from v_misdirected where client_code = $1', [r.code]);
    const why = [...reasons.map((x) => `${x.reason} ${$(x.cents)}`), ...(num(held.cents) ? [`debtor payment held by the client ${$(held.cents)}`] : [])].join(', ');
    add('breach', r.code, `Over-advanced by ${$(-num(r.available_cents))}${why ? ` (${why})` : ''}: no funding until it is back inside, ask for repayment or new invoices`);
  }
  for (const r of await db.query('select client_code, debtor_name, invoice_no, amount_cents, days_held, misdirected_days from v_misdirected where days_held > misdirected_days order by days_held desc')) {
    add('breach', r.client_code, `${r.debtor_name} paid ${$(r.amount_cents)} for ${r.invoice_no} to the client ${r.days_held} days ago and it has not been passed on (policy: ${r.misdirected_days} days)`);
  }
  for (const c of (await complianceFindings(db, s)).filter((x) => x.level !== 'info' && !/overdue|Funded without|over-advanced/i.test(x.rule))) add(c.level === 'breach' ? 'breach' : 'action', c.subject, `${c.rule}: ${c.detail}`);
  for (const r of await db.query(`select code, cdd_review_due from clients where status in ('active', 'watch') and cdd_review_due < current_date`)) add('action', r.code, `Due diligence review was due ${r.cdd_review_due}: refresh the client file`);
  for (const r of await db.query(`select code, next_audit_due from clients where status in ('active', 'watch') and next_audit_due < current_date`)) add('action', r.code, `Field audit was due ${r.next_audit_due}`);
  for (const r of await db.query(`select k.code, i.invoice_no, i.face_cents, s.status from invoices i join clients k on k.id = i.client_id join schedules s on s.id = i.schedule_id cross join settings st
      where i.verified_on is null and i.face_cents >= st.verify_over_cents and invoice_open_cents(i.id) > 0 and s.status <> 'rejected' order by (s.status = 'funded') desc, i.face_cents desc`)) {
    add(r.status === 'funded' ? 'breach' : 'action', `${r.code}:${r.invoice_no}`, r.status === 'funded' ? `${$(r.face_cents)} funded without verification: verify with the debtor today` : `Verify ${$(r.face_cents)} with the debtor before funding (finance verify ${r.invoice_no})`);
  }
  for (const r of await db.query(`select k.code, s.ref, (current_date - s.received_on) as days from schedules s join clients k on k.id = s.client_id where s.status = 'received' order by s.received_on`)) {
    add('action', r.code, `Schedule ${r.ref} waiting ${r.days} day(s): verify, then fund or reject it`);
  }
  for (const r of await db.query(`select client_code, invoice_no, open_cents, invoice_date + rec_days + 1 as stops_on from v_eligibility e join v_client_terms t on t.id = e.client_id
      where e.ineligible_reason is null and e.invoice_date + t.rec_days + 1 <= current_date + 14 order by 4`)) {
    add('action', `${r.client_code}:${r.invoice_no}`, `Stops counting on ${r.stops_on} (${$(r.open_cents)} open): chase the debtor or plan recourse`);
  }
  for (const r of await db.query(`select code, round(100.0 * credited_cents / nullif(invoiced_cents, 0), 1) as d, dilution_watch_pct from v_dilution where invoiced_cents > 0 and 100.0 * credited_cents / invoiced_cents > dilution_watch_pct`)) {
    add('action', r.code, `Dilution ${r.d}% over the last 90 days (watch level ${r.dilution_watch_pct}%): ask why the credit notes are being raised`);
  }
  for (const r of await db.query(`select k.code, b.invoice_no, (current_date - b.disputed_on) as days from v_invoice_balance b join clients k on k.id = b.client_id where b.disputed_on is not null and b.dispute_resolved_on is null and b.open_cents > 0 and b.disputed_on < current_date - 7`)) {
    add('action', `${r.code}:${r.invoice_no}`, `Disputed ${r.days} days ago and still open: resolve, credit or recourse it`);
  }
  for (const r of await db.query('select debtor_name, open_cents, credit_limit_cents from v_exposure where credit_limit_cents is not null and open_cents > credit_limit_cents')) {
    add('action', r.debtor_name, `Exposure ${$(r.open_cents)} is over the ${$(r.credit_limit_cents)} debtor limit across all clients`);
  }
  for (const r of await db.query(`select k.code, d.name, cd.noa_sent_on from client_debtors cd join clients k on k.id = cd.client_id join debtors d on d.id = cd.debtor_id
      where k.facility_type = 'disclosed' and k.status <> 'exited' and cd.noa_sent_on is not null and cd.noa_acknowledged_on is null and cd.noa_sent_on < current_date - 7`)) {
    add('info', `${r.code} / ${r.name}`, `Notice of assignment sent ${r.noa_sent_on}, not acknowledged: confirm by phone`);
  }
  const seen = new Set();
  const order = { breach: 0, action: 1, info: 2 };
  return items.filter((i) => { const k = `${i.subject}|${i.what}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => order[a.level] - order[b.level]);
}

async function cmdAttention(db, { flags }) {
  const s = await settings(db);
  const rows = await attentionItems(db, s);
  out(flags, rows, (r) => {
    heading(`Needs attention (${r.length})`);
    table(r, [['level', 'Level'], ['subject', 'Client or invoice'], ['what', 'What to do', (v) => truncate(v, 110)]]);
  });
}

// ---------------------------------------------------------------- fees

async function feeRun(db, client, period) {
  const [y, m] = period.split('-').map(Number);
  const start = `${period}-01`;
  const end = isoDate(new Date(Date.UTC(y, m, 0)));
  const [daily] = await db.query(`select coalesce(sum(greatest((select coalesce(sum(a.amount_cents), 0) from account_entries a where a.client_id = $1 and a.entry_on <= d::date and not (a.kind = 'fee' and a.period = $4)), 0)), 0)::bigint as cent_days
    from generate_series($2::date, $3::date, interval '1 day') d`, [client.id, start, end, period]);
  const [assigned] = await db.query(`select coalesce(sum(i.face_cents), 0)::bigint as face_cents from invoices i join schedules s on s.id = i.schedule_id where i.client_id = $1 and s.received_on between $2 and $3 and s.status <> 'rejected'`, [client.id, start, end]);
  const discount = Math.round(num(daily.cent_days) * num(client.discount_pct) / 100 / 30);
  const service = Math.round(num(assigned.face_cents) * num(client.service_fee_pct) / 100);
  const minimum = Math.max(num(client.min_monthly_fee_cents) - discount - service, 0);
  return { client: client.code, period, entry_on: end, average_in_use_cents: Math.round(num(daily.cent_days) / Number(end.slice(8))), assigned_cents: num(assigned.face_cents), discount_cents: discount, service_cents: service, minimum_top_up_cents: minimum, total_cents: discount + service + minimum };
}

async function cmdFees(db, { args, flags }) {
  await settings(db);
  const period = str(flags.month) || addDays(`${today().slice(0, 7)}-01`, -1).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) throw new CliError('Give the month as --month=YYYY-MM.');
  if (flags.apply && `${period}-01` >= `${today().slice(0, 7)}-01`) throw new CliError(`${period} has not ended. Fees are charged after the month ends.`);
  const clients = args[0] ? [await resolve(db, 'client', args[0])] : await db.query("select * from clients where status in ('active', 'watch') order by code");
  const runs = [];
  for (const c of clients) {
    const done = await db.query("select fee_kind from account_entries where client_id = $1 and kind = 'fee' and period = $2", [c.id, period]);
    const r = await feeRun(db, c, period);
    r.already_charged = done.map((x) => x.fee_kind);
    runs.push(r);
  }
  if (flags.apply) {
    const actor = actorOf(flags);
    await tx(db, async () => {
      for (const r of runs) {
        const c = clients.find((x) => x.code === r.client);
        for (const [kind, cents] of [['discount', r.discount_cents], ['service', r.service_cents], ['minimum', r.minimum_top_up_cents]]) {
          if (!cents || r.already_charged.includes(kind)) continue;
          await db.query("insert into account_entries (client_id, entry_on, kind, fee_kind, period, amount_cents, ref, actor) values ($1, $2, 'fee', $3, $4, $5, $6, $7)", [c.id, r.entry_on, kind, period, cents, `${kind} fee ${period}`, actor]);
        }
      }
      await record(db, actor, `fees charged for ${period}`, runs.map((r) => r.client).join(', '));
    });
  }
  out(flags, { period, applied: !!flags.apply, runs }, (d) => {
    heading(`Fees for ${period}${d.applied ? ': charged' : ': test run, add --apply to charge'}`);
    table(d.runs, [['client', 'Client'], ['average_in_use_cents', 'Avg in use', $], ['assigned_cents', 'Assigned', $], ['discount_cents', 'Discount', $], ['service_cents', 'Service', $], ['minimum_top_up_cents', 'Min top-up', $], ['total_cents', 'Total', $], ['already_charged', 'Already charged', (v) => v.join(', ')]]);
  });
}

// ---------------------------------------------------------------- writes: clients and debtors

async function cmdOnboard(db, { args, flags }) {
  const actor = actorOf(flags);
  const code = str(args[0]).toUpperCase();
  const name = str(flags.name);
  if (!code || !name) throw new CliError('onboard <CODE> --name="Client Pty Ltd" --limit=250000 [--advance=80] [--discount=1.25] [--service=0.5] [--type=disclosed|confidential]');
  const row = await tx(db, async () => {
    const [c] = await db.query(`insert into clients (code, name, business_number, facility_type, facility_limit_cents, advance_pct, discount_pct, service_fee_pct, manager, contact_name, contact_email)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
    [code, name, str(flags.abn) || str(flags.nzbn) || null, str(flags.type) || 'disclosed', parseMoney(flags.limit, 'facility limit'), num(flags.advance) || 80, flags.discount ? num(flags.discount) : 1.25, flags.service ? num(flags.service) : 0.5, str(flags.manager) || actor, str(flags.contact) || null, str(flags.email) || null]);
    await record(db, actor, 'client onboarded', code);
    return c;
  });
  out(flags, row, (c) => console.log(`${c.code} ${c.name} added as onboarding. Record due diligence (finance cdd) and the security registration (finance ppsr) before the first advance.`));
}

async function cmdCdd(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const on = parseDate(flags.on) || today();
  const s = await settings(db);
  const review = parseDate(flags.review) || addDays(on, Math.round(s.cdd_review_months * 30.4));
  await tx(db, async () => {
    await db.query("update clients set cdd_completed_on = $2, cdd_review_due = $3, risk_rating = coalesce($4, risk_rating) where id = $1", [c.id, on, review, str(flags.risk) || null]);
    await record(db, actor, 'due diligence recorded', c.code, { on, review, risk: str(flags.risk) || null });
  });
  out(flags, { client: c.code, cdd_completed_on: on, cdd_review_due: review }, (d) => console.log(`${d.client}: due diligence recorded ${d.cdd_completed_on}, next review ${d.cdd_review_due}.`));
}

async function cmdPpsr(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  if (flags.discharged) {
    const on = parseDate(flags.discharged);
    await tx(db, async () => {
      await db.query('update clients set ppsr_discharged_on = $2 where id = $1', [c.id, on]);
      await record(db, actor, 'security registration discharged', c.code, { on });
    });
    out(flags, { client: c.code, ppsr_discharged_on: on }, (d) => console.log(`${d.client}: registration recorded as discharged on ${d.ppsr_discharged_on}.`));
    return;
  }
  const ref = str(flags.ref);
  if (!ref) throw new CliError('ppsr <client> --ref=<registration number> [--on=YYYY-MM-DD] [--expires=YYYY-MM-DD] | --discharged=YYYY-MM-DD');
  const on = parseDate(flags.on) || today();
  const expires = parseDate(flags.expires);
  await tx(db, async () => {
    await db.query('update clients set ppsr_reference = $2, ppsr_registered_on = $3, ppsr_expires_on = $4 where id = $1', [c.id, ref, on, expires]);
    await record(db, actor, 'security registration recorded', c.code, { ref, on, expires });
  });
  out(flags, { client: c.code, ppsr_reference: ref, ppsr_registered_on: on, ppsr_expires_on: expires }, (d) => console.log(`${d.client}: registration ${d.ppsr_reference} recorded from ${d.ppsr_registered_on}${d.ppsr_expires_on ? `, ends ${d.ppsr_expires_on}` : ', no stated end time'}.`));
}

async function cmdAudit(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const findings = str(flags.findings);
  if (!findings) throw new CliError('audit <client> --findings="what the audit found" [--on=]');
  const on = parseDate(flags.on) || today();
  const s = await settings(db);
  const next = addDays(on, Math.round(s.audit_months * 30.4));
  await tx(db, async () => {
    await db.query('insert into field_audits (client_id, done_on, findings, actor) values ($1, $2, $3, $4)', [c.id, on, findings, actor]);
    await db.query('update clients set last_audit_on = $2, next_audit_due = $3 where id = $1', [c.id, on, next]);
    await record(db, actor, 'field audit recorded', c.code);
  });
  out(flags, { client: c.code, done_on: on, next_audit_due: next }, (d) => console.log(`${d.client}: audit recorded ${d.done_on}, next due ${d.next_audit_due}.`));
}

async function cmdStatus(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const status = str(args[1]);
  if (!['onboarding', 'active', 'watch', 'exited'].includes(status)) throw new CliError('status <client> onboarding|active|watch|exited');
  if (status === 'exited') {
    const [f] = await db.query('select funds_in_use_cents from v_funds_in_use where client_id = $1', [c.id]);
    if (num(f.funds_in_use_cents) > 0) throw new CliError(`${c.code} still has ${$(f.funds_in_use_cents)} in use. Collect it out before the client exits.`);
  }
  await tx(db, async () => {
    await db.query("update clients set status = $2, exited_on = case when $2 = 'exited' then current_date else exited_on end, started_on = case when $2 = 'active' then coalesce(started_on, current_date) else started_on end where id = $1", [c.id, status]);
    await record(db, actor, `status ${c.status} -> ${status}`, c.code, { reason: str(flags.reason) || null });
  });
  out(flags, { client: c.code, from: c.status, to: status }, (d) => console.log(`${d.client}: ${d.from} -> ${d.to}.`));
}

async function cmdAddDebtor(db, { args, flags }) {
  const actor = actorOf(flags);
  const name = args.join(' ').trim();
  if (!name) throw new CliError('add-debtor "<Debtor name>" [--terms=30] [--limit=50000] [--email=] [--contact=]');
  const row = await tx(db, async () => {
    const [d] = await db.query('insert into debtors (name, business_number, terms_days, credit_limit_cents, contact_name, contact_email, phone) values ($1, $2, $3, $4, $5, $6, $7) returning *',
      [name, str(flags.abn) || null, num(flags.terms) || 30, flags.limit ? parseMoney(flags.limit, 'debtor limit') : null, str(flags.contact) || null, str(flags.email) || null, str(flags.phone) || null]);
    await record(db, actor, 'debtor added', name);
    return d;
  });
  out(flags, row, (d) => console.log(`Debtor ${d.name} added, ${d.terms_days} day terms.`));
}

async function cmdDebtorStatus(db, { args, flags }) {
  const actor = actorOf(flags);
  const d = await resolve(db, 'debtor', args[0]);
  const status = str(args[1]);
  if (!['approved', 'watch', 'blocked'].includes(status)) throw new CliError('debtor-status <debtor> approved|watch|blocked [--reason=]');
  await tx(db, async () => {
    await db.query('update debtors set status = $2, notes = coalesce($3, notes) where id = $1', [d.id, status, str(flags.reason) || null]);
    await record(db, actor, `debtor ${d.status} -> ${status}`, d.name, { reason: str(flags.reason) || null });
  });
  out(flags, { debtor: d.name, from: d.status, to: status }, (x) => console.log(`${x.debtor}: ${x.from} -> ${x.to}.${status === 'blocked' ? ' Its invoices no longer count toward any client\'s drawing base.' : ''}`));
}

async function cmdNoa(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const d = await resolve(db, 'debtor', args[1]);
  const sent = parseDate(flags.sent) || (flags.ack ? null : today());
  const ack = parseDate(flags.ack);
  await tx(db, async () => {
    if (sent) {
      await db.query(`insert into client_debtors (client_id, debtor_id, noa_sent_on) values ($1, $2, $3)
        on conflict (client_id, debtor_id) do update set noa_sent_on = excluded.noa_sent_on`, [c.id, d.id, sent]);
    }
    if (ack) {
      const rows = await db.query('update client_debtors set noa_acknowledged_on = $3 where client_id = $1 and debtor_id = $2 and noa_sent_on is not null returning id', [c.id, d.id, ack]);
      if (!rows.length) throw new CliError(`No notice of assignment is recorded as sent to ${d.name} for ${c.code}. Record it sent first.`);
    }
    await record(db, actor, ack ? 'notice of assignment acknowledged' : 'notice of assignment sent', `${c.code} / ${d.name}`);
  });
  const [row] = await db.query('select noa_sent_on, noa_acknowledged_on from client_debtors where client_id = $1 and debtor_id = $2', [c.id, d.id]);
  out(flags, { client: c.code, debtor: d.name, ...row }, (x) => console.log(`${x.client} / ${x.debtor}: notice sent ${x.noa_sent_on || 'no'}, acknowledged ${x.noa_acknowledged_on || 'not yet'}.`));
}

// ---------------------------------------------------------------- writes: schedules and invoices

const SCHEDULE_COLS = {
  debtor: ['Debtor', 'Debtor Name', 'Customer', 'Customer Name', 'Contact'],
  invoice: ['Invoice Number', 'Invoice No', 'Invoice', 'Number', 'Reference'],
  date: ['Invoice Date', 'Date', 'Issue Date'],
  due: ['Due Date', 'Due'],
  amount: ['Amount', 'Invoice Amount', 'Total', 'Gross', 'Face Value', 'Amount Due', 'Outstanding'],
};

async function readSchedule(db, file) {
  if (!existsSync(file)) throw new CliError(`No file at ${file}.`);
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (!rows.length) throw new CliError(`${file} has no invoices.`);
  const debtors = await db.query('select id, name, terms_days from debtors');
  const problems = [];
  const lines = rows.map((r, i) => {
    const name = pick(r, ...SCHEDULE_COLS.debtor).trim();
    const d = debtors.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!d) problems.push(`row ${i + 2}: debtor "${name}" is not on file (add-debtor first)`);
    let date; let due; let cents;
    try { date = parseDate(pick(r, ...SCHEDULE_COLS.date), 'invoice date'); } catch (e) { problems.push(`row ${i + 2}: ${e.message}`); }
    try { due = parseDate(pick(r, ...SCHEDULE_COLS.due), 'due date') || (date && d ? addDays(date, d.terms_days) : null); } catch (e) { problems.push(`row ${i + 2}: ${e.message}`); }
    try { cents = parseMoney(pick(r, ...SCHEDULE_COLS.amount), 'invoice amount'); } catch (e) { problems.push(`row ${i + 2}: ${e.message}`); }
    const invoice_no = pick(r, ...SCHEDULE_COLS.invoice).trim();
    if (!invoice_no) problems.push(`row ${i + 2}: no invoice number`);
    if (!date) problems.push(`row ${i + 2}: no invoice date`);
    if (cents !== undefined && cents <= 0) problems.push(`row ${i + 2}: ${invoice_no} is not a positive amount (record a credit note instead)`);
    return { debtor_id: d?.id, debtor: name, invoice_no, invoice_date: date, due_date: due, face_cents: cents };
  });
  return { lines, problems };
}

async function cmdSchedule(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const file = args[1];
  const ref = str(flags.ref);
  if (!file || !ref) throw new CliError('schedule <client> <invoices.csv> --ref=<schedule reference> [--on=] [--dry-run]');
  const { lines, problems } = await readSchedule(db, path.resolve(file));
  const existing = await db.query('select invoice_no from invoices where client_id = $1 and invoice_no = any($2::text[])', [c.id, lines.map((l) => l.invoice_no)]);
  for (const e of existing) problems.push(`${e.invoice_no} is already assigned (a duplicate is the first sign of a fraud: check with the client)`);
  const dupes = lines.map((l) => l.invoice_no).filter((v, i, a) => a.indexOf(v) !== i);
  for (const d of new Set(dupes)) problems.push(`${d} appears twice in the file`);
  if (problems.length) throw new CliError(`Schedule refused, nothing written:\n  ${problems.join('\n  ')}`);
  const total = lines.reduce((a, l) => a + l.face_cents, 0);
  if (!flags['dry-run']) {
    await tx(db, async () => {
      const [s] = await db.query('insert into schedules (client_id, ref, received_on) values ($1, $2, $3) returning id', [c.id, ref, parseDate(flags.on) || today()]);
      for (const l of lines) {
        await db.query('insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents) values ($1, $2, $3, $4, $5, $6, $7)', [c.id, l.debtor_id, s.id, l.invoice_no, l.invoice_date, l.due_date, l.face_cents]);
      }
      await record(db, actor, `schedule ${ref} received`, c.code, { invoices: lines.length, total_cents: total });
    });
  }
  const s = await settings(db);
  const toVerify = lines.filter((l) => l.face_cents >= num(s.verify_over_cents));
  out(flags, { client: c.code, ref, dry_run: !!flags['dry-run'], invoices: lines.length, total_cents: total, to_verify: toVerify.map((l) => l.invoice_no) }, (d) => {
    console.log(`${d.dry_run ? 'Test run: ' : ''}${d.client} schedule ${d.ref}: ${d.invoices} invoices, ${$(d.total_cents)}. ${d.to_verify.length} to verify with the debtor before funding${d.to_verify.length ? ` (${d.to_verify.join(', ')})` : ''}.`);
  });
}

async function cmdVerify(db, { args, flags }) {
  const actor = actorOf(flags);
  const i = await resolve(db, 'invoice', args[0]);
  const method = str(flags.method) || 'phone';
  const contact = str(flags.contact);
  if (!contact) throw new CliError('verify <invoice> --method=phone|email|portal|signed_delivery --contact="who confirmed it"');
  await tx(db, async () => {
    await db.query('update invoices set verified_on = $2, verified_by = $3, verify_method = $4, verify_contact = $5 where id = $1', [i.id, parseDate(flags.on) || today(), actor, method, contact]);
    await record(db, actor, 'invoice verified', `${i.client_code}:${i.invoice_no}`, { method, contact });
  });
  out(flags, { invoice: i.invoice_no, client: i.client_code, verified_by: actor, method, contact }, (d) => console.log(`${d.client}:${d.invoice} verified by ${d.method} with ${d.contact}.`));
}

async function cmdReject(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const [s] = await db.query('select * from schedules where client_id = $1 and lower(ref) = lower($2)', [c.id, str(args[1])]);
  if (!s) throw new CliError(`${c.code} has no schedule "${args[1]}".`);
  if (s.status !== 'received') throw new CliError(`Schedule ${s.ref} is ${s.status}; only a received schedule can be rejected.`);
  await tx(db, async () => {
    await db.query("update schedules set status = 'rejected', note = $2 where id = $1", [s.id, str(flags.reason) || null]);
    await record(db, actor, `schedule ${s.ref} rejected`, c.code, { reason: str(flags.reason) || null });
  });
  out(flags, { client: c.code, schedule: s.ref, status: 'rejected' }, (d) => console.log(`${d.client} schedule ${d.schedule} rejected. Its invoices do not count.`));
}

// ---------------------------------------------------------------- writes: money

async function fundOrRelease(db, { args, flags }, kind) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const cents = parseMoney(args[1], `${kind} amount`);
  let schedule = null;
  if (kind === 'advance' && flags.schedule) {
    [schedule] = await db.query('select * from schedules where client_id = $1 and lower(ref) = lower($2)', [c.id, str(flags.schedule)]);
    if (!schedule) throw new CliError(`${c.code} has no schedule "${flags.schedule}".`);
    if (schedule.status === 'rejected') throw new CliError(`Schedule ${schedule.ref} was rejected.`);
  }
  const [before] = await db.query('select available_cents from v_availability where client_id = $1', [c.id]);
  await tx(db, async () => {
    await db.query('insert into account_entries (client_id, entry_on, kind, amount_cents, schedule_id, ref, actor) values ($1, $2, $3, $4, $5, $6, $7)',
      [c.id, parseDate(flags.on) || today(), kind, cents, schedule?.id || null, str(flags.ref) || (schedule ? `Funding ${schedule.ref}` : kind), actor]);
    if (schedule) await db.query("update schedules set status = 'funded' where id = $1", [schedule.id]);
    await record(db, actor, `${kind} ${cents / 100}`, c.code, { schedule: schedule?.ref || null });
  });
  const [after] = await db.query('select available_cents, funds_in_use_cents from v_availability where client_id = $1', [c.id]);
  out(flags, { client: c.code, kind, amount_cents: cents, available_before_cents: num(before.available_cents), available_after_cents: num(after.available_cents), funds_in_use_cents: num(after.funds_in_use_cents) },
    (d) => console.log(`${d.client}: ${kind} of ${$(d.amount_cents)} recorded. ${$(d.funds_in_use_cents)} in use, ${$(d.available_after_cents)} still available. The bank transfer is made outside this system.`));
}

async function cmdCollect(db, { args, flags }) {
  const actor = actorOf(flags);
  const i = await resolve(db, 'invoice', args[0]);
  const cents = parseMoney(args[1], 'payment amount');
  const to = str(flags.to) || 'lender';
  if (!['lender', 'client'].includes(to)) throw new CliError('--to=lender (the default) or --to=client when the debtor paid the client');
  await tx(db, async () => {
    await db.query('insert into collections (invoice_id, received_on, amount_cents, paid_to, ref, actor) values ($1, $2, $3, $4, $5, $6)', [i.id, parseDate(flags.on) || today(), cents, to, str(flags.ref) || null, actor]);
    await record(db, actor, `collection ${cents / 100} paid to ${to}`, `${i.client_code}:${i.invoice_no}`);
  });
  const [b] = await db.query('select open_cents from v_invoice_balance where id = $1', [i.id]);
  out(flags, { invoice: i.invoice_no, client: i.client_code, amount_cents: cents, paid_to: to, open_cents: num(b.open_cents) }, (d) => console.log(`${d.client}:${d.invoice}: ${$(d.amount_cents)} recorded as paid to the ${d.paid_to}. ${$(d.open_cents)} still open.${to === 'client' ? ' The client must pass it on: it shows on the misdirected list until it does.' : ''}`));
}

async function cmdPassedOn(db, { args, flags }) {
  const actor = actorOf(flags);
  const i = await resolve(db, 'invoice', args[0]);
  const rows = await db.query("select * from collections where invoice_id = $1 and paid_to = 'client' and passed_on_on is null order by received_on", [i.id]);
  if (!rows.length) throw new CliError(`${i.invoice_no} has no payment held by the client.`);
  const on = parseDate(flags.on) || today();
  await tx(db, async () => {
    for (const r of rows) await db.query('update collections set passed_on_on = $2 where id = $1', [r.id, on]);
    await record(db, actor, 'misdirected payment passed on', `${i.client_code}:${i.invoice_no}`);
  });
  const total = rows.reduce((a, r) => a + num(r.amount_cents), 0);
  out(flags, { invoice: i.invoice_no, client: i.client_code, passed_on_cents: total, on }, (d) => console.log(`${d.client}:${d.invoice}: ${$(d.passed_on_cents)} reached the lender on ${d.on} and is credited to the client account.`));
}

async function cmdCredit(db, { args, flags }) {
  const actor = actorOf(flags);
  const i = await resolve(db, 'invoice', args[0]);
  const cents = parseMoney(args[1], 'credit note amount');
  const reason = str(flags.reason);
  if (!reason) throw new CliError('credit <invoice> <amount> --reason="why the client credited it"');
  await tx(db, async () => {
    await db.query('insert into credit_notes (invoice_id, issued_on, amount_cents, reason, actor) values ($1, $2, $3, $4, $5)', [i.id, parseDate(flags.on) || today(), cents, reason, actor]);
    await record(db, actor, `credit note ${cents / 100}`, `${i.client_code}:${i.invoice_no}`, { reason });
  });
  const [p] = await db.query('select available_cents from v_availability where client_id = $1', [i.client_id]);
  out(flags, { invoice: i.invoice_no, client: i.client_code, amount_cents: cents, available_cents: num(p.available_cents) }, (d) => console.log(`${d.client}:${d.invoice}: credit note of ${$(d.amount_cents)} recorded. ${d.client} ${d.available_cents < 0 ? `is now over-advanced by ${$(-d.available_cents)}` : `can draw ${$(d.available_cents)}`}.`));
}

async function cmdDispute(db, { args, flags }) {
  const actor = actorOf(flags);
  const i = await resolve(db, 'invoice', args[0]);
  const reason = str(flags.reason);
  if (!reason) throw new CliError('dispute <invoice> --reason="what the debtor says"');
  await tx(db, async () => {
    await db.query('update invoices set disputed_on = $2, dispute_reason = $3, dispute_resolved_on = null where id = $1', [i.id, parseDate(flags.on) || today(), reason]);
    await record(db, actor, 'invoice disputed', `${i.client_code}:${i.invoice_no}`, { reason });
  });
  out(flags, { invoice: i.invoice_no, client: i.client_code, disputed: true }, (d) => console.log(`${d.client}:${d.invoice} marked disputed. It no longer counts toward the drawing base.`));
}

async function cmdResolve(db, { args, flags }) {
  const actor = actorOf(flags);
  const i = await resolve(db, 'invoice', args[0]);
  if (!i.disputed_on || i.dispute_resolved_on) throw new CliError(`${i.invoice_no} has no open dispute.`);
  await tx(db, async () => {
    await db.query('update invoices set dispute_resolved_on = $2 where id = $1', [i.id, parseDate(flags.on) || today()]);
    await record(db, actor, 'dispute resolved', `${i.client_code}:${i.invoice_no}`, { note: str(flags.note) || null });
  });
  out(flags, { invoice: i.invoice_no, client: i.client_code, resolved: true }, (d) => console.log(`${d.client}:${d.invoice}: dispute resolved. Record any credit note separately.`));
}

async function cmdRecourse(db, { args, flags }) {
  const actor = actorOf(flags);
  const i = await resolve(db, 'invoice', args[0]);
  if (i.recoursed_on) throw new CliError(`${i.invoice_no} was recoursed on ${i.recoursed_on}.`);
  await tx(db, async () => {
    await db.query('update invoices set recoursed_on = $2 where id = $1', [i.id, parseDate(flags.on) || today()]);
    await record(db, actor, 'invoice recoursed to the client', `${i.client_code}:${i.invoice_no}`, { reason: str(flags.reason) || null });
  });
  const [p] = await db.query('select available_cents from v_availability where client_id = $1', [i.client_id]);
  out(flags, { invoice: i.invoice_no, client: i.client_code, available_cents: num(p.available_cents) }, (d) => console.log(`${d.client}:${d.invoice} recoursed: the client carries it now. ${d.client} ${d.available_cents < 0 ? `is over-advanced by ${$(-d.available_cents)}: ask for repayment or replacement invoices` : `can draw ${$(d.available_cents)}`}.`));
}

async function cmdAdjust(db, { args, flags }) {
  const actor = actorOf(flags);
  const c = await resolve(db, 'client', args[0]);
  const cents = parseMoney(args[1], 'adjustment');
  const reason = str(flags.reason);
  if (!reason) throw new CliError('adjust <client> <amount> --reason="why" (negative to reduce funds in use)');
  await tx(db, async () => {
    await db.query("insert into account_entries (client_id, entry_on, kind, amount_cents, reason, ref, actor) values ($1, $2, 'adjustment', $3, $4, $4, $5)", [c.id, parseDate(flags.on) || today(), cents, reason, actor]);
    await record(db, actor, `adjustment ${cents / 100}`, c.code, { reason });
  });
  out(flags, { client: c.code, amount_cents: cents, reason }, (d) => console.log(`${d.client}: adjustment of ${$(d.amount_cents)} recorded (${d.reason}).`));
}

async function cmdLog(db, { args, flags }) {
  const actor = actorOf(flags);
  const [ref, ...rest] = args;
  const body = rest.join(' ').trim();
  if (!ref || !body) throw new CliError('log <client|debtor|invoice> "<note>"');
  let target = null;
  for (const kind of ['client', 'invoice', 'debtor']) {
    try { target = { kind, row: await resolve(db, kind, ref) }; break; } catch (e) { if (!/^No /.test(e.message)) throw e; }
  }
  if (!target) throw new CliError(`Nothing matches "${ref}".`);
  const cols = { client: 'client_id', debtor: 'debtor_id', invoice: 'invoice_id' };
  await db.query(`insert into notes (${cols[target.kind]}, body, actor) values ($1, $2, $3)`, [target.row.id, body, actor]);
  out(flags, { on: target.kind, ref, body }, (d) => console.log(`Note added to ${d.on} ${d.ref}.`));
}

// ---------------------------------------------------------------- reconcile against the client's own ledger

async function cmdReconcile(db, { args, flags }) {
  const c = await resolve(db, 'client', args[0]);
  const file = args[1];
  if (!file || !existsSync(file)) throw new CliError('reconcile <client> <aged-receivables.csv>: the client\'s own aged receivables export (Xero, MYOB or similar)');
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const theirs = new Map();
  for (const r of rows) {
    const no = pick(r, ...SCHEDULE_COLS.invoice).trim();
    if (!no) continue;
    theirs.set(no.toLowerCase(), { invoice_no: no, debtor: pick(r, ...SCHEDULE_COLS.debtor), open_cents: parseMoney(pick(r, 'Amount Due', 'Outstanding', 'Balance', 'Due', ...SCHEDULE_COLS.amount) || '0') });
  }
  const ours = await db.query('select b.invoice_no, d.name as debtor, b.open_cents from v_invoice_balance b join debtors d on d.id = b.debtor_id where b.client_id = $1 and b.recoursed_on is null', [c.id]);
  const oursMap = new Map(ours.map((o) => [o.invoice_no.toLowerCase(), o]));
  const paidToClient = []; const differs = []; const notAssigned = [];
  for (const o of ours) {
    if (num(o.open_cents) <= 0) continue;
    const t = theirs.get(o.invoice_no.toLowerCase());
    if (!t || t.open_cents === 0) paidToClient.push({ invoice_no: o.invoice_no, debtor: o.debtor, our_open_cents: num(o.open_cents), their_open_cents: t ? 0 : null });
    else if (t.open_cents !== num(o.open_cents)) differs.push({ invoice_no: o.invoice_no, debtor: o.debtor, our_open_cents: num(o.open_cents), their_open_cents: t.open_cents });
  }
  for (const t of theirs.values()) if (!oursMap.has(t.invoice_no.toLowerCase()) && t.open_cents > 0) notAssigned.push(t);
  const data = { client: c.code, file, shows_paid_or_missing: paidToClient, amounts_differ: differs, not_assigned: notAssigned };
  out(flags, data, (d) => {
    heading(`${d.client}: our ledger against the client's aged receivables`);
    console.log(`\n  Open with us, paid or missing in the client's ledger (${d.shows_paid_or_missing.length}): ask whether the debtor paid the client`);
    table(d.shows_paid_or_missing, [['invoice_no', 'Invoice'], ['debtor', 'Debtor'], ['our_open_cents', 'Open with us', $], ['their_open_cents', 'Client shows', (v) => (v === null ? 'not listed' : $(v))]]);
    console.log(`\n  Amounts differ (${d.amounts_differ.length}): a credit note we have not been told about?`);
    table(d.amounts_differ, [['invoice_no', 'Invoice'], ['debtor', 'Debtor'], ['our_open_cents', 'Ours', $], ['their_open_cents', 'Theirs', $]]);
    console.log(`\n  On the client's ledger, never assigned to us (${d.not_assigned.length}): ask for them on the next schedule`);
    table(d.not_assigned, [['invoice_no', 'Invoice'], ['debtor', 'Debtor'], ['open_cents', 'Open', $]]);
  });
}

// ---------------------------------------------------------------- drafts

async function cmdDraftLetter(db, { args, flags }) {
  const s = await settings(db);
  const kind = str(flags.kind) || 'noa';
  const c = await resolve(db, 'client', args[0]);
  let text = '';
  const date = today();
  if (kind === 'noa' || kind === 'debtor-reminder') {
    const d = await resolve(db, 'debtor', args[1]);
    const inv = await db.query('select invoice_no, invoice_date, due_date, open_cents from v_invoice_balance where client_id = $1 and debtor_id = $2 and open_cents > 0 and recoursed_on is null order by invoice_date', [c.id, d.id]);
    if (kind === 'noa') {
      text = `${date}\n\n${d.name}\nAttention: ${d.contact_name || 'Accounts Payable'}\n\nNotice of assignment: ${c.name}\n\n${c.name} has assigned to ${s.lender_name} the amounts payable, and to become payable, under its invoices to you, including every invoice it issues to you from today.\n\nPlease pay every amount owing on those invoices to ${s.lender_name}, to the account below, and not to ${c.name}. Payment made as this notice directs discharges what you owe to the extent of the payment.\n\nAccount name: ${s.lender_name}\nAccount: [lender trust account details]\nReference: the invoice number\n\nThis instruction stays in place until ${s.lender_name} tells you in writing that it has ended. If you would like proof of the assignment, ask us and we will send it within five business days.\n\nPlease confirm you have received this notice by replying to [lender email].\n\n${c.name}\nand\n${s.lender_name}\n\nThe notice identifies the contract by class (all invoices from ${c.name} to you) and states that payment is to be made to the transferee, as section 80(7) of the Personal Property Securities Act 2009 (Cth) describes. Check it with your adviser before first use.\n`;
    } else {
      const overdue = inv.filter((i) => i.due_date < date);
      if (!overdue.length) throw new CliError(`${d.name} has nothing overdue on ${c.code}.`);
      text = `${date}\n\n${d.name}\nAttention: ${d.contact_name || 'Accounts Payable'}\n\nOverdue invoices from ${c.name}\n\nThe invoices below are past their due date. They are payable to ${s.lender_name} under the notice of assignment you received.\n\n${overdue.map((i) => `  ${i.invoice_no}  dated ${i.invoice_date}  due ${i.due_date}  ${$(i.open_cents)}`).join('\n')}\n\nTotal overdue: ${$(overdue.reduce((a, i) => a + num(i.open_cents), 0))}\n\nIf any of these is not payable in full, please tell us why today so we can sort it out with ${c.name}.\n\n${s.lender_name}\n`;
    }
  } else if (kind === 'misdirected') {
    const m = await db.query('select debtor_name, invoice_no, received_on, amount_cents from v_misdirected where client_code = $1', [c.code]);
    if (!m.length) throw new CliError(`${c.code} holds no debtor payments.`);
    text = `${date}\n\n${c.contact_name || c.name}\n${c.name}\n\nDebtor payments to pass on\n\nOur records show these debtor payments reached your account. They belong to the facility and need to be passed on to ${s.lender_name}:\n\n${m.map((x) => `  ${x.debtor_name}  ${x.invoice_no}  paid ${x.received_on}  ${$(x.amount_cents)}`).join('\n')}\n\nTotal: ${$(m.reduce((a, x) => a + num(x.amount_cents), 0))}\n\nPlease transfer it today, quoting the invoice numbers, and let the debtor know the correct account for future payments.\n\n${s.lender_name}\n`;
  } else if (kind === 'over-advance') {
    const [p] = await db.query('select * from v_availability where client_id = $1', [c.id]);
    if (num(p.available_cents) >= 0) throw new CliError(`${c.code} is not over-advanced.`);
    const reasons = await db.query('select ineligible_reason, sum(open_cents)::bigint as cents from v_eligibility where client_id = $1 and ineligible_reason is not null group by 1 order by 2 desc', [c.id]);
    text = `${date}\n\n${c.contact_name || c.name}\n${c.name}\n\nYour facility is over its drawing base\n\nToday your eligible invoices support ${$(p.drawing_base_cents)} of funding, and ${$(p.funds_in_use_cents)} is in use. The facility is over by ${$(-num(p.available_cents))}.\n\nWhat has stopped counting:\n${reasons.map((r) => `  ${r.ineligible_reason}: ${$(r.cents)}`).join('\n')}${num(p.concentration_excess_cents) ? `\n  over the debtor concentration limit: ${$(p.concentration_excess_cents)}` : ''}\n\nTo bring it back inside, send new invoices on a schedule, or repay the difference. We cannot make a further advance until it is back inside.\n\n${s.lender_name}\n`;
  } else throw new CliError('--kind=noa|debtor-reminder|misdirected|over-advance');
  mkdirSync(path.join(REPO_ROOT, 'drafts'), { recursive: true });
  const file = path.join('drafts', `${kind}-${c.code.toLowerCase()}${args[1] ? '-' + args[1].toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''}-${date}.txt`);
  writeFileSync(path.join(REPO_ROOT, file), text);
  out(flags, { file, kind, client: c.code }, (d) => console.log(`Draft written to ${d.file}. Nothing is sent from here.`));
}

// ---------------------------------------------------------------- import from a Lendscape-style export

const IMPORT_COLS = {
  code: ['Client Code', 'Client ID', 'Client Number', 'Account Number', 'Client Ref'],
  client: ['Client Name', 'Client', 'Name'],
  limit: ['Facility Limit', 'Limit', 'Credit Limit'],
  advance: ['Prepayment %', 'Prepayment Rate', 'Advance Rate', 'Advance %', 'Prepayment'],
  discount: ['Discount Rate', 'Discount %', 'Interest Rate'],
  service: ['Service Fee %', 'Service Charge', 'Admin Fee %', 'Service Fee'],
  type: ['Facility Type', 'Disclosure', 'Product'],
  balance: ['Funds In Use', 'Current Account Balance', 'Funds Employed', 'Balance', 'Client Balance'],
};

async function cmdImport(db, { args, flags }) {
  const [source, folder] = args;
  if (source !== 'lendscape' || !folder) throw new CliError('import lendscape <folder> [--dry-run] [--as-at=YYYY-MM-DD]  (folder holds clients.csv, debtors.csv, invoices.csv)');
  const actor = flags['dry-run'] ? 'dry run' : actorOf(flags);
  const asAt = parseDate(flags['as-at']) || today();
  const read = (name) => { const f = path.join(folder, name); if (!existsSync(f)) throw new CliError(`${f} is missing. Export ${name.replace('.csv', '')} from Lendscape as CSV.`); return parseCsv(readFileSync(f, 'utf8')); };
  const cRows = read('clients.csv'); const dRows = read('debtors.csv'); const iRows = read('invoices.csv');
  const problems = [];
  const clients = cRows.map((r, n) => {
    const code = pick(r, ...IMPORT_COLS.code).trim().toUpperCase();
    const name = pick(r, ...IMPORT_COLS.client).trim();
    if (!code || !name) problems.push(`clients.csv row ${n + 2}: needs a client code and name`);
    const t = pick(r, ...IMPORT_COLS.type).toLowerCase();
    let limit = 0; let balance = 0;
    try { limit = parseMoney(pick(r, ...IMPORT_COLS.limit), 'facility limit'); } catch (e) { problems.push(`clients.csv row ${n + 2}: ${e.message}`); }
    try { balance = parseMoney(pick(r, ...IMPORT_COLS.balance) || '0'); } catch (e) { problems.push(`clients.csv row ${n + 2}: ${e.message}`); }
    return { code, name, limit, balance, advance: num(String(pick(r, ...IMPORT_COLS.advance)).replace('%', '')) || 80, discount: num(String(pick(r, ...IMPORT_COLS.discount)).replace('%', '')) || 0, service: num(String(pick(r, ...IMPORT_COLS.service)).replace('%', '')) || 0, type: /confid|undisclosed|invoice discount/.test(t) ? 'confidential' : 'disclosed' };
  });
  const debtors = dRows.map((r, n) => {
    const name = pick(r, 'Debtor Name', 'Debtor', 'Customer Name', 'Name').trim();
    if (!name) problems.push(`debtors.csv row ${n + 2}: no debtor name`);
    let limit = null;
    try { const v = pick(r, 'Debtor Limit', 'Credit Limit', 'Limit'); limit = v ? parseMoney(v) : null; } catch (e) { problems.push(`debtors.csv row ${n + 2}: ${e.message}`); }
    return { name, terms: num(pick(r, 'Terms', 'Terms Days', 'Payment Terms').replace(/\D/g, '')) || 30, limit, abn: pick(r, 'ABN', 'NZBN', 'Business Number') || null };
  });
  const dNames = new Set([...debtors.map((d) => d.name.toLowerCase()), ...(await db.query('select lower(name) as n from debtors')).map((r) => r.n)]);
  const cCodes = new Set(clients.map((c) => c.code));
  const invoices = iRows.map((r, n) => {
    const code = pick(r, ...IMPORT_COLS.code).trim().toUpperCase();
    const debtor = pick(r, ...SCHEDULE_COLS.debtor).trim();
    if (!cCodes.has(code)) problems.push(`invoices.csv row ${n + 2}: client "${code}" is not in clients.csv`);
    if (!dNames.has(debtor.toLowerCase())) problems.push(`invoices.csv row ${n + 2}: debtor "${debtor}" is not in debtors.csv`);
    let date; let due; let open;
    try { date = parseDate(pick(r, ...SCHEDULE_COLS.date), 'invoice date'); due = parseDate(pick(r, ...SCHEDULE_COLS.due), 'due date') || date; } catch (e) { problems.push(`invoices.csv row ${n + 2}: ${e.message}`); }
    try { open = parseMoney(pick(r, 'Outstanding', 'Balance', 'Open Amount', 'Amount Due', ...SCHEDULE_COLS.amount)); } catch (e) { problems.push(`invoices.csv row ${n + 2}: ${e.message}`); }
    return { code, debtor, invoice_no: pick(r, ...SCHEDULE_COLS.invoice).trim(), date, due, open, disputed: /^(y|yes|true|1)$/i.test(pick(r, 'Disputed', 'Dispute', 'In Dispute')) };
  });
  const existing = await db.query('select code from clients where code = any($1::text[])', [clients.map((c) => c.code)]);
  for (const e of existing) problems.push(`client ${e.code} is already in the database`);
  if (problems.length) throw new CliError(`Import refused, nothing written:\n  ${problems.slice(0, 30).join('\n  ')}`);
  const summary = { dry_run: !!flags['dry-run'], as_at: asAt, clients: clients.length, debtors: debtors.length, invoices: invoices.length, open_cents: invoices.reduce((a, i) => a + i.open, 0), funds_in_use_cents: clients.reduce((a, c) => a + c.balance, 0) };
  if (!flags['dry-run']) {
    await tx(db, async () => {
      for (const d of debtors) await db.query('insert into debtors (name, terms_days, credit_limit_cents, business_number) values ($1, $2, $3, $4) on conflict (name) do nothing', [d.name, d.terms, d.limit, d.abn]);
      const ids = {};
      for (const c of clients) {
        const [row] = await db.query(`insert into clients (code, name, status, facility_type, facility_limit_cents, advance_pct, discount_pct, service_fee_pct, started_on, notes)
          values ($1, $2, 'active', $3, $4, $5, $6, $7, $8, 'Imported from Lendscape. Record due diligence and the security registration to fund.') returning id`, [c.code, c.name, c.type, c.limit, c.advance, c.discount, c.service, asAt]);
        ids[c.code] = row.id;
      }
      for (const c of clients) {
        const [s] = await db.query("insert into schedules (client_id, ref, received_on, status, note) values ($1, 'OPENING', $2, 'funded', 'Open ledger brought across from Lendscape') returning id", [ids[c.code], asAt]);
        c.schedule = s.id;
      }
      for (const i of invoices) {
        const [d] = await db.query('select id from debtors where lower(name) = lower($1)', [i.debtor]);
        const c = clients.find((x) => x.code === i.code);
        await db.query('insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents, disputed_on, dispute_reason, verified_on, verified_by, verify_method, verify_contact) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
          [ids[i.code], d.id, c.schedule, i.invoice_no, i.date, i.due, i.open, i.disputed ? asAt : null, i.disputed ? 'Disputed in Lendscape at cutover' : null, asAt, 'Lendscape import', 'portal', 'Verified status carried from Lendscape']);
        await db.query('update client_debtors set noa_sent_on = coalesce(noa_sent_on, $3) where client_id = $1 and debtor_id = $2', [ids[i.code], d.id, asAt]);
      }
      for (const c of clients) {
        if (c.balance) await db.query("insert into account_entries (client_id, entry_on, kind, amount_cents, reason, ref, actor) values ($1, $2, 'adjustment', $3, 'Opening funds in use from Lendscape', 'OPENING', $4)", [ids[c.code], asAt, c.balance, actor]);
      }
      await record(db, actor, 'import from Lendscape', folder, summary);
    });
  }
  out(flags, summary, (d) => console.log(`${d.dry_run ? 'Test run: ' : ''}${d.clients} clients, ${d.debtors} debtors, ${d.invoices} open invoices (${$(d.open_cents)}), ${$(d.funds_in_use_cents)} funds in use as at ${d.as_at}.${d.dry_run ? ' Nothing written.' : ''}`));
}

// ---------------------------------------------------------------- export, help

async function cmdExport(db, { flags }) {
  const file = path.resolve(str(flags.file) || path.join(REPO_ROOT, 'exports', `invoice-finance-${today()}.json`));
  if (existsSync(file)) throw new CliError(`${file} already exists. Choose another --file.`);
  const tables = ['settings', 'clients', 'debtors', 'client_debtors', 'schedules', 'invoices', 'credit_notes', 'collections', 'account_entries', 'field_audits', 'notes', 'history'];
  const dump = { exported_at: new Date().toISOString(), tables: {} };
  const counts = {};
  for (const t of tables) { dump.tables[t] = await db.query(`select * from ${t}`); counts[t] = dump.tables[t].length; }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(dump, null, 2), { mode: 0o600 });
  out(flags, { file, counts }, (d) => console.log(`Exported to ${d.file}: ${Object.entries(d.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`));
}

const COMMANDS = {
  clients: [cmdClients, 'clients [--all]', 'Every client: facility, ledger, funds in use, what they can draw'],
  client: [cmdClient, 'client <code|name>', 'One client: terms, position, ineligibles, concentration, debtors, notes'],
  debtors: [cmdDebtors, 'debtors', 'Every debtor with open exposure and status'],
  debtor: [cmdDebtor, 'debtor <name>', 'One debtor: open invoices across clients, payment habits, notes'],
  position: [cmdPosition, 'position', 'What every client can draw today, and who is over-advanced'],
  invoices: [cmdInvoices, 'invoices [<client>] [--ineligible]', 'Open invoices and why any do not count'],
  schedules: [cmdSchedules, 'schedules [--open]', 'Schedules of invoices received, funded or rejected'],
  'verify-queue': [cmdVerifyQueue, 'verify-queue', 'Invoices to verify with the debtor, funded ones first'],
  ageing: [cmdAgeing, 'ageing [<client>]', 'Open ledger by age from invoice date'],
  concentration: [cmdConcentration, 'concentration', 'Debtors over a client\'s concentration limit'],
  exposure: [cmdExposure, 'exposure', 'Exposure to each debtor across every client'],
  dilution: [cmdDilution, 'dilution', 'Credit notes against invoices, last 90 days'],
  misdirected: [cmdMisdirected, 'misdirected', 'Debtor payments the client is holding'],
  disputes: [cmdDisputes, 'disputes', 'Open disputes, oldest first'],
  account: [cmdAccount, 'account <client>', 'The client account: advances, fees, collections, funds in use'],
  calendar: [cmdCalendar, 'calendar [--days=60]', 'Registrations ending, reviews and audits due, invoices passing the recourse date'],
  compliance: [cmdCompliance, 'compliance', 'Checks the book against the PPSA, your AML/CTF programme and your credit policy'],
  attention: [cmdAttention, 'attention', 'What needs doing now'],
  history: [cmdHistory, 'history [--limit=30]', 'Who did what'],
  fees: [cmdFees, 'fees [<client>] [--month=YYYY-MM] [--apply --actor=]', 'Discount, service and minimum fees for a month: test run, then charge'],
  onboard: [cmdOnboard, 'onboard <CODE> --name= --limit= [--advance=] [--discount=] [--service=] [--type=] --actor=', 'Add a client (onboarding)'],
  cdd: [cmdCdd, 'cdd <client> [--on=] [--review=] [--risk=] --actor=', 'Record customer due diligence done'],
  ppsr: [cmdPpsr, 'ppsr <client> --ref= [--on=] [--expires=] | --discharged= --actor=', 'Record the security registration, or its discharge'],
  audit: [cmdAudit, 'audit <client> --findings= [--on=] --actor=', 'Record a field audit of the client\'s books'],
  status: [cmdStatus, 'status <client> onboarding|active|watch|exited --actor=', 'Change a client\'s status'],
  'add-debtor': [cmdAddDebtor, 'add-debtor "<name>" [--terms=] [--limit=] --actor=', 'Add a debtor'],
  'debtor-status': [cmdDebtorStatus, 'debtor-status <debtor> approved|watch|blocked --actor=', 'Approve, watch or block a debtor'],
  noa: [cmdNoa, 'noa <client> <debtor> [--sent=] [--ack=] --actor=', 'Record a notice of assignment sent or acknowledged'],
  schedule: [cmdSchedule, 'schedule <client> <invoices.csv> --ref= [--dry-run] --actor=', 'Receive a schedule of invoices'],
  verify: [cmdVerify, 'verify <invoice> --method= --contact= --actor=', 'Record that the debtor confirmed an invoice'],
  reject: [cmdReject, 'reject <client> <schedule> --reason= --actor=', 'Reject a schedule'],
  fund: [(db, a) => fundOrRelease(db, a, 'advance'), 'fund <client> <amount> [--schedule=] --actor=', 'Record an advance (refused above what the client can draw)'],
  release: [(db, a) => fundOrRelease(db, a, 'release'), 'release <client> <amount> --actor=', 'Record a release of surplus to the client'],
  collect: [cmdCollect, 'collect <invoice> <amount> [--to=client] [--on=] [--ref=] --actor=', 'Record a debtor payment the bank received'],
  'passed-on': [cmdPassedOn, 'passed-on <invoice> [--on=] --actor=', 'A misdirected payment reached the lender'],
  credit: [cmdCredit, 'credit <invoice> <amount> --reason= --actor=', 'Record a credit note'],
  dispute: [cmdDispute, 'dispute <invoice> --reason= --actor=', 'Mark an invoice disputed'],
  resolve: [cmdResolve, 'resolve <invoice> --actor=', 'Close a dispute'],
  recourse: [cmdRecourse, 'recourse <invoice> --actor=', 'Hand an invoice back to the client'],
  adjust: [cmdAdjust, 'adjust <client> <amount> --reason= --actor=', 'A correcting entry on the client account'],
  log: [cmdLog, 'log <client|debtor|invoice> "<note>" --actor=', 'A note on a file'],
  reconcile: [cmdReconcile, 'reconcile <client> <aged-receivables.csv>', 'Our ledger against the client\'s own'],
  'draft-letter': [cmdDraftLetter, 'draft-letter <client> [<debtor>] --kind=noa|debtor-reminder|misdirected|over-advance', 'Draft a letter to drafts/'],
  import: [cmdImport, 'import lendscape <folder> [--dry-run] [--as-at=] --actor=', 'Bring clients, debtors, open invoices and balances across'],
  export: [cmdExport, 'export [--file=]', 'Everything to one JSON file'],
  help: [null, 'help', 'This list'],
};

async function main() {
  const { args, flags } = parseArgv(process.argv.slice(2));
  const name = args.shift() || 'help';
  if (name === 'help' || flags.help || !COMMANDS[name]) {
    const list = Object.entries(COMMANDS).map(([k, [, usage, what]]) => ({ command: k, usage, what }));
    if (flags.json) console.log(JSON.stringify(list, null, 2));
    else { heading('Invoice Finance for Claude Code'); table(list, [['usage', 'Command'], ['what', 'What it does']]); }
    if (name !== 'help' && !flags.help && !COMMANDS[name]) { console.error(`Unknown command "${name}".`); process.exit(1); }
    return;
  }
  const db = await getDb();
  try {
    await settings(db).catch(() => {});
    await COMMANDS[name][0](db, { args, flags });
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  const msg = e instanceof CliError ? e.message : String(e.message || e).replace(/^error: /, '');
  console.error(msg);
  process.exit(e.code && Number.isInteger(e.code) ? e.code : 1);
});
