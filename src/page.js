// Client-side rendering, sorting and filtering. Runs against the inlined `DATA`.
/* global DATA */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const DAY = 86400000;
const days = (iso) => Math.floor((Date.now() - Date.parse(iso)) / DAY);
const ago = (iso) => {
  if (!iso) return "—";
  const d = days(iso);
  if (d === 0) return "today";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
};

// Only the exceptional states earn a color. On the open tab PENDING is the majority state --
// painting it would be noise -- and COMMENTED is informational, not a verdict.
const STATE_CLASS = { APPROVED: "st-good", CHANGES_REQUESTED: "st-serious" };
const LABELS = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

// The two views differ only in their tail column, what an outstanding request means, and
// which aggregate sits underneath. Everything else is shared.
const VIEWS = {
  open: {
    d: () => DATA.open,
    tail: (pr) => pr.updatedAt,
    // Still waiting on them.
    stateLabel: (s) => (s === "PENDING" ? "pending" : LABELS[s] ?? s),
    sort: "number",
    dir: -1,
  },
  merged: {
    d: () => DATA.merged,
    tail: (pr) => pr.mergedAt,
    // The PR merged with the request still outstanding: they never got to it.
    stateLabel: (s) => (s === "PENDING" ? "no review" : LABELS[s] ?? s),
    sort: "tail",
    dir: -1,
  },
};

const state = {
  tab: "open",
  open: { sort: "number", dir: -1, q: "", label: "", reviewer: "", mode: "all" },
  merged: { sort: "tail", dir: -1, q: "", label: "", reviewer: "", mode: "all" },
  wsort: "mine",
  wdir: -1,
  asort: "approved",
  adir: -1,
};

/* ---------------------------------- PR table ---------------------------------- */

function reviewerSpan(r, view) {
  // Two visual states by design: the assigner's picks read as ink, everyone else's recede.
  // The distinction between "someone else assigned them" and "they volunteered" is real but
  // secondary -- it lives in the tooltip rather than adding a third visual weight.
  //
  // Bots are never bold whoever requested them: emphasis is meant to pick out the humans
  // carrying review load. They also skip the dot, which specifically means "assigned by
  // someone else" and would be a lie for a bot the assigner requested.
  const kind = r.isBot ? "machine" : r.origin === "mine" ? "mine" : "other";
  const n = el("span", `rv rv-${kind}`);
  n.append(el("span", "rv-name", r.login));
  if (r.isBot) n.append(el("span", "rv-bot", "bot"));
  if (r.state !== "PENDING" || view === VIEWS.merged) {
    n.append(el("span", `badge ${STATE_CLASS[r.state] ?? "st-mute"}`, view.stateLabel(r.state)));
  }
  const on = r.assignedAt ? ` on ${r.assignedAt.slice(0, 10)}` : "";
  n.title =
    r.origin === "mine"
      ? `Task force selection — ${DATA.assigner} requested ${r.login}${on}`
      : r.origin === "volunteer"
        ? `${r.login} reviewed without being requested — not a task force selection`
        : r.assignedBy === DATA.assigner
          ? `${DATA.assigner} requested ${r.login}${on}, before the task force began`
          : `Requested by ${r.assignedBy}${on} — not a task force selection`;
  return n;
}

function prRow(pr, view) {
  const tr = el("tr");

  const num = el("td", "col-num");
  const a = el("a", "prnum", `#${pr.number}`);
  a.href = pr.url;
  a.rel = "noopener";
  num.append(a);

  const title = el("td", "col-title", pr.title);
  title.title = pr.title;

  const labels = el("td", "col-labels");
  for (const l of pr.labels) {
    const chip = el("span", "chip");
    const dot = el("span", "chip-dot");
    // The label's own GitHub color identifies it; the text stays in ink so the chip can
    // never fail contrast, however light the label color happens to be.
    dot.style.background = `#${l.color || "999999"}`;
    chip.append(dot, el("span", null, l.name));
    labels.append(chip);
  }

  const revs = el("td", "col-revs");
  if (pr.reviewers.length === 0) {
    revs.append(el("span", "none", view === VIEWS.merged ? "nobody reviewed" : "nobody assigned"));
  } else {
    for (const r of pr.reviewers) revs.append(reviewerSpan(r, view));
  }

  const age = el("td", "col-age num", ago(pr.createdAt));
  age.title = pr.createdAt;
  const tail = el("td", "col-upd num", ago(view.tail(pr)));
  tail.title = view.tail(pr) ?? "";

  tr.append(num, title, el("td", "col-author", pr.author), labels, revs, age, tail);
  return tr;
}

// Dates sort as raw timestamps so that, like every other column, descending means
// biggest-first -- i.e. most recent first. Negating here as well would cancel that out.
const PR_KEY = {
  number: (p) => p.number,
  title: (p) => p.title.toLowerCase(),
  author: (p) => p.author.toLowerCase(),
  labels: (p) => p.labels.length,
  reviewers: (p) => p.reviewers.length,
  age: (p) => Date.parse(p.createdAt),
};

