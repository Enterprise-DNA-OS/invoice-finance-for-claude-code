# Moving off Lendscape

Switch in a day: bring the clients, debtors, open invoices and each client's funds in use across as at a cutover date, test run first, then run the two systems side by side for one statement cycle.

## 1. Export from Lendscape

Lendscape is set up differently by each lender, so the report names below are what to look for, not menu paths. Save each report as CSV into one folder.

| File | What it holds | Columns this import accepts |
|---|---|---|
| `clients.csv` | One row per client | Client Code (or Client ID, Account Number), Client Name, Facility Limit, Prepayment % (or Advance Rate), Discount Rate, Service Fee %, Facility Type (disclosed or confidential), Funds In Use (or Current Account Balance, Funds Employed) |
| `debtors.csv` | One row per debtor | Debtor Name, Terms (days), Debtor Limit (or Credit Limit), ABN |
| `invoices.csv` | Every open invoice at the cutover | Client Code, Debtor, Invoice Number, Invoice Date, Due Date, Outstanding (or Balance, Amount Due), Disputed (yes or no) |

Dates can be YYYY-MM-DD or DD/MM/YYYY. Amounts can carry $ and commas.

## 2. Test run

```bash
npm run finance -- import lendscape imports/cutover --dry-run --as-at=2027-01-31
```

It reads all three files and reports counts and totals. Compare them with Lendscape's own client list and ledger totals for the same date. A problem anywhere (an unknown debtor, a bad date, a client already in the database) refuses the whole import and writes nothing.

## 3. Import

```bash
npm run finance -- import lendscape imports/cutover --as-at=2027-01-31 --actor="Your name"
```

What happens:

- Each client is created active, with its facility terms.
- Each debtor is created (or matched by name).
- Every open invoice goes onto an `OPENING` schedule, marked funded and verified as carried from Lendscape.
- Each client's funds in use becomes one opening adjustment on its account.
- Notices of assignment are recorded as sent on the cutover date for every client and debtor pair. Correct any that were never sent with `npm run finance -- noa`.

## 4. After the import

1. Record each client's due diligence and security registration (`/onboard` steps 2 and 3). The database will not fund a client until both are on file.
2. Run `/position` and compare each client's drawing base with Lendscape's availability. Differences usually come from settings: concentration limits, recourse days or verification thresholds. Set them per client.
3. Run `/compliance` and `/attention`.

## What does not carry over

- History before the cutover: past schedules, paid invoices, fee history and collections stay in Lendscape's archive. Keep a final export.
- Client portal logins and bank feeds: those are built into your version by Enterprise DNA if you want them.
- Credit insurance policies, broker commissions and multi-currency facilities: not in the free version.

Your Lendscape export has its own columns. If yours differ from the list above, rename them, or ask Claude Code to map them. Mapping your exact layout is part of what Enterprise DNA does in the customised version.
