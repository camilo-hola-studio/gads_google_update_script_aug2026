/**
 * BID STRATEGY AUDIT — pre-17-Aug-2026 target-based-bidding change.
 *
 * Author: Camilo - Hola Studio | holastudio.com.au
 * Hola Studio branded edition (light blue #38E3F2 / navy #292B41).
 * *
 * READ-ONLY: this script makes NO changes to the Google Ads account. It only
 * reads reporting data (AdsApp.report queries and account metadata) and
 * writes the results to a Google Sheet in your own Drive. It contains no
 * bid, budget, target, status or structure mutations, and no calls that send
 * data anywhere outside your Google account. (The authorisation prompt still
 * shows broad Ads permissions — Google Ads Scripts has no read-only consent
 * scope — but the code below is the complete behaviour and can be audited.)
 *
 * THE CHANGE (https://support.google.com/google-ads/answer/17061251): from
 * 17 August 2026, budget-limited campaigns using Target CPA / Target ROAS
 * start bidding to the TARGET YOU TYPED IN, not the better number the
 * algorithm quietly achieved within the budget. A campaign with a stale
 * target (e.g. tCPA $10 while actually converting at $5) will be pushed back
 * toward the stated $10 — expect spend, CPC and volume shifts wherever the
 * stated target and 30d actual have drifted apart. Only budget-limited
 * campaigns that carry a target are directly affected; Google's Bid Target
 * Adjustment Tool (in-product since 6 July 2026) suggests targets from recent
 * performance but changes nothing automatically. This audit finds the drift
 * so targets can be re-anchored to actuals before the date.
 *
 * INSTALL: In Google Ads, go to Tools > Bulk actions > Scripts, create a new
 * script, paste this whole file in, click Authorise (it needs Ads read access
 * plus Google Sheets/Drive to write the report), optionally set
 * SPREADSHEET_URL below (leave blank to have the script create a fresh sheet
 * and log its URL), then Preview/Run. Schedule it weekly if you want the sheet
 * kept current. The script is account-generic: it reads the account's own
 * timezone, currency and bid strategies, so the same file can be deployed
 * unchanged across accounts (ROAS-target and CPA-target accounts alike).
 *
 * What it does: pulls campaign performance over four windows (60d base,
 * 30/14/7d rolling, all ending yesterday), computes windowed ROAS/CPA
 * in-script (there is no native windowed column), classifies every campaign
 * by target status, and writes a four-tab audit workbook: Summary,
 * Actionable, Change Impact (budget & bid strategy change history matched to
 * daily/weekly performance), Campaign Data.
 */

// Bumped on every release. Written into the sheet subtitles and the logs so
// a workbook always says which script version produced it - if the sheet
// shows an older stamp, the paste didn't take.
var SCRIPT_VERSION = 'v9 (2026-08-14)';

// ---------------------------------------------------------------------------
// CONFIG — the only block you should need to touch.
// ---------------------------------------------------------------------------
var CONFIG = {
  // Full URL of an existing Google Sheet. Leave '' to create a new one
  // (the URL is logged at the end of the run).
  SPREADSHEET_URL: '',

  // Campaigns with less than this 60-day cost (account currency) are never
  // flagged/prioritised — short-window ratios are too volatile below it.
  LOW_SPEND_FLOOR: 1500,

  // The three rolling lookback windows, in days, each ending yesterday in the
  // account's own timezone. Order matters: [long, mid, short].
  WINDOW_LONG: 30,
  WINDOW_MID: 14,
  WINDOW_SHORT: 7,

  // Base window used for classification, spend weighting and the pie charts.
  BASE_WINDOW: 60,

  // A campaign is treated as budget-limited when its 7-day average daily
  // spend reaches this share of its daily budget (see isBudgetLimited_).
  BUDGET_LIMITED_THRESHOLD: 0.85,

  // Change tracking: the change-history table + yellow change dots on the
  // Targets-vs-Actuals charts. Set false to skip the change-log pull
  // entirely - the tab then keeps only the daily/weekly target-vs-actual
  // charts with the campaign filter.
  TRACK_CHANGES: true,

  // Change Impact tab lookback in days (daily chart + fresh change pulls).
  // Capped at 29 in-code: the Google Ads change log (change_event) only
  // retains 30 days. Changes already pulled are archived inside the sheet,
  // so the table keeps accumulating across runs regardless of this cap.
  CHANGE_LOOKBACK_DAYS: 28,

  // Campaigns whose 60-day cost is below this (account currency) are dropped
  // from the workbook entirely - every tab, chart and dropdown. Old test /
  // video campaigns trickling a few dollars a week otherwise clutter every
  // view. Set to 0 to include every campaign with any spend. (Different from
  // LOW_SPEND_FLOOR, which only controls flagging, not inclusion.)
  MIN_COST_60D: 100
};

// Theme.
var COLORS = {
  PRIMARY: '#38E3F2', // Hola Studio light blue - header bands, primary series, "with target"
  DARK: '#292B41',    // Hola Studio navy - comparison series, "no target", titles
  NAVY: '#292B41',    // titles
  YELLOW: '#F4B400',  // gap-vs-target series (contrast against blue/navy)
  BORDER: '#D9D9D9',  // light grey table borders
  WHITE: '#FFFFFF',
  RED: '#F4C7C3',     // decay at/past the Act-now bar
  AMBER: '#FCE8B2',   // decay between the Watch and Act-now bars
  GREEN: '#D9EAD3',   // better than the Watch bar
  GREY: '#EFEFEF'     // no-target / low-spend rows
};

var TAB_ORDER = ['Summary', 'Actionable', 'Change Impact', 'Campaign Data'];

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------
function main() {
  Logger.log('Bid strategy audit - script ' + SCRIPT_VERSION);
  var account = AdsApp.currentAccount();
  var tz = account.getTimeZone();
  var currency = account.getCurrencyCode();

  // All four windows end yesterday *in the account's timezone*, so partial
  // "today" data never skews the short windows.
  var ranges = buildDateRanges_(tz);

  // Portfolio strategies are a separate resource: campaigns attached to one
  // carry their target on the strategy, not on the campaign, so we fetch the
  // strategies once and join by resource name.
  var portfolios = fetchPortfolioStrategies_();

  // 60-day base pull: identity, strategy, targets, budget + 60d metrics.
  var campaigns = fetchBase_(ranges.base, portfolios);

  // Hard exclusion below MIN_COST_60D: the campaign disappears from every
  // tab, chart, dropdown and change row - not just from flagging. Every
  // downstream pull joins onto this map, so the scope is inherited.
  for (var cid in campaigns) {
    if (campaigns[cid].base.cost < CONFIG.MIN_COST_60D) delete campaigns[cid];
  }

  // -------------------------------------------------------------------------
  // THE CORE JOIN. There is no native 30/14/7-day ROAS or CPA column and the
  // report API only aggregates over one date range per query — so we run the
  // same metrics query three more times (last 30, 14 and 7 days) and stitch
  // the results onto the 60-day base by campaign ID, in memory. A campaign
  // present in the base but absent (or zero) in a shorter window simply gets
  // nulls for that window, which render as blanks — never Infinity/NaN.
  // -------------------------------------------------------------------------
  attachWindow_(campaigns, 'w30', ranges.w30);
  attachWindow_(campaigns, 'w14', ranges.w14);
  attachWindow_(campaigns, 'w7', ranges.w7);

  // Which conversion actions feed each campaign's Conversions column over
  // the base window - powers the multi-goal / mixed-value-goal side notes.
  // Guarded: a failure only costs those notes, never the run.
  try {
    fetchConversionGoals_(ranges.base, campaigns);
  } catch (e) {
    Logger.log('Conversion goal split skipped: ' + e);
  }

  var list = [];
  for (var id in campaigns) list.push(campaigns[id]);
  list.sort(function(a, b) { return b.base.cost - a.base.cost; });

  // Which metric the account "speaks": cost-weighted by targeted 60d spend.
  var primaryMetric = accountPrimaryMetric_(list);

  var totalCost = 0;
  list.forEach(function(c) { totalCost += c.base.cost; });

  // Per-campaign derived fields; one bad campaign logs and skips, it cannot
  // kill the run.
  list.forEach(function(c) {
    try {
      deriveCampaign_(c, primaryMetric, totalCost);
    } catch (e) {
      Logger.log('Skipping derivations for campaign "' + c.name + '": ' + e);
      c.broken = true;
    }
  });
  list = list.filter(function(c) { return !c.broken; });

  // Weekly series for the target-vs-actual chart: last 8 weeks, targeted
  // campaigns on the account's primary metric only. Guarded so a failure
  // here costs the chart, not the run.
  var weekly = { weeks: [], rows: [] };
  try {
    weekly = fetchWeeklyRows_(ranges.base.end, campaigns, primaryMetric);
  } catch (e) {
    Logger.log('Weekly series skipped: ' + e);
  }

  // Change Impact inputs: daily series over the change window, all-campaign
  // weekly series, and the budget/bid-strategy change history. Each guarded
  // so a failure costs that piece of the tab, never the run.
  var daily = { start: '', end: '', dates: [], rows: [] };
  try {
    daily = fetchDailyRows_(ranges.base.end, campaigns, changeWindowDays_());
  } catch (e) {
    Logger.log('Daily series skipped: ' + e);
  }
  var weeklyAll = { weeks: [], rows: [] };
  try {
    weeklyAll = fetchAllWeeklyRows_(ranges.base.end, campaigns);
  } catch (e) {
    Logger.log('All-campaign weekly series skipped: ' + e);
  }
  var changes = [], changesError = '';
  if (CONFIG.TRACK_CHANGES) {
    try {
      changes = fetchChangeEvents_(tz, campaigns, portfolios);
    } catch (e) {
      changesError = String(e);
      Logger.log('Change history skipped: ' + e);
    }
  }

  var ss = openOrCreateSpreadsheet_(account, ranges);
  applySheetName_(ss, account.getName() || account.getCustomerId(),
                  'Bid Strategy Audit');

  buildSummaryTab_(ss, list, account, ranges, primaryMetric, currency, weekly);
  buildActionableTab_(ss, list, primaryMetric, currency);
  buildChangeImpactTab_(ss, list, primaryMetric, currency, daily, weeklyAll,
                        changes, changesError);
  buildCampaignDataTab_(ss, list, primaryMetric, currency, totalCost);

  orderTabs_(ss);

  Logger.log('Bid strategy audit complete: ' + list.length + ' campaigns, ' +
             'primary metric ' + primaryMetric + '.');
  Logger.log('Spreadsheet: ' + ss.getUrl());
}

// ---------------------------------------------------------------------------
// DATES
// ---------------------------------------------------------------------------
function buildDateRanges_(tz) {
  // "Yesterday" as a calendar date in the account's timezone, then shifted
  // with pure date arithmetic in UTC so DST can't move the boundaries.
  var todayIso = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var end = shiftDays_(todayIso, -1);
  function windowOf(days) {
    return { start: shiftDays_(end, -(days - 1)), end: end, days: days };
  }
  return {
    base: windowOf(CONFIG.BASE_WINDOW),
    w30: windowOf(CONFIG.WINDOW_LONG),
    w14: windowOf(CONFIG.WINDOW_MID),
    w7: windowOf(CONFIG.WINDOW_SHORT)
  };
}

