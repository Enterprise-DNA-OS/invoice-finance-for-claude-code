<h1 align="center">Invoice Finance for Claude Code</h1>

<p align="center">
  <strong>The open-source invoice finance system that is just a database and Claude Code.</strong>
</p>

<p align="center">
  Created by <a href="https://www.enterprisedna.co"><strong>Enterprise DNA</strong></a>. Free and open source. Works with Claude Code, Codex, OpenCode or Cursor.
</p>

<!-- three-doors -->
<table align="center">
  <tr>
    <td align="center"><strong>Do it yourself</strong><br/>Clone it, run it, own it. Free, MIT.<br/><a href="#quick-start">Quick start</a></td>
    <td align="center"><strong>We customise it</strong><br/>Your fields, your rules, your Lendscape data brought across.<br/><a href="https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=lendscape">Book a call</a></td>
    <td align="center"><strong>We run it for you</strong><br/>Installed, connected and operated inside Omni. Setup fee, then a retainer.<br/><a href="https://enterprisedna.co/omni/instead-of/lendscape?utm_source=github&utm_medium=readme&utm_campaign=lendscape">How it works</a></td>
  </tr>
</table>

<p align="center">
  <a href="#what-is-this">What is this</a> &bull;
  <a href="#why-no-front-end">Why no front end</a> &bull;
  <a href="#quick-start">Quick start</a> &bull;
  <a href="#the-commands">Commands</a> &bull;
  <a href="#instead-of-lendscape">Instead of Lendscape</a> &bull;
  <a href="#want-it-installed-and-run-for-you">Installed for you</a> &bull;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square" alt="Node 20+" />
  <img src="https://img.shields.io/badge/PostgreSQL-any-336791?style=flat-square" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/PGlite-embedded-3ecf8e?style=flat-square" alt="PGlite" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" />
</p>

---

## What is this

