import { readFile } from "node:fs/promises";

const pageScript = await readFile(new URL("./page.js", import.meta.url), "utf8");

// JSON goes inside a <script> element, where the HTML parser ends that block at the first
// literal "</script" regardless of JS syntax -- escaping "<" closes that hole. U+2028/9 are
// legal in JSON but were historically illegal raw inside JS string literals.
const jsonForScript = (data) =>
  JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// Palette roles from the reference instance, declared once and used by name below.
// Dark is a selected set of steps for the dark surface, not an inverted light.
const CSS = `
:root {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --plane: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.10);
  --series-1: #2a78d6;
  /* Ordinal ramp for the workload bar: one hue in two steps, because the segments are stages
     of the same review (not yet looked at -> looked at, not signed off), and a reader should
     see that order in the color. Blue steps 250 and 450; the near-surface end clears 2:1. */
  --stage-1: #86b6ef;
  --stage-2: #2a78d6;
  --good: #0ca30c;
  --serious: #ec835a;
  --accent-ink: #184f95;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --plane: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255, 255, 255, 0.10);
    --series-1: #3987e5;
    /* Dark flips the anchor: the near-surface end is the dark one, so the later stage stays
       the more prominent of the two. Blue steps 550 and 400. */
    --stage-1: #1c5cab;
    --stage-2: #3987e5;
    --good: #0ca30c;
    --serious: #ec835a;
    --accent-ink: #86b6ef;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--text-primary);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 1240px; margin: 0 auto; padding: 32px 20px 64px; }
a { color: var(--accent-ink); }

header h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.01em; }
header p { margin: 0; color: var(--text-secondary); }
.sub { font-size: 13px; }

.tabs { display: flex; gap: 4px; margin: 20px 0 0; border-bottom: 1px solid var(--grid); }
.tabs button {
  background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0;
  padding: 8px 14px; margin-bottom: -1px; font-size: 14px; font-weight: 600;
  color: var(--text-muted); cursor: pointer;
}
.tabs button:hover { color: var(--text-primary); }
.tabs button[aria-selected="true"] { color: var(--text-primary); border-bottom-color: var(--series-1); }
.tabn {
  margin-left: 6px; padding: 0 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text-secondary);
}

/* KPI row -- headline numbers are stat tiles, not a one-bar chart. */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 20px 0 24px; }
.kpi { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.kpi .v { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }
.kpi .k { color: var(--text-secondary); font-size: 12px; margin-top: 2px; }
.kpi .k2 { display: block; color: var(--text-muted); font-size: 11px; }
.kpi.flag .v { color: var(--serious); }

section { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 24px; }
.head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 14px 16px; border-bottom: 1px solid var(--grid); }
.head h2 { margin: 0; font-size: 14px; font-weight: 650; }
.head .note { color: var(--text-muted); font-size: 12px; }
.scroll { overflow-x: auto; }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
th {
  position: sticky; top: 0; z-index: 1;
  background: var(--surface-1);
  border-bottom: 1px solid var(--axis);
  color: var(--text-secondary);
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
th[data-sort], th[data-wsort] { cursor: pointer; user-select: none; }
th[data-sort]:hover, th[data-wsort]:hover { color: var(--text-primary); }
th[data-active="true"] { color: var(--text-primary); }
th[data-dir="asc"]::after { content: " \\2191"; }
th[data-dir="desc"]::after { content: " \\2193"; }
tbody tr:hover { background: color-mix(in srgb, var(--text-primary) 3.5%, transparent); }
.num { font-variant-numeric: tabular-nums; }
.dim { color: var(--text-secondary); }

.prnum { font-variant-numeric: tabular-nums; font-weight: 600; text-decoration: none; white-space: nowrap; }
.prnum:hover { text-decoration: underline; }
.col-num { width: 1%; }
.col-title { min-width: 260px; max-width: 420px; }
.col-author, .col-age, .col-upd { white-space: nowrap; color: var(--text-secondary); }
.col-age, .col-upd { width: 1%; }
.col-labels { min-width: 150px; }
.col-revs { min-width: 220px; }

.chip {
  display: inline-flex; align-items: center; gap: 5px;
  margin: 1px 4px 1px 0; padding: 1px 7px 1px 5px;
  border: 1px solid var(--border); border-radius: 999px;
  font-size: 11px; color: var(--text-secondary); white-space: nowrap;
}
.chip-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px var(--border) inset; }

/* Two states by design: the assigner's picks are ink, everyone else's recede. Bots recede
   too, whoever requested them -- bold is for the humans carrying load. */
.rv { display: inline-flex; align-items: center; gap: 4px; margin: 1px 8px 1px 0; white-space: nowrap; }
.rv-mine .rv-name { color: var(--text-primary); font-weight: 620; }
.rv-other .rv-name, .rv-machine .rv-name { color: var(--text-muted); font-weight: 400; }
/* A leading dot carries "assigned by someone else" a second time, so the distinction survives
   greyscale, print, and CVD rather than resting on weight and color alone. It is deliberately
   absent on bots, whom the assigner may well have requested. NBSP: a plain space collapses. */
.rv-other .rv-name::before { content: "\\00b7\\00a0"; }
/* Same quiet outline for both: a factual marker on the row, not a state worth a hue. */
.rv-bot, .draft {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-muted); border: 1px solid var(--border); border-radius: 3px; padding: 0 3px;
}
.draft { margin-left: 5px; vertical-align: 1px; }
.badge { font-size: 10px; font-weight: 600; color: var(--text-muted); }
/* Only exceptional states earn a hue; pending is the majority and stays neutral.
   Each badge carries its own word, so color never conveys state alone. */
.st-good { color: var(--good); }
.st-serious { color: var(--serious); }
.none { color: var(--text-muted); font-style: italic; font-size: 12px; }

.w-name { white-space: nowrap; }
.w-bar { display: flex; align-items: center; gap: 10px; }
.w-bar .num { min-width: 1.5em; }
/* A bar chart, not a meter: no track. Zero must render as nothing, or an idle reviewer
   reads as a loaded one -- which is exactly backwards for the question being asked. */
.bar { flex: 1; min-width: 60px; height: 8px; }
.bar-fill { height: 100%; background: var(--series-1); border-radius: 4px; min-width: 0; }
/* Square at the baseline, 4px at the data end -- and only the last segment carries it. */
.w-bar .bar { display: flex; }
.w-bar .bar-fill { border-radius: 0; }
.w-bar .bar-fill:last-child { border-radius: 0 4px 4px 0; }
.seg-1 { background: var(--stage-1); }
.seg-2 { background: var(--stage-2); }
/* The 2px surface gap the segments are separated by, painted over the start of the second
   one rather than inserted between them, so a split bar is exactly as long as an unsplit
   one of the same total. Never a border: that would add ink that isn't data. */
.w-bar .bar-fill + .bar-fill { box-shadow: -2px 0 0 var(--surface-1); }
.legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.legend .sw-1 { background: var(--stage-1); }
.legend .sw-2 { background: var(--stage-2); }
#w-table td { border-bottom: 1px solid var(--grid); }
#w-table th:not(:first-child), #w-table td:not(:first-child) { width: 22%; }
#a-table td { border-bottom: 1px solid var(--grid); }
#a-table th:not(:first-child), #a-table td:not(:first-child) { width: 28%; }

/* Figure rows inside a section: the same stat-tile contract as the KPI row, one level
   quieter, since these answer a follow-up question rather than leading the page. */
.figs { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px 20px; padding: 14px 16px; }
.fig .v { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.2; }
.fig .k { color: var(--text-secondary); font-size: 12px; }
.fig .k2 { display: block; color: var(--text-muted); font-size: 11px; }
.fig.flag .v { color: var(--serious); }

figure.chart { margin: 0; padding: 4px 16px 16px; border-top: 1px solid var(--grid); }
figure.chart figcaption { color: var(--text-secondary); font-size: 12px; margin: 10px 0 12px; }
figure.chart .cap { color: var(--text-muted); font-size: 11px; margin: 14px 0 0; max-width: 84ch; }

/* One series, so one hue and no legend -- the caption names what is plotted. Bars grow from
   a single left baseline: square where they start, rounded only at the data end. */
.hist { display: grid; gap: 6px; }
.hist-row { display: grid; grid-template-columns: 62px 1fr; align-items: center; gap: 10px; }
.hist-k { color: var(--text-secondary); font-size: 12px; text-align: right; white-space: nowrap; }
/* The count rides its own bar's tip. Parked in a right-hand column it would sit an inch of
   whitespace away from a short bar, and the reader has to work out which number is which.
   The reserved margin is what the longest bar's label sits in. */
.hist .bar { position: relative; height: 14px; margin-right: 34px; }
.hist .bar-fill { border-radius: 0 4px 4px 0; }
/* The last band is the finding, not merely the biggest number: it earns the status hue, and
   its own label says "31d+" so the meaning never rests on colour alone. */
.hist-row[data-stalled="true"] .bar-fill { background: var(--serious); }
.hist-v {
  position: absolute; top: 50%; transform: translateY(-50%); margin-left: 8px;
  color: var(--text-primary); font-size: 12px; font-weight: 620;
}

/* A strip of dots on one axis: 12 values, so show all 12 rather than a summary of them. */
.strip { position: relative; height: 46px; }
.strip-tick { position: absolute; top: 0; bottom: 14px; width: 1px; background: var(--grid); }
.strip-base { position: absolute; left: 0; right: 0; bottom: 14px; height: 1px; background: var(--axis); }
.strip-dot {
  position: absolute; bottom: 8px; width: 10px; height: 10px; margin-left: -5px;
  border-radius: 50%; background: var(--series-1);
  /* A surface ring, not a border: dots overlap where PRs merged on similar timelines, and
     the ring is what keeps two of them from reading as one. */
  box-shadow: 0 0 0 2px var(--surface-1);
}
/* The rule starts below its own label rather than through it. */
.strip-med { position: absolute; top: 17px; bottom: 14px; width: 2px; margin-left: -1px; background: var(--text-primary); }
.strip-med-k { position: absolute; top: 0; font-size: 11px; font-weight: 620; color: var(--text-primary); white-space: nowrap; }
.strip-med-k[data-side="right"] { margin-left: 6px; }
.strip-med-k[data-side="left"] { transform: translateX(-100%); margin-left: -6px; }
.strip-axis { position: relative; height: 16px; }
.strip-axis span { position: absolute; font-size: 11px; color: var(--text-muted); transform: translateX(-50%); font-variant-numeric: tabular-nums; }

.filters { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--grid); }
input, select, button {
  font: inherit; font-size: 13px; color: var(--text-primary);
  background: var(--surface-1); border: 1px solid var(--axis); border-radius: 7px; padding: 5px 9px;
}
input { min-width: 200px; flex: 1; }
button { cursor: pointer; color: var(--text-secondary); }
button:hover { color: var(--text-primary); }
:focus-visible { outline: 2px solid var(--series-1); outline-offset: 1px; }

.legend { display: flex; gap: 16px; align-items: center; color: var(--text-muted); font-size: 12px; margin-left: auto; }
.legend b { color: var(--text-primary); font-weight: 620; }

.empty { padding: 28px 16px; text-align: center; color: var(--text-muted); }
footer { color: var(--text-muted); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
#stale { color: var(--serious); font-weight: 600; }
`;