function shiftDays_(isoDate, days) {
  var d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// DATA PULLS
// ---------------------------------------------------------------------------
function fetchPortfolioStrategies_() {
  var map = {};
  try {
    var rows = AdsApp.report(
      'SELECT bidding_strategy.resource_name, bidding_strategy.name, ' +
      ' bidding_strategy.type, ' +
      ' bidding_strategy.target_roas.target_roas, ' +
      ' bidding_strategy.target_cpa.target_cpa_micros, ' +
      ' bidding_strategy.maximize_conversion_value.target_roas, ' +
      ' bidding_strategy.maximize_conversions.target_cpa_micros ' +
      'FROM bidding_strategy').rows();
    while (rows.hasNext()) {
      var r = rows.next();
      map[r['bidding_strategy.resource_name']] = {
        name: r['bidding_strategy.name'] || '',
        type: r['bidding_strategy.type'] || '',
        targetRoas: num_(r['bidding_strategy.target_roas.target_roas']) ||
                    num_(r['bidding_strategy.maximize_conversion_value.target_roas']),
        targetCpa: micros_(r['bidding_strategy.target_cpa.target_cpa_micros']) ||
                   micros_(r['bidding_strategy.maximize_conversions.target_cpa_micros'])
      };
    }
  } catch (e) {
    // No portfolio strategies (or the resource is unavailable) — campaigns
    // then classify from their own campaign-level fields only.
    Logger.log('Portfolio strategy pull skipped: ' + e);
  }
  return map;
}

// How budget-limited was detected this run: 'primary_status_reasons' (the
// platform's own flag) or 'derived' (spend-vs-budget fallback). Surfaced in
// the Summary notes so the sheet says which method it used.
var BUDGET_LIMITED_METHOD = 'derived';

function fetchBase_(range, portfolios) {
  var campaigns = {};

  function baseQuery(withStatusReasons) {
    return 'SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, ' +
      ' campaign.bidding_strategy, ' +
      ' campaign.maximize_conversion_value.target_roas, ' +
      ' campaign.maximize_conversions.target_cpa_micros, ' +
      ' campaign.target_roas.target_roas, ' +
      ' campaign.target_cpa.target_cpa_micros, ' +
      ' campaign_budget.amount_micros, campaign_budget.explicitly_shared, ' +
      (withStatusReasons ? ' campaign.primary_status_reasons, ' : '') +
      ' metrics.cost_micros, metrics.conversions_value, metrics.conversions ' +
      'FROM campaign ' +
      // Scope: currently-enabled campaigns only (paused/removed never
      // appear), and only those with actual spend inside the 60-day base
      // window - zero-spend campaigns would otherwise come back with
      // all-zero metric rows and clutter every tab. The shorter-window and
      // weekly pulls join onto this base by ID, so they inherit the scope.
      "WHERE campaign.status = 'ENABLED' " +
      ' AND metrics.cost_micros > 0 ' +
      " AND segments.date BETWEEN '" + range.start + "' AND '" + range.end + "'";
  }

  // First choice for the budget-limited flag: the platform's own
  // campaign.primary_status_reasons (BUDGET_CONSTRAINED is what the UI shows
  // as "Limited by budget"). The field's availability depends on the API
  // version behind the Scripts environment, so we attempt it and fall back
  // to a spend-vs-budget derivation (see isBudgetLimited_) if the query is
  // rejected.
  var rows, statusReasonsAvailable = true;
  try {
    rows = AdsApp.report(baseQuery(true)).rows();
    rows.hasNext(); // force validation now, not mid-parse
    BUDGET_LIMITED_METHOD = 'primary_status_reasons';
  } catch (e) {
    Logger.log('primary_status_reasons unavailable, deriving budget-limited ' +
               'from spend vs budget instead: ' + e);
    statusReasonsAvailable = false;
    rows = AdsApp.report(baseQuery(false)).rows();
  }

  while (rows.hasNext()) {
    var r = rows.next();
    try {
      var c = {
        id: String(r['campaign.id']),
        name: r['campaign.name'],
        strategyType: r['campaign.bidding_strategy_type'] || 'UNKNOWN',
        portfolio: false,
        portfolioName: '',
        targetType: 'None',
        target: null,
        budgetDaily: micros_(r['campaign_budget.amount_micros']),
        budgetShared: String(r['campaign_budget.explicitly_shared']) === 'true',
        // Repeated enum; rendered as an array or bracketed string depending
        // on runtime, so match on the string form either way.
        statusSaysLimited: statusReasonsAvailable
            ? String(r['campaign.primary_status_reasons'] || '')
                  .indexOf('BUDGET_CONSTRAINED') !== -1
            : null,
        base: {
          cost: micros_(r['metrics.cost_micros']),
          value: num_(r['metrics.conversions_value']),
          conv: num_(r['metrics.conversions'])
        },
        w30: null, w14: null, w7: null
      };

      // ---- Target resolution, generic across account types. ----
      // Portfolio first: if the campaign points at a portfolio strategy the
      // target lives there, not on the campaign.
      var res = r['campaign.bidding_strategy'] || '';
      if (res && portfolios[res]) {
        c.portfolio = true;
        c.portfolioName = portfolios[res].name;
        if (portfolios[res].targetRoas) {
          c.targetType = 'ROAS'; c.target = portfolios[res].targetRoas;
        } else if (portfolios[res].targetCpa) {
          c.targetType = 'CPA'; c.target = portfolios[res].targetCpa;
        }
      } else {
        // Standard (campaign-level) strategies: read whichever oneof field is
        // populated. A tROAS/max-conv-value campaign exposes a target ROAS, a
        // tCPA/max-conversions campaign exposes a target CPA. 0/absent = no
        // target set (plain Maximise conversions / conversion value).
        var tRoas = num_(r['campaign.target_roas.target_roas']) ||
                    num_(r['campaign.maximize_conversion_value.target_roas']);
        var tCpa = micros_(r['campaign.target_cpa.target_cpa_micros']) ||
                   micros_(r['campaign.maximize_conversions.target_cpa_micros']);
        if (tRoas) { c.targetType = 'ROAS'; c.target = tRoas; }
        else if (tCpa) { c.targetType = 'CPA'; c.target = tCpa; }
      }

      campaigns[c.id] = c;
    } catch (e) {
      Logger.log('Skipping unreadable campaign row: ' + e);
    }
  }
  return campaigns;
}

// One extra query per rolling window: raw cost/value/conversions only, keyed
// by campaign ID and stitched onto the base map. This is the "windowed
// ROAS/CPA" mechanism — the ratios are computed later, never read.
function attachWindow_(campaigns, key, range) {
  var rows = AdsApp.report(
    'SELECT campaign.id, metrics.cost_micros, metrics.conversions_value, ' +
    ' metrics.conversions ' +
    'FROM campaign ' +
    "WHERE campaign.status = 'ENABLED' " +
    " AND segments.date BETWEEN '" + range.start + "' AND '" + range.end + "'"
  ).rows();
  while (rows.hasNext()) {
    var r = rows.next();
    var c = campaigns[String(r['campaign.id'])];
    if (!c) continue; // not in the 60d base (shouldn't happen) — ignore.
    c[key] = {
      cost: micros_(r['metrics.cost_micros']),
      value: num_(r['metrics.conversions_value']),
      conv: num_(r['metrics.conversions'])
    };
  }
}

// Per-campaign split of the Conversions column by conversion action.
// metrics.conversions / conversions_value only count actions INCLUDED in
// bidding, so 2+ actions here means the campaign genuinely optimises toward
// multiple goals - and 2+ value-recording actions means its windowed ROAS
// blends different kinds of value (hybrid accounts: begin-checkout revenue
// alongside purchases, or several valued lead goals).
function fetchConversionGoals_(range, campaigns) {
  var rows = AdsApp.report(
    'SELECT campaign.id, segments.conversion_action_name, ' +
    ' metrics.conversions, metrics.conversions_value ' +
    'FROM campaign ' +
    "WHERE campaign.status = 'ENABLED' " +
    ' AND metrics.conversions > 0 ' +
    " AND segments.date BETWEEN '" + range.start + "' AND '" + range.end + "'"
  ).rows();
  while (rows.hasNext()) {
    var r = rows.next();
    var c = campaigns[String(r['campaign.id'])];
    if (!c) continue;
    (c.goals = c.goals || []).push({
      name: String(r['segments.conversion_action_name'] || ''),
      conv: num_(r['metrics.conversions']),
      value: num_(r['metrics.conversions_value'])
    });
  }
}

// Per-campaign per-week raw metrics for the weekly target-vs-actual chart.
// segments.week buckets by the Monday of each week; we pull 56 days ending
// yesterday, then keep the 8 most recent week buckets (the newest can be a
// partial week — that's the "so far this week" read). Only campaigns that
// carry a target on the account's primary metric are included, so the
// weighted-target line means one thing.
function fetchWeeklyRows_(endIso, campaigns, primaryMetric) {
  var start = shiftDays_(endIso, -55);
  var report = AdsApp.report(
    'SELECT campaign.id, segments.week, metrics.cost_micros, ' +
    ' metrics.conversions_value, metrics.conversions ' +
    'FROM campaign ' +
    "WHERE campaign.status = 'ENABLED' " +
    " AND segments.date BETWEEN '" + start + "' AND '" + endIso + "'").rows();

  var raw = [];
  while (report.hasNext()) {
    var r = report.next();
    var c = campaigns[String(r['campaign.id'])];
    if (!c || c.targetType !== primaryMetric || !c.target) continue;
    raw.push({
      week: String(r['segments.week']),
      name: c.name,
      cost: micros_(r['metrics.cost_micros']),
      value: num_(r['metrics.conversions_value']),
      conv: num_(r['metrics.conversions']),
      target: c.target
    });
  }

  var weekSet = {};
  raw.forEach(function(x) { weekSet[x.week] = true; });
  var weeks = Object.keys(weekSet).sort().slice(-8);
  var keep = {};
  weeks.forEach(function(w) { keep[w] = true; });
  return { weeks: weeks, rows: raw.filter(function(x) { return keep[x.week]; }) };
}

// Per-campaign per-day raw metrics over the change window, for the Change
// Impact tab's daily chart and the before/after maths on each change. Joins
// onto the 60d base by ID, so scope (enabled + spent) is inherited.
function fetchDailyRows_(endIso, campaigns, days) {
  var start = shiftDays_(endIso, -(days - 1));
  var report = AdsApp.report(
    'SELECT campaign.id, segments.date, metrics.cost_micros, ' +
    ' metrics.conversions_value, metrics.conversions ' +
    'FROM campaign ' +
    "WHERE campaign.status = 'ENABLED' " +
    " AND segments.date BETWEEN '" + start + "' AND '" + endIso + "'").rows();
  var rows = [];
  while (report.hasNext()) {
    var r = report.next();
    var c = campaigns[String(r['campaign.id'])];
    if (!c) continue;
    rows.push({
      date: String(r['segments.date']),
      id: c.id,
      name: c.name,
      cost: micros_(r['metrics.cost_micros']),
      value: num_(r['metrics.conversions_value']),
      conv: num_(r['metrics.conversions']),
      target: c.target || 0
    });
  }
  var dates = [];
  for (var i = 0; i < days; i++) dates.push(shiftDays_(start, i));
  return { start: start, end: endIso, dates: dates, rows: rows };
}

// Weekly raw rows for the Change Impact weekly chart. Same shape as
// fetchWeeklyRows_ but covers ALL base campaigns (targeted or not, either
// metric), so budget changes on untargeted campaigns are visible too;
// campaigns without a target contribute no weight to the target line.
function fetchAllWeeklyRows_(endIso, campaigns) {
  var start = shiftDays_(endIso, -55);
  var report = AdsApp.report(
    'SELECT campaign.id, segments.week, metrics.cost_micros, ' +
    ' metrics.conversions_value, metrics.conversions ' +
    'FROM campaign ' +
    "WHERE campaign.status = 'ENABLED' " +
    " AND segments.date BETWEEN '" + start + "' AND '" + endIso + "'").rows();
  var raw = [];
  while (report.hasNext()) {
    var r = report.next();
    var c = campaigns[String(r['campaign.id'])];
    if (!c) continue;
    raw.push({
      week: String(r['segments.week']),
      name: c.name,
      cost: micros_(r['metrics.cost_micros']),
      value: num_(r['metrics.conversions_value']),
      conv: num_(r['metrics.conversions']),
      target: c.target || 0
    });
  }
  var weekSet = {};
  raw.forEach(function(x) { weekSet[x.week] = true; });
  var weeks = Object.keys(weekSet).sort().slice(-8);
  var keep = {};
  weeks.forEach(function(w) { keep[w] = true; });
  return { weeks: weeks, rows: raw.filter(function(x) { return keep[x.week]; }) };
}

// Budget & bid-strategy change history from the account's own change log
// (change_event). The resource only retains 30 days and requires an explicit
// datetime range plus a LIMIT, so the window is capped at 29 days ending
// today - today's changes surface immediately even though metrics run to
// yesterday. Campaigns, campaign budgets and campaign criteria (bid
// adjustments) are pulled; each event is parsed down to the budget/bidding
// deltas the audit cares about (name edits etc. are dropped). Portfolio
// bidding strategy edits never appear - Google's change log has no enum
// value for them (BAD_ENUM_CONSTANT if requested).
var CHANGE_PULL_STATS = { rows: 0, kept: 0, samples: [] };

function fetchChangeEvents_(tz, campaigns, portfolios) {
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var start = shiftDays_(today, -changeWindowDays_());
  CHANGE_PULL_STATS = { rows: 0, kept: 0, samples: [] };

  function query(withAttribution) {
    return 'SELECT change_event.change_date_time, ' +
      ' change_event.change_resource_type, change_event.change_resource_name, ' +
      ' change_event.changed_fields, change_event.old_resource, ' +
      ' change_event.new_resource, change_event.resource_change_operation' +
      (withAttribution
        ? ', change_event.user_email, campaign.id, campaign.name ' : ' ') +
      'FROM change_event ' +
      "WHERE change_event.change_date_time >= '" + start + " 00:00:00' " +
      " AND change_event.change_date_time <= '" + today + " 23:59:59' " +
      " AND change_event.change_resource_type IN ('CAMPAIGN', " +
      "  'CAMPAIGN_BUDGET', 'CAMPAIGN_CRITERION') " +
      'ORDER BY change_event.change_date_time DESC ' +
      'LIMIT 9800';
  }

  // The campaign attribution join and user_email are the fields most likely
  // to be rejected by an older API version behind Scripts - retry without
  // them (campaign is then recovered from the resource name where possible).
  var rows;
  try {
    rows = AdsApp.report(query(true)).rows();
    rows.hasNext(); // force validation now, not mid-parse
  } catch (e) {
    Logger.log('Change history attribution unavailable, retrying reduced ' +
               'query: ' + e);
    rows = AdsApp.report(query(false)).rows();
  }

  var out = [];
  while (rows.hasNext()) {
    var r = rows.next();
    CHANGE_PULL_STATS.rows++;
    try {
      var evs = parseChangeEvent_(r, campaigns, portfolios);
      if (!evs.length) sampleChange_(r); // remember what was dropped and why
      for (var i = 0; i < evs.length; i++) {
        // Changes on campaigns excluded from the report (no 60d spend, or
        // below MIN_COST_60D) would dangle - skip them.
        if (evs[i].campId && !campaigns[evs[i].campId]) continue;
        out.push(evs[i]);
      }
    } catch (e2) {
      Logger.log('Skipping unreadable change event: ' + e2);
      sampleChange_(r);
    }
  }
  CHANGE_PULL_STATS.kept = out.length;
  Logger.log('Change history: ' + CHANGE_PULL_STATS.rows +
             ' events pulled, ' + out.length + ' relevant deltas kept.');
  return out;
}

// Keeps a small distinct sample of dropped events so an empty change table
// can say WHY it is empty (surfaced on the sheet and in the logs).
function sampleChange_(r) {
  var s = String(r['change_event.change_resource_type'] || '?') + ':' +
      String(r['change_event.resource_change_operation'] || '?') + ':' +
      (String(r['change_event.changed_fields'] || '').slice(0, 80) ||
       '(no fields)');
  if (CHANGE_PULL_STATS.samples.length < 6 &&
      CHANGE_PULL_STATS.samples.indexOf(s) === -1) {
    CHANGE_PULL_STATS.samples.push(s);
  }
}

// One change_event row -> zero or more {date, time, campId, label, what,
// old, nw, numeric, who} deltas, keeping only budget amounts, bidding
// fields and bid adjustments. old_resource/new_resource arrive as
// serialised proto JSON whose key casing differs between runtimes
// (protoGet_ tries both), and changed_fields entries are matched with and
// without their resource prefix. When a relevant field changed but the
// values can't be read in this runtime's serialisation, the delta is still
// emitted with blank old/new - seeing THAT a change happened matters more
// than the numbers.
function parseChangeEvent_(r, campaigns, portfolios) {
  var type = String(r['change_event.change_resource_type'] || '');
  var op = String(r['change_event.resource_change_operation'] || '');
  // Campaign/budget rows: only UPDATEs are adjustments (CREATE = new
  // campaign, REMOVE = deletion). Criterion rows: a bid adjustment can
  // arrive as CREATE (set), UPDATE (changed) or REMOVE (cleared), so all
  // three pass through to the criterion branch.
  if ((type === 'CAMPAIGN' || type === 'CAMPAIGN_BUDGET') && op !== 'UPDATE') {
    return [];
  }
  var fields = String(r['change_event.changed_fields'] || '')
      .replace(/[\[\]"]/g, '').split(',').map(function(f) {
        // The runtime serialises field masks in camelCase
        // (maximizeConversionValue.targetRoas) - normalise to snake_case so
        // one spelling matches regardless of runtime.
        return f.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      });
  function hasField(name) {
    var suffix = '.' + name;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f === name) return true;
      if (f.length > suffix.length &&
          f.lastIndexOf(suffix) === f.length - suffix.length) return true;
    }
    return false;
  }
  var oldRes = safeJson_(r['change_event.old_resource']);
  var newRes = safeJson_(r['change_event.new_resource']);
  var dt = String(r['change_event.change_date_time'] || '');
  var resName = String(r['change_event.change_resource_name'] || '');

  var campId = String(r['campaign.id'] || '');
  if (!campId) {
    var m = null;
    if (type === 'CAMPAIGN') m = resName.match(/campaigns\/(\d+)/);
    else if (type === 'CAMPAIGN_CRITERION') {
      m = resName.match(/campaignCriteria\/(\d+)~/);
    }
    if (m) campId = m[1];
  }
  var known = campaigns[campId];
  var label = known ? known.name : String(r['campaign.name'] || '');

  var deltas = [];
  function pushNum(field, what, path, isMicros) {
    if (!hasField(field)) return;
    var o = parseFloat(protoGet_(oldRes, path));
    var n = parseFloat(protoGet_(newRes, path));
    o = isFinite(o) ? (isMicros ? o / 1e6 : o) : null;
    n = isFinite(n) ? (isMicros ? n / 1e6 : n) : null;
    deltas.push({ what: what, old: o, nw: n, numeric: o != null || n != null });
  }
  function pushText(field, what, oldV, newV) {
    if (!hasField(field)) return;
    deltas.push({ what: what, old: oldV, nw: newV, numeric: false });
  }

  if (type === 'CAMPAIGN_BUDGET') {
    pushNum('amount_micros', 'Daily budget',
            ['campaign_budget', 'amount_micros'], true);
    if (!label) label = '(shared or unattributed budget)';
  } else if (type === 'CAMPAIGN') {
    pushNum('target_roas.target_roas', 'Target ROAS',
            ['campaign', 'target_roas', 'target_roas'], false);
    pushNum('maximize_conversion_value.target_roas', 'Target ROAS',
            ['campaign', 'maximize_conversion_value', 'target_roas'], false);
    pushNum('target_cpa.target_cpa_micros', 'Target CPA',
            ['campaign', 'target_cpa', 'target_cpa_micros'], true);
    pushNum('maximize_conversions.target_cpa_micros', 'Target CPA',
            ['campaign', 'maximize_conversions', 'target_cpa_micros'], true);
    pushText('bidding_strategy_type', 'Bid strategy type',
        prettyStrategyType_(String(
            protoGet_(oldRes, ['campaign', 'bidding_strategy_type']) || '')),
        prettyStrategyType_(String(
            protoGet_(newRes, ['campaign', 'bidding_strategy_type']) || '')));
    if (!hasField('bidding_strategy_type')) {
      pushText('bidding_strategy', 'Portfolio strategy',
          stratName_(protoGet_(oldRes, ['campaign', 'bidding_strategy']),
                     portfolios),
          stratName_(protoGet_(newRes, ['campaign', 'bidding_strategy']),
                     portfolios));
    }
    pushText('campaign_budget', 'Budget assignment', '',
             'campaign moved to a different budget');
  } else if (type === 'CAMPAIGN_CRITERION') {
    // Platform/device/schedule bid adjustments live on campaign criteria.
    // CREATE events carry no changed_fields, so read the modifier straight
    // off the resources: 1.0 = no adjustment, 0 = -100%.
    var oB = parseFloat(
        protoGet_(oldRes, ['campaign_criterion', 'bid_modifier']));
    var nB = parseFloat(
        protoGet_(newRes, ['campaign_criterion', 'bid_modifier']));
    var hasO = isFinite(oB), hasN = isFinite(nB);
    if (hasO || hasN) {
      deltas.push({
        what: op === 'REMOVE' ? 'Bid adjustment removed'
            : op === 'CREATE' ? 'Bid adjustment set'
            : 'Bid adjustment',
        old: hasO ? oB : null,
        nw: hasN ? nB : null,
        numeric: true
      });
    }
  }
  if (!label) label = '(unknown)';

  return deltas.map(function(d) {
    return {
      date: dt.slice(0, 10),
      time: dt.length >= 16 ? dt.slice(11, 16) : '',
      campId: campId,
      label: label,
      what: d.what,
      old: d.old == null ? '' : d.old,
      nw: d.nw == null ? '' : d.nw,
      numeric: d.numeric,
      who: String(r['change_event.user_email'] || '')
    };
  });
}

