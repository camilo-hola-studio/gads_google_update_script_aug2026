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
 * by target status, and writes a three-tab audit workbook: Summary,
 * Actionable, Campaign Data.
 */

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
  BUDGET_LIMITED_THRESHOLD: 0.85
};

// Theme.
var COLORS = {
  PRIMARY: '#38E3F2', // Hola Studio light blue - header bands, primary series, "with target"
  DARK: '#292B41',    // Hola Studio navy - comparison series, "no target", titles
  NAVY: '#292B41',    // titles
  YELLOW: '#F4B400',  // gap-vs-target series (contrast against blue/navy)
  BORDER: '#D9D9D9',  // light grey table borders
  WHITE: '#FFFFFF',
  RED: '#F4C7C3',     // trend <= -20%
  AMBER: '#FCE8B2',   // trend -10% .. -20%
  GREEN: '#D9EAD3',   // trend > -10%
  GREY: '#EFEFEF'     // no-target / low-spend rows
};

var TAB_ORDER = ['Summary', 'Actionable', 'Campaign Data'];

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------
function main() {
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

  var ss = openOrCreateSpreadsheet_(account, ranges);

  buildSummaryTab_(ss, list, account, ranges, primaryMetric, currency, weekly);
  buildActionableTab_(ss, list, primaryMetric, currency);
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
      "WHERE campaign.status = 'ENABLED' " +
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

  // Gap vs Target respects direction: beating the target reads POSITIVE for
  // both metric types (higher ROAS is good, lower CPA is good).
  c.gap = null;
  if (c.target && c.m30 != null) {
    c.gap = c.targetType === 'ROAS'
        ? (c.m30 - c.target) / c.target
        : (c.target - c.m30) / c.target;
  }

  // Trend 30d>7d ("decay"): negative = deteriorating, for both metric types.
  // ROAS: (m7-m30)/m30. CPA equivalent: (m30-m7)/m30, so a rising CPA reads
  // negative too.
  c.trend = null;
  if (c.m30 != null && c.m30 !== 0 && c.m7 != null) {
    c.trend = c.metricType === 'ROAS'
        ? (c.m7 - c.m30) / c.m30
        : (c.m30 - c.m7) / c.m30;
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
  } else if (c.trend <= -0.20) {
    c.priority = '1 - Act now';
  } else if (c.trend <= -0.10) {
    c.priority = '2 - Watch';
  } else {
    c.priority = '3 - Stable';
  }

  // Segment (no name-based inference — target status, spend floor, gap band).
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
  c.flag = flags.join('; ') || '-';

  c.actionable = c.hasTarget && c.aboveFloor &&
      ((c.gap != null && Math.abs(c.gap) > 0.20) ||
       (c.trend != null && c.trend <= -0.20));
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
            ' | All money in ' + currency);

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
                 'Actual 30d', 'Actual 14d', 'Actual 7d', 'Trend 30d>7d',
                 'Priority'];
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
      c.priority
    ]);
  });
  if (out.length) {
    sh.getRange(hdrRow + 1, 1, out.length, headers.length).setValues(out);
    sh.getRange(hdrRow + 1, 4, out.length, 4).setNumberFormat('#,##0.00');
    sh.getRange(hdrRow + 1, 8, out.length, 1).setNumberFormat('0.0%');

    // Same watercolour wash as Campaign Data: full row tinted for the
    // actionable set, a shade deeper when the trend says "1 - Act now".
    // Applied before the trend-cell colours so those keep their own fill.
    list.forEach(function(c, i) {
      if (!c.actionable) return;
      var urgent = c.priority === '1 - Act now';
      sh.getRange(hdrRow + 1 + i, 1, 1, headers.length)
          .setBackground(urgent ? '#B9F5FC' : '#E0FBFE');
    });

    // "Conditional formatting" applied deterministically per row: red/amber/
    // green on the priority thresholds for flagged rows, grey for no-target
    // and low-spend rows.
    list.forEach(function(c, i) {
      var cell = sh.getRange(hdrRow + 1 + i, 8);
      if (!c.hasTarget || !c.aboveFloor) cell.setBackground(COLORS.GREY);
      else if (c.trend == null) cell.setBackground(COLORS.GREY);
      else if (c.trend <= -0.20) cell.setBackground(COLORS.RED);
      else if (c.trend <= -0.10) cell.setBackground(COLORS.AMBER);
      else cell.setBackground(COLORS.GREEN);
    });
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
      'CPA. Trend 30d>7d: negative always means deteriorating. Priority: <= -20% = Act now; ' +
      '-10% to -20% = Watch; else Stable.',
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
  weeks.forEach(function(w, i) {
    var row = tblStart + i;
    var wk = ',' + rawA1('S') + ',$N' + row;
    sh.getRange(row, IDX_COL).setValue(i + 1);
    sh.getRange(row, TBL_COL).setValue(w);
    sh.getRange(row, TBL_COL + 1).setFormula(
        '=IFERROR(SUMIFS(' + rawA1('X') + wk + crit + ')/SUMIFS(' +
        rawA1('U') + wk + crit + '),"")');
    sh.getRange(row, TBL_COL + 2).setFormula(primaryMetric === 'ROAS'
        ? '=IFERROR(SUMIFS(' + rawA1('V') + wk + crit + ')/SUMIFS(' +
          rawA1('U') + wk + crit + '),"")'
        : '=IFERROR(SUMIFS(' + rawA1('U') + wk + crit + ')/SUMIFS(' +
          rawA1('W') + wk + crit + '),"")');
    // Gap vs target, same direction convention as every other tab: beating
    // the target reads positive for both ROAS and CPA.
    sh.getRange(row, TBL_COL + 3).setFormula(primaryMetric === 'ROAS'
        ? '=IFERROR(($P' + row + '-$O' + row + ')/$O' + row + ',"")'
        : '=IFERROR(($O' + row + '-$P' + row + ')/$O' + row + ',"")');
    sh.getRange(row, TBL_COL + 4).setFormula(
        '=IFERROR(TREND(' + yA1 + ',' + xA1 + ',$M' + row + '),"")');
  });
  sh.getRange(tblStart, IDX_COL, weeks.length, 1)
      .setFontColor('#999999').setFontSize(8);
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
      ', and |gap| > 20% or decay <= -20%. Ordered by 60d cost. ' +
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
  if (c.trend != null && c.trend <= -0.20) {
    parts.push('decaying ' + Math.round(Math.abs(c.trend) * 100) +
               '% (7d vs 30d)');
  }
  if (c.portfolio) {
    parts.push('portfolio strategy "' + c.portfolioName +
               '" - target sits at strategy level and needs unpicking before ' +
               'a per-campaign change');
  }
  if (c.budgetLimited) {
    parts.push('budget-limited: in the directly-affected set for 17 Aug');
  }
  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// TAB 3: CAMPAIGN DATA
// ---------------------------------------------------------------------------
function buildCampaignDataTab_(ss, list, primaryMetric, currency, totalCost) {
  var sh = resetSheet_(ss, 'Campaign Data');
  title_(sh, 1, 'Campaign Data - all raw and computed fields', 12);

  var headers = ['Campaign', 'Campaign ID', 'Bid Strategy', 'Portfolio',
                 'Target Type', 'Target', 'Budget-limited', 'Cost 60d',
                 '% of Spend', 'Metric', 'ROAS/CPA 60d', 'ROAS/CPA 30d',
                 'ROAS/CPA 14d', 'ROAS/CPA 7d', 'Gap vs Target',
                 'Trend 30d>7d', 'Segment', 'Flag'];
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
      c.segment, c.flag
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
    // the trend also says "1 - Act now".
    list.forEach(function(c, i) {
      if (!c.actionable) return;
      var urgent = c.priority === '1 - Act now';
      sh.getRange(3 + i, 1, 1, headers.length)
          .setBackground(urgent ? '#B9F5FC' : '#E0FBFE');
    });

    tableStyle_(sh, 2, 1, out.length + 1, headers.length);
  } else {
    sh.getRange(3, 1).setValue('No enabled campaigns found.');
  }

  sh.setFrozenRows(2);
  sh.setFrozenColumns(1);
  sh.setColumnWidths(1, 1, 280);
  sh.setColumnWidths(2, 17, 110);
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
