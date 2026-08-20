// Turns raw GitHub API nodes into the dashboard's data model.
//
// The domain fact that shapes all of this: GitHub DELETES a review request the moment
// that person submits a review. So `reviewRequests` (pending) and `latestReviews`
// (responded) are disjoint sets, and neither one remembers who did the assigning.
// The timeline is the only durable record of that, so we replay it.

/** A requestedReviewer/author union member -> its display login. Teams carry `name`. */
export function loginOf(actor) {
  if (!actor) return null;
  return actor.login ?? actor.name ?? null;
}

/**
 * Replay a PR's review-request events to find who currently owns each assignment.
 * Chronological, last write wins; a removal clears the assignment entirely.
 * @returns Map<reviewerLogin, {actor: string|null, at: string}>
 */
export function replayAssignments(timelineNodes) {
  const assigner = new Map();
  const events = [...timelineNodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const e of events) {
    const reviewer = loginOf(e.requestedReviewer);
    if (!reviewer) continue;
    if (e.__typename === "ReviewRequestedEvent") {
      assigner.set(reviewer, { actor: loginOf(e.actor), at: e.createdAt });
    } else {
      assigner.delete(reviewer);
    }
  }
  return assigner;
}

// Three origins, and they are genuinely different things:
//   mine      - a task force selection: the assigner requested it, on or after the start date
//   other     - somebody else requested it, OR the assigner did before the task force existed
//   volunteer - nobody ever requested them; they reviewed on their own initiative
// A volunteer is never PENDING -- with no request outstanding, there is nothing to wait on.
//
// The start date matters: the assigner has been requesting reviews as ordinary maintainer work
// for years, and without a cutoff that history is indistinguishable from the task force -- it
// would have claimed 8 merged PRs for an effort that had produced 2. `at` is an ISO timestamp
// and `start` an ISO date, so a lexical >= includes everything on the start day.
function originOf(assigner, reviewer, me, start) {
  const a = assigner.get(reviewer);
  if (!a) return "volunteer";
  return a.actor === me && (!start || a.at >= start) ? "mine" : "other";
}

/** One PR's reviewers, each resolved to {origin, state}. Task force picks sort first. */
function reviewersFor(pr, me, start) {
  const assigner = replayAssignments(pr.timelineItems.nodes);

  const pending = new Map();
  for (const { requestedReviewer } of pr.reviewRequests.nodes) {
    const login = loginOf(requestedReviewer);
    if (login) pending.set(login, requestedReviewer);
  }

  const reviewed = new Map();
  for (const review of pr.latestReviews.nodes) {
    const login = loginOf(review.author);
    if (login) reviewed.set(login, review);
  }

  const reviewers = [];
  for (const login of new Set([...pending.keys(), ...reviewed.keys()])) {
    const actor = pending.get(login) ?? reviewed.get(login).author;
    // Pending wins over a past review: a re-request after a review means they owe another look.
    const state = pending.has(login) ? "PENDING" : reviewed.get(login).state;
    const a = assigner.get(login);
    reviewers.push({
      login,
      state,
      origin: originOf(assigner, login, me, start),
      assignedBy: a?.actor ?? null,
      assignedAt: a?.at ?? null,
      // Null while pending, even for someone who reviewed an earlier round and was then
      // re-requested: that old timestamp predates the current request, so pairing the two
      // would report a negative response time for a review that has not happened yet.
      submittedAt: pending.has(login) ? null : (reviewed.get(login).submittedAt ?? null),
      isBot: actor.__typename === "Bot",
      isTeam: actor.__typename === "Team",
    });
  }

  const rank = { mine: 0, other: 1, volunteer: 2 };
  reviewers.sort((a, b) => rank[a.origin] - rank[b.origin] || a.login.localeCompare(b.login));
  return reviewers;
}

/**
 * Per-reviewer workload. `mine` is the load-balancing number: outstanding requests you
 * made. `other` is outstanding requests someone else made. `volunteer` counts reviews
 * they picked up unasked -- real effort that no pending-request count would ever show.
 * Bots are excluded here; they still appear on the PR rows.
 */