export function render(data) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>M2 PR Task Force</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>PR Task Force</h1>
  <p class="sub">Pull requests on <a id="repo" rel="noopener">…</a>, and who
     <span class="who">…</span> put on them. A <b>task force selection</b> is a review
     <span class="who">…</span> requested since <span id="tf-start">…</span>.</p>
</header>

<div class="tabs" role="tablist">
  <button role="tab" data-tab="open" aria-controls="panel-open" aria-selected="true">Open <span class="tabn" id="tab-open-count">–</span></button>
  <button role="tab" data-tab="merged" aria-controls="panel-merged" aria-selected="false">Merged <span class="tabn" id="tab-merged-count">–</span></button>
</div>

<div id="panel-open" role="tabpanel">
  <div class="kpis">
    <div class="kpi">
      <div class="v num" id="kpi-prs">–</div>
      <div class="k">open PRs up for review <span class="k2" id="kpi-prs-note"></span></div>
    </div>
    <div class="kpi"><div class="v num" id="kpi-mine">–</div><div class="k">awaiting review — assigned by <span class="who">…</span></div></div>
    <div class="kpi flag">
      <div class="v num" id="kpi-untriaged">–</div>
      <div class="k">opened since <span id="kpi-untriaged-since">…</span> with no reviewer from
        <span class="who">…</span> <span class="k2" id="kpi-untriaged-note"></span></div>
    </div>
  </div>

  <section>
    <div class="head">
      <h2>Task force requests awaiting review</h2>
      <span class="note" id="tf-open-note"></span>
    </div>
    <div class="figs">
      <div class="fig"><div class="v num" id="tf-median">–</div><div class="k">median wait since the request</div></div>
      <div class="fig"><div class="v num" id="tf-oldest">–</div><div class="k">longest a request has gone unanswered</div></div>
      <div class="fig flag"><div class="v num" id="tf-stalled">–</div><div class="k">waiting over <span id="tf-stalled-days">30</span> days</div></div>
    </div>
    <figure class="chart">
      <figcaption>How long the unanswered requests have been waiting</figcaption>
      <div class="hist" id="tf-hist"></div>
      <p class="cap" id="tf-ceiling"></p>
    </figure>
  </section>

  <section>
    <div class="head">
      <h2>Open pull requests</h2>
      <span class="note" id="open-pr-count"></span>
      <span class="legend"><span><b>bold</b> = task force selection</span><span>· grey = anyone else</span></span>
    </div>
    <div class="filters">
      <input id="open-f-q" type="search" placeholder="Search number, title, author…" aria-label="Search open pull requests">
      <select id="open-f-label" aria-label="Filter by label"></select>
      <select id="open-f-reviewer" aria-label="Filter by reviewer"></select>
      <select id="open-f-mode" aria-label="Filter by assignment">
        <option value="all">Any assignment</option>
        <option value="mine">Has a task force selection</option>
        <option value="notmine">No task force selection</option>
        <option value="started">Review begun, not approved</option>
        <option value="nohook">Nobody on the hook</option>
        <option value="unassigned">No reviewer at all</option>
      </select>
      <button id="open-f-reset" type="button">Reset</button>
    </div>
    <div class="scroll">
      <table id="open-pr-table">
        <thead><tr>
          <th data-sort="number">PR</th>
          <th data-sort="title">Title</th>
          <th data-sort="author">Author</th>
          <th data-sort="labels">Labels</th>
          <th data-sort="reviewers">Reviewers</th>
          <th data-sort="age">Opened</th>
          <th data-sort="tail">Updated</th>
        </tr></thead>
        <tbody id="open-pr-body"></tbody>
      </table>
    </div>
    <div class="empty" id="open-pr-empty" hidden>No pull requests match these filters.</div>
  </section>

  <section>
    <div class="head">
      <h2>Reviewer workload</h2>
      <span class="note">task force selections each reviewer still owes something on</span>
      <span class="legend">
        <span><span class="sw sw-1"></span>awaiting a first review</span>
        <span><span class="sw sw-2"></span>reviewed, not approved</span>
      </span>
    </div>
    <div class="scroll">
      <table id="w-table">
        <thead><tr>
          <th data-wsort="reviewer">Reviewer</th>
          <th data-wsort="total">Total</th>
          <th data-wsort="waiting">Awaiting first review</th>
          <th data-wsort="started">Review begun</th>
        </tr></thead>
        <tbody id="w-body"></tbody>
      </table>
    </div>
  </section>
