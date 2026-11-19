---
description: Approve, watch or block a debtor across every client.
---

Run `npm run finance -- debtor-status <debtor> approved|watch|blocked --reason="..."`. A blocked debtor's invoices stop counting for every client: run `npm run finance -- position` after and report who is affected.
