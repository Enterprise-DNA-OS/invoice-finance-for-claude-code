-- invoice-finance-for-claude-code: core schema.
-- An invoice finance lender's book: the clients it funds, the debtors who owe
-- them, the schedules of invoices each client assigns, verification, notices of
-- assignment, advances and releases, debtor collections, credit notes,
-- disputes, recourse, fees, and the client's funds in use.
--
-- Runs unchanged on PGlite (embedded) and on Postgres / Supabase.
--
-- Money is stored in cents. The client account is a RECORD: advances and
-- collections move through the lender's bank, and are recorded here. This
-- database never moves money, never registers a security interest and never
-- makes a credit decision: it records them, and it refuses the steps the
-- lender's own rules forbid.
--
-- The rules live in the database, not a screen: an advance above what the
-- client can draw is refused, an advance to a client whose customer due
-- diligence is not done or whose security is not registered is refused, a
-- collection above what an invoice still owes is refused, fees cannot be
-- charged twice for the same month, and the client account is append only.
-- docs/compliance.md cites the law behind each check.

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- ---------------------------------------------------------------- settings

create table settings (
  id boolean primary key default true check (id),
  lender_name text not null,
  currency text not null default 'AUD',
  jurisdiction text not null default 'AU' check (jurisdiction in ('NZ', 'AU')),
  verify_over_cents bigint not null default 1000000,     -- verify every invoice at or above this before funding (credit policy)
  recourse_days integer not null default 90,              -- default: days from invoice date before an invoice stops counting
  concentration_pct numeric(5,2) not null default 25,     -- default: one debtor's share of a client's eligible ledger
  cdd_review_months integer not null default 12,          -- ongoing due diligence review cycle (AML/CFT programme)
  audit_months integer not null default 6,                -- field audit of each client's books (credit policy)
  ppsr_warn_days integer not null default 60,             -- warn this many days before a registration expires
  dilution_watch_pct numeric(5,2) not null default 5,     -- credit notes as a share of invoices, last 90 days
  misdirected_days integer not null default 2,            -- days a client may hold a debtor payment before passing it on
  updated_at timestamptz not null default now()
);
create trigger settings_updated before update on settings for each row execute function set_updated_at();

-- ---------------------------------------------------------------- clients

create table clients (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  business_number text,                                    -- NZBN or ABN
  industry text,
  status text not null default 'onboarding' check (status in ('onboarding', 'active', 'watch', 'exited')),
  facility_type text not null default 'disclosed' check (facility_type in ('disclosed', 'confidential')),
  facility_limit_cents bigint not null check (facility_limit_cents >= 0),
  advance_pct numeric(5,2) not null default 80 check (advance_pct > 0 and advance_pct <= 100),
  discount_pct numeric(6,3) not null default 1.25 check (discount_pct >= 0),   -- per 30 days on funds in use
  service_fee_pct numeric(6,3) not null default 0.50 check (service_fee_pct >= 0), -- of the face value assigned
  min_monthly_fee_cents bigint not null default 0,
  concentration_pct numeric(5,2),                          -- null: the settings default
  recourse_days integer,                                   -- null: the settings default
  risk_rating text not null default 'medium' check (risk_rating in ('low', 'medium', 'high')),
  cdd_completed_on date,                                   -- customer due diligence finished
  cdd_review_due date,
  ppsr_reference text,                                     -- financing statement or registration number
  ppsr_registered_on date,
  ppsr_expires_on date,
  ppsr_discharged_on date,                                 -- registration ended or discharged after exit
  last_audit_on date,
  next_audit_due date,
  manager text,
  contact_name text,
  contact_email text,
  started_on date,
  exited_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ppsr_expires_on is null or ppsr_registered_on is null or ppsr_expires_on > ppsr_registered_on)
);
create trigger clients_updated before update on clients for each row execute function set_updated_at();

-- ---------------------------------------------------------------- debtors

