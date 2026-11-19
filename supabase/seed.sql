-- Demo data: Harbourline Trade Finance, a fictional Sydney invoice financier.
-- Dates are relative to today, so the book always has something to say:
-- an over-advanced client after credit notes and a dispute, a debtor that paid
-- the client instead of the lender nine days ago, one debtor carrying most of
-- a client's ledger, a security registration about to end, a due diligence
-- review overdue, a field audit overdue, an invoice past the recourse date, an
-- unverified invoice above the threshold, and a client still onboarding.
-- Idempotent: a second run does nothing.

do $$
declare
  t date := current_date;
  clx uuid; brk uuid; mpk uuid; tce uuid; nff uuid; orb uuid;
  sg uuid; mr uuid; cb uuid; ph uuid; kc uuid; ib uuid; hh uuid; wd uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s7 uuid; s8 uuid;
  i uuid; col uuid;
begin
  if exists (select 1 from settings) then return; end if;

  insert into settings (lender_name, currency, jurisdiction, verify_over_cents, recourse_days, concentration_pct)
  values ('Harbourline Trade Finance Pty Ltd', 'AUD', 'AU', 1000000, 90, 40);

  -- ---------------------------------------------------------------- clients
  insert into clients (code, name, business_number, industry, status, facility_type, facility_limit_cents, advance_pct, discount_pct, service_fee_pct, min_monthly_fee_cents, concentration_pct, risk_rating,
    cdd_completed_on, cdd_review_due, ppsr_reference, ppsr_registered_on, ppsr_expires_on, last_audit_on, next_audit_due, manager, contact_name, contact_email, started_on)
  values ('CLX', 'Coastline Logistics Pty Ltd', '51 624 118 903', 'Freight', 'active', 'disclosed', 75000000, 85, 1.10, 0.40, 150000, 45, 'low',
    t - 400, t + 330, '201904110001234', t - 380, null, t - 70, t + 110, 'Priya Raman', 'Dan Whitlock', 'accounts@coastline.example', t - 380)
  returning id into clx;

  insert into clients (code, name, business_number, industry, status, facility_type, facility_limit_cents, advance_pct, discount_pct, service_fee_pct, min_monthly_fee_cents, risk_rating,
    cdd_completed_on, cdd_review_due, ppsr_reference, ppsr_registered_on, ppsr_expires_on, last_audit_on, next_audit_due, manager, contact_name, contact_email, started_on)
  values ('BRK', 'Brickfield Labour Services Pty Ltd', '73 109 552 418', 'Labour hire', 'active', 'confidential', 40000000, 80, 1.35, 0.60, 100000, 'medium',
    t - 300, t + 65, '202107220004411', t - 290, null, t - 210, t - 30, 'Priya Raman', 'Mel Farrow', 'mel@brickfield.example', t - 290)
  returning id into brk;

  insert into clients (code, name, business_number, industry, status, facility_type, facility_limit_cents, advance_pct, discount_pct, service_fee_pct, min_monthly_fee_cents, risk_rating,
    cdd_completed_on, cdd_review_due, ppsr_reference, ppsr_registered_on, ppsr_expires_on, last_audit_on, next_audit_due, manager, contact_name, contact_email, started_on)
  values ('MPK', 'Meridian Packaging Pty Ltd', '22 870 334 615', 'Manufacturing', 'watch', 'disclosed', 30000000, 80, 1.50, 0.50, 120000, 'high',
    t - 500, t - 40, '201811300009876', t - 700, null, t - 60, t + 120, 'Tom Hadley', 'Raj Sethi', 'raj@meridianpack.example', t - 700)
  returning id into mpk;

  insert into clients (code, name, business_number, industry, status, facility_type, facility_limit_cents, advance_pct, discount_pct, service_fee_pct, min_monthly_fee_cents, risk_rating,
    cdd_completed_on, cdd_review_due, ppsr_reference, ppsr_registered_on, ppsr_expires_on, last_audit_on, next_audit_due, manager, contact_name, contact_email, started_on)
  values ('TCE', 'Tallowood Civil Engineering Pty Ltd', '64 551 207 889', 'Civil construction', 'active', 'disclosed', 50000000, 75, 1.25, 0.45, 150000, 'medium',
    t - 200, t + 165, '201912050007720', t - 2520, t + 40, t - 100, t + 80, 'Tom Hadley', 'Sue Bannon', 'sue@tallowood.example', t - 2520)
  returning id into tce;
  update clients set concentration_pct = 70 where id = tce;  -- a council debtor, a higher limit agreed

  insert into clients (code, name, business_number, industry, status, facility_type, facility_limit_cents, advance_pct, discount_pct, service_fee_pct, risk_rating, manager, contact_name, contact_email)
  values ('NFF', 'Northfield Fresh Foods Pty Ltd', '39 448 912 006', 'Food distribution', 'onboarding', 'disclosed', 25000000, 80, 1.30, 0.50, 'medium', 'Priya Raman', 'Lena Cho', 'lena@northfield.example')
  returning id into nff;

  insert into clients (code, name, business_number, industry, status, facility_type, facility_limit_cents, advance_pct, risk_rating, cdd_completed_on, ppsr_reference, ppsr_registered_on, manager, started_on, exited_on, notes)
  values ('ORB', 'Orbit Security Services Pty Ltd', '18 207 664 391', 'Security', 'exited', 'disclosed', 20000000, 80, 'medium', t - 900, '201706190001111', t - 1000, 'Tom Hadley', t - 1000, t - 120, 'Refinanced to a bank overdraft.')
  returning id into orb;

  -- ---------------------------------------------------------------- last month's fees
  insert into account_entries (client_id, entry_on, kind, fee_kind, period, amount_cents, ref, actor) values
    (clx, (date_trunc('month', t) - interval '1 day')::date, 'fee', 'discount', to_char(t - interval '1 month', 'YYYY-MM'), 248000, 'Discount fee', 'Priya Raman'),
    (clx, (date_trunc('month', t) - interval '1 day')::date, 'fee', 'service', to_char(t - interval '1 month', 'YYYY-MM'), 128000, 'Service fee', 'Priya Raman'),
    (brk, (date_trunc('month', t) - interval '1 day')::date, 'fee', 'discount', to_char(t - interval '1 month', 'YYYY-MM'), 102000, 'Discount fee', 'Priya Raman'),
    (tce, (date_trunc('month', t) - interval '1 day')::date, 'fee', 'discount', to_char(t - interval '1 month', 'YYYY-MM'), 121000, 'Discount fee', 'Tom Hadley');

  -- ---------------------------------------------------------------- debtors
  insert into debtors (name, business_number, terms_days, credit_limit_cents, status, contact_name, contact_email, phone) values
    ('Southern Grocers Ltd', '11 004 220 117', 45, 50000000, 'approved', 'Accounts Payable', 'ap@southerngrocers.example', '02 9000 1100') returning id into sg;
  insert into debtors (name, business_number, terms_days, credit_limit_cents, status, contact_name, contact_email) values
    ('Metro Rail Maintenance Pty Ltd', '29 118 774 506', 30, 15000000, 'approved', 'Lucy Park', 'payables@metrorail.example') returning id into mr;
  insert into debtors (name, terms_days, credit_limit_cents, status, contact_name, contact_email) values
    ('City of Bayside', 30, 20000000, 'approved', 'Creditors', 'creditors@bayside.example') returning id into cb;
  insert into debtors (name, terms_days, credit_limit_cents, status, contact_email) values
    ('Pacific Hardware Group Pty Ltd', 30, 10000000, 'approved', 'ap@pachardware.example') returning id into ph;
  insert into debtors (name, terms_days, credit_limit_cents, status, contact_email, notes) values
    ('Kestrel Construction Pty Ltd', 30, 8000000, 'watch', 'accounts@kestrel.example', 'Paying 30 days later than terms since August.') returning id into kc;
  insert into debtors (name, terms_days, credit_limit_cents, status, notes) values
    ('Ironbark Mining Services Pty Ltd', 30, 0, 'blocked', 'Administrators appointed. No new invoices to count.') returning id into ib;
  insert into debtors (name, terms_days, credit_limit_cents, status, contact_email) values
    ('Harbour Hospitality Group Pty Ltd', 14, 6000000, 'approved', 'ap@harbourhospitality.example') returning id into hh;
  insert into debtors (name, terms_days, credit_limit_cents, status, contact_email) values
    ('Westgate Distribution Pty Ltd', 30, 12000000, 'approved', 'payables@westgate.example') returning id into wd;

  -- ---------------------------------------------------------------- Coastline Logistics: one debtor carries most of the ledger
  insert into schedules (client_id, ref, received_on, status) values (clx, 'CLX-0141', t - 52, 'funded') returning id into s1;
  insert into schedules (client_id, ref, received_on, status) values (clx, 'CLX-0142', t - 24, 'funded') returning id into s2;
  insert into schedules (client_id, ref, received_on, status) values (clx, 'CLX-0143', t - 3, 'received') returning id into s3;
  insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents, verified_on, verified_by, verify_method, verify_contact) values
    (clx, sg, s1, 'CL-20811', t - 54, t - 9, 6240000, t - 51, 'Priya Raman', 'phone', 'Accounts Payable'),
    (clx, sg, s1, 'CL-20812', t - 53, t - 8, 5870000, t - 51, 'Priya Raman', 'phone', 'Accounts Payable'),
    (clx, wd, s1, 'CL-20815', t - 52, t - 22, 3820000, t - 50, 'Priya Raman', 'email', 'payables@westgate.example'),
    (clx, wd, s1, 'CL-20795', t - 82, t - 52, 1980000, t - 79, 'Priya Raman', 'email', 'payables@westgate.example'),
    (clx, ph, s1, 'CL-20790', t - 104, t - 74, 2450000, t - 99, 'Priya Raman', 'phone', 'ap@pachardware.example'),
    (clx, sg, s2, 'CL-20877', t - 26, t + 19, 7110000, t - 23, 'Priya Raman', 'portal', 'Southern Grocers supplier portal'),
    (clx, sg, s2, 'CL-20878', t - 25, t + 20, 6680000, t - 23, 'Priya Raman', 'portal', 'Southern Grocers supplier portal'),
    (clx, wd, s2, 'CL-20880', t - 24, t + 6, 4150000, t - 22, 'Priya Raman', 'email', 'payables@westgate.example'),
    (clx, mr, s3, 'CL-20903', t - 4, t + 26, 2960000, null, null, null, null),
    (clx, sg, s3, 'CL-20904', t - 4, t + 41, 5400000, t - 2, 'Priya Raman', 'portal', 'Southern Grocers supplier portal'),
    (clx, wd, s3, 'CL-20905', t - 3, t + 27, 860000, null, null, null, null);
  -- an older invoice already paid in full
  insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents, verified_on, verified_by, verify_method)
  values (clx, sg, s1, 'CL-20802', t - 60, t - 15, 4400000, t - 51, 'Priya Raman', 'phone') returning id into i;
  update client_debtors set noa_sent_on = t - 380, noa_acknowledged_on = t - 372 where client_id = clx and debtor_id = sg;
  update client_debtors set noa_sent_on = t - 380, noa_acknowledged_on = t - 375 where client_id = clx and debtor_id = wd;
  update client_debtors set noa_sent_on = t - 200 where client_id = clx and debtor_id = ph;
  update client_debtors set noa_sent_on = t - 5 where client_id = clx and debtor_id = mr;
  insert into account_entries (client_id, entry_on, kind, amount_cents, schedule_id, ref, actor) values
    (clx, t - 52, 'advance', (select floor(available_cents * 90 / 100 / 100000) * 100000 from v_availability where client_id = clx)::bigint, s1, 'Funding CLX-0141', 'Priya Raman');
  insert into collections (invoice_id, received_on, amount_cents, paid_to, ref, actor) values (i, t - 14, 4400000, 'lender', 'SG remittance 88213', 'Priya Raman');
  insert into account_entries (client_id, entry_on, kind, amount_cents, schedule_id, ref, actor) values
    (clx, t - 24, 'advance', (select floor(available_cents * 55 / 100 / 100000) * 100000 from v_availability where client_id = clx)::bigint, s2, 'Funding CLX-0142', 'Priya Raman');

  -- ---------------------------------------------------------------- Brickfield Labour: confidential, a debtor paid the client
  insert into schedules (client_id, ref, received_on, status) values (brk, 'BRK-0077', t - 40, 'funded') returning id into s4;
  insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents, verified_on, verified_by, verify_method) values
    (brk, mr, s4, 'BLS-3310', t - 42, t - 12, 3150000, t - 39, 'Priya Raman', 'phone'),
    (brk, cb, s4, 'BLS-3311', t - 42, t - 12, 2840000, t - 39, 'Priya Raman', 'email'),
    (brk, hh, s4, 'BLS-3314', t - 41, t - 27, 960000, null, null, null),
    (brk, kc, s4, 'BLS-3316', t - 40, t - 10, 1780000, t - 38, 'Priya Raman', 'phone'),
    (brk, cb, s4, 'BLS-3320', t - 33, t - 3, 2210000, t - 31, 'Priya Raman', 'email');
  insert into account_entries (client_id, entry_on, kind, amount_cents, schedule_id, ref, actor) values
    (brk, t - 40, 'advance', (select floor(available_cents * 95 / 100 / 100000) * 100000 from v_availability where client_id = brk)::bigint, s4, 'Funding BRK-0077', 'Priya Raman');
  -- funded on the client's word, never verified with the debtor
  update invoices set verified_on = null, verified_by = null, verify_method = null where invoice_no = 'BLS-3316';
  select id into i from invoices where invoice_no = 'BLS-3311';
  insert into collections (invoice_id, received_on, amount_cents, paid_to, ref, actor) values (i, t - 9, 2840000, 'client', 'Bayside EFT into client account', 'Priya Raman');
  select id into i from invoices where invoice_no = 'BLS-3310';
  insert into collections (invoice_id, received_on, amount_cents, paid_to, ref, actor) values (i, t - 6, 3150000, 'client', 'Metro Rail EFT into client account', 'Priya Raman') returning id into col;
  update collections set passed_on_on = t - 5 where id = col;

  -- ---------------------------------------------------------------- Meridian Packaging: credit notes and a dispute after funding
  insert into schedules (client_id, ref, received_on, status) values (mpk, 'MPK-0230', t - 35, 'funded') returning id into s5;
  insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents, verified_on, verified_by, verify_method) values
    (mpk, ph, s5, 'MP-11902', t - 37, t - 7, 4620000, t - 34, 'Tom Hadley', 'phone'),
    (mpk, wd, s5, 'MP-11903', t - 36, t - 6, 3980000, t - 34, 'Tom Hadley', 'email'),
    (mpk, hh, s5, 'MP-11905', t - 36, t - 22, 1240000, t - 34, 'Tom Hadley', 'email'),
    (mpk, kc, s5, 'MP-11906', t - 35, t - 5, 2870000, t - 33, 'Tom Hadley', 'phone');
  update client_debtors set noa_sent_on = t - 690, noa_acknowledged_on = t - 680 where client_id = mpk;
  insert into account_entries (client_id, entry_on, kind, amount_cents, schedule_id, ref, actor) values
    (mpk, t - 35, 'advance', (select floor(available_cents * 97 / 100 / 100000) * 100000 from v_availability where client_id = mpk)::bigint, s5, 'Funding MPK-0230', 'Tom Hadley');
  select id into i from invoices where invoice_no = 'MP-11902';
  insert into credit_notes (invoice_id, issued_on, amount_cents, reason, actor) values (i, t - 12, 1150000, 'Short delivery: 140 cartons damaged', 'Tom Hadley');
  select id into i from invoices where invoice_no = 'MP-11903';
  insert into credit_notes (invoice_id, issued_on, amount_cents, reason, actor) values (i, t - 8, 640000, 'Price adjustment agreed by client', 'Tom Hadley');
  update invoices set disputed_on = t - 10, dispute_reason = 'Westgate says the second pallet run was never ordered' where invoice_no = 'MP-11903';

  -- ---------------------------------------------------------------- Tallowood Civil: registration ending, a blocked debtor
  insert into schedules (client_id, ref, received_on, status) values (tce, 'TCE-0412', t - 30, 'funded') returning id into s6;
  insert into schedules (client_id, ref, received_on, status) values (tce, 'TCE-0413', t - 12, 'funded') returning id into s7;
  insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents, verified_on, verified_by, verify_method) values
    (tce, cb, s6, 'TCE-PC-18', t - 31, t - 1, 9850000, t - 29, 'Tom Hadley', 'signed_delivery'),
    (tce, kc, s6, 'TCE-PC-19', t - 30, t, 3420000, t - 28, 'Tom Hadley', 'phone'),
    (tce, ib, s6, 'TCE-PC-14', t - 75, t - 45, 2600000, t - 72, 'Tom Hadley', 'phone'),
    (tce, cb, s7, 'TCE-PC-21', t - 13, t + 17, 7340000, t - 11, 'Tom Hadley', 'signed_delivery'),
    (tce, mr, s7, 'TCE-PC-22', t - 12, t + 18, 1890000, t - 10, 'Tom Hadley', 'email');
  update client_debtors set noa_sent_on = t - 2500, noa_acknowledged_on = t - 2490 where client_id = tce;
  update debtors set status = 'approved' where id = ib;
  insert into account_entries (client_id, entry_on, kind, amount_cents, schedule_id, ref, actor) values
    (tce, t - 30, 'advance', (select floor(available_cents * 60 / 100 / 100000) * 100000 from v_availability where client_id = tce)::bigint, s6, 'Funding TCE-0412', 'Tom Hadley');
  insert into account_entries (client_id, entry_on, kind, amount_cents, schedule_id, ref, actor) values
    (tce, t - 12, 'advance', (select floor(available_cents * 85 / 100 / 100000) * 100000 from v_availability where client_id = tce)::bigint, s7, 'Funding TCE-0413', 'Tom Hadley');
  update debtors set status = 'blocked' where id = ib;
  -- funded against Metro Rail before anyone sent Metro Rail the notice
  update client_debtors set noa_sent_on = null, noa_acknowledged_on = null where client_id = tce and debtor_id = mr;

  -- ---------------------------------------------------------------- Northfield Fresh: onboarding, a schedule waiting
  insert into schedules (client_id, ref, received_on, status) values (nff, 'NFF-0001', t - 2, 'received') returning id into s8;
  insert into invoices (client_id, debtor_id, schedule_id, invoice_no, invoice_date, due_date, face_cents) values
    (nff, sg, s8, 'NF-1001', t - 6, t + 39, 3300000),
    (nff, hh, s8, 'NF-1002', t - 5, t + 9, 780000);

  -- ---------------------------------------------------------------- field audits and notes
  insert into field_audits (client_id, done_on, findings, actor) values
    (clx, t - 70, 'Sales ledger agreed to schedules within 0.4 percent. No issues.', 'Priya Raman'),
    (brk, t - 210, 'Two invoices raised before the work was done. Client warned in writing.', 'Priya Raman'),
    (mpk, t - 60, 'Credit notes running at three times last year. Moved to watch.', 'Tom Hadley'),
    (tce, t - 100, 'Progress claims match signed certificates. No issues.', 'Tom Hadley');
  insert into notes (client_id, body, actor) values
    (brk, 'Mel says Bayside paid into the old account by mistake and will be passed on this week.', 'Priya Raman'),
    (mpk, 'Raj expects more credit notes on the September run. Watch dilution.', 'Tom Hadley');
  insert into notes (debtor_id, body, actor) values
    (kc, 'Kestrel promised the August and September invoices by the end of the month.', 'Tom Hadley');

  insert into history (actor, action, subject) values ('Seed', 'demo data loaded', 'Harbourline Trade Finance');
end
$$;
