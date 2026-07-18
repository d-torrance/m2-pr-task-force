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

const shape = (pr, me, start) => ({
  number: pr.number,
  title: pr.title,
  url: pr.url,
  author: loginOf(pr.author) ?? "(ghost)",
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
  mergedAt: pr.mergedAt ?? null,
  labels: pr.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
  reviewers: reviewersFor(pr, me, start),
});

/** Open PRs -> table rows, pending workload, and the two gap numbers. */
function reconcileOpen(rawPrs, me, start) {
  const prs = rawPrs
    .filter((pr) => !pr.isDraft)
    .map((pr) => shape(pr, me, start))
    .sort((a, b) => b.number - a.number);

  // Every KPI here counts PRs, not reviewer slots, so the headline numbers partition the
  // queue exactly: pendingMine + pendingOther + noOneOnHook === prs.length. A PR with two
  // pending reviewers is one PR waiting, and a PR the assigner picked counts as theirs even
  // if someone else also requested a reviewer on it -- the task force owns it either way.
  const isPending = (r) => r.state === "PENDING";
  const waiting = prs.filter((p) => p.reviewers.some(isPending));
  const pendingMine = waiting.filter((p) => p.reviewers.some((r) => isPending(r) && r.origin === "mine"));

  return {
    prs,
    workload: workloadFrom(prs),
    stats: {
      prs: prs.length,
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
  const approved = prs.filter((p) => p.reviewers.some((r) => r.state === "APPROVED"));

  return {
    since,
    months,
    prs,
    approvals,
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
  return {
    generatedAt,
    repo,
    assigner: me,
    taskForceStart: start,
    open: reconcileOpen(rawOpen, me, start),
    merged: reconcileMerged(rawMerged, me, start, { since, months }),
  };
}
