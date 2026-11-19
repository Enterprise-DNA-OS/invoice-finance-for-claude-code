# Invoice Finance for Claude Code: operating instructions

This file is the brain. Claude Code reads it at the start of every session. It says who this is for, how work gets done, and the one right way to do each recurring job.

## Who this is for

- **Lender:** [YOUR BUSINESS] (the demo is Harbourline Trade Finance, fictional)
- **Operator:** [YOUR NAME], [your role: client manager, credit manager, operations]
- **What matters most:** no client over-advanced, every debtor payment reaching the lender, and every invoice that counts being real, verified and covered by a notice and a registration

Fill this in once. A worker with context knows. A worker without it guesses.

## How to work

1. **Take a brief, not a script.** The operator describes the outcome. You run the right command and present the answer.
2. **Read before you write.** Before drafting anything about a record, read its full history first.
3. **Plain language.** Short sentences. No filler. Numbers in tables.
4. **Silent success, loud problems.** No play-by-play. Say what broke and what you did about it.
5. **Stop at the line.** Anything that sends, deletes, or faces a customer waits for a yes in this session.

## Routing table: one right way for each recurring job

| When the operator asks for... | Use this |
|---|---|
| the client account: advances, releases, fees and collections with the running funds in use | `/account` |
| the open ledger by age from invoice date, per client | `/ageing` |
| what needs doing now across the whole book: over-advances, money held by clients, verifications, schedules, reviews and registrations | `/attention` |
| record a field audit of a client's books | `/audit` |
| what is coming up: registrations ending, due diligence reviews, field audits, invoices passing the recourse date, debtor payments due | `/calendar` |
| everything about one client: terms, position line by line, ineligible invoices, concentration, debtors, notices of assignment and notes | `/client` |
| every client: facility, ledger, funds in use and what they can draw | `/clients` |
| record a debtor payment the bank has received, or one the debtor paid to the client | `/collect` |
| check the book against the PPSA rules, your AML/CTF programme and your credit policy, each finding cited | `/compliance` |
| debtors over a client's concentration limit, and how much is not counted because of it | `/concentration` |
| record a credit note the client raised against an assigned invoice | `/credit` |
| make this system yours in plain language. Add a field, rename stages, change a rule, add a column to a document. Writes the migration, applies it, updates the commands that touch it | `/customise` |
| one debtor: open invoices across every client, how late it pays, notes | `/debtor` |
| approve, watch or block a debtor across every client | `/debtor-status` |
| every debtor with its open exposure across clients, limit, status and overdue amount | `/debtors` |
| credit notes against invoices raised in the last 90 days, per client | `/dilution` |
| mark an invoice disputed, or close a dispute | `/dispute` |
| open disputes, oldest first | `/disputes` |
| render the paperwork: client statements, notices of assignment and debtor statements | `/documents` |
| draft a letter: notice of assignment, debtor reminder, misdirected payment, or over-advance | `/draft-letter` |
| export every record to one JSON file | `/export` |
| exposure to each debtor across every client, against its limit | `/exposure` |
| month-end fees: discount on daily funds in use, service fee on invoices assigned, minimum fee top-up. Test run, then charge | `/fees` |
| record an advance against a schedule. The database refuses anything above what the client can draw | `/fund` |
| every CLI command and its arguments | `/help` |
| who changed what, and when | `/history` |
| bring clients, debtors, open invoices and funds in use across from Lendscape | `/import` |
| open invoices for one client or all, and why any do not count | `/invoices` |
| a note on a client, debtor or invoice file: a call, a promise, a visit | `/log` |
| debtor payments the client is holding, and recording that one was passed on | `/misdirected` |
| month end: fees, statements and the review pack | `/month-end` |
| add a read-only HTML view (a dashboard page) from a plain-language description, rendered in the operator's brand by `npm run view` | `/new-view` |
| record a notice of assignment sent to a debtor, or its acknowledgement | `/noa` |
| onboard a new client: the record, due diligence, the security registration and the first notices | `/onboard` |
| what every client can draw today, and who is over-advanced and why | `/position` |
| our ledger against the client's own aged receivables: invoices the debtor may have paid to the client, amounts that differ, invoices never assigned | `/reconcile` |
| hand an invoice back to the client after the recourse period or a failed collection | `/recourse` |
| record a release of surplus to a client | `/release` |
| receive a schedule of invoices from a client: test run, then record it | `/schedule` |
| schedules received, funded or rejected, with what is still to verify | `/schedules` |
| the verification queue, and recording that a debtor confirmed an invoice | `/verify` |
| render the read-only dashboards: this week in the book, and portfolio risk | `/views` |
| the Monday credit review, written from the position, the attention list and the exposure report | `/weekly-review` |

If an ask fits nothing here, run the CLI directly (`npm run finance -- help`) and then propose a new command for it.

## Hard rules

- Never send email or messages from here. Draft to `drafts/`, a person sends.
- Never delete records without an explicit yes in this session. Prefer marking closed or archived.
- Never invent a record. If a name is ambiguous, list the candidates and ask.
- The database is the source of truth. If the answer is not in it, say so.
- Every write names a person (`--actor` or `FINANCE_ACTOR`). Never invent an actor, a payment, a verification or a decision.
- Credit decisions belong to the lender's people: approving a client, a debtor limit, an advance, a release, a recourse. You show the numbers and record the decision; you never make it.
- Never run `fund`, `release`, `recourse` or `fees --apply` without a yes in this session. The database refuses an over-advance; the operator decides the rest.
- Never mark an invoice verified unless the operator says the debtor confirmed it.
- The client account and collections are append only. Fix a mistake with `adjust`, never by editing.
- This system moves no money and registers nothing. Advances go out through the bank; registrations are made on the PPSR. Record them after they happen.
- Read docs/compliance.md before answering a question about what the law requires. Do not guess at law.

## Where things live

- `scripts/` the CLI. `scripts/lib/db.mjs` picks `DATABASE_URL` (Postgres, Supabase) or the embedded database in `.data/`.
- `supabase/migrations/` the schema, plain SQL. `npm run migrate` applies it.
- `.claude/commands/` the slash commands. Add one every time the same ask comes twice.
- `docs/` the thesis and the guide for moving off Lendscape.

Built by Enterprise DNA. Installed and run for you as part of Omni: https://enterprisedna.co/omni/instead-of/lendscape