function visiblePrs(view, st) {
  const q = st.q.toLowerCase();
  return view.d().prs.filter((pr) => {
    if (q && !`#${pr.number} ${pr.title} ${pr.author}`.toLowerCase().includes(q)) return false;
    if (st.label && !pr.labels.some((l) => l.name === st.label)) return false;
    if (st.reviewer && !pr.reviewers.some((r) => r.login === st.reviewer)) return false;
    const has = (fn) => pr.reviewers.some(fn);
    switch (st.mode) {
      case "mine":
        return has((r) => r.origin === "mine");
      case "notmine":
        return !has((r) => r.origin === "mine");
      case "nohook":
        return !has((r) => r.state === "PENDING");
      case "unassigned":
        return pr.reviewers.length === 0;
      case "approved":
        return has((r) => r.state === "APPROVED");
      case "approved-mine":
        return has((r) => r.state === "APPROVED" && r.origin === "mine");
      case "unapproved":
        return !has((r) => r.state === "APPROVED");
      default:
        return true;
    }
  });
}

function drawPrs(key) {
  const view = VIEWS[key];
  const st = state[key];
  const rows = visiblePrs(view, st);
  const keyFn = st.sort === "tail" ? (p) => Date.parse(view.tail(p) ?? 0) : PR_KEY[st.sort];
  rows.sort((a, b) => {
    const x = keyFn(a);
    const y = keyFn(b);
    return (x < y ? -1 : x > y ? 1 : 0) * st.dir || b.number - a.number;
  });

  $(`#${key}-pr-body`).replaceChildren(...rows.map((pr) => prRow(pr, view)));
  const total = view.d().prs.length;
  $(`#${key}-pr-count`).textContent =
    rows.length === total ? `${total} pull requests` : `${rows.length} of ${total} pull requests`;
  $(`#${key}-pr-empty`).hidden = rows.length > 0;

  for (const th of document.querySelectorAll(`#${key}-pr-table th[data-sort]`)) {
    th.dataset.active = String(th.dataset.sort === st.sort);
    th.dataset.dir = th.dataset.sort === st.sort ? (st.dir === 1 ? "asc" : "desc") : "";
  }
}

/* ------------------------------- Bottom tables -------------------------------- */

// One series per table (the number the table is ranked by), so each bar is a single
// sequential hue and needs no legend.
function bar(value, max) {
  const td = el("td", "w-mine");
  const track = el("div", "bar");
  const fill = el("div", "bar-fill");
  fill.style.width = `${(value / max) * 100}%`;
  track.append(fill);
  td.append(el("span", "num", String(value)), track);
  return td;
}

function drawTable({ table, body, rows, sortKey, dir, keys, primary, extra }) {
  const sorted = [...rows].sort((a, b) => {
    const x = keys[sortKey](a);
    const y = keys[sortKey](b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || a.login.localeCompare(b.login);
  });
  const max = Math.max(1, ...rows.map((r) => r[primary]));
  $(body).replaceChildren(
    ...sorted.map((r) => {
      const tr = el("tr");
      tr.append(el("td", "w-name", r.login), bar(r[primary], max));
      for (const k of extra) tr.append(el("td", "num dim", String(r[k])));
      return tr;
    }),
  );
  for (const th of document.querySelectorAll(`${table} th[data-wsort]`)) {
    th.dataset.active = String(th.dataset.wsort === sortKey);
    th.dataset.dir = th.dataset.wsort === sortKey ? (dir === 1 ? "asc" : "desc") : "";
  }
}

const drawWorkload = () =>
  drawTable({
    table: "#w-table",
    body: "#w-body",
    rows: DATA.open.workload,
    sortKey: state.wsort,
    dir: state.wdir,
    keys: {
      reviewer: (r) => r.login.toLowerCase(),
      mine: (r) => r.mine,
      other: (r) => r.other,
      volunteer: (r) => r.volunteer,
    },
    primary: "mine",
    extra: ["other", "volunteer"],
  });

const drawApprovals = () =>
  drawTable({
    table: "#a-table",
    body: "#a-body",
    rows: DATA.merged.approvals,
    sortKey: state.asort,
    dir: state.adir,
    keys: {
      reviewer: (r) => r.login.toLowerCase(),
      approved: (r) => r.approved,
      mine: (r) => r.mine,
    },
    primary: "approved",
    extra: ["mine"],
  });

/* ---------------------------------- Controls ---------------------------------- */

function fillSelect(sel, items, allLabel) {
  const keep = sel.value;
  sel.replaceChildren();
  const first = el("option", null, allLabel);
  first.value = "";
  sel.append(first);
  for (const it of items) {
    const o = el("option", null, it);
    o.value = it;
    sel.append(o);
  }
  sel.value = keep;
}

function wireFilters(key) {
  const st = state[key];
  const prs = VIEWS[key].d().prs;
  fillSelect($(`#${key}-f-label`), [...new Set(prs.flatMap((p) => p.labels.map((l) => l.name)))].sort(), "All labels");
  fillSelect($(`#${key}-f-reviewer`), [...new Set(prs.flatMap((p) => p.reviewers.map((r) => r.login)))].sort(), "All reviewers");

  const on = (sel, ev, fn) => $(sel).addEventListener(ev, (e) => (fn(e.target.value), drawPrs(key)));
  on(`#${key}-f-q`, "input", (v) => (st.q = v.trim()));
  on(`#${key}-f-label`, "change", (v) => (st.label = v));
  on(`#${key}-f-reviewer`, "change", (v) => (st.reviewer = v));
  on(`#${key}-f-mode`, "change", (v) => (st.mode = v));

  $(`#${key}-f-reset`).addEventListener("click", () => {
    Object.assign(st, { q: "", label: "", reviewer: "", mode: "all" });
    for (const s of ["q", "label", "reviewer", "mode"]) $(`#${key}-f-${s}`).value = s === "mode" ? "all" : "";
    drawPrs(key);
  });

  for (const th of document.querySelectorAll(`#${key}-pr-table th[data-sort]`)) {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      // Text sorts read best A->Z first; counts and dates read best biggest-first.
      if (st.sort === k) st.dir *= -1;
      else Object.assign(st, { sort: k, dir: k === "title" || k === "author" ? 1 : -1 });
      drawPrs(key);
    });
  }
}

