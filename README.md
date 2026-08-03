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
light blue washes, light greys). Chart/filter helper data lives on a hidden
"Audit Data (auto)" tab so the Summary tab stays clean.

### `bid-strategy-audit.js` (single account)

Three-tab audit workbook per account: **Summary** (target-split pies, the
interactive 8-week target-vs-actual chart with campaign filter and decay
trend line, campaign table with 30/14/7d actuals), **Actionable** (one row
per campaign whose target should move, timed before/after 17 Aug), and
**Campaign Data** (all windows, actionable rows highlighted). Install in a
single account: Tools > Bulk actions > Scripts, paste, authorise, run;
leave `SPREADSHEET_URL` blank on first run, then pin the logged URL.

### `mcc-bid-strategy-audit.js` (manager level)

Installs once at MCC level, audits up to 50 child accounts per run in
parallel (batch bigger MCCs with `ACCOUNT_LABEL` / `ACCOUNT_IDS`), writes
each account its own audit workbook plus an MCC **Overview** ranking
accounts most-urgent-first with links to every audit. Run once with
`MASTER_SPREADSHEET_URL` blank, then paste the logged Overview URL into the
config so re-runs reuse the same sheets. `LOW_SPEND_FLOOR` defaults to 0.
