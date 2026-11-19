# Compliance: the rules this system checks

`/compliance` (`npm run finance -- compliance`) checks the book against the rules below. Each rule names its source. Rules marked **credit policy** are the lender's own settings, not law, and change in `settings`.

This is not legal advice. It records the rules the operator has told the system to enforce. Your own advisers confirm them before you go live.

Australian law is the default (`settings.jurisdiction = 'AU'`). The sections below were read from the Personal Property Securities Act 2009 (Cth), Compilation No. 22, 14 October 2024, on the Federal Register of Legislation: https://www.legislation.gov.au/C2009A00130/latest/text

## Personal Property Securities Act 2009 (Cth)

| Rule | Source | What a breach looks like in the data | Enforced |
|---|---|---|---|
| A transfer of an account is a security interest, so the lender registers it | s 12(3)(a): a security interest includes "the interest of a transferee under a transfer of an account or chattel paper" | An active or funded client with no `ppsr_registered_on` | The database refuses an advance until a registration is recorded |
| A registration ends at its stated end time | s 153(1), table item 5: for collateral that is not consumer or serial-numbered property, no stated end time or an end time no later than 25 years after registration | `ppsr_expires_on` within `ppsr_warn_days`, or passed with funds in use | The database refuses an advance on or after the end date |
| The debtor may keep paying the client until it receives a notice that states the transfer and says to pay the lender | s 80(7)(a): the account debtor may continue to make payments to the transferor until it receives a notice that states the amount has been transferred, that payment is to be made to the transferee, and identifies the contract | A funded invoice on a disclosed facility whose debtor has no `noa_sent_on` | Not counted toward the drawing base (`no notice of assignment`) and reported as a breach |
| After the notice, paying the lender discharges the debtor | s 80(8): payment to the transferee in line with the notice discharges the debtor's obligation to the extent of the payment | A debtor payment recorded `paid_to = 'client'` after the notice date | Reported as a breach: recover from the client, tell the debtor where to pay |
| The debtor can ask for proof of the transfer | s 80(7)(b): if proof is asked for and not given within 5 business days, the debtor may keep paying the client | | The notice of assignment draft offers proof within five business days |
| The debtor keeps its defences and set-off | s 80(1)(b): the transferee takes subject to the debtor's defences and rights of set-off | Credit notes and disputes | Disputed invoices do not count; credit notes reduce the open amount |

Note: s 8(1)(f) puts some transfers of accounts outside the Act (for example a transfer made only so the account can be collected for the person making the transfer). If your facility is structured that way, ask your adviser whether the registration rule applies.

## Anti-Money Laundering and Counter-Terrorism Financing Act 2006 (Cth)

The lender's AML/CTF programme sets when customer due diligence is done and how often it is reviewed. This system holds the dates; it does not decide whether your business is a reporting entity or what your programme must say. Section references are not given here until your adviser confirms them.

| Rule | Source | What a breach looks like | Enforced |
|---|---|---|---|
| Due diligence finished before the client is funded | Your AML/CTF programme | An advance to a client with no `cdd_completed_on` | The database refuses it |
| Ongoing review on the programme's cycle | Your AML/CTF programme (`settings.cdd_review_months`) | `cdd_review_due` passed on an active client | Reported as a breach |
| Records kept | Your AML/CTF programme | | The client account and collections are append only; `export` writes everything to one file |

## Credit policy

| Rule | Setting | Enforced |
|---|---|---|
| No advance above the drawing base | `advance_pct`, `facility_limit_cents` per client | The database refuses it |
| Verify invoices at or above a threshold with the debtor before funding | `settings.verify_over_cents` | Unverified invoices do not count; funded unverified ones are breaches |
| Invoices stop counting after a number of days from invoice date | `settings.recourse_days`, or per client | Not counted (`past N days`) |
| One debtor's share of a client's eligible ledger is capped | `settings.concentration_pct`, or per client | The excess is left out of the drawing base |
| Field audit of each client's books | `settings.audit_months` | Overdue audits reported |
| Debtor payments paid to the client are passed on quickly | `settings.misdirected_days` | Held longer reported as a breach |
| Credit notes watched | `settings.dilution_watch_pct` | Over the watch level reported |
| A registration is discharged after a client exits | Your own procedure | Exited clients with a registration not marked discharged are reported |

## New Zealand

The Personal Property Securities Act 1999 (NZ) and the Anti-Money Laundering and Countering Financing of Terrorism Act 2009 (NZ) cover the same ground. Their section numbers are not cited here yet because they have not been checked against the official text. Set `jurisdiction = 'NZ'`, have your adviser confirm the sections, and update this file and the `/compliance` labels together.
