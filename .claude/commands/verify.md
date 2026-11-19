---
description: The verification queue, and recording that a debtor confirmed an invoice.
---

Run `npm run finance -- verify-queue --json` and show funded-but-unverified invoices first. When the operator says a debtor confirmed one, run `npm run finance -- verify <invoice> --method=phone|email|portal|signed_delivery --contact="<who>"`. Never mark an invoice verified on the client's word.
