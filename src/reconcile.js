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
 * Chronological; a removal clears everything asked of that person before it, so what is left
 * is every request still standing, oldest first. Plural because GitHub records a re-request as
 * a new event and never removes the old one: one reviewer can be under several live asks from
 * several people at once, and which of them attribution belongs to is not this function's call.
 * @returns Map<reviewerLogin, Array<{actor: string|null, at: string}>>
 */
export function replayAssignments(timelineNodes) {
  const assigner = new Map();
  const events = [...timelineNodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const e of events) {
    const reviewer = loginOf(e.requestedReviewer);
    if (!reviewer) continue;
    if (e.__typename === "ReviewRequestedEvent") {
      assigner.set(reviewer, [...(assigner.get(reviewer) ?? []), { actor: loginOf(e.actor), at: e.createdAt }]);
    } else {
      assigner.delete(reviewer);
    }
  }
  return assigner;
}

/**
 * Which of a reviewer's live requests attribution reads from: the assigner's own first, if the
 * task force ever asked this person and the ask still stands, otherwise the most recent.
 *
 * Last-write-wins would be wrong here, and visibly so: an author who nudges a reviewer the task
 * force picked -- a re-request, which GitHub files as a fresh event -- would take the pick away
 * from the task force and hand it to themselves. The earliest of the assigner's own requests is
 * also the honest clock: it is when the task force started waiting.
 */