function workloadFrom(prs) {
  const byLogin = new Map();
  const seen = (login) => {
    if (!byLogin.has(login)) byLogin.set(login, { login, mine: 0, other: 0, volunteer: 0 });
    return byLogin.get(login);
  };

  for (const pr of prs) {
    for (const r of pr.reviewers) {
      if (r.isBot) continue;
      // Everyone who touches a PR gets a row, even at all-zero: someone who answered every
      // request they were given reads as 0/0/0, which is precisely "has capacity" -- the
      // question this table exists to answer. Their finished reviews still show on PR rows.
      const row = seen(r.login);
      if (r.origin === "volunteer") row.volunteer += 1;
      else if (r.state === "PENDING") row[r.origin] += 1;
    }
  }

  return [...byLogin.values()].sort(
    (a, b) =>
      b.mine - a.mine ||
      b.other - a.other ||
      b.volunteer - a.volunteer ||
      a.login.localeCompare(b.login),
  );
}

/**
 * Approvals per reviewer on merged PRs -- what the review effort actually delivered.
 * `mine` is the subset the assigner had requested, which is the task force's own output as
 * distinct from approvals that would have happened anyway.
 *
 * Everyone who reviewed a merged PR gets a row, including reviewers who only ever commented
 * (approved: 0). They engaged with the PR, so dropping them would misrepresent who is active.
 * Bots are excluded, as in the open workload.
 */
function approvalsFrom(prs) {
  const byLogin = new Map();
  for (const pr of prs) {
    for (const r of pr.reviewers) {
      if (r.isBot) continue;
      if (!byLogin.has(r.login)) byLogin.set(r.login, { login: r.login, approved: 0, mine: 0 });
      if (r.state !== "APPROVED") continue;
      const row = byLogin.get(r.login);
      row.approved += 1;
      if (r.origin === "mine") row.mine += 1;
    }
  }
  return [...byLogin.values()].sort(
    (a, b) => b.approved - a.approved || b.mine - a.mine || a.login.localeCompare(b.login),
  );
}

/* ------------------------------- how long ------------------------------------ */

const DAY_MS = 86400000;
const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const round1 = (n) => Math.round(n * 10) / 10;
const earliest = (times) => times.reduce((a, b) => (a < b ? a : b));

