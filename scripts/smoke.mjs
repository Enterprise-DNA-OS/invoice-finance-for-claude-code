#!/usr/bin/env node
// End-to-end smoke test on a throwaway embedded database.
// Migrate, seed, then every CLI command, asserting on the JSON. Then the rules
// the database enforces, a schedule, a fee run, an import from a
// Lendscape-shaped export, a reconciliation, the documents, the views and the
// export. Passes on Windows and Linux. No network.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'finance-smoke-'));
const work = mkdtempSync(path.join(tmpdir(), 'finance-smoke-files-'));
const env = { ...process.env, DATA_DIR: dataDir, FINANCE_ACTOR: 'Smoke Test' };
delete env.DATABASE_URL;

let step = 0;
function run(label, args, { json = true, expectFail = false, script = 'finance.mjs' } = {}) {
  step++;
  const argv = [path.join(root, 'scripts', script), ...args, ...(json ? ['--json'] : [])];
  const res = spawnSync(process.execPath, argv, { cwd: root, env, encoding: 'utf8' });
  const ok = expectFail ? res.status !== 0 : res.status === 0;
  if (!ok) {
    console.error(`\nFAIL step ${step} (${label}): exit ${res.status}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`);
    process.exit(1);
  }
  console.log(`  ok  ${String(step).padStart(2)}  ${label}`);
  if (!json || expectFail) return { stdout: res.stdout, stderr: res.stderr };
  try { return JSON.parse(res.stdout); } catch {
    console.error(`\nFAIL step ${step} (${label}): output is not JSON\n${res.stdout}\n${res.stderr}`);
    process.exit(1);
  }
}
function assert(cond, msg) {
  if (!cond) { console.error(`\nFAIL assertion: ${msg}`); process.exit(1); }
}
const n = (v) => Number(v ?? 0);
const iso = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (k) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + k); return iso(d); };