create table debtors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  business_number text,
  terms_days integer not null default 30 check (terms_days between 0 and 365),
  credit_limit_cents bigint,                                -- the lender's limit on this debtor across every client
  status text not null default 'approved' check (status in ('approved', 'watch', 'blocked')),
  contact_name text,
  contact_email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger debtors_updated before update on debtors for each row execute function set_updated_at();

-- The notice of assignment, per client and debtor.
create table client_debtors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  debtor_id uuid not null references debtors(id),
  noa_sent_on date,
  noa_acknowledged_on date,
  created_at timestamptz not null default now(),
  unique (client_id, debtor_id),
  check (noa_acknowledged_on is null or (noa_sent_on is not null and noa_acknowledged_on >= noa_sent_on))
);

-- ---------------------------------------------------------------- schedules and invoices

create table schedules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  ref text not null,
  received_on date not null,
  status text not null default 'received' check (status in ('received', 'funded', 'rejected')),
  note text,
  created_at timestamptz not null default now(),
  unique (client_id, ref)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  debtor_id uuid not null references debtors(id),
  schedule_id uuid references schedules(id),
  invoice_no text not null,
  invoice_date date not null,
  due_date date not null,
  face_cents bigint not null check (face_cents > 0),
  verified_on date,
  verified_by text,
  verify_method text check (verify_method in ('phone', 'email', 'portal', 'signed_delivery')),
  verify_contact text,
  disputed_on date,
  dispute_reason text,
  dispute_resolved_on date,
  recoursed_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, invoice_no),
  check (due_date >= invoice_date)
);
create trigger invoices_updated before update on invoices for each row execute function set_updated_at();
create index invoices_client on invoices(client_id);
create index invoices_debtor on invoices(debtor_id);

-- An invoice's own debtor must belong to the invoice's client, and its schedule too.
create or replace function invoices_check() returns trigger
language plpgsql as $$
begin
  if new.schedule_id is not null and not exists (select 1 from schedules s where s.id = new.schedule_id and s.client_id = new.client_id) then
    raise exception 'Invoice %: the schedule belongs to another client', new.invoice_no;
  end if;
  insert into client_debtors (client_id, debtor_id) values (new.client_id, new.debtor_id) on conflict do nothing;
  return new;
end
$$;
create trigger invoices_check before insert or update of client_id, debtor_id, schedule_id on invoices for each row execute function invoices_check();

create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id),
  issued_on date not null,
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null,
  actor text not null,
  created_at timestamptz not null default now()
);

-- A debtor payment. paid_to = 'client' is a misdirected payment: the debtor
-- paid the client instead of the lender, and the client must pass it on.
create table collections (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id),
  received_on date not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_to text not null default 'lender' check (paid_to in ('lender', 'client')),
  passed_on_on date,                                          -- the day a misdirected payment reached the lender
  ref text,
  actor text not null,
  created_at timestamptz not null default now(),
  check (paid_to = 'client' or passed_on_on is null),
  check (passed_on_on is null or passed_on_on >= received_on)
);
create index collections_invoice on collections(invoice_id);

create or replace function invoice_open_cents(inv uuid) returns bigint
language sql stable as $$
  select i.face_cents
    - coalesce((select sum(c.amount_cents) from collections c where c.invoice_id = i.id), 0)
    - coalesce((select sum(n.amount_cents) from credit_notes n where n.invoice_id = i.id), 0)
  from invoices i where i.id = inv
$$;

create or replace function money_on_invoice_check() returns trigger
language plpgsql as $$
declare open_c bigint;
begin
  select invoice_open_cents(new.invoice_id) into open_c;
  if new.amount_cents > open_c then
    raise exception 'Invoice still owes % cents; % cents is more than that. Record the excess as an unapplied payment with the client instead.', open_c, new.amount_cents;
  end if;
  return new;