/**
 * Median, never mean. These distributions are severely right-skewed -- one 721-day request
 * sits in the same queue as one asked this morning -- and a mean would report a queue state
 * that describes no actual PR. `null` for an empty set rather than 0, which would read as
 * "answered instantly".
 */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return round1(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

// Age bands rather than one summary number: the median wait can read as five weeks while
// two thirds of the queue sits in a single 31+ pile, and only the bands show that shape.
const WAIT_BANDS = [7, 14, 30];
const BAND_LABELS = ["0–7d", "8–14d", "15–30d", "31d+"];
const STALLED_DAYS = 30;

const bandsOf = (values) =>
  BAND_LABELS.map((label, i) => ({
    label,
    n: values.filter(
      (v) => (i === 0 || v > WAIT_BANDS[i - 1]) && (i === WAIT_BANDS.length || v <= WAIT_BANDS[i]),
    ).length,
    // The last band is the one that matters; the page flags it rather than colouring by size.
    stalled: i === WAIT_BANDS.length,
  }));

/**
 * The task force's own queue on open PRs: how long its picks have been left unanswered.
 *
 * Counted per PR, matching the KPI row above it -- a PR with two pending picks is one PR
 * waiting -- and measured from the OLDEST outstanding pick, which is how long the PR itself
 * has been sitting on a request nobody answered.
 */
function openTaskForce(prs, now) {
  const picked = prs.filter((pr) => pr.reviewers.some((r) => r.origin === "mine"));
  const waits = [];
  for (const pr of picked) {
    const asked = pr.reviewers
      .filter((r) => r.origin === "mine" && r.state === "PENDING" && r.assignedAt)
      .map((r) => r.assignedAt);
    if (asked.length) waits.push(round1(daysBetween(earliest(asked), now)));
  }
  return {
    prs: picked.length,
    waiting: waits.length,
    answered: picked.length - waits.length,
    medianDays: median(waits),
    oldestDays: waits.length ? Math.max(...waits) : null,
    stalled: waits.filter((w) => w > STALLED_DAYS).length,
    stalledDays: STALLED_DAYS,
    bands: bandsOf(waits),
  };
}

/**
 * What the picks delivered on merged PRs, measured assignment -> merge rather than
 * open -> merge. PRs are picked up long after they were opened, and that pre-existing
 * neglect is neither something the review effort caused nor something it could have fixed;
 * charging it to the task force would make targeting stale PRs look like slowness.
 */
function mergedTaskForce(prs) {
  const durations = prs
    .filter((pr) => pr.mergedAt && pr.reviewers.some((r) => r.origin === "mine" && r.assignedAt))
    .map((pr) => ({
      number: pr.number,
      days: round1(
        daysBetween(
          earliest(pr.reviewers.filter((r) => r.origin === "mine" && r.assignedAt).map((r) => r.assignedAt)),
          pr.mergedAt,
        ),
      ),
    }))
    .sort((a, b) => a.days - b.days || a.number - b.number);

  return {
    prs: durations.length,
    durations,
    medianDays: median(durations.map((d) => d.days)),
    withinTwoWeeks: durations.filter((d) => d.days <= 14).length,
  };
}

/**
 * Every request the task force has made, across both tabs. Request-level on purpose: the
 * question is whether asking somebody produces a review, and one PR can carry several asks.
 *
 * The open/merged split is reported but is not two success rates. A PR that reached "merged"
 * has largely already been reviewed, so that subset is selected for having been answered and
 * will always look better. The combined number is the honest one.
 */
function taskForceRequests(openPrs, mergedPrs) {
  const tally = (prs) => {
    const asked = prs.flatMap((pr) => pr.reviewers.filter((r) => r.origin === "mine" && r.assignedAt));
    const answered = asked.filter((r) => r.state !== "PENDING");
    return { total: asked.length, answered: answered.length, rows: answered };
  };

  const open = tally(openPrs);
  const merged = tally(mergedPrs);
  // A review that predates its own request belongs to an earlier round, not to this one.
  const latencies = [...open.rows, ...merged.rows]
    .filter((r) => r.submittedAt && r.submittedAt > r.assignedAt)
    .map((r) => round1(daysBetween(r.assignedAt, r.submittedAt)));

  return {
    total: open.total + merged.total,
    answered: open.answered + merged.answered,
    medianResponseDays: median(latencies),
    responded: latencies.length,
    open: { total: open.total, answered: open.answered },
    merged: { total: merged.total, answered: merged.answered },
  };
}

// Draft normally means "not ready for review", which is why drafts stay off the board. JSAG
// submissions are the exception: policy has them opened as drafts and they are still meant to
// be reviewed, so for them the label -- not the draft flag -- decides. Matched case-insensitively
// so a "jsag" label is not silently dropped.
export const REVIEW_READY_DRAFT_LABEL = "JSAG";

/** An open PR the dashboard tracks: any non-draft, plus a draft the review policy marks ready. */
export const isReviewable = (pr) =>
  !pr.isDraft ||
  pr.labels.nodes.some((l) => l.name.toLowerCase() === REVIEW_READY_DRAFT_LABEL.toLowerCase());

const shape = (pr, me, start) => ({
  number: pr.number,
  title: pr.title,
  url: pr.url,
  isDraft: Boolean(pr.isDraft),
  author: loginOf(pr.author) ?? "(ghost)",
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
  mergedAt: pr.mergedAt ?? null,
  labels: pr.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
  reviewers: reviewersFor(pr, me, start),
});

/** Open PRs -> table rows, pending workload, the two gap numbers, and the wait times. */
function reconcileOpen(rawPrs, me, start, now) {
  const prs = rawPrs
    .filter(isReviewable)
    .map((pr) => shape(pr, me, start))
    .sort((a, b) => b.number - a.number);

  // Every KPI here counts PRs, not reviewer slots, so the headline numbers partition the
  // queue exactly: pendingMine + pendingOther + noOneOnHook === prs.length. A PR with two
  // pending reviewers is one PR waiting, and a PR the assigner picked counts as theirs even
  // if someone else also requested a reviewer on it -- the task force owns it either way.
  const isPending = (r) => r.state === "PENDING";
  const untriaged = prs.filter(
    (p) => (!start || p.createdAt >= start) && !p.reviewers.some((r) => r.origin === "mine"),
  );
  const waiting = prs.filter((p) => p.reviewers.some(isPending));
  const pendingMine = waiting.filter((p) => p.reviewers.some((r) => isPending(r) && r.origin === "mine"));

  return {
    prs,
    workload: workloadFrom(prs),
    taskForce: openTaskForce(prs, now),
    stats: {
      prs: prs.length,
      // Drafts on the board, i.e. the JSAG ones. Worth naming: "open PRs" here is not the
      // number GitHub shows for non-drafts, and this is the whole difference.
      drafts: prs.filter((p) => p.isDraft).length,
      draftLabel: REVIEW_READY_DRAFT_LABEL,
      // The task force's own inbox: PRs that have arrived since it began and that the
      // assigner has not put anybody on. Dated from the start deliberately -- the years of
      // backlog before it are a different problem, and burying this number in them hides the
      // one queue that can actually be kept at zero.
      untriaged: untriaged.length,
      untriagedNoReviewer: untriaged.filter((p) => p.reviewers.length === 0).length,
      // Two different gaps. `unassigned` is a PR nobody has touched at all. `noOneOnHook` also
      // catches the PR whose only reviewer volunteered a drive-by comment and owes nothing --
      // still nobody committed to reviewing it, so it's the real queue of work to hand out.
      unassigned: prs.filter((p) => p.reviewers.length === 0).length,
      noOneOnHook: prs.length - waiting.length,
      pending: waiting.length,
      pendingMine: pendingMine.length,
    },
  };
}

/** Merged PRs -> table rows and approval counts, newest merge first. */
function reconcileMerged(rawPrs, me, start, { since, months }) {
  const prs = rawPrs
    .map((pr) => shape(pr, me, start))
    .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : b.number - a.number));

  const approvals = approvalsFrom(prs);
  const taskForce = mergedTaskForce(prs);
  const approved = prs.filter((p) => p.reviewers.some((r) => r.state === "APPROVED"));

  return {
    since,
    months,
    prs,
    approvals,
    taskForce,
    stats: {
      prs: prs.length,
      approved: approved.length,
      // A merged PR nobody approved. Common on M2 and not inherently wrong -- it is the
      // baseline the task force exists to move.
      unapproved: prs.length - approved.length,
      // Merges carrying an approval from someone the assigner put there: the task force's
      // actual output. Expect this to be tiny until a full window post-dates the effort.
      taskForce: prs.filter((p) => p.reviewers.some((r) => r.state === "APPROVED" && r.origin === "mine")).length,
    },
  };
}

/** Raw API nodes -> the full data model baked into the page. */
export function reconcile(
  { open: rawOpen, merged: rawMerged = [], since = null, months = 3 },
  { me, repo, start = null, generatedAt = new Date().toISOString() },
) {
  const open = reconcileOpen(rawOpen, me, start, generatedAt);
  const merged = reconcileMerged(rawMerged, me, start, { since, months });
  return {
    generatedAt,
    repo,
    assigner: me,
    taskForceStart: start,
    taskForce: {
      // Every duration on the page is capped by the age of the effort itself: a request
      // cannot have gone unanswered for longer than the task force has existed. The medians
      // will keep climbing while that ceiling lifts, which is not the queue getting worse,
      // so the page says so rather than leaving a reader to infer a trend.
      ageDays: start ? Math.floor(daysBetween(`${start}T00:00:00Z`, generatedAt)) : null,
      requests: taskForceRequests(open.prs, merged.prs),
    },
    open,
    merged,
  };
}