// ---------------------------------------------------------------------------
// DERIVED FIELDS
// ---------------------------------------------------------------------------
function accountPrimaryMetric_(list) {
  // Cost-weighted, not campaign-counted: whichever target type carries more
  // 60d spend wins. Untargeted accounts fall back on "does the account track
  // conversion value at all".
  var roasCost = 0, cpaCost = 0, anyValue = 0;
  list.forEach(function(c) {
    if (c.targetType === 'ROAS') roasCost += c.base.cost;
    if (c.targetType === 'CPA') cpaCost += c.base.cost;
    anyValue += c.base.value;
  });
  if (roasCost === 0 && cpaCost === 0) return anyValue > 0 ? 'ROAS' : 'CPA';
  return roasCost >= cpaCost ? 'ROAS' : 'CPA';
}

// ROAS = conversions_value / cost; CPA = cost / conversions. Divide-by-zero
// returns null (rendered blank) — never Infinity/NaN.
function metricOf_(w, type) {
  if (!w) return null;
  if (type === 'ROAS') return w.cost > 0 ? w.value / w.cost : null;
  return w.conv > 0 ? w.cost / w.conv : null;
}

function deriveCampaign_(c, primaryMetric, totalCost) {
  // Campaigns with a target are measured on their own target's metric; the
  // rest are displayed on the account's primary metric so columns stay
  // comparable.
  c.metricType = c.targetType !== 'None' ? c.targetType : primaryMetric;

  c.m60 = metricOf_(c.base, c.metricType);
  c.m30 = metricOf_(c.w30, c.metricType);
  c.m14 = metricOf_(c.w14, c.metricType);
  c.m7 = metricOf_(c.w7, c.metricType);

  // Multi-goal detection - derived BEFORE the trend, because hybrid
  // campaigns get a softer decay treatment below. Only PRIMARY conversion
  // actions appear here (metrics.conversions counts nothing else), and an
  // action must carry a material share (>= 5% of the campaign's 60d
  // conversions or value) to count as a goal - a stray action that
  // converted once doesn't make a campaign multi-goal.
  var allGoals = c.goals || [];
  var totConv = 0, totVal = 0;
  allGoals.forEach(function(g) { totConv += g.conv; totVal += g.value; });
  var goals = allGoals.filter(function(g) {
    return (totConv > 0 && g.conv / totConv >= 0.05) ||
           (totVal > 0 && g.value / totVal >= 0.05);
  }).sort(function(a, b) {
    return b.value - a.value || b.conv - a.conv;
  });
  c.goalCount = goals.length;
  c.valueGoalCount = goals.filter(function(g) {
    return totVal > 0 && g.value / totVal >= 0.05;
  }).length;
  // Multi-goal: 2+ material primary actions counted - a deliberate, healthy
  // setup on lead-gen accounts (lead form + phone call can matter equally),
  // flagged for context only. Mixed-value ("hybrid"): 2+ of them EACH
  // record material value, so windowed ROAS blends different kinds of value.
  c.multiGoal = c.goalCount >= 2;
  c.multiValueGoal = c.valueGoalCount >= 2;
  var goalNames = goals.map(function(g) { return g.name; });
  c.goalsDetail = goalNames.slice(0, 4).join(', ') +
      (goalNames.length > 4 ? ' +' + (goalNames.length - 4) + ' more' : '');
  c.goalsSummary = !c.goalCount ? '-'
      : c.goalCount === 1 ? goalNames[0]
      : c.goalCount + ' goals' +
        (c.multiValueGoal ? ' (' + c.valueGoalCount + ' record value)' : '');

  // Gap vs Target respects direction: beating the target reads POSITIVE for
  // both metric types (higher ROAS is good, lower CPA is good).
  c.gap = null;
  if (c.target && c.m30 != null) {
    c.gap = c.targetType === 'ROAS'
        ? (c.m30 - c.target) / c.target
        : (c.target - c.m30) / c.target;
  }

  // Decay trend: negative = deteriorating, for both metric types. Normally
  // 30d vs 7d; hybrid (mixed-value-goal) campaigns are measured 30d vs 14d
  // and held to doubled thresholds - with several value streams and high-AOV
  // lumpiness, a 7-day blended ROAS swings on a single sale.
  c.trendWindow = c.multiValueGoal ? '14d' : '7d';
  c.actNowAt = c.multiValueGoal ? -0.40 : -0.20;
  c.watchAt = c.multiValueGoal ? -0.20 : -0.10;
  var shortM = c.multiValueGoal ? c.m14 : c.m7;
  c.trend = null;
  if (c.m30 != null && c.m30 !== 0 && shortM != null) {
    c.trend = c.metricType === 'ROAS'
        ? (shortM - c.m30) / c.m30
        : (c.m30 - shortM) / c.m30;
  }

  c.hasTarget = c.targetType !== 'None';
  c.aboveFloor = c.base.cost >= CONFIG.LOW_SPEND_FLOOR;
  c.budgetLimited = isBudgetLimited_(c);
  c.pctSpend = totalCost > 0 ? c.base.cost / totalCost : 0;

  // Priority: only campaigns that carry a target AND clear the spend floor
  // are flagged; everyone else is labelled, not scored.
  if (!c.hasTarget) {
    c.priority = 'No target';
  } else if (!c.aboveFloor) {
    c.priority = 'Low spend - not flagged';
  } else if (c.trend == null) {
    c.priority = 'No recent data';
  } else if (c.trend <= c.actNowAt) {
    c.priority = '1 - Act now';
  } else if (c.trend <= c.watchAt) {
    c.priority = '2 - Watch';
  } else {
    c.priority = '3 - Stable';
  }

  // Segment (no name-based inference - target status, spend floor, gap band).
  if (!c.hasTarget) c.segment = 'No target';
  else if (!c.aboveFloor) c.segment = 'Targeted - low spend';
  else if (c.gap == null) c.segment = 'Within +/-20% of target';
  else if (c.gap > 0.20) c.segment = 'Beating target >20%';
  else if (c.gap < -0.20) c.segment = 'Missing target >20%';
  else c.segment = 'Within +/-20% of target';

  var flags = [];
  if (c.hasTarget && c.aboveFloor) flags.push(c.priority);
  if (c.budgetLimited) flags.push('Budget-limited');
  if (c.portfolio) flags.push('Portfolio strategy');
  if (c.multiValueGoal) flags.push('Mixed-value goals');
  else if (c.multiGoal) flags.push('Multi-goal');
  c.flag = flags.join('; ') || '-';

  c.actionable = c.hasTarget && c.aboveFloor &&
      ((c.gap != null && Math.abs(c.gap) > 0.20) ||
       (c.trend != null && c.trend <= c.actNowAt));
}

