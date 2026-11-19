---
description: Month-end fees: discount on daily funds in use, service fee on invoices assigned, minimum fee top-up. Test run, then charge.
---

Run `npm run finance -- fees --month=YYYY-MM --json` and show the test run. Fees already charged for the month are skipped. With a yes, run `npm run finance -- fees --month=YYYY-MM --apply`. A month is only charged after it ends.