console.log(`smoke: data dir ${dataDir}`);
try {
  run('migrate', [], { json: false, script: 'migrate.mjs' });
  run('migrate again (idempotent)', [], { json: false, script: 'migrate.mjs' });
  run('seed', [], { json: false, script: 'seed.mjs' });
  run('seed again (idempotent)', [], { json: false, script: 'seed.mjs' });

  // ---- reads
  const help = run('help', ['help']);
  assert(help.length >= 45, `help lists every command (${help.length})`);
  const clients = run('clients', ['clients']);
  assert(clients.length === 5, `five clients not exited (${clients.length})`);
  assert(run('clients --all', ['clients', '--all']).length === 6, 'six with the exited one');

  const pos = run('position', ['position']);
  const over = pos.clients.filter((c) => n(c.available_cents) < 0).map((c) => c.code).sort();
  assert(over.join(',') === 'BRK,MPK,TCE', `three clients over-advanced (${over})`);
  const clxPos = pos.clients.find((c) => c.code === 'CLX');
  assert(n(clxPos.available_cents) > 0 && n(clxPos.concentration_excess_cents) > 10000000, 'CLX can draw, with a large concentration excess');

  const clx = run('client by code', ['client', 'CLX']);
  assert(clx.client.name === 'Coastline Logistics Pty Ltd', 'resolved by code');
  assert(clx.concentration[0].debtor_name === 'Southern Grocers Ltd' && n(clx.concentration[0].share_pct) > 70, 'Southern Grocers carries most of the ledger');
  assert(clx.ineligible.some((r) => r.reason === 'past 90 days') && clx.ineligible.some((r) => r.reason === 'not verified'), 'ineligible reasons');
  const byName = run('client by name', ['client', 'Meridian']);
  assert(byName.client.code === 'MPK', 'resolved by part of the name');
  const amb = run('an ambiguous reference lists candidates and exits 1', ['client', 'Pty'], { json: false, expectFail: true });
  assert(/matches \d+ client records/.test(amb.stderr), 'lists candidates rather than guessing');
  const none = run('an unknown client exits 1', ['client', 'Nobody Ltd'], { json: false, expectFail: true });
  assert(/No client matches/.test(none.stderr), 'and says so');

  const debtors = run('debtors', ['debtors']);
  assert(debtors.length === 8, 'eight debtors');
  const kestrel = run('debtor', ['debtor', 'kestrel']);
  assert(kestrel.invoices.length === 3, 'Kestrel owes on three clients');
  const inv = run('invoices for a client', ['invoices', 'TCE']);
  assert(inv.some((i) => i.ineligible_reason === 'debtor blocked') && inv.some((i) => i.ineligible_reason === 'no notice of assignment'), 'TCE ineligible reasons');
  assert(run('invoices --ineligible', ['invoices', '--ineligible']).every((i) => i.ineligible_reason), 'only ineligible');
  const schedules = run('schedules', ['schedules']);
  assert(schedules.length === 8, 'eight schedules');
  assert(run('schedules --open', ['schedules', '--open']).length === 2, 'two waiting');
  const vq = run('verify-queue', ['verify-queue']);
  assert(vq.some((v) => v.invoice_no === 'BLS-3316' && v.schedule_status === 'funded'), 'a funded invoice never verified');
  const ageing = run('ageing', ['ageing']);
  assert(ageing.find((a) => a.client === 'CLX').d90_plus_cents > 0, 'CLX has a 90+ invoice');
  const conc = run('concentration', ['concentration']);
  assert(conc[0].client === 'CLX', 'largest excess first');
  const exposure = run('exposure', ['exposure']);
  assert(exposure.some((e) => e.debtor === 'Ironbark Mining Services Pty Ltd' && e.status === 'blocked'), 'blocked debtor exposure');
  const dil = run('dilution', ['dilution']);
  assert(dil[0].client === 'MPK' && n(dil[0].dilution_pct) > 10, 'MPK dilution over the watch level');
  const mis = run('misdirected', ['misdirected']);
  assert(mis.length === 1 && mis[0].invoice_no === 'BLS-3311' && mis[0].days_held === 9, 'one payment held 9 days');
  const disputes = run('disputes', ['disputes']);
  assert(disputes.length === 1 && disputes[0].invoice_no === 'MP-11903', 'one dispute');
  const acct = run('account', ['account', 'BRK']);
  assert(acct.entries.some((e) => e.kind === 'collection'), 'the passed-on payment credited the account');
  const cal = run('calendar', ['calendar']);
  assert(cal.some((c) => /registration ends/i.test(c.what) && c.subject === 'TCE'), 'TCE registration ending');
  const comp = run('compliance', ['compliance']);
  for (const rule of ['Funded invoices with no notice of assignment', 'Ongoing due diligence review overdue', 'Funded without verification', 'Field audit overdue', 'Registration end time', 'Registration still on the register after exit']) {
    assert(comp.some((c) => c.rule === rule), `compliance finds: ${rule}`);
  }
  assert(comp.some((c) => /s 80\(7\)/.test(c.source)), 'cites s 80(7)');
  const att = run('attention', ['attention']);
  assert(att.filter((a) => a.level === 'breach' && /Over-advanced/.test(a.what)).length === 3, 'three over-advance breaches');
  assert(att.some((a) => /stops counting/i.test(a.what)), 'an invoice about to pass the recourse date');
  assert(att.some((a) => /debtor payment held by the client/.test(a.what)), 'the over-advance names the payment held');

  // ---- the rules the database enforces
  const overFund = run('an advance that would over-advance is refused', ['fund', 'MPK', '1000'], { json: false, expectFail: true });
  assert(/over-advance/.test(overFund.stderr), 'says over-advance');
  run('an advance to a client with no due diligence is refused', ['status', 'NFF', 'active']);
  const noCdd = run('  (funding NFF)', ['fund', 'NFF', '1000'], { json: false, expectFail: true });
  assert(/due diligence/.test(noCdd.stderr), 'says due diligence');
  run('record due diligence', ['cdd', 'NFF', '--risk=low']);
  const noPpsr = run('an advance with no registration is refused', ['fund', 'NFF', '1000'], { json: false, expectFail: true });
  assert(/security registration/.test(noPpsr.stderr), 'says registration');
  run('record the registration', ['ppsr', 'NFF', '--ref=202611190001', '--on=today']);
  const nffBefore = run('NFF can draw nothing yet', ['client', 'NFF']);
  assert(n(nffBefore.position.available_cents) === 0, 'unverified and no notice');
  run('verify the big invoice', ['verify', 'NF-1001', '--method=phone', '--contact=Accounts Payable']);
  run('notice to Southern Grocers', ['noa', 'NFF', 'Southern Grocers', '--sent=today']);
  run('notice acknowledged', ['noa', 'NFF', 'Southern Grocers', '--ack=today']);
  run('notice to Harbour Hospitality', ['noa', 'NFF', 'Harbour Hospitality', '--sent=today']);
  const nff = run('NFF can now draw', ['client', 'NFF']);
  assert(n(nff.position.available_cents) > 0, `NFF has availability (${nff.position.available_cents})`);
  const fundNff = run('fund NFF against its schedule', ['fund', 'NFF', String(Math.floor(n(nff.position.available_cents) / 100)), '--schedule=NFF-0001']);
  assert(fundNff.available_after_cents < 100, 'funded to the limit');
  assert(run('schedule now funded', ['schedules']).find((s) => s.ref === 'NFF-0001').status === 'funded', 'schedule marked funded');
  const noActor = spawnSync(process.execPath, [path.join(root, 'scripts', 'finance.mjs'), 'log', 'CLX', 'test'], { cwd: root, env: { ...env, FINANCE_ACTOR: '' }, encoding: 'utf8' });
  step++; assert(noActor.status === 1 && /Name who is doing this/.test(noActor.stderr), 'a write with no person is refused'); console.log(`  ok  ${step}  a write with no person is refused`);

  // ---- collections, misdirected, credit, dispute, recourse
  const overpay = run('a collection above what the invoice owes is refused', ['collect', 'CL-20811', '999999'], { json: false, expectFail: true });
  assert(/still owes/.test(overpay.stderr), 'says what it still owes');
  const before = run('CLX before collection', ['client', 'CLX']);
  run('collect a debtor payment', ['collect', 'CL-20811', '62400', '--ref=SG 90112']);
  const after = run('CLX after collection', ['client', 'CLX']);
  assert(n(after.position.funds_in_use_cents) === n(before.position.funds_in_use_cents) - 6240000, 'funds in use fall by the payment');
  run('a debtor pays the client', ['collect', 'TCE-PC-21', '10000', '--to=client']);
  assert(run('misdirected now two', ['misdirected']).length === 2, 'two held');
  run('passed on', ['passed-on', 'BLS-3311']);
  run('passed on the second', ['passed-on', 'TCE-PC-21']);
  assert(run('misdirected empty', ['misdirected']).length === 0, 'nothing held');
  const brk = run('BRK after the money arrives', ['client', 'BRK']);
  assert(n(brk.position.funds_in_use_cents) < 4652000, 'BRK funds in use fell');
  const cr = run('credit note', ['credit', 'CL-20812', '5000', '--reason=Damaged stock']);
  assert(cr.amount_cents === 500000, 'credit recorded');
  run('dispute', ['dispute', 'CL-20878', '--reason=Pricing query']);
  assert(run('disputes now two', ['disputes']).length === 2, 'two disputes');
  run('resolve', ['resolve', 'CL-20878']);
  run('resolving twice is refused', ['resolve', 'CL-20878'], { json: false, expectFail: true });
  const rec = run('recourse an old invoice', ['recourse', 'CL-20790', '--reason=Past 90 days']);
  assert(typeof rec.available_cents === 'number', 'recourse reports the position');
  run('recourse twice is refused', ['recourse', 'CL-20790'], { json: false, expectFail: true });
  run('adjust', ['adjust', 'CLX', '-100', '--reason=Bank fee refunded']);
  run('an adjustment needs a reason', ['adjust', 'CLX', '-100'], { json: false, expectFail: true });
  run('log a note', ['log', 'Kestrel', 'Called, payment run Friday']);
  run('log a note on an invoice', ['log', 'MP-11906', 'Proof of delivery requested']);

  // ---- clients, debtors, schedules
  run('add a debtor', ['add-debtor', 'Seaview Foods Pty Ltd', '--terms=30', '--limit=40000']);
  run('a duplicate debtor is refused', ['add-debtor', 'Seaview Foods Pty Ltd'], { json: false, expectFail: true });
  run('block a debtor', ['debtor-status', 'Westgate', 'watch', '--reason=Slow']);
  run('onboard a client', ['onboard', 'OAK', '--name=Oakridge Engineering Pty Ltd', '--limit=150000', '--advance=80']);
  writeFileSync(path.join(work, 'schedule.csv'), 'Debtor,Invoice Number,Invoice Date,Due Date,Amount\r\nSeaview Foods Pty Ltd,OE-1001,' + daysFromNow(-3) + ',' + daysFromNow(27) + ',"$12,500.00"\r\nCity of Bayside,OE-1002,' + daysFromNow(-2).split('-').reverse().join('/') + ',,8400\r\n');
  const dry = run('schedule test run', ['schedule', 'OAK', path.join(work, 'schedule.csv'), '--ref=OAK-0001', '--dry-run']);
  assert(dry.dry_run && dry.invoices === 2 && dry.total_cents === 2090000 && dry.to_verify.length === 1, 'test run reads both, one to verify');
  run('schedule', ['schedule', 'OAK', path.join(work, 'schedule.csv'), '--ref=OAK-0001']);
  const dup = run('the same invoices again are refused', ['schedule', 'OAK', path.join(work, 'schedule.csv'), '--ref=OAK-0002'], { json: false, expectFail: true });
  assert(/already assigned/.test(dup.stderr), 'flags the duplicate');
  writeFileSync(path.join(work, 'bad.csv'), 'Debtor,Invoice Number,Invoice Date,Amount\nUnknown Co,X-1,2026-01-01,100\n');
  const bad = run('an unknown debtor is refused, nothing written', ['schedule', 'OAK', path.join(work, 'bad.csv'), '--ref=OAK-0003'], { json: false, expectFail: true });
  assert(/not on file/.test(bad.stderr), 'names the debtor');
  run('reject a schedule', ['reject', 'CLX', 'CLX-0143', '--reason=Duplicates suspected']);
  assert(run('CLX invoices on a rejected schedule do not count', ['invoices', 'CLX', '--ineligible']).some((i) => i.ineligible_reason === 'schedule rejected'), 'rejected schedule');
  run('audit', ['audit', 'BRK', '--findings=Sales ledger agreed']);
  run('cdd review', ['cdd', 'MPK']);
  run('ppsr renewed', ['ppsr', 'TCE', '--ref=201912050007720', '--on=2019-12-05']);
  run('ppsr discharged', ['ppsr', 'ORB', '--discharged=today']);
  const comp2 = run('compliance after the fixes', ['compliance']);
  for (const rule of ['Ongoing due diligence review overdue', 'Field audit overdue', 'Registration end time', 'Registration still on the register after exit']) {
    assert(!comp2.some((c) => c.rule === rule), `fixed: ${rule}`);
  }
  run('a client with money out cannot exit', ['status', 'CLX', 'exited'], { json: false, expectFail: true });
  run('watch', ['status', 'CLX', 'watch']);

  // ---- fees
  const lastMonth = daysFromNow(-new Date().getUTCDate()).slice(0, 7);
  const fees = run('fees test run', ['fees', `--month=${lastMonth}`]);
  assert(!fees.applied && fees.runs.length >= 4, 'test run');
  const mpkRun = fees.runs.find((r) => r.client === 'MPK');
  assert(mpkRun.discount_cents > 0 && mpkRun.service_cents > 0, 'MPK fees worked out');
  run('fees for this month are refused', ['fees', '--apply', `--month=${daysFromNow(0).slice(0, 7)}`], { json: false, expectFail: true });
  run('charge fees', ['fees', '--apply', `--month=${lastMonth}`]);
  const again = run('fees again skip what is charged', ['fees', `--month=${lastMonth}`]);
  assert(again.runs.find((r) => r.client === 'MPK').already_charged.includes('discount'), 'already charged');
  run('charging again adds nothing', ['fees', '--apply', `--month=${lastMonth}`]);

  // ---- reconcile against the client's aged receivables
  writeFileSync(path.join(work, 'aged.csv'), 'Contact,Invoice Number,Due\nSouthern Grocers Ltd,CL-20812,"53,700.00"\nWestgate Distribution Pty Ltd,CL-20815,0\nWestgate Distribution Pty Ltd,CL-20999,4100\n');
  const recon = run('reconcile', ['reconcile', 'CLX', path.join(work, 'aged.csv')]);
  assert(recon.shows_paid_or_missing.some((r) => r.invoice_no === 'CL-20815' && r.their_open_cents === 0), 'shows paid in theirs');
  assert(recon.not_assigned.some((r) => r.invoice_no === 'CL-20999'), 'never assigned');

  // ---- drafts
  for (const [label, a] of [['notice of assignment', ['CLX', 'Metro Rail', '--kind=noa']], ['debtor reminder', ['MPK', 'Pacific Hardware', '--kind=debtor-reminder']], ['over-advance letter', ['MPK', '--kind=over-advance']]]) {
    const d = run(`draft ${label}`, ['draft-letter', ...a]);
    const text = readFileSync(path.join(root, d.file), 'utf8');
    if (label === 'notice of assignment') assert(text.includes('section 80(7)'), 'cites s 80(7)');
    rmSync(path.join(root, d.file));
  }
  run('no misdirected letter when nothing is held', ['draft-letter', 'BRK', '--kind=misdirected'], { json: false, expectFail: true });

  // ---- history
  const hist = run('history', ['history', '--limit=100']);
  assert(hist.length >= 25, `history kept (${hist.length})`);
  assert(hist.every((h) => h.actor), 'every change has a person');

  // ---- the client account is append only
  const { getDb } = await import(new URL('./lib/db.mjs', import.meta.url));
  process.env.DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;
  const db = await getDb();
  let refused = false;
  try { await db.exec("update account_entries set amount_cents = 1 where kind = 'advance'"); } catch (e) { refused = /append only/.test(e.message); }
  step++; assert(refused, 'the client account refuses an edit'); console.log(`  ok  ${step}  the client account refuses an edit`);
  refused = false;
  try { await db.exec("insert into account_entries (client_id, entry_on, kind, fee_kind, period, amount_cents, actor) select client_id, entry_on, 'fee', fee_kind, period, 1, 'x' from account_entries where kind = 'fee' limit 1"); } catch (e) { refused = /duplicate key|unique/.test(e.message); }
  step++; assert(refused, 'a fee twice for one month is refused'); console.log(`  ok  ${step}  a fee twice for one month is refused`);
  await db.close();

  // ---- import from a Lendscape-shaped export
  const imp = path.join(work, 'lendscape');
  mkdirSync(imp);
  writeFileSync(path.join(imp, 'clients.csv'), 'Client Code,Client Name,Facility Limit,Prepayment %,Discount Rate,Service Fee %,Facility Type,Funds In Use\r\nWLD,Wildfern Nurseries Pty Ltd,"$200,000.00",80%,1.2,0.5,Disclosed,"64,000.00"\r\nQRY,Quarryhill Freight Pty Ltd,350000,85,1.1,0.45,Confidential invoice discounting,0\r\n');
  writeFileSync(path.join(imp, 'debtors.csv'), 'Debtor Name,Terms,Credit Limit,ABN\nGreenway Garden Centres Pty Ltd,30 days,90000,22 333 444 555\nSouthern Grocers Ltd,45,,\n');
  writeFileSync(path.join(imp, 'invoices.csv'), 'Client Code,Debtor,Invoice Number,Invoice Date,Due Date,Outstanding,Disputed\nWLD,Greenway Garden Centres Pty Ltd,WN-501,' + daysFromNow(-20).split('-').reverse().join('/') + ',' + daysFromNow(10).split('-').reverse().join('/') + ',"48,000.00",No\nWLD,Southern Grocers Ltd,WN-502,' + daysFromNow(-12) + ',' + daysFromNow(33) + ',32000,Yes\nQRY,Southern Grocers Ltd,QF-77,' + daysFromNow(-5) + ',' + daysFromNow(40) + ',15000,No\n');
  const idry = run('import test run', ['import', 'lendscape', imp, '--dry-run']);
  assert(idry.dry_run && idry.clients === 2 && idry.invoices === 3 && idry.open_cents === 9500000 && idry.funds_in_use_cents === 6400000, 'test run reads all three files');
  const imported = run('import', ['import', 'lendscape', imp]);
  assert(imported.clients === 2, 'imported');
  const wld = run('imported client', ['client', 'WLD']);
  assert(n(wld.position.funds_in_use_cents) === 6400000 && wld.ineligible.some((r) => r.reason === 'disputed'), 'funds in use and the dispute carried in');
  assert(run('confidential mapped', ['client', 'QRY']).client.facility_type === 'confidential', 'facility type mapped');
  run('importing the same clients again is refused', ['import', 'lendscape', imp], { json: false, expectFail: true });
  writeFileSync(path.join(imp, 'clients.csv'), 'Client Code,Client Name,Facility Limit\nZZZ,Zed Ltd,1000\n');
  writeFileSync(path.join(imp, 'invoices.csv'), 'Client Code,Debtor,Invoice Number,Invoice Date,Outstanding\nZZZ,Nobody Pty Ltd,Z-1,2026-01-01,100\n');
  const ibad = run('an unknown debtor refuses the import, nothing written', ['import', 'lendscape', imp], { json: false, expectFail: true });
  assert(/Nobody Pty Ltd/.test(ibad.stderr), 'names the debtor');
  run('nothing was written', ['client', 'ZZZ'], { json: false, expectFail: true });

  // ---- documents, views, export
  const docs = run('npm run docs', [], { json: false, script: 'docs.mjs' });
  assert(/\d+ document\(s\) rendered/.test(docs.stdout), 'documents rendered');
  assert(readdirSync(path.join(root, 'docs-out', 'client-statement')).length >= 5, 'client statements rendered');
  assert(readdirSync(path.join(root, 'docs-out', 'notice-of-assignment')).length >= 10, 'notices rendered');
  const views = run('npm run view', [], { json: false, script: 'view.mjs' });
  assert(/views[\\/]week\.html/.test(views.stdout) && /views[\\/]portfolio\.html/.test(views.stdout), 'both views rendered');
  const exp = run('export', ['export', `--file=${path.join(work, 'backup.json')}`]);
  assert(exp.counts.invoices >= 30 && exp.counts.account_entries > 15 && exp.counts.clients === 9, 'every record type exported');
  run('export refuses to overwrite', ['export', `--file=${path.join(work, 'backup.json')}`], { json: false, expectFail: true });
  assert(existsSync(path.join(work, 'backup.json')), 'backup written');

  console.log(`\nPASS: ${step} steps`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
