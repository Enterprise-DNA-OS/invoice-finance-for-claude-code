---
description: Record an advance against a schedule. The database refuses anything above what the client can draw.
---

Run `npm run finance -- client <code> --json` and show what the client can draw. With the operator's yes and the amount, run `npm run finance -- fund <client> <amount> --schedule=<ref>`. If it is refused, explain why (over-advance, no due diligence, no registration) and stop. The bank transfer is made outside this system.