/**
 * Budget-limited flag, two-tier:
 *  1. Preferred: campaign.primary_status_reasons contains BUDGET_CONSTRAINED —
 *     this is the platform's own "Limited by budget" signal, the same one the
 *     UI shows (fetched in fetchBase_, null when the field isn't available in
 *     this Scripts environment's API version).
 *  2. Fallback derivation: last-7-day average daily spend reaches
 *     BUDGET_LIMITED_THRESHOLD (default 85%) of the daily budget. Caveat:
 *     for shared budgets the comparison is this campaign's own spend vs the
 *     whole shared amount, so shared-budget campaigns can be under-flagged.
 */
function isBudgetLimited_(c) {
  if (c.statusSaysLimited !== null && c.statusSaysLimited !== undefined) {
    return c.statusSaysLimited;
  }
  if (!c.budgetDaily || !c.w7) return false;
  var avgDaily = c.w7.cost / CONFIG.WINDOW_SHORT;
  return avgDaily >= CONFIG.BUDGET_LIMITED_THRESHOLD * c.budgetDaily;
}

// ---------------------------------------------------------------------------
// TAB 1: SUMMARY
// ---------------------------------------------------------------------------
function buildSummaryTab_(ss, list, account, ranges, primaryMetric, currency,
                          weekly) {
  var sh = resetSheet_(ss, 'Summary');

  title_(sh, 1, 'Bid Strategy Audit - ' + account.getName() + ' (' +
         account.getCustomerId() + ')', 12);
  subtitle_(sh, 2, 'Run ' + ranges.base.end + ' | Windows: 60/30/14/7 days ending ' +
            ranges.base.end + ' | Primary metric: ' + primaryMetric +
            ' | All money in ' + currency + ' | script ' + SCRIPT_VERSION);

  // ---- Helper tables the pie charts reference (kept far right, visible). ----
  var withT = list.filter(function(c) { return c.hasTarget; });
  var noT = list.filter(function(c) { return !c.hasTarget; });
  function sum(arr, f) { var t = 0; arr.forEach(function(c) { t += f(c); }); return t; }

  sh.getRange(3, 14).setValue('Chart data - do not edit').setFontStyle('italic')
      .setFontColor('#999999');
  var helper = [
    ['Segment', 'Campaigns'],
    ['With target', withT.length],
    ['No target', noT.length],
    ['', ''],
    ['Segment', 'Cost 60d'],
    ['With target', round2_(sum(withT, function(c) { return c.base.cost; }))],
    ['No target', round2_(sum(noT, function(c) { return c.base.cost; }))],
    ['', ''],
    ['Segment', 'Conversions 60d'],
    ['With target', round2_(sum(withT, function(c) { return c.base.conv; }))],
    ['No target', round2_(sum(noT, function(c) { return c.base.conv; }))]
  ];
  sh.getRange(4, 14, helper.length, 2).setValues(helper);

  // Three native pie charts: with-target vs no-target split by campaign
  // count, 60d cost, 60d conversions.
  insertChartSafe_(sh, 'Campaigns: with vs without target', function() {
    return sh.newChart().setChartType(Charts.ChartType.PIE)
        .addRange(sh.getRange(4, 14, 3, 2))
        .setPosition(4, 1, 0, 0)
        .setOption('title', 'Campaigns: with vs without target')
        // Without setNumHeaders the header row is treated as a slice, which
        // shifts every slice color off by one (that's how a theme yellow
        // leaked in). 'slices' is what Sheets honours for pie colors; the
        // 'colors' array alone can be overridden by the sheet theme.
        .setNumHeaders(1)
        .setOption('colors', [COLORS.PRIMARY, COLORS.DARK])
        .setOption('slices', { 0: { color: COLORS.PRIMARY },
                               1: { color: COLORS.DARK } })
        .setOption('width', 300).setOption('height', 220)
        .setOption('legend', { position: 'bottom' })
        .build();
  });
  insertChartSafe_(sh, 'Cost 60d: with vs without target', function() {
    return sh.newChart().setChartType(Charts.ChartType.PIE)
        .addRange(sh.getRange(8, 14, 3, 2))
        .setPosition(4, 4, 0, 0)
        .setOption('title', 'Cost 60d: with vs without target')
        // Without setNumHeaders the header row is treated as a slice, which
        // shifts every slice color off by one (that's how a theme yellow
        // leaked in). 'slices' is what Sheets honours for pie colors; the
        // 'colors' array alone can be overridden by the sheet theme.
        .setNumHeaders(1)
        .setOption('colors', [COLORS.PRIMARY, COLORS.DARK])
        .setOption('slices', { 0: { color: COLORS.PRIMARY },
                               1: { color: COLORS.DARK } })
        .setOption('width', 300).setOption('height', 220)
        .setOption('legend', { position: 'bottom' })
        .build();
  });
  insertChartSafe_(sh, 'Conversions 60d: with vs without target', function() {
    return sh.newChart().setChartType(Charts.ChartType.PIE)
        .addRange(sh.getRange(12, 14, 3, 2))
        .setPosition(4, 7, 0, 0)
        .setOption('title', 'Conversions 60d: with vs without target')
        // Without setNumHeaders the header row is treated as a slice, which
        // shifts every slice color off by one (that's how a theme yellow
        // leaked in). 'slices' is what Sheets honours for pie colors; the
        // 'colors' array alone can be overridden by the sheet theme.
        .setNumHeaders(1)
        .setOption('colors', [COLORS.PRIMARY, COLORS.DARK])
        .setOption('slices', { 0: { color: COLORS.PRIMARY },
                               1: { color: COLORS.DARK } })
        .setOption('width', 300).setOption('height', 220)
        .setOption('legend', { position: 'bottom' })
        .build();
  });

  // ---- Weekly target-vs-actual section (interactive, formula-driven). ----
  // Ends around row 34; the campaign table starts below it.
  buildWeeklySection_(sh, primaryMetric, currency, weekly);

  // Camouflage the helper zone (cols M..X: pie tables, weekly chart table,
  // raw weekly rows, criteria cell). The chart sources must stay on THIS
  // sheet and unhidden - Sheets charts drop hidden rows/columns and ignore
  // ranges on other sheets - so the zone is made invisible instead: white
  // 6pt text in pencil-thin columns.
  sh.getRange(1, 13, Math.min(sh.getMaxRows(), 1000), 12)
      .setFontColor('#FFFFFF').setFontSize(6);
  sh.setColumnWidths(13, 12, 26);

  // ---- Full campaign table below the charts. ----
  var hdrRow = 36;
  var headers = ['Campaign', 'Bid Strategy', 'Target Type', 'Target',
                 'Actual 30d', 'Actual 14d', 'Actual 7d', 'Decay trend',
                 'Priority', 'Conv. goals (60d)'];
  sh.getRange(hdrRow, 1, 1, headers.length).setValues([headers]);
  headerBand_(sh, hdrRow, headers.length);

  var out = [];
  list.forEach(function(c) {
    out.push([
      c.name, prettyStrategy_(c), c.targetType,
      c.target != null ? round2_(c.target) : '',
      c.m30 != null ? round2_(c.m30) : '',
      c.m14 != null ? round2_(c.m14) : '',
      c.m7 != null ? round2_(c.m7) : '',
      c.trend != null ? c.trend : '',
      c.priority,
      c.goalsSummary
    ]);
  });
  if (out.length) {
    sh.getRange(hdrRow + 1, 1, out.length, headers.length).setValues(out);
    sh.getRange(hdrRow + 1, 4, out.length, 4).setNumberFormat('#,##0.00');
    sh.getRange(hdrRow + 1, 8, out.length, 1).setNumberFormat('0.0%');

    // Watercolour wash (full row for the actionable set, deeper when the
    // trend says "1 - Act now") and the trend-cell red/amber/green, built as
    // ONE 2D array and written with a single setBackgrounds call - per-cell
    // writes cost ~100ms each and dominate runtime on big accounts.
    var bg = list.map(function(c) {
      var wash = c.actionable
          ? (c.priority === '1 - Act now' ? '#B9F5FC' : '#E0FBFE')
          : null;
      var row = [];
      for (var k = 0; k < headers.length; k++) row.push(wash);
      // Column 8 = Decay trend: grey for no-target/low-spend/no-data rows,
      // red/amber/green against the campaign's OWN thresholds - hybrid
      // mixed-value campaigns carry a doubled bar (see deriveCampaign_).
      if (!c.hasTarget || !c.aboveFloor || c.trend == null) row[7] = COLORS.GREY;
      else if (c.trend <= c.actNowAt) row[7] = COLORS.RED;
      else if (c.trend <= c.watchAt) row[7] = COLORS.AMBER;
      else row[7] = COLORS.GREEN;
      return row;
    });
    sh.getRange(hdrRow + 1, 1, bg.length, headers.length).setBackgrounds(bg);
    tableStyle_(sh, hdrRow, 1, out.length + 1, headers.length);
  } else {
    sh.getRange(hdrRow + 1, 1).setValue('No enabled campaigns found in this account.');
  }

  // Compact method notes — the reference material lives here now rather than
  // on its own tab, to keep the workbook lean.
  var noteRow = hdrRow + out.length + 2;
  var notes = [
    'How to read this',
    'The change (support.google.com/google-ads/answer/17061251): from 17 Aug 2026, ' +
      'budget-limited campaigns with a tCPA/tROAS target bid to the STATED target, not the ' +
      'better number the algorithm was actually achieving. Re-anchor stale targets to 30d ' +
      'actuals before the date — the Actionable tab lists exactly those campaigns.',
    'Windowed ROAS/CPA are computed in-script from raw cost/value/conversions per window ' +
      '(no native windowed column exists). ROAS = value/cost; CPA = cost/conversions; ' +
      'blanks mean the denominator was zero.',
    'Gap vs Target is direction-aware: beating the target reads positive for both ROAS and ' +
      'CPA. Decay trend: negative always means deteriorating; normally 30d vs 7d, with Act ' +
      'now <= -20% and Watch <= -10%. Hybrid campaigns (Mixed-value goals flag) get a softer ' +
      'bar - measured 30d vs 14d with thresholds doubled (Act now <= -40%, Watch <= -20%) - ' +
      'because one high-AOV sale swings a short blended-ROAS window.',
    'Budget-limited via ' +
      (BUDGET_LIMITED_METHOD === 'primary_status_reasons'
        ? 'the platform\'s own status (primary_status_reasons: BUDGET_CONSTRAINED).'
        : 'derivation: 7d avg daily spend >= ' +
          Math.round(CONFIG.BUDGET_LIMITED_THRESHOLD * 100) +
          '% of daily budget (platform status field unavailable; shared budgets can be under-flagged).'),
    'The weekly chart covers targeted ' + primaryMetric + ' campaigns over the last 8 ' +
      'weeks (newest week may be partial). It is formula-driven: change the Campaign ' +
      'filter dropdown and the target, actual, decay trend line and est. decay/week all ' +
      'recompute live - no script re-run needed. Target is cost-weighted when viewing all ' +
      'campaigns. Charts are created once and then left alone on re-runs (data refreshes ' +
      'underneath), so manual styling in the chart editor sticks; delete a chart to have ' +
      'the script rebuild it.',
    'Scope: only campaigns that are currently enabled AND spent in the last 60 days are ' +
      'included. Paused, removed and zero-spend campaigns are ignored entirely.',
    'Mixed-value goals = 2+ PRIMARY conversion actions each recording a material share of ' +
      'value (>= 5% of the campaign\'s 60d value) - hybrid setups like online revenue ' +
      'alongside begin-checkout value. Windowed ROAS blends those values, so these campaigns ' +
      'get the softer decay bar above. Multi-goal = 2+ material primary actions counted but ' +
      'at most one records value - a deliberate, healthy setup on lead-gen accounts (a lead ' +
      'form can matter as much as a phone call when both are tracked properly); flagged for ' +
      'context only, standard bar, since blended CPA is still one consistent number. ' +
      'Secondary conversion actions never appear in these counts.',
    'Decay on low-spend campaigns (< ' + CONFIG.LOW_SPEND_FLOOR + ' ' + currency +
      ' over 60d) is volatile — shown for context, never flagged for action. All rollups are ' +
      'cost-weighted. The data cannot see: attribution lag, intended campaign role, whether a ' +
      'target was deliberate or inherited, or the promo calendar.'
  ];
  notes.forEach(function(n, i) {
    var cell = sh.getRange(noteRow + i, 1, 1, 9);
    cell.merge().setValue(n).setWrap(true).setFontSize(9)
        .setVerticalAlignment('middle')
        .setFontColor(i === 0 ? COLORS.NAVY : '#666666');
    if (i === 0) cell.setFontWeight('bold');
    else cell.setFontStyle('italic');
  });

  sh.setColumnWidths(1, 1, 280);
  sh.setColumnWidths(2, 8, 120);
  sh.setColumnWidths(10, 1, 190);
  finishSheet_(sh);
}

