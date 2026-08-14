# gads_google_update_script_aug2026

Hola Studio branded edition of the Google Ads bid strategy audit scripts for
the [17 August 2026 target-based-bidding change](https://support.google.com/google-ads/answer/17061251).
Private repo - Hola Studio internal.

Author: Camilo - Hola Studio | holastudio.com.au

**Read-only.** Nothing in this repo changes a Google Ads account: the scripts
only read reporting data and write results to Google Sheets in the
authorising user's own Drive. No bids, budgets, targets, statuses or
structures are ever modified, and no data is sent anywhere outside that
user's Google account.

## Scripts

Both are functionally identical to the public `gads_scripts` versions - the
difference is the branding: charts, header bands, highlight washes and accent
colours use the Hola Studio palette (light blue `#38E3F2`, navy `#292B41`,
light blue washes, light greys). Chart/filter helper data sits camouflaged
(white-on-white, pencil-thin columns) at the far right of the Summary tab -
Sheets charts cannot read hidden rows/columns or other sheets, so this is
the clean-looking arrangement that keeps the charts and live filter working.

### `bid-strategy-audit.js` (single account)

Four-tab audit workbook per account: **Summary** (target-split pies, the
interactive 8-week target-vs-actual chart with campaign filter and decay
trend line, campaign table with 30/14/7d actuals), **Actionable** (one row
per campaign whose target should move, timed before/after 17 Aug),
**Change Impact / Targets vs Actuals** (daily and weekly
target-vs-actual charts, both filterable by campaign; with
`TRACK_CHANGES: true` the tab additionally pulls the account's change log —
yellow dots marking change days/weeks plus a change-history table with
old→new values and 7-days-before vs 7-days-after impact, archived in-sheet
beyond Google's 30-day retention. Off by default, the tab is charts only),
and **Campaign Data** (all windows, actionable rows highlighted).
Campaigns with 60-day cost under `MIN_COST_60D` (default 100, account
currency) are excluded from every tab, chart and dropdown so tiny/stale
campaigns don't clutter the views. Campaigns whose Conversions column is
fed by multiple conversion actions are flagged — **Mixed-value goals**
when 2+ primary actions each record a material (≥5%) share of value
(hybrid accounts: online revenue alongside begin-checkout value),
**Multi-goal** otherwise — with the goal names listed and a side note in
the Actionable commentary. Hybrid mixed-value campaigns get a **softer
decay bar** (measured 30d vs 14d, thresholds doubled to −40%/−20%)
because one high-AOV sale swings a short blended-ROAS window; plain
multi-goal lead-gen setups (lead form + phone call tracked as equals)
keep the standard bar and are flagged for context only. Each run also names the workbook
`Account Name | Bid Strategy Audit | by Camilo - holastudio.com.au`.
Install in a single account: Tools > Bulk actions > Scripts, paste,
authorise, run; leave `SPREADSHEET_URL` blank on first run, then pin the
logged URL.

### `mcc-bid-strategy-audit.js` (manager level)

Installs once at MCC level, audits up to 50 child accounts per run in
parallel (batch bigger MCCs with `ACCOUNT_LABEL` / `ACCOUNT_IDS`), writes
each account its own four-tab audit workbook (including the same Change
Impact tab, spend floor and auto-naming) plus an MCC **Overview** ranking
accounts most-urgent-first with links to every audit — named
`MCC Name | Bid Strategy Audit - MCC Overview | by Camilo - holastudio.com.au`. Run once with
`MASTER_SPREADSHEET_URL` blank, then paste the logged Overview URL into the
config so re-runs reuse the same sheets. `LOW_SPEND_FLOOR` defaults to 0.