function attribute(requests, me, start) {
  if (!requests?.length) return null;
  return requests.find((r) => r.actor === me && (!start || r.at >= start)) ?? requests.at(-1);
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
function originOf(request, me, start) {
  if (!request) return "volunteer";
  return request.actor === me && (!start || request.at >= start) ? "mine" : "other";
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
    const a = attribute(assigner.get(login), me, start);
    reviewers.push({
      login,
      state,
      origin: originOf(a, me, start),
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
 * Per-reviewer workload: the task force's own queue, one row per reviewer it has put on an
 * open PR. These are exactly the (PR, reviewer) pairs the PR table sets in bold, so the table
 * and the rows agree about who the task force has asked for what.
 *
 * Three states, read off whose turn it is (see turnOf):
 *   waiting  - their move, and they have not reviewed since they were picked: a first look
 *   followup - their move, and they have reviewed before: the author has answered since
 *   author   - the author owes a reply to a review, so there is nothing to ask this person yet
 * `total` is all three: every task force PR this person is on, since one waiting on the author
 * is still theirs even with nothing to do today. The split is what says which are their move --
 * a single "reviewed, not approved" column once ranked a reviewer the author owed three replies
 * alongside one sitting on three answers.
 *
 * Only `waiting` survives in GitHub's own view of things, because it deletes the request as
 * soon as a review is submitted. Counting that alone -- as this table once did -- reported the
 * project's most engaged reviewers as carrying nothing, since the moment they comment their
 * request disappears and the PR still isn't approved.
 *
 * Requests the task force did not make are left out, and so are the people who only ever
 * appear that way: a maintainer who comments on everything unasked would otherwise top a
 * table meant for deciding who to ask next, on work nobody asked them for. Their reviews
 * still show on the PR rows, in grey. `TASK_FORCE_START` therefore moves rows here, as it
 * does everywhere else. Bots never rank, whoever requested them.
 */
function workloadFrom(prs) {
  const byLogin = new Map();
  const seen = (login) => {
    if (!byLogin.has(login)) byLogin.set(login, { login, waiting: 0, followup: 0, author: 0, total: 0 });
    return byLogin.get(login);
  };

  for (const pr of prs) {
    for (const r of pr.reviewers) {
      if (r.isBot || r.origin !== "mine") continue;
      // A pick whose every review is in gets a row at zero rather than none at all: that is
      // precisely "has capacity", which is the question this table exists to answer.
      const row = seen(r.login);
      if (r.turn === "first") row.waiting += 1;
      else if (r.turn === "followup") row.followup += 1;
      else if (r.turn === "author") row.author += 1;
    }
  }

  for (const row of byLogin.values()) row.total = row.waiting + row.followup + row.author;

  return [...byLogin.values()].sort(
    (a, b) => b.total - a.total || b.waiting - a.waiting || a.login.localeCompare(b.login),
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
//
// The last band starts at the same line `assigned.sh --summary` draws by default, so the email
// and the page agree about which waits are long. Both count whole days, and both include the
// line itself: 21 days is in, 20.9 is not.
const WAIT_BANDS = [7, 14, 20];
const BAND_LABELS = ["0–7d", "8–14d", "15–20d", "21d+"];
const STALLED_DAYS = 21;

const bandsOf = (values) =>
  BAND_LABELS.map((label, i) => ({
    label,
    n: values.map(Math.floor).filter(
      (v) => (i === 0 || v > WAIT_BANDS[i - 1]) && (i === WAIT_BANDS.length || v <= WAIT_BANDS[i]),
    ).length,
    // The last band is the one that matters; the page flags it rather than colouring by size.
    stalled: i === WAIT_BANDS.length,
  }));

/**
 * The task force's own queue on open PRs: how long PRs have been waiting on its picks.
 *
 * Counted per PR, matching the KPI row above it -- a PR with two picks owing a look is one PR
 * waiting -- and measured from the longest-waiting pick (see withTurns). A follow-up counts as
 * much as a first look: a pick who reviewed once and went quiet after the author answered is
 * the same stall, and counting only outstanding requests hid every one of them.
 */
function openTaskForce(prs, now) {
  const picked = prs.filter((pr) => pr.taskForce);
  const kind = (k) => picked.filter((pr) => pr.taskForce.kind === k).length;
  const waits = picked
    .filter((pr) => pr.taskForce.kind === "first" || pr.taskForce.kind === "followup")
    .map((pr) => round1(daysBetween(pr.taskForce.since, now)));
  return {
    prs: picked.length,
    waiting: waits.length,
    firstLook: kind("first"),
    followup: kind("followup"),
    onAuthor: kind("author"),
    done: kind("done"),
    medianDays: median(waits),
    oldestDays: waits.length ? Math.max(...waits) : null,
    stalled: waits.filter((w) => Math.floor(w) >= STALLED_DAYS).length,
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

/* ------------------------------- whose turn ---------------------------------- */

// ISO timestamps compare correctly as strings. Nulls are skipped, so a missing time never wins.
const latest = (times) => times.filter(Boolean).reduce((a, b) => (a > b ? a : b), null);
const day = (iso) => iso.slice(0, 10);

/**
 * What a PR's author has done, and every review from anybody else, oldest first. `act` is
 * the second fetch (query.js fetchActivity): comments, the last commit, and every review
 * round, which `latestReviews` collapses to one per person. Without it this falls back to
 * what the first fetch has -- enough to run, but blind to anything the author did.
 *
 * Bot reviews are left out: a bot asking the author for something is not a reviewer handing
 * the PR back, and counting it would park every PR Copilot touched on the author's side.
 */
function activityOf(pr, act) {
  const author = loginOf(pr.author);
  const reviews = (act?.reviews.nodes ?? pr.latestReviews.nodes)
    // A review still in draft has no submittedAt, and nobody else can see it yet.
    .filter((v) => v.submittedAt && v.state !== "PENDING")
    .map((v) => ({ login: loginOf(v.author), isBot: v.author?.__typename === "Bot", state: v.state, at: v.submittedAt }))
    .sort((a, b) => a.at.localeCompare(b.at));
  // Opening the PR counts as its first push.
  const lastPush = latest([pr.createdAt, ...(act?.commits.nodes ?? []).map((n) => n.commit.committedDate)]);
  // Everything the author has done, review-thread replies of their own included.
  const authorActs = [
    pr.createdAt,
    lastPush,
    ...(act?.comments.nodes ?? []).filter((c) => author && loginOf(c.author) === author).map((c) => c.createdAt),
    ...reviews.filter((v) => author && v.login === author).map((v) => v.at),
  ];
  return {
    reviews: reviews.filter((v) => v.login !== author && !v.isBot),
    authorActs,
    authorAt: latest(authorActs),
    lastPush,
  };
}

/**
 * Whose move it is on one pick, since when, and the story of how it got there -- the same rules
 * as `assigned.sh --summary`, which is where they were worked out.
 *
 * The move belongs to a side, not a person: reviewers confer, so any review that asks the author
 * for something (anything but an approval) and that the author has not answered puts the PR on
 * the author's side, whoever wrote it. Once the author answers, it is back with the reviewers,
 * and the wait runs from that FIRST answer: later comments do not restart it, or an author
 * pinging for news would make the wait look fresh. A later push does, since until the fix is in
 * there may be nothing new to review. Never earlier than the pick: what a reviewer is late on
 * starts the day they were asked.
 *
 * A pick who has reviewed since being asked owes a follow-up, not a first look -- including one
 * the author re-requested, whom GitHub lists as pending just like somebody never asked before.
 *
 * `picks` is every task force pick on the PR: the story names the last review by one of them,
 * since a review from outside helps the PR but is not what the pick is following up.
 */
function turnOf(pr, r, a, picks) {
  const pickAt = r.assignedAt;
  const firstAnswerAfter = (t) => {
    const later = a.authorActs.filter((x) => x > t);
    return later.length ? earliest(later) : null;
  };
  const lastDemand = a.reviews.filter((v) => v.state !== "APPROVED").at(-1);

  const ev = (at, text) => ({ at, text });
  const told = (events, tail) =>
    [...events]
      .sort((x, y) => x.at.localeCompare(y.at))
      .map((e) => e.text)
      .concat(tail)
      .join(", ");
  const picked = ev(pickAt, `picked ${day(pickAt)}`);

  if (lastDemand && lastDemand.at > a.authorAt && lastDemand.at > pickAt) {
    return {
      turn: "author",
      turnSince: lastDemand.at,
      story: told([picked, ev(lastDemand.at, `${lastDemand.login} reviewed ${day(lastDemand.at)}`)], "author has not responded"),
    };
  }

  const answered = lastDemand ? firstAnswerAfter(lastDemand.at) : null;
  const since = latest([pickAt, answered, a.lastPush]);

  const tf = a.reviews.filter((v) => picks.has(v.login));
  const tfDemand = tf.filter((v) => v.state !== "APPROVED").at(-1);
  const tfApproval = tf.filter((v) => v.state === "APPROVED" && v.login !== r.login && (!tfDemand || v.at > tfDemand.at)).at(-1);
  // A push only earns a mention when it is what started the clock.
  const pushed = since === a.lastPush && a.lastPush > pr.createdAt ? [ev(a.lastPush, `last pushed ${day(a.lastPush)}`)] : [];
  const approved = tfApproval ? [ev(tfApproval.at, `${tfApproval.login} approved ${day(tfApproval.at)}`)] : [];
  const nothing = `nothing from ${r.login} since`;

  let events;
  let tail;
  if (tfDemand && a.authorAt > tfDemand.at) {
    const responded = firstAnswerAfter(tfDemand.at);
    events = [
      ev(tfDemand.at, `${tfDemand.login} reviewed ${day(tfDemand.at)}`),
      ev(responded, `author responded ${day(responded)}`),
      // Said once is enough when the push came the same day.
      ...pushed.filter((e) => day(e.at) !== day(responded)),
      ...approved,
    ];
    tail = approved.length ? nothing : "no review since";
  } else if (!tfDemand && approved.length) {
    events = [...approved, ...pushed];
    tail = nothing;
  } else if (!tf.length) {
    events = [ev(pr.createdAt, `opened ${day(pr.createdAt)}`), ...pushed];
    tail = "no task force review since";
  } else {
    const last = tf.at(-1);
    events = [ev(last.at, `${last.login} reviewed ${day(last.at)}`), ...pushed];
    tail = nothing;
  }

  const reviewedSincePick = a.reviews.some((v) => v.login === r.login && v.at >= pickAt);
  return { turn: reviewedSincePick ? "followup" : "first", turnSince: since, story: told([picked, ...events], tail) };
}

/**
 * Stamp each task force pick on an open PR with whose turn it is (see turnOf), and the PR with
 * the pick it has waited on longest. `taskForce` is null on a PR with no pick, and its `kind`
 * is "first" or "followup" while a pick owes a look, "author" when every pick still owing
 * something is waiting on the author, and "done" when they have all approved.
 */
function withTurns(pr, raw, act) {
  const picks = new Set(pr.reviewers.filter((r) => r.origin === "mine").map((r) => r.login));
  if (!picks.size) return { ...pr, taskForce: null };

  const a = activityOf(raw, act);
  const reviewers = pr.reviewers.map((r) =>
    r.origin !== "mine" || r.isBot || r.state === "APPROVED" ? r : { ...r, ...turnOf(raw, r, a, picks) },
  );
  const oldest = (turns) =>
    reviewers.filter((r) => turns.includes(r.turn)).sort((x, y) => x.turnSince.localeCompare(y.turnSince))[0];
  const owed = oldest(["first", "followup"]) ?? oldest(["author"]);
  return {
    ...pr,
    reviewers,
    taskForce: owed
      ? { kind: owed.turn, reviewer: owed.login, since: owed.turnSince, story: owed.story }
      : { kind: "done", reviewer: null, since: null, story: null },
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

/**
 * The open PRs worth the second fetch: every reviewable one with a task force pick on it.
 * Whose turn it is only matters for those, and they are a fraction of the open queue.
 */
export const pickedNumbers = (rawPrs, { me, start = null }) =>
  rawPrs
    .filter(isReviewable)
    .filter((pr) => reviewersFor(pr, me, start).some((r) => r.origin === "mine"))
    .map((pr) => pr.number);

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

/**
 * Open PRs -> table rows, reviewer workload, the gap numbers, and the wait times. `activity`
 * is the second fetch, keyed by PR number; a PR missing from it falls back (see activityOf).
 */
function reconcileOpen(rawPrs, activity, me, start, now) {
  const prs = rawPrs
    .filter(isReviewable)
    .map((pr) => withTurns(shape(pr, me, start), pr, activity[pr.number]))
    .sort((a, b) => b.number - a.number);

  // Every KPI here counts PRs, not reviewer slots, so the headline numbers partition the
  // queue exactly: pending + inProgress + noOneOnHook === prs.length. A PR with two pending
  // reviewers is one PR waiting, and a PR the assigner picked counts as theirs even if
  // someone else also requested a reviewer on it -- the task force owns it either way.
  const isPending = (r) => r.state === "PENDING";
  // A submitted review that is not an approval: that reviewer is engaged and the PR still
  // needs their sign-off. This is the group GitHub's request list cannot see, since it
  // deletes the request the moment the review lands -- see workloadFrom.
  const isUnderway = (r) => !isPending(r) && r.state !== "APPROVED";
  const untriaged = prs.filter(
    (p) => (!start || p.createdAt >= start) && !p.reviewers.some((r) => r.origin === "mine"),
  );
  const waiting = prs.filter((p) => p.reviewers.some(isPending));
  // Awaiting a first review takes precedence: if anyone is still to look at all, that is the
  // more urgent thing about the PR, so the three groups stay disjoint.
  const underway = prs.filter((p) => !p.reviewers.some(isPending) && p.reviewers.some(isUnderway));
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
      // Three states, because "waiting" and "abandoned" are different problems: `pending` is
      // waiting on a first look, `inProgress` has a review underway that no request records
      // any more, and `noOneOnHook` is what's left -- the real queue of work to hand out.
      // Counting the middle group as nobody's, as this once did, put 13 of M2's 21 supposedly
      // untended PRs in a pile where somebody was already mid-review.
      pending: waiting.length,
      pendingMine: pendingMine.length,
      // PRs where it is a task force pick's move -- a first look or a follow-up. The headline
      // number, and the same one the wait times below it measure.
      waitingMine: prs.filter((p) => p.taskForce?.kind === "first" || p.taskForce?.kind === "followup").length,
      inProgress: underway.length,
      noOneOnHook: prs.length - waiting.length - underway.length,
      // A PR nobody has touched at all: a strict subset of noOneOnHook, and the only one of
      // these where there is no one even to nudge.
      unassigned: prs.filter((p) => p.reviewers.length === 0).length,
    },
  };
}

/** Merged PRs -> table rows and approval counts, newest merge first. */
// The short window the merged tab reports beside the full one, in days.
const RECENT_DAYS = 30;

function reconcileMerged(rawPrs, me, start, { since, months, now }) {
  const prs = rawPrs
    .map((pr) => shape(pr, me, start))
    .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : b.number - a.number));

  const approvals = approvalsFrom(prs);
  const taskForce = mergedTaskForce(prs);
  // Merges the task force had a pick on: its actual output. Deliberately not "approved by a
  // pick", which misses real task force reviews that never show as one -- a pick with merge
  // rights who approves by merging, or one who reviewed alongside a maintainer who then
  // approved for both. The same PRs the assignment -> merge figures measure.
  const picked = prs.filter((p) => p.reviewers.some((r) => r.origin === "mine"));
  const recentSince = new Date(Date.parse(now) - RECENT_DAYS * DAY_MS).toISOString();

  return {
    since,
    months,
    prs,
    approvals,
    taskForce,
    stats: {
      prs: prs.length,
      taskForce: picked.length,
      // The same, over the last RECENT_DAYS: the full window is mostly history once the effort
      // is a few months old, and this is the number that says what it is doing now.
      taskForceRecent: picked.filter((p) => p.mergedAt >= recentSince).length,
      recentDays: RECENT_DAYS,
      recentSince: day(recentSince),
    },
  };
}

/** Raw API nodes -> the full data model baked into the page. */
export function reconcile(
  { open: rawOpen, merged: rawMerged = [], activity = {}, since = null, months = 3 },
  { me, repo, start = null, generatedAt = new Date().toISOString() },
) {
  const open = reconcileOpen(rawOpen, activity, me, start, generatedAt);
  const merged = reconcileMerged(rawMerged, me, start, { since, months, now: generatedAt });
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