/**
 * Weekly target-vs-actual chart with a live campaign filter, kept on Summary.
 *
 * The script writes RAW per-campaign per-week rows to a helper area and
 * builds the chart's 4-column source table out of SUMIFS formulas that read
 * a dropdown cell — so the chart re-filters inside the sheet, no script
 * re-run needed:
 *   - dropdown B18: "All targeted campaigns" or any single targeted campaign;
 *   - Target line = cost-weighted stated target per week (sum(target*cost) /
 *     sum(cost) over the filtered rows);
 *   - Actual line = the metric recomputed per week from filtered raw sums;
 *   - Decay trend line = in-sheet linear fit (TREND) over the weekly actuals,
 *     recomputed live as the filter changes; the estimated decay per week
 *     next to the dropdown is SLOPE/AVERAGE, sign-flipped for CPA so that
 *     negative always means deteriorating.
 */
function buildWeeklySection_(sh, primaryMetric, currency, weekly) {
  title_(sh, 16, 'Targeted campaigns - weekly ' + primaryMetric +
         ': target vs actual (last 8 weeks)', 11);

  var weeks = weekly.weeks, raw = weekly.rows;
  if (!weeks.length) {
    sh.getRange(17, 1).setValue('No weekly data - no campaign carries a ' +
        primaryMetric + ' target.').setFontColor('#666666');
    return;
  }

  // --- Raw helper rows (col S..X): Week | Campaign | Cost | Value | Conv |
  // Target*Cost (pre-multiplied so the weighted target is a plain SUMIFS
  // ratio). ---
  var RAW_COL = 19; // S
  sh.getRange(16, RAW_COL).setValue('Chart data - do not edit')
      .setFontStyle('italic').setFontColor('#999999');
  sh.getRange(17, RAW_COL, 1, 6).setValues(
      [['Week', 'Campaign', 'Cost', 'Value', 'Conv', 'TargetXCost']]);
  var rawOut = raw.map(function(x) {
    return [x.week, x.name, x.cost, x.value, x.conv, x.target * x.cost];
  });
  sh.getRange(18, RAW_COL, rawOut.length, 6).setValues(rawOut);
  var rawA1 = function(colLetter) {
    return '$' + colLetter + '$18:$' + colLetter + '$' + (17 + rawOut.length);
  };

  // --- Filter dropdown + criteria cell. SUMIFS criteria "<>" matches every
  // non-blank campaign, which is how "All targeted campaigns" works. ---
  var names = {};
  raw.forEach(function(x) { names[x.name] = true; });
  var options = ['All targeted campaigns'].concat(Object.keys(names).sort());
  sh.getRange(18, 1).setValue('Campaign filter:').setFontWeight('bold');
  var dd = sh.getRange(18, 2, 1, 2).merge();
  dd.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(options, true).setAllowInvalid(false).build());
  dd.setValue(options[0]).setBackground('#E0FBFE');
  sh.getRange(17, 17).setFormula(  // Q17, hidden-in-plain-sight criteria
      '=IF($B$18="All targeted campaigns","<>",$B$18)')
      .setFontColor('#999999').setFontSize(8);

  // --- Chart source table (col M..R): wk# | Week | Target | Actual |
  // Gap vs target | Decay trend. The wk# column exists because Sheets does
  // not reliably expand ROW(range) into an array inside SLOPE/TREND — a real
  // index column makes the regression formulas dependable. ---
  var IDX_COL = 13; // M
  var TBL_COL = 14; // N
  var tblStart = 19;
  sh.getRange(18, IDX_COL, 1, 6).setValues(
      [['wk#', 'Week', 'Target', 'Actual', 'Gap vs target', 'Decay trend']]);
  var crit = ',' + rawA1('T') + ',$Q$17';
  var lastRow = tblStart + weeks.length - 1;
  var yA1 = '$P$' + tblStart + ':$P$' + lastRow;   // Actual column
  var xA1 = '$M$' + tblStart + ':$M$' + lastRow;   // wk# column
  // Values and formulas accumulated per row, then written in two batched
  // calls (setValues + setFormulas) instead of ~6 per-cell writes per week.
  var idxWeek = [];
  var formulas = [];
  weeks.forEach(function(w, i) {
    var row = tblStart + i;
    var wk = ',' + rawA1('S') + ',$N' + row;
    idxWeek.push([i + 1, w]);
    formulas.push([
      '=IFERROR(SUMIFS(' + rawA1('X') + wk + crit + ')/SUMIFS(' +
          rawA1('U') + wk + crit + '),"")',
      primaryMetric === 'ROAS'
          ? '=IFERROR(SUMIFS(' + rawA1('V') + wk + crit + ')/SUMIFS(' +
            rawA1('U') + wk + crit + '),"")'
          : '=IFERROR(SUMIFS(' + rawA1('U') + wk + crit + ')/SUMIFS(' +
            rawA1('W') + wk + crit + '),"")',
      // Gap vs target, same direction convention as every other tab: beating
      // the target reads positive for both ROAS and CPA.
      primaryMetric === 'ROAS'
          ? '=IFERROR(($P' + row + '-$O' + row + ')/$O' + row + ',"")'
          : '=IFERROR(($O' + row + '-$P' + row + ')/$O' + row + ',"")',
      '=IFERROR(TREND(' + yA1 + ',' + xA1 + ',$M' + row + '),"")'
    ]);
  });
  sh.getRange(tblStart, IDX_COL, idxWeek.length, 2).setValues(idxWeek);
  sh.getRange(tblStart, TBL_COL + 1, formulas.length, 4).setFormulas(formulas);
  sh.getRange(tblStart, TBL_COL + 1, weeks.length, 2)
      .setNumberFormat('#,##0.00');
  sh.getRange(tblStart, TBL_COL + 3, weeks.length, 1).setNumberFormat('0.0%');
  sh.getRange(tblStart, TBL_COL + 4, weeks.length, 1)
      .setNumberFormat('#,##0.00');

  // Estimated decay per week, live with the filter. CPA slope is inverted so
  // negative always reads "deteriorating".
  sh.getRange(18, 5, 1, 3).merge()
      .setValue('Est. decay per week (negative = deteriorating):')
      .setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange(18, 8).setFormula(
      '=IFERROR(' + (primaryMetric === 'CPA' ? '-' : '') + 'SLOPE(' + yA1 +
      ',' + xA1 + ')/AVERAGE(' + yA1 + '),"")')
      .setNumberFormat('0.0%').setFontWeight('bold')
      .setFontColor(COLORS.DARK).setBackground('#E0FBFE');

  var chartTitle = 'Weekly ' + primaryMetric +
      ' vs stated target - use the Campaign filter to drill in';
  insertChartSafe_(sh, chartTitle, function() {
    return sh.newChart().setChartType(Charts.ChartType.LINE)
        .addRange(sh.getRange(18, TBL_COL, weeks.length + 1, 1))
        .addRange(sh.getRange(18, TBL_COL + 1, weeks.length + 1, 4))
        // Without this the header row is charted as data and the legend
        // shows unnamed swatches.
        .setNumHeaders(1)
        .setPosition(19, 1, 0, 0)
        .setOption('title', chartTitle)
        .setOption('colors', [COLORS.DARK, COLORS.PRIMARY, COLORS.YELLOW,
                              '#9E9E9E'])
        .setOption('series', {
          0: { color: COLORS.DARK },                          // Target
          1: { color: COLORS.PRIMARY },                           // Actual
          // Gap % lives on the right-hand axis — it's a ratio, not a
          // ROAS/CPA level, so it can't share the left axis scale.
          2: { color: COLORS.YELLOW, targetAxisIndex: 1 },
          3: { color: '#9E9E9E', lineDashStyle: [2, 4] }       // Decay trend (dotted)
        })
        .setOption('vAxes', { 1: { format: 'percent' } })
        .setOption('width', 660).setOption('height', 320)
        .setOption('legend', { position: 'bottom' })
        .build();
  });
}

