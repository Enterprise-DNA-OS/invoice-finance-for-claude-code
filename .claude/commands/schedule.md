---
description: Receive a schedule of invoices from a client: test run, then record it.
---

The operator gives a CSV of invoices (debtor, invoice number, date, due date, amount). Run `npm run finance -- schedule <client> <file> --ref=<ref> --dry-run --json` first and show the totals and the invoices to verify. Duplicates and unknown debtors are refused: report them. With a yes, run it again without `--dry-run`.