end
$$;
create trigger collections_check before insert on collections for each row execute function money_on_invoice_check();
create trigger credit_notes_check before insert on credit_notes for each row execute function money_on_invoice_check();

-- ---------------------------------------------------------------- the client account

-- Funds in use = advances + releases + fees + charges - collections that reached the lender.
-- Positive amounts increase what the client owes the lender.
create table account_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  entry_on date not null,
  kind text not null check (kind in ('advance', 'release', 'fee', 'collection', 'adjustment')),
  fee_kind text check (fee_kind in ('discount', 'service', 'minimum', 'other')),
  period text,                                                -- YYYY-MM for monthly fees
  amount_cents bigint not null check (amount_cents <> 0),
  schedule_id uuid references schedules(id),
  collection_id uuid references collections(id),
  ref text,
  reason text,
  actor text not null,
  created_at timestamptz not null default now(),
  check ((kind = 'collection') = (amount_cents < 0 and collection_id is not null) or kind = 'adjustment'),
  check (kind <> 'fee' or fee_kind is not null),
  check (kind <> 'adjustment' or reason is not null)
);
create index account_client on account_entries(client_id, entry_on);
create unique index one_fee_a_month on account_entries(client_id, fee_kind, period) where kind = 'fee' and period is not null;

create or replace function append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'The client account is append only. Correct a mistake with an adjustment entry.';
end
$$;
create trigger account_append_only before update or delete on account_entries for each row execute function append_only();
create trigger collections_append_only before delete on collections for each row execute function append_only();

-- A collection that reaches the lender credits the client account.
create or replace function collection_to_account() returns trigger
language plpgsql as $$
declare cid uuid;
begin
  if (tg_op = 'INSERT' and new.paid_to = 'lender') or (tg_op = 'UPDATE' and old.passed_on_on is null and new.passed_on_on is not null) then
    select client_id into cid from invoices where id = new.invoice_id;
    insert into account_entries (client_id, entry_on, kind, amount_cents, collection_id, ref, actor)
    values (cid, coalesce(new.passed_on_on, new.received_on), 'collection', -new.amount_cents, new.id, new.ref, new.actor);
  end if;
  if tg_op = 'UPDATE' and (old.amount_cents <> new.amount_cents or old.invoice_id <> new.invoice_id or old.paid_to <> new.paid_to or (old.passed_on_on is not null and new.passed_on_on is distinct from old.passed_on_on)) then
    raise exception 'A recorded collection cannot be changed. Only the date a misdirected payment was passed on can be added.';
  end if;
  return new;
end
$$;
create trigger collections_account after insert or update on collections for each row execute function collection_to_account();

-- ---------------------------------------------------------------- notes, audits and history

create table field_audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  done_on date not null,
  findings text not null,
  actor text not null,
  created_at timestamptz not null default now()
);

create table notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id),
  debtor_id uuid references debtors(id),
  invoice_id uuid references invoices(id),
  body text not null,
  actor text not null,
  created_at timestamptz not null default now(),
  check (client_id is not null or debtor_id is not null or invoice_id is not null)
);

create table history (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  subject text,
  detail jsonb
);

-- ---------------------------------------------------------------- views

create view v_client_terms as
select c.*,
  coalesce(c.concentration_pct, s.concentration_pct) as conc_pct,
  coalesce(c.recourse_days, s.recourse_days) as rec_days,
  s.verify_over_cents, s.currency
from clients c cross join settings s;

create view v_invoice_balance as
select i.*,
  coalesce((select sum(c.amount_cents) from collections c where c.invoice_id = i.id), 0)::bigint as collected_cents,
  coalesce((select sum(n.amount_cents) from credit_notes n where n.invoice_id = i.id), 0)::bigint as credited_cents,
  invoice_open_cents(i.id) as open_cents,
  (current_date - i.invoice_date) as age_days,
  greatest(current_date - i.due_date, 0) as days_past_due
from invoices i;