// ---------------------------------------------------------------------------
// TAB 2: ACTIONABLE
// ---------------------------------------------------------------------------
function buildActionableTab_(ss, list, primaryMetric, currency) {
  var sh = resetSheet_(ss, 'Actionable');
  title_(sh, 1, 'Actionable - campaigns whose target should move', 12);
  subtitle_(sh, 2, 'Filter: carries a target, 60d cost >= ' +
      CONFIG.LOW_SPEND_FLOOR + ' ' + currency +
      ', and |gap| > 20% or decay past its bar (<= -20% vs 7d; hybrid ' +
      'mixed-value campaigns <= -40% vs 14d). Ordered by 60d cost. ' +
      '"Before 17 Aug" rows are budget-limited: from that date they bid to the ' +
      'stated target instead of the level actually being achieved, so a stale ' +
      'target starts steering real spend. Proposed Target is seeded at the 30d ' +
      'actual - edit freely; Wk1-3 and Status are yours for manual tracking.');

  var headers = ['Campaign', 'Target', 'Actual 30d', 'Gap', 'Timing',
                 'Proposed Target', 'Wk1', 'Wk2', 'Wk3', 'Status', 'Commentary'];
  sh.getRange(3, 1, 1, headers.length).setValues([headers]);
  headerBand_(sh, 3, headers.length);

  var rows = list.filter(function(c) { return c.actionable; });
  var out = rows.map(function(c) {
    return [
      c.name,
      round2_(c.target),
      c.m30 != null ? round2_(c.m30) : '',
      c.gap != null ? c.gap : '',
      // Budget-limited campaigns behave differently once target-based bidding
      // changes on 17 Aug 2026 — move those first.
      c.budgetLimited ? 'Before 17 Aug' : 'After 17 Aug',
      c.m30 != null ? round2_(c.m30) : '',
      '', '', '', '',
      actionCommentary_(c)
    ];
  });
  if (out.length) {
    sh.getRange(4, 1, out.length, headers.length).setValues(out);
    sh.getRange(4, 4, out.length, 1).setNumberFormat('0.0%');
    sh.getRange(4, 2, out.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(4, 3, out.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(4, 6, out.length, 1).setNumberFormat('#,##0.00');
    tableStyle_(sh, 3, 1, out.length + 1, headers.length);
  } else {
    sh.getRange(4, 1).setValue('Nothing actionable right now - no targeted, ' +
        'above-floor campaign is >20% off target or decaying >=20%.');
  }

  sh.setColumnWidths(1, 1, 280);
  sh.setColumnWidths(2, 9, 105);
  sh.setColumnWidths(11, 1, 420);
  sh.getRange(4, 11, Math.max(out.length, 1), 1).setWrap(true);
  finishSheet_(sh);
}

function actionCommentary_(c) {
  var parts = [];
  var metric = c.targetType;
  if (c.gap != null) {
    var pct = Math.round(Math.abs(c.gap) * 100);
    if (c.gap > 0.20) {
      // The exact case the 17 Aug change bites: the stated target is looser
      // than reality, and enforcement will pull performance back toward it.
      parts.push('Beating ' + metric + ' target by ' + pct + '% over 30d - ' +
                 'stated target is stale' +
                 (c.budgetLimited
                   ? ' and from 17 Aug bidding chases the stated number, so ' +
                     'tighten it to the 30d actual or expect efficiency to ' +
                     'drift back to the looser target'
                   : '; tighten toward the 30d actual'));
    } else if (c.gap < -0.20) {
      parts.push('Missing ' + metric + ' target by ' + pct + '% over 30d - ' +
                 'target is stricter than reality; decide whether to relax it ' +
                 'to the 30d actual or fix the campaign first');
    } else {
      parts.push('Within ' + pct + '% of ' + metric + ' target over 30d');
    }
  }
  if (c.trend != null && c.trend <= c.actNowAt) {
    parts.push('decaying ' + Math.round(Math.abs(c.trend) * 100) +
               '% (' + c.trendWindow + ' vs 30d' +
               (c.multiValueGoal ? ', past the softer hybrid bar' : '') + ')');
  }
  if (c.portfolio) {
    parts.push('portfolio strategy "' + c.portfolioName +
               '" - target sits at strategy level and needs unpicking before ' +
               'a per-campaign change');
  }
  if (c.budgetLimited) {
    parts.push('budget-limited: in the directly-affected set for 17 Aug');
  }
  // Hybrid-account side note: when bidding chases several goals the windowed
  // ROAS/CPA blends them, so the target maths reads differently.
  if (c.multiValueGoal) {
    parts.push('NOTE: optimises toward ' + c.valueGoalCount +
               ' value-recording goals (' + c.goalsDetail + ') - windowed ' +
               'ROAS blends their values, so judge the target against the ' +
               'blended value, not sales revenue alone');
  } else if (c.multiGoal) {
    parts.push('NOTE: optimises toward ' + c.goalCount +
               ' conversion goals (' + c.goalsDetail + ') - CPA blends them, ' +
               'which is fine when deliberate (e.g. lead form + phone call ' +
               'tracked as equals)');
  }
  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// TAB 3: CHANGE IMPACT
// ---------------------------------------------------------------------------
/**
 * Daily & weekly target-vs-actual charts sharing one campaign dropdown, on
 * the same live-SUMIFS pattern as the Summary weekly section: raw
 * per-campaign rows sit camouflaged at the far right and the chart source
 * tables recompute as the filter changes.
 *
 * Change tracking (CONFIG.TRACK_CHANGES, off by default) additionally pulls
 * the account's change log, marks change days/weeks as yellow dots pinned to
 * the Actual line, and lists every change (newest first) with old -> new
 * values, 7-day before/after performance and a direction-aware Impact %.
 * The change log API only exposes the last 30 days, so each run's pull is
 * merged into a JSON archive camouflaged on the sheet (col AU).
 *
 * Helper zone geometry (headers row 2, data from row 3):
 *   P1      filter criteria cell
 *   Q..W    daily raw rows   (Date|Campaign|Cost|Value|Conv|TargetXCost|TCost)
 *   Y..AE   weekly raw rows  (Week|Campaign|Cost|Value|Conv|TargetXCost|TCost)
 *   AG..AI  change rows      (Date|Campaign|Week)      [tracking only]
 *   AK..AN  daily chart source  (Date|Target|Actual[|Change])
 *   AP..AS  weekly chart source (Week|Target|Actual[|Change])
 *   AU      change archive (one JSON record per row)   [tracking only]
 */
function buildChangeImpactTab_(ss, list, primaryMetric, currency, daily,
                               weeklyAll, changes, changesError) {
  var track = !!CONFIG.TRACK_CHANGES;

  // Read the archive BEFORE resetting the sheet, then fold this run's fresh
  // pull into it - tracking mode only.
  var archive = track ? readChangeArchive_(ss) : [];
  var sh = resetSheet_(ss, 'Change Impact');
  changes = track ? mergeChanges_(changes, archive) : [];

  title_(sh, 1, track
      ? 'Change Impact - budget & bid strategy changes vs performance'
      : 'Targets vs Actuals - daily & weekly ' + primaryMetric, 12);
  subtitle_(sh, 2, track
      ? ('Charts: navy = current stated target (cost-weighted), light blue ' +
         '= actual ' + primaryMetric + ', yellow dots = days/weeks with a ' +
         'budget or bid strategy change for the filtered campaign(s). ' +
         'Table: every change this sheet has ever seen, with performance 7 ' +
         'days before vs after - fresh pulls reach back ' +
         daily.dates.length + ' days (the API keeps only 30) and are ' +
         'archived in the sheet across runs. All money in ' + currency +
         '. | script ' + SCRIPT_VERSION)
      : ('Navy = current stated target (cost-weighted across the filtered ' +
         'campaigns), light blue = actual ' + primaryMetric + '. Use the ' +
         'Campaign filter to drill into any single campaign - both charts ' +
         'recompute live, no script re-run needed. All money in ' +
         currency + '. | script ' + SCRIPT_VERSION));

  if (!daily.rows.length) {
    sh.getRange(4, 1).setValue('No daily performance data available for ' +
        'this window - charts need spend to plot.')
        .setFontColor('#666666');
    if (track) writeChangeArchive_(sh, changes); // resetSheet_ wiped it
    finishSheet_(sh);
    return;
  }

  // The daily raw block (campaigns x days) can outgrow a default 1000-row
  // sheet on big accounts.
  var needRows = Math.max(daily.rows.length + 2, weeklyAll.rows.length + 2,
                          changes.length + 40, 120);
  if (sh.getMaxRows() < needRows) {
    sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
  }

  // ---- Campaign filter dropdown driving both charts. ----
  var names = {};
  daily.rows.forEach(function(x) { names[x.name] = true; });
  var options = ['All campaigns'].concat(Object.keys(names).sort());
  sh.getRange(3, 1).setValue('Campaign filter:').setFontWeight('bold');
  var dd = sh.getRange(3, 2, 1, 3).merge();
  dd.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(options, true).setAllowInvalid(false).build());
  dd.setValue(options[0]).setBackground('#E0FBFE');
  // P1: SUMIFS/COUNTIFS criteria - "<>" matches every non-blank campaign,
  // which is how "All campaigns" works.
  sh.getRange(1, 16).setFormula(
      '=IF($B$3="All campaigns","<>",$B$3)');

  // ---- Raw helper rows. ----
  sh.getRange(2, 17, 1, 7).setValues(
      [['Date', 'Campaign', 'Cost', 'Value', 'Conv', 'TargetXCost', 'TCost']]);
  var dOut = daily.rows.map(function(x) {
    return [x.date, x.name, x.cost, x.value, x.conv,
            x.target * x.cost, x.target > 0 ? x.cost : 0];
  });
  sh.getRange(3, 17, dOut.length, 7).setValues(dOut);

  sh.getRange(2, 25, 1, 7).setValues(
      [['Week', 'Campaign', 'Cost', 'Value', 'Conv', 'TargetXCost', 'TCost']]);
  if (weeklyAll.rows.length) {
    var wOut = weeklyAll.rows.map(function(x) {
      return [x.week, x.name, x.cost, x.value, x.conv,
              x.target * x.cost, x.target > 0 ? x.cost : 0];
    });
    sh.getRange(3, 25, wOut.length, 7).setValues(wOut);
  }

  if (track) {
    sh.getRange(2, 33, 1, 3).setValues([['Date', 'Campaign', 'Week']]);
    if (changes.length) {
      var cOut = changes.map(function(g) {
        return [g.date, g.label, weekMondayOf_(g.date)];
      });
      sh.getRange(3, 33, cOut.length, 3).setValues(cOut);
    }
  }

  var dEnd = 2 + dOut.length;
  var wEnd = 2 + Math.max(weeklyAll.rows.length, 1);
  var cEnd = 2 + Math.max(changes.length, 1);
  function dR(col) { return '$' + col + '$3:$' + col + '$' + dEnd; }
  function wR(col) { return '$' + col + '$3:$' + col + '$' + wEnd; }
  function cR(col) { return '$' + col + '$3:$' + col + '$' + cEnd; }

  // ---- Daily chart source (AK..AN): Target = weighted stated target over
  // the filtered rows; Actual = the metric recomputed per day; Change (only
  // with tracking on) = the Actual value on days the change log has an
  // entry, so it plots as isolated dots on the line. ----
  var srcCols = track ? 4 : 3;
  sh.getRange(2, 37, 1, srcCols).setValues([track
      ? ['Date', 'Target', 'Actual', 'Change']
      : ['Date', 'Target', 'Actual']]);
  var dDates = [], dFormulas = [];
  daily.dates.forEach(function(d, i) {
    var row = 3 + i;
    var k = ',' + dR('Q') + ',$AK' + row + ',' + dR('R') + ',$P$1';
    dDates.push([d]);
    var f = [
      '=IFERROR(SUMIFS(' + dR('V') + k + ')/SUMIFS(' + dR('W') + k + '),"")',
      primaryMetric === 'ROAS'
          ? '=IFERROR(SUMIFS(' + dR('T') + k + ')/SUMIFS(' + dR('S') + k +
            '),"")'
          : '=IFERROR(SUMIFS(' + dR('S') + k + ')/SUMIFS(' + dR('U') + k +
            '),"")'
    ];
    if (track) {
      f.push('=IF(AND($AM' + row + '<>"",COUNTIFS(' + cR('AG') + ',$AK' +
          row + ',' + cR('AH') + ',$P$1)>0),$AM' + row + ',"")');
    }
    dFormulas.push(f);
  });
  sh.getRange(3, 37, dDates.length, 1).setValues(dDates);
  sh.getRange(3, 38, dFormulas.length, srcCols - 1).setFormulas(dFormulas);
  sh.getRange(3, 38, dDates.length, srcCols - 1).setNumberFormat('#,##0.00');

  // ---- Weekly chart source (AP..AS), same construction per week. ----
  sh.getRange(2, 42, 1, srcCols).setValues([track
      ? ['Week', 'Target', 'Actual', 'Change']
      : ['Week', 'Target', 'Actual']]);
  var weeks = weeklyAll.weeks;
  if (weeks.length) {
    var wWeeks = [], wFormulas = [];
    weeks.forEach(function(w, i) {
      var row = 3 + i;
      var k = ',' + wR('Y') + ',$AP' + row + ',' + wR('Z') + ',$P$1';
      wWeeks.push([w]);
      var f = [
        '=IFERROR(SUMIFS(' + wR('AD') + k + ')/SUMIFS(' + wR('AE') + k +
            '),"")',
        primaryMetric === 'ROAS'
            ? '=IFERROR(SUMIFS(' + wR('AB') + k + ')/SUMIFS(' + wR('AA') + k +
              '),"")'
            : '=IFERROR(SUMIFS(' + wR('AA') + k + ')/SUMIFS(' + wR('AC') + k +
              '),"")'
      ];
      if (track) {
        f.push('=IF(AND($AR' + row + '<>"",COUNTIFS(' + cR('AI') + ',$AP' +
            row + ',' + cR('AH') + ',$P$1)>0),$AR' + row + ',"")');
      }
      wFormulas.push(f);
    });
    sh.getRange(3, 42, wWeeks.length, 1).setValues(wWeeks);
    sh.getRange(3, 43, wFormulas.length, srcCols - 1).setFormulas(wFormulas);
    sh.getRange(3, 43, wWeeks.length, srcCols - 1).setNumberFormat('#,##0.00');
  }

  // ---- The two charts, side by side. Titles differ per mode, and swapping
  // TRACK_CHANGES must not leave the other mode's charts behind. ----
  var dailyTitle = track
      ? 'Daily ' + primaryMetric + ' vs target - change days marked'
      : 'Daily ' + primaryMetric + ' vs target';
  var weeklyTitle = track
      ? 'Weekly ' + primaryMetric +
        ' vs target - change weeks marked (last 8 weeks)'
      : 'Weekly ' + primaryMetric + ' vs target (last 8 weeks)';
  removeChartsByTitle_(sh, track
      ? ['Daily ' + primaryMetric + ' vs target',
         'Weekly ' + primaryMetric + ' vs target (last 8 weeks)']
      : ['Daily ' + primaryMetric + ' vs target - change days marked',
         'Weekly ' + primaryMetric +
         ' vs target - change weeks marked (last 8 weeks)']);
  var seriesOpt = track
      ? { 0: { color: COLORS.DARK },
          1: { color: COLORS.PRIMARY },
          // Change days as isolated dots pinned to the Actual line.
          2: { color: COLORS.YELLOW, lineWidth: 0, pointSize: 8 } }
      : { 0: { color: COLORS.DARK }, 1: { color: COLORS.PRIMARY } };
  var colorsOpt = track
      ? [COLORS.DARK, COLORS.PRIMARY, COLORS.YELLOW]
      : [COLORS.DARK, COLORS.PRIMARY];
  insertChartSafe_(sh, dailyTitle, function() {
    return sh.newChart().setChartType(Charts.ChartType.LINE)
        .addRange(sh.getRange(2, 37, daily.dates.length + 1, srcCols))
        // Without this the header row is charted as data and the legend
        // shows unnamed swatches.
        .setNumHeaders(1)
        .setPosition(5, 1, 0, 0)
        .setOption('title', dailyTitle)
        .setOption('colors', colorsOpt)
        .setOption('series', seriesOpt)
        .setOption('width', 640).setOption('height', 320)
        .setOption('legend', { position: 'bottom' })
        .build();
  });
  if (weeks.length) {
    insertChartSafe_(sh, weeklyTitle, function() {
      return sh.newChart().setChartType(Charts.ChartType.LINE)
          .addRange(sh.getRange(2, 42, weeks.length + 1, srcCols))
          .setNumHeaders(1)
          .setPosition(5, 7, 0, 0)
          .setOption('title', weeklyTitle)
          .setOption('colors', colorsOpt)
          .setOption('series', seriesOpt)
          .setOption('width', 640).setOption('height', 320)
          .setOption('legend', { position: 'bottom' })
          .build();
    });
  }

  // ---- Change history table (tracking mode only). ----
  var TBL = 23;
  var noteRow = TBL;
  if (track) {
    title_(sh, TBL - 1,
           'Change history - budgets & bid strategies, newest first', 11);
    var headers = ['Date', 'Time', 'Campaign', 'Change', 'Old value',
                   'New value', 'Change %', 'Cost/day 7d before',
                   'Cost/day 7d after', 'Metric', '7d before', '7d after',
                   'Impact', 'Changed by'];
    sh.getRange(TBL, 1, 1, headers.length).setValues([headers]);
    headerBand_(sh, TBL, headers.length);

    if (!changes.length) {
      var emptyMsg;
      if (changesError) {
        emptyMsg = 'Change history unavailable this run: ' + changesError;
      } else if (CHANGE_PULL_STATS.rows > 0) {
        // Self-diagnosis: events came back but none matched - print what
        // they were so the gap can be identified from the sheet alone.
        emptyMsg = CHANGE_PULL_STATS.rows + ' change events were pulled in ' +
            'the last ' + daily.dates.length + ' days but none carried ' +
            'budget/bidding fields. Samples (type:operation:changed_fields): ' +
            CHANGE_PULL_STATS.samples.join('   |   ');
      } else {
        emptyMsg = 'No budget or bid strategy changes recorded in the last ' +
            daily.dates.length + ' days.';
      }
      sh.getRange(TBL + 1, 1, 1, headers.length).merge().setValue(emptyMsg)
          .setFontColor('#666666').setFontStyle('italic').setWrap(true);
      noteRow = TBL + 4;
    } else {
      var byCamp = {};
      daily.rows.forEach(function(x) {
        (byCamp[x.id] = byCamp[x.id] || {})[x.date] = x;
      });
      var cmap = {};
      list.forEach(function(c) { cmap[c.id] = c; });
      function spanTotals(id, startIso, days) {
        var t = { cost: 0, value: 0, conv: 0 };
        for (var i = 0; i < days; i++) {
          var x = (byCamp[id] || {})[shiftDays_(startIso, i)];
          if (x) { t.cost += x.cost; t.value += x.value; t.conv += x.conv; }
        }
        return t;
      }

      var out = changes.map(function(g) {
        var c = g.campId ? cmap[g.campId] : null;
        var costB = '', costA = '', mB = '', mA = '', impact = '', mType = '';
        if (c) mType = c.metricType;
        if (c && g.date >= daily.start) {
          // Before: the 7 days up to and excluding the change day, clipped
          // to the data window; After: the 7 days from the day following
          // the change, clipped to yesterday. ISO strings compare lexically.
          var bStart = shiftDays_(g.date, -7);
          if (bStart < daily.start) bStart = daily.start;
          var bEnd = shiftDays_(g.date, -1);
          var bDays = bEnd >= bStart ? daysBetween_(bStart, bEnd) + 1 : 0;
          var aStart = shiftDays_(g.date, 1);
          var aEnd = shiftDays_(g.date, 7);
          if (aEnd > daily.end) aEnd = daily.end;
          var aDays = aEnd >= aStart ? daysBetween_(aStart, aEnd) + 1 : 0;

          if (bDays >= 3) {
            var b = spanTotals(c.id, bStart, bDays);
            costB = round2_(b.cost / bDays);
            var mBv = metricOf_(b, mType);
            if (mBv != null) mB = round2_(mBv);
          }
          if (aDays > 0) {
            var a = spanTotals(c.id, aStart, aDays);
            costA = round2_(a.cost / aDays);
            if (aDays >= 3) {
              var mAv = metricOf_(a, mType);
              if (mAv != null) mA = round2_(mAv);
            }
          }
          if (aDays < 3) {
            impact = 'Too early (' + aDays + 'd after)';
          } else if (mB !== '' && mB !== 0 && mA !== '') {
            impact = mType === 'ROAS' ? (mA - mB) / mB : (mB - mA) / mB;
          }
          // Carried into the sheet archive so the numbers survive once the
          // change scrolls out of the daily window.
          g.saved = { costB: costB, costA: costA, mB: mB, mA: mA,
                      impact: impact };
        } else if (g.saved) {
          // Older than the daily window: reuse the values computed while
          // the change was fresh.
          costB = g.saved.costB != null ? g.saved.costB : '';
          costA = g.saved.costA != null ? g.saved.costA : '';
          mB = g.saved.mB != null ? g.saved.mB : '';
          mA = g.saved.mA != null ? g.saved.mA : '';
          impact = g.saved.impact != null ? g.saved.impact : '';
        }
        var pct = '';
        if (g.numeric && typeof g.old === 'number' &&
            typeof g.nw === 'number' && g.old > 0) {
          pct = (g.nw - g.old) / g.old;
        }
        return [g.date, g.time, g.label, g.what,
                g.numeric && g.old !== '' ? round2_(g.old) : g.old,
                g.numeric && g.nw !== '' ? round2_(g.nw) : g.nw,
                pct, costB, costA, mType, mB, mA, impact, g.who];
      });
      sh.getRange(TBL + 1, 1, out.length, headers.length).setValues(out);
      sh.getRange(TBL + 1, 5, out.length, 2).setNumberFormat('#,##0.00');
      sh.getRange(TBL + 1, 7, out.length, 1).setNumberFormat('0.0%');
      sh.getRange(TBL + 1, 8, out.length, 2).setNumberFormat('#,##0.00');
      sh.getRange(TBL + 1, 11, out.length, 2).setNumberFormat('#,##0.00');
      sh.getRange(TBL + 1, 13, out.length, 1).setNumberFormat('0.0%');

      // Impact cell wash: red = deteriorated >=10%, green = improved >=10%,
      // grey = not yet measurable. One batched setBackgrounds call.
      var bg = out.map(function(rowVals) {
        var row = [];
        for (var k2 = 0; k2 < headers.length; k2++) row.push(null);
        var imp = rowVals[12];
        if (typeof imp === 'number') {
          row[12] = imp <= -0.10 ? COLORS.RED
                  : imp >= 0.10 ? COLORS.GREEN : null;
        } else if (imp) {
          row[12] = COLORS.GREY;
        }
        return row;
      });
      sh.getRange(TBL + 1, 1, bg.length, headers.length).setBackgrounds(bg);
      tableStyle_(sh, TBL, 1, out.length + 1, headers.length);
      noteRow = TBL + out.length + 2;
    }
    writeChangeArchive_(sh, changes);
  }

  var notes;
  if (track) {
    notes = [
      'How to read this',
      'Change history comes from the account\'s own change log ' +
        '(change_event). Google only exposes the last 30 days, so anything ' +
        'changed before this script\'s first run is unrecoverable - but ' +
        'every pull is archived inside this sheet and merged on each run, ' +
        'so the table and chart markers accumulate history from here on ' +
        '(capped at the 400 most recent). Today\'s changes appear ' +
        'immediately (metrics run to yesterday, so their impact reads ' +
        '"Too early").',
      'Impact is direction-aware: positive = improved (ROAS up, CPA down), ' +
        'comparing the 7 days after the change (excluding the change day) ' +
        'to the 7 days before. It needs at least 3 days of data each side; ' +
        'red <= -10%, green >= +10%. The after-window also contains ' +
        'whatever else happened that week - seasonality, promos, other ' +
        'changes - so read it as "what happened next", not proof of cause.',
      'Both charts recompute live from the Campaign filter dropdown - no ' +
        'script re-run needed. The target line is the CURRENT stated ' +
        'target (cost-weighted across filtered campaigns); past target ' +
        'changes show as dots, not as steps in the line. Campaigns without ' +
        'a target plot an actual line only.',
      'To filter the TABLE by campaign use Data > Create a filter view (a ' +
        'plain filter hides rows, which would blank the charts\' ' +
        'camouflaged source data sitting on the same rows).',
      'Coverage: campaign target/strategy edits, budget amounts and bid ' +
        'adjustments (platform/device/schedule criteria). Blind spot: a ' +
        'target moved at PORTFOLIO strategy level never appears in ' +
        'Google\'s change log (attaching/detaching a campaign to a ' +
        'portfolio does) - note those manually or move targets to campaign ' +
        'level. Shared-budget changes may not attribute to a single ' +
        'campaign. Bid adjustment values are multipliers: 1.1 = +10%, ' +
        '0 = -100%.'
    ];
    if (changesError && changes.length) {
      notes.splice(1, 0, 'This run could not pull fresh changes (' +
          changesError + ') - the table shows previously archived history ' +
          'only.');
    }
  } else {
    notes = [
      'How to read this',
      'Both charts recompute live from the Campaign filter dropdown - no ' +
        'script re-run needed. The target line is the CURRENT stated ' +
        'target (cost-weighted across the filtered campaigns); campaigns ' +
        'without a target plot an actual line only. The daily chart covers ' +
        'the last ' + daily.dates.length + ' days, the weekly chart the ' +
        'last 8 weeks, both ending yesterday.',
      'Change tracking is off (CONFIG.TRACK_CHANGES: false). Flip it to ' +
        'true to add the budget/bid-strategy change log: a change-history ' +
        'table with before/after impact plus yellow change-day dots on ' +
        'these charts.'
    ];
  }
  notes.forEach(function(n, i) {
    var cell = sh.getRange(noteRow + i, 1, 1, 14);
    cell.merge().setValue(n).setWrap(true).setFontSize(9)
        .setVerticalAlignment('middle')
        .setFontColor(i === 0 ? COLORS.NAVY : '#666666');
    if (i === 0) cell.setFontWeight('bold');
    else cell.setFontStyle('italic');
  });

  // Camouflage the helper zone (cols P..AS) - same arrangement as Summary:
  // sources must stay on this sheet and unhidden, so they go white 6pt in
  // pencil-thin columns instead.
  sh.getRange(1, 16, Math.min(sh.getMaxRows(), Math.max(needRows, 1000)), 32)
      .setFontColor('#FFFFFF').setFontSize(6);
  sh.setColumnWidths(16, 32, 26);

  sh.setColumnWidths(1, 1, 90);   // Date
  sh.setColumnWidths(2, 1, 55);   // Time
  sh.setColumnWidths(3, 1, 280);  // Campaign
  sh.setColumnWidths(4, 1, 150);  // Change
  sh.setColumnWidths(5, 2, 110);  // Old / New value
  sh.setColumnWidths(7, 1, 85);   // Change %
  sh.setColumnWidths(8, 2, 120);  // Cost/day before / after
  sh.setColumnWidths(10, 1, 65);  // Metric
  sh.setColumnWidths(11, 2, 90);  // 7d before / after
  sh.setColumnWidths(13, 1, 85);  // Impact
  sh.setColumnWidths(14, 1, 180); // Changed by
  finishSheet_(sh);
}

// Remove charts whose exact title is in the list - used when TRACK_CHANGES
// flips, so the tab never carries both modes' charts at once.
function removeChartsByTitle_(sh, titles) {
  try {
    sh.getCharts().forEach(function(ch) {
      var t = '';
      try { t = ch.getOptions().get('title'); } catch (ignored) {}
      if (titles.indexOf(t) !== -1) sh.removeChart(ch);
    });
  } catch (e) {
    Logger.log('Chart cleanup skipped: ' + e);
  }
}

// ---------------------------------------------------------------------------
// TAB 4: CAMPAIGN DATA
// ---------------------------------------------------------------------------
function buildCampaignDataTab_(ss, list, primaryMetric, currency, totalCost) {
  var sh = resetSheet_(ss, 'Campaign Data');
  title_(sh, 1, 'Campaign Data - all raw and computed fields', 12);

  var headers = ['Campaign', 'Campaign ID', 'Bid Strategy', 'Portfolio',
                 'Target Type', 'Target', 'Budget-limited', 'Cost 60d',
                 '% of Spend', 'Metric', 'ROAS/CPA 60d', 'ROAS/CPA 30d',
                 'ROAS/CPA 14d', 'ROAS/CPA 7d', 'Gap vs Target',
                 'Decay trend', 'Segment', 'Flag', 'Conv. goals (60d)'];
  sh.getRange(2, 1, 1, headers.length).setValues([headers]);
  headerBand_(sh, 2, headers.length);

  var out = list.map(function(c) {
    return [
      c.name, c.id, prettyStrategy_(c), c.portfolio ? 'Yes' : 'No',
      c.targetType, c.target != null ? round2_(c.target) : '',
      c.budgetLimited ? 'Yes' : 'No',
      Math.round(c.base.cost),
      c.pctSpend,
      c.metricType,
      c.m60 != null ? round2_(c.m60) : '',
      c.m30 != null ? round2_(c.m30) : '',
      c.m14 != null ? round2_(c.m14) : '',
      c.m7 != null ? round2_(c.m7) : '',
      c.gap != null ? c.gap : '',
      c.trend != null ? c.trend : '',
      c.segment, c.flag,
      c.goalCount ? c.goalsDetail : '-'
    ];
  });
  if (out.length) {
    sh.getRange(3, 1, out.length, headers.length).setValues(out);
    sh.getRange(3, 8, out.length, 1).setNumberFormat('#,##0');
    sh.getRange(3, 9, out.length, 1).setNumberFormat('0.0%');
    sh.getRange(3, 11, out.length, 4).setNumberFormat('#,##0.00');
    sh.getRange(3, 15, out.length, 2).setNumberFormat('0.0%');

    // Full-row watercolour wash on campaigns that need acting on, so they
    // jump out of a long list. Soft blue for the actionable set (the same
    // campaigns that appear on the Actionable tab), deepening slightly when
    // the trend also says "1 - Act now". One batched setBackgrounds call,
    // not per-row writes.
    var bg = list.map(function(c) {
      var wash = c.actionable
          ? (c.priority === '1 - Act now' ? '#B9F5FC' : '#E0FBFE')
          : null;
      var row = [];
      for (var k = 0; k < headers.length; k++) row.push(wash);
      return row;
    });
    sh.getRange(3, 1, bg.length, headers.length).setBackgrounds(bg);

    tableStyle_(sh, 2, 1, out.length + 1, headers.length);
  } else {
    sh.getRange(3, 1).setValue('No enabled campaigns found.');
  }

  sh.setFrozenRows(2);
  sh.setFrozenColumns(1);
  sh.setColumnWidths(1, 1, 280);
  sh.setColumnWidths(2, 17, 110);
  sh.setColumnWidths(19, 1, 280);
  sh.getRange(3, 19, Math.max(out.length, 1), 1).setWrap(true);
  finishSheet_(sh);
}

// ---------------------------------------------------------------------------
// SPREADSHEET / FORMATTING HELPERS
// ---------------------------------------------------------------------------
function openOrCreateSpreadsheet_(account, ranges) {
  if (CONFIG.SPREADSHEET_URL) {
    return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  }
  var ss = SpreadsheetApp.create('Bid Strategy Audit - ' + account.getName() +
                                 ' - ' + ranges.base.end);
  Logger.log('Created new spreadsheet: ' + ss.getUrl());
  return ss;
}

function resetSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  } else {
    // Deliberately does NOT remove charts: they point at fixed cell ranges
    // that each run rewrites in place, so existing charts stay live AND any
    // manual styling done in the chart editor survives re-runs. Delete a
    // chart by hand to have the script recreate it fresh.
    sh.clear();
    sh.setFrozenRows(0);
    sh.setFrozenColumns(0);
  }
  return sh;
}