</div>

<div id="panel-merged" role="tabpanel" hidden>
  <div class="kpis">
    <div class="kpi"><div class="v num" id="kpi-merged">–</div><div class="k">merged in the last <span class="months">3</span> months <span class="k2">since <span id="merged-since"></span></span></div></div>
    <div class="kpi"><div class="v num" id="kpi-approved">–</div><div class="k">merged with an approval</div></div>
    <div class="kpi"><div class="v num" id="kpi-unapproved">–</div><div class="k">merged with no approval</div></div>
    <div class="kpi"><div class="v num" id="kpi-taskforce">–</div><div class="k">approved by a task force selection</div></div>
  </div>

  <section>
    <div class="head">
      <h2>From assignment to merge</h2>
      <span class="note" id="tf-merged-note"></span>
    </div>
    <div class="figs">
      <div class="fig"><div class="v num" id="tf-m-median">–</div><div class="k">median from request to merge</div></div>
      <div class="fig"><div class="v num" id="tf-m-fast">–</div><div class="k">merged within two weeks of the request</div></div>
      <div class="fig"><div class="v num" id="tf-m-response">–</div><div class="k">median time to a review, when one came</div></div>
    </div>
    <figure class="chart">
      <figcaption>Days from the task force request to the merge — one dot per pull request</figcaption>
      <div class="strip" id="tf-strip"></div>
      <div class="strip-axis" id="tf-strip-axis"></div>
      <p class="cap" id="tf-strip-cap"></p>
    </figure>
  </section>

  <section>
    <div class="head">
      <h2>Merged pull requests</h2>
      <span class="note" id="merged-pr-count"></span>
      <span class="legend"><span><b>bold</b> = task force selection</span><span>· grey = anyone else</span></span>
    </div>
    <div class="filters">
      <input id="merged-f-q" type="search" placeholder="Search number, title, author…" aria-label="Search merged pull requests">
      <select id="merged-f-label" aria-label="Filter by label"></select>
      <select id="merged-f-reviewer" aria-label="Filter by reviewer"></select>
      <select id="merged-f-mode" aria-label="Filter by approval">
        <option value="all">Any approval</option>
        <option value="approved">Approved by anyone</option>
        <option value="approved-mine">Approved by a task force selection</option>
        <option value="unapproved">Merged with no approval</option>
      </select>
      <button id="merged-f-reset" type="button">Reset</button>
    </div>
    <div class="scroll">
      <table id="merged-pr-table">
        <thead><tr>
          <th data-sort="number">PR</th>
          <th data-sort="title">Title</th>
          <th data-sort="author">Author</th>
          <th data-sort="labels">Labels</th>
          <th data-sort="reviewers">Reviewers</th>
          <th data-sort="age">Opened</th>
          <th data-sort="tail">Merged</th>
        </tr></thead>
        <tbody id="merged-pr-body"></tbody>
      </table>
    </div>
    <div class="empty" id="merged-pr-empty" hidden>No pull requests match these filters.</div>
  </section>

  <section>
    <div class="head">
      <h2>Approvals on merged PRs</h2>
      <span class="note">reviewers of PRs merged in the last <span class="months">3</span> months, and how many they approved</span>
    </div>
    <div class="scroll">
      <table id="a-table">
        <thead><tr>
          <th data-wsort="reviewer">Reviewer</th>
          <th data-wsort="approved">Approved</th>
          <th data-wsort="mine">As a task force selection</th>
        </tr></thead>
        <tbody id="a-body"></tbody>
      </table>
    </div>
  </section>
</div>

<footer>
  <span>Generated <time id="generated">…</time></span>
  <span id="stale" hidden></span>
</footer>

</div>
<script>const DATA = ${jsonForScript(data)};</script>
<script>${pageScript}</script>
</body>
</html>
`;
}