-- Every open invoice, with whether it counts toward what the client can draw and why not.
create view v_eligibility as
select b.id as invoice_id, b.client_id, b.debtor_id, b.invoice_no, b.invoice_date, b.due_date, b.open_cents, b.age_days,
  t.code as client_code, d.name as debtor_name, t.currency,
  case
    when b.recoursed_on is not null then 'recoursed'
    when b.disputed_on is not null and b.dispute_resolved_on is null then 'disputed'
    when b.schedule_id is null then 'not assigned on a schedule'
    when sc.status = 'rejected' then 'schedule rejected'
    when d.status = 'blocked' then 'debtor blocked'
    when b.age_days > t.rec_days then 'past ' || t.rec_days || ' days'
    when b.face_cents >= t.verify_over_cents and b.verified_on is null then 'not verified'
    when t.facility_type = 'disclosed' and cd.noa_sent_on is null then 'no notice of assignment'
    else null
  end as ineligible_reason
from v_invoice_balance b
join v_client_terms t on t.id = b.client_id
join debtors d on d.id = b.debtor_id
left join schedules sc on sc.id = b.schedule_id
left join client_debtors cd on cd.client_id = b.client_id and cd.debtor_id = b.debtor_id
where b.open_cents > 0;

-- One debtor's share of a client's eligible ledger, and the excess over the limit.
create view v_concentration as
with e as (
  select client_id, debtor_id, debtor_name, client_code, currency, sum(open_cents)::bigint as eligible_cents
  from v_eligibility where ineligible_reason is null group by 1, 2, 3, 4, 5
), tot as (select client_id, sum(eligible_cents)::bigint as total_cents from e group by 1)
select e.client_id, e.client_code, e.debtor_id, e.debtor_name, e.currency, e.eligible_cents, tot.total_cents,
  round(100.0 * e.eligible_cents / nullif(tot.total_cents, 0), 1) as share_pct,
  t.conc_pct as limit_pct,
  greatest(e.eligible_cents - floor(tot.total_cents * t.conc_pct / 100), 0)::bigint as excess_cents
from e join tot on tot.client_id = e.client_id join v_client_terms t on t.id = e.client_id;

create view v_funds_in_use as
select c.id as client_id, coalesce(sum(a.amount_cents), 0)::bigint as funds_in_use_cents
from clients c left join account_entries a on a.client_id = c.id
group by c.id;

-- What each client can draw today.
create view v_position as
select t.id as client_id, t.code, t.name, t.status, t.currency, t.facility_type, t.facility_limit_cents, t.advance_pct,
  coalesce((select sum(open_cents) from v_eligibility e where e.client_id = t.id), 0)::bigint as ledger_cents,
  coalesce((select sum(open_cents) from v_eligibility e where e.client_id = t.id and e.ineligible_reason is not null), 0)::bigint as ineligible_cents,
  coalesce((select sum(excess_cents) from v_concentration k where k.client_id = t.id), 0)::bigint as concentration_excess_cents,
  f.funds_in_use_cents
from v_client_terms t join v_funds_in_use f on f.client_id = t.id;

create view v_availability as
select p.*,
  (p.ledger_cents - p.ineligible_cents - p.concentration_excess_cents) as eligible_cents,
  least(floor((p.ledger_cents - p.ineligible_cents - p.concentration_excess_cents) * p.advance_pct / 100), p.facility_limit_cents)::bigint as drawing_base_cents,
  (least(floor((p.ledger_cents - p.ineligible_cents - p.concentration_excess_cents) * p.advance_pct / 100), p.facility_limit_cents) - p.funds_in_use_cents)::bigint as available_cents
from v_position p;