function orderTabs_(ss) {
  // Clean up the helper tab a since-reverted version created (chart sources
  // can't live on another sheet - script-built charts come out empty).
  var stale = ss.getSheetByName('Audit Data (auto)');
  if (stale) ss.deleteSheet(stale);

  TAB_ORDER.forEach(function(name, i) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
  // Drop the default empty tab if we created the file this run.
  var d = ss.getSheetByName('Sheet1');
  if (d && d.getLastRow() === 0 && ss.getSheets().length > TAB_ORDER.length) {
    ss.deleteSheet(d);
  }
  ss.setActiveSheet(ss.getSheetByName(TAB_ORDER[0]));
}

function title_(sh, row, text, size) {
  sh.getRange(row, 1).setValue(text).setFontColor(COLORS.NAVY)
      .setFontWeight('bold').setFontSize(size || 12);
}

function subtitle_(sh, row, text) {
  sh.getRange(row, 1).setValue(text).setFontColor('#666666').setFontSize(9);
}

function headerBand_(sh, row, ncols) {
  sh.getRange(row, 1, 1, ncols).setBackground(COLORS.PRIMARY)
      .setFontColor(COLORS.DARK).setFontWeight('bold');
}

// Shared table finish: light grey borders all round + vertical centring, so
// wrapped cells never leave neighbours pinned to the top or bottom.
function tableStyle_(sh, row, col, numRows, numCols) {
  sh.getRange(row, col, numRows, numCols)
      .setBorder(true, true, true, true, true, true, COLORS.BORDER,
                 SpreadsheetApp.BorderStyle.SOLID)
      .setVerticalAlignment('middle');
}

function finishSheet_(sh) {
  sh.setHiddenGridlines(true);
  var rows = Math.min(sh.getMaxRows(), Math.max(sh.getLastRow() + 20, 50));
  sh.getRange(1, 1, rows, sh.getMaxColumns()).setFontFamily('Arial');
}

// Insert a chart only if one with the same title isn't already on the sheet
// (so re-runs refresh the data underneath but never duplicate charts or wipe
// manual styling). Degrades gracefully: if the Charts service misbehaves the
// run keeps its tables and logs a warning instead of dying.
function insertChartSafe_(sh, title, buildFn) {
  try {
    var charts = sh.getCharts();
    for (var i = 0; i < charts.length; i++) {
      var t = '';
      try { t = charts[i].getOptions().get('title'); } catch (ignored) {}
      if (t === title) {
        // Self-heal: a chart that lost its data ranges (e.g. built by an
        // older script version against ranges that no longer exist) renders
        // as "Add a series..." - remove it and rebuild below.
        var broken = false;
        try { broken = charts[i].getRanges().length === 0; } catch (ig2) {}
        if (broken) {
          sh.removeChart(charts[i]);
          break;
        }
        return; // healthy - keep it, along with any manual styling
      }
    }
    sh.insertChart(buildFn());
  } catch (e) {
    Logger.log('Chart skipped on "' + sh.getName() + '": ' + e);
  }
}

// ---------------------------------------------------------------------------
// SMALL UTILITIES
// ---------------------------------------------------------------------------
function num_(v) {
  var n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

// Micros -> currency units. Raw micros are never printed.
function micros_(v) {
  return num_(v) / 1e6;
}

function round2_(v) {
  return Math.round(v * 100) / 100;
}

// Change Impact window: capped at 29 days because the change log
// (change_event) only retains 30 days of history.
function changeWindowDays_() {
  return Math.max(7, Math.min(CONFIG.CHANGE_LOOKBACK_DAYS || 28, 29));
}

// Monday of the week containing the date - matches segments.week bucketing,
// so in-sheet change markers line up with the weekly rows.
function weekMondayOf_(isoDate) {
  var d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function daysBetween_(startIso, endIso) {
  return Math.round((new Date(endIso + 'T12:00:00Z') -
                     new Date(startIso + 'T12:00:00Z')) / 86400000);
}

function safeJson_(v) {
  try {
    var o = JSON.parse(String(v || ''));
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

// Walk a parsed proto by snake_case path, accepting camelCase keys too (the
// serialisation of change_event old/new resources differs between runtimes).
function protoGet_(obj, path) {
  var cur = obj;
  for (var i = 0; i < path.length; i++) {
    if (cur == null || typeof cur !== 'object') return null;
    var snake = path[i];
    var camel = snake.replace(/_([a-z])/g,
        function(mm, l) { return l.toUpperCase(); });
    cur = cur[snake] != null ? cur[snake] : cur[camel];
  }
  return cur == null ? null : cur;
}

// Portfolio strategy resource name -> its display name where known.
function stratName_(resourceName, portfolios) {
  var s = String(resourceName || '');
  if (!s) return '(none)';
  return (portfolios[s] && portfolios[s].name) || s;
}

// Naming convention, applied on every run so it covers spreadsheets created
// blank via the URL config as well as fresh ones.
function applySheetName_(ss, accountName, scriptName) {
  var name = accountName + ' | ' + scriptName + ' | by Camilo - holastudio.com.au';
  try {
    if (ss.getName() !== name) ss.rename(name);
  } catch (e) {
    Logger.log('Could not rename spreadsheet: ' + e);
  }
}

// The sheet-resident change archive: one JSON record per row, camouflaged in
// col AU of the Change Impact tab. This is what makes the change table a
// rolling record - the API forgets changes after 30 days, the sheet doesn't.
var ARCHIVE_COL = 47; // AU

function readChangeArchive_(ss) {
  var sh = ss.getSheetByName('Change Impact');
  if (!sh) return [];
  var out = [];
  try {
    var last = sh.getLastRow();
    if (last < 3) return [];
    var vals = sh.getRange(3, ARCHIVE_COL, last - 2, 1).getValues();
    vals.forEach(function(v) {
      if (!v[0]) return;
      try {
        var g = JSON.parse(String(v[0]));
        if (g && g.date && g.what) out.push(g);
      } catch (ignored) {}
    });
  } catch (e) {
    Logger.log('Change archive unreadable, starting fresh: ' + e);
  }
  return out;
}

function writeChangeArchive_(sh, changes) {
  if (!changes.length) return;
  sh.getRange(2, ARCHIVE_COL).setValue('Archive - do not edit');
  var rows = changes.map(function(g) { return [JSON.stringify(g)]; });
  sh.getRange(3, ARCHIVE_COL, rows.length, 1).setValues(rows);
}

// Fresh pull + archive, newest first, deduped on (date, time, campaign,
// change, old, new), capped so the archive cannot grow without bound.
function mergeChanges_(fresh, archive) {
  var seen = {}, out = [];
  function keyOf(g) {
    return [g.date, g.time, g.label, g.what, g.old, g.nw].join('|');
  }
  fresh.concat(archive).forEach(function(g) {
    var k = keyOf(g);
    if (seen[k]) return;
    seen[k] = true;
    out.push(g);
  });
  out.sort(function(a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1
         : a.time < b.time ? 1 : a.time > b.time ? -1 : 0;
  });
  return out.slice(0, 400);
}

function prettyStrategyType_(t) {
  var names = {
    'TARGET_ROAS': 'Target ROAS',
    'TARGET_CPA': 'Target CPA',
    'MAXIMIZE_CONVERSION_VALUE': 'Max conv. value',
    'MAXIMIZE_CONVERSIONS': 'Max conversions',
    'TARGET_SPEND': 'Max clicks',
    'TARGET_IMPRESSION_SHARE': 'Target impr. share',
    'MANUAL_CPC': 'Manual CPC',
    'MANUAL_CPM': 'Manual CPM',
    'MANUAL_CPV': 'Manual CPV',
    'COMMISSION': 'Commission',
    'PERCENT_CPC': 'Percent CPC'
  };
  return names[t] || t;
}

function prettyStrategy_(c) {
  var label = prettyStrategyType_(c.strategyType);
  if (c.portfolio) label += ' (portfolio)';
  if (c.targetType === 'ROAS' && c.strategyType === 'MAXIMIZE_CONVERSION_VALUE') {
    label += ' + tROAS';
  }
  if (c.targetType === 'CPA' && c.strategyType === 'MAXIMIZE_CONVERSIONS') {
    label += ' + tCPA';
  }
  return label;
}