function showTab(key) {
  state.tab = key;
  for (const btn of document.querySelectorAll("[data-tab]")) {
    const on = btn.dataset.tab === key;
    btn.setAttribute("aria-selected", String(on));
    $(`#panel-${btn.dataset.tab}`).hidden = !on;
  }
  history.replaceState(null, "", key === "open" ? location.pathname : `#${key}`);
}

function init() {
  $("#repo").textContent = DATA.repo;
  $("#repo").href = `https://github.com/${DATA.repo}`;
  document.title = `${DATA.repo} PR Task Force`;

  // This page is public, so it names the assigner rather than addressing a "you" that most
  // readers aren't. The name comes from the data, since TASK_FORCE_ASSIGNER is configurable.
  for (const n of document.querySelectorAll(".who")) n.textContent = DATA.assigner;
  for (const n of document.querySelectorAll(".months")) n.textContent = String(DATA.merged.months);
  $("#tf-start").textContent = DATA.taskForceStart
    ? new Date(`${DATA.taskForceStart}T00:00:00Z`).toLocaleDateString(undefined, {
        year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
      })
    : "the beginning";

  const o = DATA.open.stats;
  $("#kpi-prs").textContent = o.prs;
  $("#kpi-mine").textContent = o.pendingMine;
  $("#kpi-other").textContent = o.pending - o.pendingMine;
  $("#kpi-nohook").textContent = o.noOneOnHook;
  $("#kpi-nohook-note").textContent = `${o.unassigned} have no reviewer at all`;

  const m = DATA.merged.stats;
  $("#kpi-merged").textContent = m.prs;
  $("#kpi-approved").textContent = m.approved;
  $("#kpi-unapproved").textContent = m.unapproved;
  $("#kpi-taskforce").textContent = m.taskForce;
  $("#tab-open-count").textContent = o.prs;
  $("#tab-merged-count").textContent = m.prs;
  $("#merged-since").textContent = new Date(`${DATA.merged.since}T00:00:00Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const when = new Date(DATA.generatedAt);
  $("#generated").textContent = when.toLocaleString();
  $("#generated").dateTime = DATA.generatedAt;
  const stale = Math.floor((Date.now() - when.getTime()) / DAY);
  if (stale >= 2) {
    $("#stale").textContent = `snapshot is ${stale} days old`;
    $("#stale").hidden = false;
  }

  for (const btn of document.querySelectorAll("[data-tab]")) {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  }
  for (const [table, sortState, draw] of [
    ["#w-table", ["wsort", "wdir"], drawWorkload],
    ["#a-table", ["asort", "adir"], drawApprovals],
  ]) {
    for (const th of document.querySelectorAll(`${table} th[data-wsort]`)) {
      th.addEventListener("click", () => {
        const k = th.dataset.wsort;
        const [sk, dk] = sortState;
        if (state[sk] === k) state[dk] *= -1;
        else Object.assign(state, { [sk]: k, [dk]: k === "reviewer" ? 1 : -1 });
        draw();
      });
    }
  }

  wireFilters("open");
  wireFilters("merged");
  drawWorkload();
  drawApprovals();
  drawPrs("open");
  drawPrs("merged");
  showTab(location.hash === "#merged" ? "merged" : "open");
}

init();
