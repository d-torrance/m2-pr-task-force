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
  const d = days(iso);
  if (d === 0) return "today";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
};

// Only the exceptional states earn a color. PENDING is the majority state -- painting it
// would be noise -- and COMMENTED is informational, not a verdict.
const STATE_LABEL = {
  PENDING: "pending",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};
const STATE_CLASS = {
  APPROVED: "st-good",
  CHANGES_REQUESTED: "st-serious",
};

const state = { sort: "number", dir: -1, wsort: "mine", wdir: -1, q: "", label: "", reviewer: "", mine: "all" };

/* ---------------------------------- PR table ---------------------------------- */

function reviewerSpan(r) {
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
  if (r.state !== "PENDING") {
    n.append(el("span", `badge ${STATE_CLASS[r.state] ?? "st-mute"}`, STATE_LABEL[r.state] ?? r.state));
  }
  n.title =
    r.origin === "mine"
      ? `${DATA.assigner} requested ${r.login}`
      : r.origin === "other"
        ? `Requested by ${r.assignedBy} — not one of ${DATA.assigner}'s task force selections`
        : `${r.login} reviewed without being requested — not one of ${DATA.assigner}'s task force selections`;
  return n;
}

function prRow(pr) {
  const tr = el("tr");

  const num = el("td", "col-num");
  const a = el("a", "prnum", `#${pr.number}`);
  a.href = pr.url;
  a.rel = "noopener";
  num.append(a);

  const title = el("td", "col-title", pr.title);
  title.title = pr.title;

  const author = el("td", "col-author", pr.author);

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
    revs.append(el("span", "none", "nobody assigned"));
  } else {
    for (const r of pr.reviewers) revs.append(reviewerSpan(r));
  }

  const age = el("td", "col-age num", ago(pr.createdAt));
  age.title = pr.createdAt;
  const upd = el("td", "col-upd num", ago(pr.updatedAt));
  upd.title = pr.updatedAt;

  tr.append(num, title, author, labels, revs, age, upd);
  return tr;
}

function visiblePrs() {
  const q = state.q.toLowerCase();
  return DATA.prs.filter((pr) => {
    if (q && !(`#${pr.number} ${pr.title} ${pr.author}`.toLowerCase().includes(q))) return false;
    if (state.label && !pr.labels.some((l) => l.name === state.label)) return false;
    if (state.reviewer && !pr.reviewers.some((r) => r.login === state.reviewer)) return false;
    if (state.mine === "unassigned" && pr.reviewers.length > 0) return false;
    if (state.mine === "nohook" && pr.reviewers.some((r) => r.state === "PENDING")) return false;
    if (state.mine === "mine" && !pr.reviewers.some((r) => r.origin === "mine")) return false;
    if (state.mine === "notmine" && !pr.reviewers.every((r) => r.origin !== "mine")) return false;
    return true;
  });
}

const PR_KEY = {
  number: (p) => p.number,
  title: (p) => p.title.toLowerCase(),
  author: (p) => p.author.toLowerCase(),
  labels: (p) => p.labels.length,
  reviewers: (p) => p.reviewers.length,
  age: (p) => -Date.parse(p.createdAt),
  updated: (p) => -Date.parse(p.updatedAt),
};

function drawPrs() {
  const rows = visiblePrs();
  const key = PR_KEY[state.sort];
  rows.sort((a, b) => {
    const x = key(a), y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * state.dir || b.number - a.number;
  });

  const body = $("#pr-body");
  body.replaceChildren(...rows.map(prRow));
  $("#pr-count").textContent =
    rows.length === DATA.prs.length
      ? `${rows.length} pull requests`
      : `${rows.length} of ${DATA.prs.length} pull requests`;
  $("#pr-empty").hidden = rows.length > 0;

  for (const th of document.querySelectorAll("#pr-table th[data-sort]")) {
    th.dataset.active = String(th.dataset.sort === state.sort);
    th.dataset.dir = th.dataset.sort === state.sort ? (state.dir === 1 ? "asc" : "desc") : "";
  }
}

/* ------------------------------ Reviewer workload ------------------------------ */

const W_KEY = {
  reviewer: (r) => r.login.toLowerCase(),
  mine: (r) => r.mine,
  other: (r) => r.other,
  volunteer: (r) => r.volunteer,
};

