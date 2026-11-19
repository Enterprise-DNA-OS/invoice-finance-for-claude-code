---
description: Record a debtor payment the bank has received, or one the debtor paid to the client.
---

For each payment on the bank statement run `npm run finance -- collect <invoice> <amount> --on=<date> --ref=<bank ref>`. If the debtor paid the client instead, add `--to=client`. Overpayments are refused: tell the operator to hold the excess as unapplied with the client.