Invoice Finance for Claude Code does the job you pay Lendscape for, as a Postgres database and a set of agent commands. There is no web front end. You open the folder in [Claude Code](https://claude.com/claude-code) (or Codex, OpenCode, Cursor: see `AGENTS.md`) and ask for what you want in plain language. It runs the right query, and it can answer questions the Lendscape dashboard cannot.

Lendscape publishes no price list: it sells its receivables finance platform to banks and lenders and quotes each one privately. Earlypay, an Australian listed invoice financier, chose it in 2025 to bring three older systems onto one platform ([ABF Journal, 28 August 2026](https://www.abfjournal.com/earlypay-moves-invoice-finance-business-onto-lendscape-platform/)).

Want the same thing with a web front end, or built on a different stack? That is a customisation, and it is exactly what Enterprise DNA does: [book a call](https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=lendscape).

It is for an independent invoice financier or debtor finance lender in Australia or New Zealand, from a two-person shop to a team running a few hundred clients. It holds the clients and their facility terms, the debtors, the schedules of invoices each client assigns, verification with the debtor, notices of assignment, advances and releases, debtor collections, payments a debtor made to the client instead, credit notes, disputes, recourse, month-end fees and each client's funds in use. From those it works out what every client can draw today: the ledger, less ineligible invoices (disputed, unverified, past the recourse date, blocked debtor, no notice), less debtor concentration over the limit, times the advance rate, capped at the facility, less funds in use.

The rules sit in the database itself: an advance above what the client can draw is refused, so is one to a client with no due diligence or no security registration on file, a collection above what the invoice owes, a fee charged twice for one month, and any edit to the client account.

It does not move money, register on the PPSR or make credit decisions: advances go through your bank, registrations through the PPSR, decisions through your people. It records them.

## Why no front end

- The front end was only ever there because the database was hard to talk to. That is no longer true.
- Your data sits in plain Postgres tables you own. Any tool can read them. No export, no lock-in.
- No seats, no tiers, no add-ons. Read [docs/why-no-front-end.md](docs/why-no-front-end.md) for the honest trade-offs too.

## Quick start

Sixty seconds, no database install (an embedded Postgres runs inside Node):

```bash
git clone https://github.com/Enterprise-DNA-OS/invoice-finance-for-claude-code.git
cd invoice-finance-for-claude-code
npm install
npm run demo
```

Then open the folder in Claude Code and type `/attention`. The demo is Harbourline Trade Finance, a fictional Sydney lender with six clients, and its book is deliberately messy: three clients over-advanced for three different reasons (a dispute and credit notes, a debtor that paid the client, a debtor gone into administration after funding), $28,400 of a debtor's money sitting in a client's account for nine days, one debtor carrying 78 percent of a client's ledger, a funded invoice never verified, a funded debtor never sent the notice of assignment, a security registration ending in 40 days, a due diligence review and a field audit overdue.

`npm test` runs every command against a throwaway database (106 steps).

### Use it with your own Postgres or Supabase

Copy `.env.example` to `.env`, set `DATABASE_URL`, then `npm run migrate`. Same commands, shared data, no per-seat fee.

## The commands

43 slash commands, each a short recipe over one CLI (`npm run finance -- help` lists its verbs). Every read takes `--json`. Clients match by code or name, debtors by name, invoices by number (or `CLIENT:number`); an ambiguous match lists the candidates and stops. Every write needs a person: `--actor="Name"` or `FINANCE_ACTOR`.

### The working week

1. `/attention` lists what needs doing, each with the command that does it.
2. `/schedule` takes in a client's new invoices; `/verify` confirms the big ones with the debtor; `/fund` records the advance (refused if it would over-advance).
3. `/collect` records each debtor payment off the bank statement; `/misdirected` chases money a debtor paid the client.
4. `/position`, `/concentration`, `/exposure` and `/dilution` show where the risk is.
5. `/weekly-review` writes the Monday credit review; `/month-end` charges fees and renders the client statements.

| Command | What it does |
|---|---|
| `/account` | The client account: advances, releases, fees and collections with the running funds in use. |
| `/ageing` | The open ledger by age from invoice date, per client. |
| `/attention` | What needs doing now across the whole book: over-advances, money held by clients, verifications, schedules, reviews and registrations. |
| `/audit` | Record a field audit of a client's books. |
| `/calendar` | What is coming up: registrations ending, due diligence reviews, field audits, invoices passing the recourse date, debtor payments due. |
| `/client` | Everything about one client: terms, position line by line, ineligible invoices, concentration, debtors, notices of assignment and notes. |
| `/clients` | Every client: facility, ledger, funds in use and what they can draw. |
| `/collect` | Record a debtor payment the bank has received, or one the debtor paid to the client. |
| `/compliance` | Check the book against the PPSA rules, your AML/CTF programme and your credit policy, each finding cited. |
| `/concentration` | Debtors over a client's concentration limit, and how much is not counted because of it. |
| `/credit` | Record a credit note the client raised against an assigned invoice. |
| `/customise` | Make this system yours in plain language. Add a field, rename stages, change a rule, add a column to a document. Writes the migration, applies it, updates the commands that touch it. |
| `/debtor` | One debtor: open invoices across every client, how late it pays, notes. |
| `/debtor-status` | Approve, watch or block a debtor across every client. |
| `/debtors` | Every debtor with its open exposure across clients, limit, status and overdue amount. |
| `/dilution` | Credit notes against invoices raised in the last 90 days, per client. |
| `/dispute` | Mark an invoice disputed, or close a dispute. |
| `/disputes` | Open disputes, oldest first. |
| `/documents` | Render the paperwork: client statements, notices of assignment and debtor statements. |
| `/draft-letter` | Draft a letter: notice of assignment, debtor reminder, misdirected payment, or over-advance. |
| `/export` | Export every record to one JSON file. |
| `/exposure` | Exposure to each debtor across every client, against its limit. |
| `/fees` | Month-end fees: discount on daily funds in use, service fee on invoices assigned, minimum fee top-up. Test run, then charge. |
| `/fund` | Record an advance against a schedule. The database refuses anything above what the client can draw. |
| `/help` | Every CLI command and its arguments. |
| `/history` | Who changed what, and when. |
| `/import` | Bring clients, debtors, open invoices and funds in use across from Lendscape. |
| `/invoices` | Open invoices for one client or all, and why any do not count. |
| `/log` | A note on a client, debtor or invoice file: a call, a promise, a visit. |
| `/misdirected` | Debtor payments the client is holding, and recording that one was passed on. |
| `/month-end` | Month end: fees, statements and the review pack. |
| `/new-view` | Add a read-only HTML view (a dashboard page) from a plain-language description, rendered in the operator's brand by `npm run view`. |
| `/noa` | Record a notice of assignment sent to a debtor, or its acknowledgement. |
| `/onboard` | Onboard a new client: the record, due diligence, the security registration and the first notices. |
| `/position` | What every client can draw today, and who is over-advanced and why. |
| `/reconcile` | Our ledger against the client's own aged receivables: invoices the debtor may have paid to the client, amounts that differ, invoices never assigned. |
| `/recourse` | Hand an invoice back to the client after the recourse period or a failed collection. |
| `/release` | Record a release of surplus to a client. |
| `/schedule` | Receive a schedule of invoices from a client: test run, then record it. |
| `/schedules` | Schedules received, funded or rejected, with what is still to verify. |
| `/verify` | The verification queue, and recording that a debtor confirmed an invoice. |
| `/views` | Render the read-only dashboards: this week in the book, and portfolio risk. |
| `/weekly-review` | The Monday credit review, written from the position, the attention list and the exposure report. |

## Ten questions Lendscape's screens do not answer in one step

Each one is a single ask here, answered from the demo data by a shipped command.

1. How much can each client draw today, after ineligible invoices and debtor concentration? (`/position`)
2. Which clients are over-advanced right now, and what caused each one? (`/position`, `/client`)
3. Which debtors paid the client instead of us, and how many days has the client held the money? (`/misdirected`)
4. Which invoices stop counting in the next fortnight because they pass the recourse date? (`/attention`)
5. Which debtors are over each client's concentration limit, and how much funding does that take away? (`/concentration`)
6. What is our total exposure to each debtor across every client we fund, against its limit? (`/exposure`)
7. Which clients' credit notes are running above our watch level over the last 90 days? (`/dilution`)
8. Which invoices above the verification threshold were funded without anyone confirming them with the debtor? (`/compliance`)
9. Which funded debtors were never sent a notice of assignment, so can still lawfully pay the client? (`/compliance`)
10. Which invoices does the client's own ledger show as paid that we still hold open? (`/reconcile`)

## Documents and views

`npm run docs` renders a client statement per active client, a notice of assignment per client and debtor, and a statement of assigned invoices per debtor with overdue invoices, into docs-out/, in the lender's name, colours and logo from brand.json. `npm run view` renders views/week.html (what each client can draw, money held by clients, what is waiting, reviews and registrations) and views/portfolio.html (exposure, concentration, dilution, ageing). `/draft-letter` writes notices, debtor reminders, misdirected payment and over-advance letters to drafts/. Nothing is ever sent from here.

## Your first hour: ten things to ask for

1. Put our name, colours and logo in brand.json.
2. Set our verification threshold, recourse days and concentration limit in settings.
3. Import our clients, debtors and open invoices from Lendscape, test run first.
4. Check each client's drawing base against Lendscape's availability for the same day.
5. Record due diligence and the PPSR registration for every client.
6. Show me what needs attention.
7. Which clients are over-advanced, and why?
8. Take this schedule from a client and tell me what to verify.
9. Reconcile this client's aged receivables against our ledger.
10. Write this week's credit review.

## Instead of Lendscape

Export three reports from Lendscape as CSV (clients with facility terms and funds in use, debtors, and every open invoice at your cutover date), put them in a folder and run:

```bash
npm run finance -- import lendscape imports/cutover --dry-run --as-at=2027-01-31
npm run finance -- import lendscape imports/cutover --as-at=2027-01-31 --actor="Your name"
```

Each field accepts the column names lenders commonly use. Report layouts depend on how your Lendscape is set up, so check yours against the list in [the switching guide](docs/replace-lendscape.md) and rename any that differ (or ask Claude Code to). A problem anywhere refuses the whole import and writes nothing. History before the cutover stays in Lendscape's archive; each client's funds in use carries across as one opening entry.

## Architecture

```
invoice-finance-for-claude-code/
  CLAUDE.md                 how the operator wants this run (routing table + house rules)
  AGENTS.md                 the same, for Codex / OpenCode / Cursor / Gemini CLI
  .claude/commands/         the slash commands
  scripts/                  the CLI the commands drive
  scripts/lib/db.mjs        one adapter: DATABASE_URL (pg) or embedded PGlite
  supabase/migrations/      plain SQL schema
  supabase/seed.sql         demo data
  docs/                     the thesis and the migration guide
```

## Built for coding agents

The database, CLI and command recipes work with Claude Code, Codex, OpenCode or Cursor. Ask your coding agent for a new command and have it implement and test the change against the same records.

## Contributing

Issues and pull requests are welcome. Keep the shape: plain SQL, a small CLI, a slash command per recurring job, no front end.

## Want it installed and run for you?

Enterprise DNA installs Invoice Finance for Claude Code for your business, migrates your Lendscape data, connects it to the rest of your tools, and runs it for you as part of **Omni**, our managed Command Center. One setup fee, then a monthly retainer.

- Book a call: [enterprisedna.co/omni/book](https://enterprisedna.co/omni/book/?offer=replace-software&utm_source=github&utm_medium=readme&utm_campaign=lendscape)
- Read more: [enterprisedna.co/omni/instead-of/lendscape](https://enterprisedna.co/omni/instead-of/lendscape?utm_source=github&utm_medium=readme&utm_campaign=lendscape)

## License

MIT. Copyright (c) 2026 Enterprise DNA.
