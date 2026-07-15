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
 * @returns Map<reviewerLogin, actorLogin|null>
 */
export function replayAssignments(timelineNodes) {
  const assigner = new Map();
  const events = [...timelineNodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const e of events) {
    const reviewer = loginOf(e.requestedReviewer);
    if (!reviewer) continue;
    if (e.__typename === "ReviewRequestedEvent") {
      assigner.set(reviewer, loginOf(e.actor));
    } else {
      assigner.delete(reviewer);
    }
  }
  return assigner;
}

// Three origins, and they are genuinely different things:
//   mine      - you requested this review (your task force selection)
//   other     - somebody else requested it
//   volunteer - nobody ever requested them; they reviewed on their own initiative
// A volunteer is never PENDING -- with no request outstanding, there is nothing to wait on.
function originOf(assigner, reviewer, me) {
  if (!assigner.has(reviewer)) return "volunteer";
  return assigner.get(reviewer) === me ? "mine" : "other";
}

/** One PR's reviewers, each resolved to {origin, state}. Sorted with yours first. */
function reviewersFor(pr, me) {
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
    reviewers.push({
      login,
      state,
      origin: originOf(assigner, login, me),
      assignedBy: assigner.get(login) ?? null,
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

/** Raw API nodes -> the full data model baked into the page. */
export function reconcile(rawPrs, { me, repo, generatedAt = new Date().toISOString() }) {
  const prs = rawPrs
    .filter((pr) => !pr.isDraft)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: loginOf(pr.author) ?? "(ghost)",
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      labels: pr.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
      reviewers: reviewersFor(pr, me),
    }))
    .sort((a, b) => b.number - a.number);

  const pending = prs.flatMap((p) => p.reviewers).filter((r) => r.state === "PENDING");

  return {
    generatedAt,
    repo,
    assigner: me,
    prs,
    workload: workloadFrom(prs),
    stats: {
      prs: prs.length,
      // Two different gaps. `unassigned` is a PR nobody has touched at all. `noOneOnHook` also
      // catches the PR whose only reviewer volunteered a drive-by comment and owes nothing --
      // still nobody committed to reviewing it, so it's the real queue of work to hand out.
      unassigned: prs.filter((p) => p.reviewers.length === 0).length,
      noOneOnHook: prs.filter((p) => !p.reviewers.some((r) => r.state === "PENDING")).length,
      pending: pending.length,
      pendingMine: pending.filter((r) => r.origin === "mine").length,
    },
  };
}
