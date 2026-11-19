---
description: Onboard a new client: the record, due diligence, the security registration and the first notices.
---

1. `npm run finance -- onboard <CODE> --name="..." --limit=<dollars> --advance=<pct> --discount=<pct per 30 days> --service=<pct> --type=disclosed|confidential`.
2. When due diligence is finished: `npm run finance -- cdd <client> --on=<date> --risk=low|medium|high`.
3. When the PPSR registration is made: `npm run finance -- ppsr <client> --ref=<registration number> --on=<date> [--expires=<date>]`.
4. For a disclosed facility, draft each notice of assignment (`npm run finance -- draft-letter <client> <debtor> --kind=noa`) and record it sent (`npm run finance -- noa <client> <debtor> --sent=<date>`).
5. `npm run finance -- status <client> active`. The database refuses an advance until steps 2 and 3 are recorded.