create view v_ageing as
select e.client_id, e.client_code, e.currency,
  sum(case when e.age_days <= 30 then e.open_cents else 0 end)::bigint as d0_30_cents,
  sum(case when e.age_days between 31 and 60 then e.open_cents else 0 end)::bigint as d31_60_cents,
  sum(case when e.age_days between 61 and 90 then e.open_cents else 0 end)::bigint as d61_90_cents,
  sum(case when e.age_days > 90 then e.open_cents else 0 end)::bigint as d90_plus_cents,
  sum(e.open_cents)::bigint as total_cents
from v_eligibility e group by 1, 2, 3;

create view v_dilution as
select c.id as client_id, c.code, s.currency,
  coalesce((select sum(i.face_cents) from invoices i where i.client_id = c.id and i.invoice_date > current_date - 90), 0)::bigint as invoiced_cents,
  coalesce((select sum(n.amount_cents) from credit_notes n join invoices i on i.id = n.invoice_id where i.client_id = c.id and n.issued_on > current_date - 90), 0)::bigint as credited_cents,
  s.dilution_watch_pct
from clients c cross join settings s where c.status <> 'exited';

create view v_misdirected as
select col.id as collection_id, c.code as client_code, c.name as client_name, d.name as debtor_name, i.invoice_no,
  col.received_on, col.amount_cents, (current_date - col.received_on) as days_held, s.misdirected_days, s.currency
from collections col
join invoices i on i.id = col.invoice_id join clients c on c.id = i.client_id join debtors d on d.id = i.debtor_id
cross join settings s
where col.paid_to = 'client' and col.passed_on_on is null;

create view v_exposure as
select d.id as debtor_id, d.name as debtor_name, d.status, d.credit_limit_cents, s.currency,
  count(distinct b.client_id)::int as clients,
  coalesce(sum(b.open_cents), 0)::bigint as open_cents,
  coalesce(sum(case when b.days_past_due > 0 then b.open_cents else 0 end), 0)::bigint as overdue_cents
from debtors d cross join settings s
left join v_invoice_balance b on b.debtor_id = d.id and b.open_cents > 0 and b.recoursed_on is null
group by d.id, s.currency;

-- ---------------------------------------------------------------- the funding rules

-- An advance or a release is refused when the client is not funded, its due
-- diligence is not done, its security is not registered, or the amount is more
-- than it can draw today. Fees, collections and adjustments are not limited.
create or replace function account_entry_check() returns trigger
language plpgsql as $$
declare c record; avail bigint;
begin
  if new.kind not in ('advance', 'release') then return new; end if;
  if new.amount_cents <= 0 then raise exception 'An % is a positive amount.', new.kind; end if;
  select * into c from clients where id = new.client_id;
  if c.status not in ('active', 'watch') then
    raise exception '% is %, not funded. Make the client active first.', c.code, c.status;
  end if;
  if c.cdd_completed_on is null then
    raise exception '% has no completed customer due diligence on file. No funding until it is recorded.', c.code;
  end if;
  if c.ppsr_registered_on is null then
    raise exception '% has no security registration on file. Register it on the PPSR and record it before funding.', c.code;
  end if;
  if c.ppsr_expires_on is not null and c.ppsr_expires_on <= new.entry_on then
    raise exception '% security registration ended on %. Renew it before funding.', c.code, c.ppsr_expires_on;
  end if;
  select available_cents into avail from v_availability where client_id = new.client_id;
  if new.amount_cents > avail then
    raise exception '% can draw % cents today; % cents would over-advance the facility.', c.code, greatest(avail, 0), new.amount_cents;
  end if;
  return new;
end
$$;
create trigger account_entry_check before insert on account_entries for each row execute function account_entry_check();

alter table settings enable row level security;
alter table clients enable row level security;
alter table debtors enable row level security;
alter table client_debtors enable row level security;
alter table schedules enable row level security;
alter table invoices enable row level security;
alter table credit_notes enable row level security;
alter table collections enable row level security;
alter table account_entries enable row level security;
alter table field_audits enable row level security;
alter table notes enable row level security;
alter table history enable row level security;