function drawWorkload() {
  const rows = [...DATA.workload];
  const key = W_KEY[state.wsort];
  rows.sort((a, b) => {
    const x = key(a), y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * state.wdir || a.login.localeCompare(b.login);
  });

  // One series (the queue you own), so the bar is a single sequential hue and needs no legend.
  const max = Math.max(1, ...DATA.workload.map((r) => r.mine));

  const body = $("#w-body");
  body.replaceChildren(
    ...rows.map((r) => {
      const tr = el("tr");
      const name = el("td", "w-name", r.login);
      const mine = el("td", "w-mine");
      const bar = el("div", "bar");
      const fill = el("div", "bar-fill");
      fill.style.width = `${(r.mine / max) * 100}%`;
      bar.append(fill);
      mine.append(el("span", "num", String(r.mine)), bar);

      tr.append(
        name,
        mine,
        el("td", "num dim", String(r.other)),
        el("td", "num dim", String(r.volunteer)),
      );
      return tr;
    }),
  );

  for (const th of document.querySelectorAll("#w-table th[data-wsort]")) {
    th.dataset.active = String(th.dataset.wsort === state.wsort);
    th.dataset.dir = th.dataset.wsort === state.wsort ? (state.wdir === 1 ? "asc" : "desc") : "";
  }
}

/* ---------------------------------- Controls ---------------------------------- */

function fillSelect(sel, items, allLabel) {
  sel.append(el("option", null, allLabel));
  sel.firstChild.value = "";
  for (const it of items) {
    const o = el("option", null, it);
    o.value = it;
    sel.append(o);
  }
}

function init() {
  $("#repo").textContent = DATA.repo;
  $("#repo").href = `https://github.com/${DATA.repo}`;
  document.title = `${DATA.repo} PR Task Force`;

  // This page is public, so it names the assigner rather than addressing a "you" that most
  // readers aren't. The name comes from the data, since TASK_FORCE_ASSIGNER is configurable.
  for (const n of document.querySelectorAll(".who")) n.textContent = DATA.assigner;
  $("#f-mine").querySelector('[value="mine"]').textContent = `Assigned by ${DATA.assigner}`;
  $("#f-mine").querySelector('[value="notmine"]').textContent = `Not assigned by ${DATA.assigner}`;

  const s = DATA.stats;
  $("#kpi-prs").textContent = s.prs;
  $("#kpi-mine").textContent = s.pendingMine;
  $("#kpi-other").textContent = s.pending - s.pendingMine;
  $("#kpi-nohook").textContent = s.noOneOnHook;
  $("#kpi-nohook-note").textContent = `${s.unassigned} have no reviewer at all`;

  const when = new Date(DATA.generatedAt);
  $("#generated").textContent = when.toLocaleString();
  $("#generated").dateTime = DATA.generatedAt;
  const stale = Math.floor((Date.now() - when.getTime()) / DAY);
  if (stale >= 2) {
    $("#stale").textContent = `snapshot is ${stale} days old`;
    $("#stale").hidden = false;
  }

  const labels = [...new Set(DATA.prs.flatMap((p) => p.labels.map((l) => l.name)))].sort();
  const reviewers = [...new Set(DATA.prs.flatMap((p) => p.reviewers.map((r) => r.login)))].sort();
  fillSelect($("#f-label"), labels, "All labels");
  fillSelect($("#f-reviewer"), reviewers, "All reviewers");

  $("#f-q").addEventListener("input", (e) => {
    state.q = e.target.value.trim();
    drawPrs();
  });
  $("#f-label").addEventListener("change", (e) => {
    state.label = e.target.value;
    drawPrs();
  });
  $("#f-reviewer").addEventListener("change", (e) => {
    state.reviewer = e.target.value;
    drawPrs();
  });
  $("#f-mine").addEventListener("change", (e) => {
    state.mine = e.target.value;
    drawPrs();
  });
  $("#f-reset").addEventListener("click", () => {
    Object.assign(state, { q: "", label: "", reviewer: "", mine: "all" });
    $("#f-q").value = "";
    $("#f-label").value = "";
    $("#f-reviewer").value = "";
    $("#f-mine").value = "all";
    drawPrs();
  });

  for (const th of document.querySelectorAll("#pr-table th[data-sort]")) {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      // Text sorts read best A->Z first; counts and dates read best biggest-first.
      if (state.sort === k) state.dir *= -1;
      else Object.assign(state, { sort: k, dir: k === "title" || k === "author" ? 1 : -1 });
      drawPrs();
    });
  }
  for (const th of document.querySelectorAll("#w-table th[data-wsort]")) {
    th.addEventListener("click", () => {
      const k = th.dataset.wsort;
      if (state.wsort === k) state.wdir *= -1;
      else Object.assign(state, { wsort: k, wdir: k === "reviewer" ? 1 : -1 });
      drawWorkload();
    });
  }

  drawWorkload();
  drawPrs();
}

init();
