---
description: Bring clients, debtors, open invoices and funds in use across from Lendscape.
---

Read `docs/replace-lendscape.md`. Put clients.csv, debtors.csv and invoices.csv in a folder. Run `npm run finance -- import lendscape <folder> --dry-run --as-at=<cutover date> --json` and compare the totals with Lendscape's own. With a yes, run it without `--dry-run`. A problem anywhere refuses the whole import.
