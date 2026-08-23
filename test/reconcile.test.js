import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reconcile, replayAssignments } from "../src/reconcile.js";

const raw = JSON.parse(await readFile(new URL("./fixture.json", import.meta.url), "utf8"));
const opts = { me: "me", repo: "acme/widgets", generatedAt: "2026-07-15T00:00:00Z" };

// No cutoff: exercises the origin logic on its own.
const data = reconcile({ ...raw, since: "2026-04-15", months: 3 }, opts);
// With a cutoff, so only requests from July count as task force selections.
const cut = reconcile({ ...raw, since: "2026-04-15", months: 3 }, { ...opts, start: "2026-07-01" });

const pr = (n) => data.open.prs.find((p) => p.number === n);
const rev = (n, login) => pr(n).reviewers.find((r) => r.login === login);
const who = (login) => data.open.workload.find((w) => w.login === login);
const mpr = (n) => data.merged.prs.find((p) => p.number === n);
const appr = (d, login) => d.merged.approvals.find((a) => a.login === login);

/* --------------------------------- open tab ---------------------------------- */

test("an unlabelled draft is excluded", () => {
  assert.equal(pr(900), undefined);
  assert.equal(data.open.stats.prs, 8);
});

test("a JSAG draft is listed -- policy opens them as drafts, but they want review", () => {
  assert.equal(pr(106).isDraft, true);
  assert.equal(data.open.stats.drafts, 1);
  // And it carries its full assignment data, exactly like any other row.
  assert.equal(rev(106, "erin").origin, "mine");
  assert.equal(who("erin").waiting, 1);
});

test("the JSAG label matches whatever its casing", () => {
  const lower = JSON.parse(JSON.stringify(raw));
  const draft = lower.open.find((p) => p.number === 106);
  draft.labels.nodes[0].name = "jsag";
  const d = reconcile({ ...lower, since: "2026-04-15", months: 3 }, opts);
  assert.ok(d.open.prs.some((p) => p.number === 106));
});

test("PRs are listed newest first", () => {
  assert.deepEqual(
    data.open.prs.map((p) => p.number),
    [107, 106, 105, 104, 103, 102, 101, 100],
  );
});

test("origin is attributed from the timeline, not from the request list", () => {
  assert.equal(rev(100, "alice").origin, "mine");
  assert.equal(rev(100, "alice").assignedBy, "me");
  assert.equal(rev(100, "bob").origin, "other");
  assert.equal(rev(100, "bob").assignedBy, "otherperson");
  // Never requested by anyone -- reviewed on their own initiative.
  assert.equal(rev(100, "carol").origin, "volunteer");
  assert.equal(rev(100, "carol").assignedBy, null);
});

test("replay keeps the last event: re-requested by me after someone else's removal", () => {
  assert.equal(rev(101, "alice").origin, "mine");
  assert.equal(rev(101, "alice").assignedBy, "me");
});

test("a removed request is not an assignment, even though I made it originally", () => {
  // dave reviewed after I withdrew the request, so he volunteered -- counting him as my
  // selection would credit the task force for work it did not direct.
  assert.equal(rev(102, "dave").origin, "volunteer");
  assert.equal(rev(102, "dave").state, "APPROVED");
});

test("re-request after a review reads as pending, not as the old verdict", () => {
  assert.equal(rev(103, "alice").state, "PENDING");
});

test("state comes from latestReviews when no request is outstanding", () => {
  assert.equal(rev(100, "carol").state, "COMMENTED");
  assert.equal(rev(102, "dave").state, "APPROVED");
});

test("reviewers sort with task force picks first", () => {
  assert.deepEqual(
    pr(100).reviewers.map((r) => [r.login, r.origin]),
    [
      ["alice", "mine"],
      ["bob", "other"],
      ["carol", "volunteer"],
    ],
  );
});

test("bots show on the PR row but never rank in the workload", () => {
  const bot = rev(104, "copilot-pull-request-reviewer");
  assert.equal(bot.isBot, true);
  assert.equal(bot.origin, "volunteer");
  assert.equal(who("copilot-pull-request-reviewer"), undefined);
});

test("teams are carried by name and do count as assignments", () => {
  const team = rev(104, "reviewers-team");
  assert.equal(team.isTeam, true);
  assert.equal(team.origin, "mine");
  assert.equal(who("reviewers-team").waiting, 1);
});

test("workload splits what a reviewer owes into not-yet-reviewed and not-yet-approved", () => {
  // alice has yet to look at #100, #101 and #103 -- including #103, where she left
  // CHANGES_REQUESTED and was then re-requested, so she owes another look.
  assert.deepEqual(who("alice"), { login: "alice", waiting: 3, started: 0, total: 3 });
  // bob is the case GitHub's own view loses: still to look at #100, and on #107 he has
  // commented without approving, which deleted his request but not his part in the PR.
  assert.deepEqual(who("bob"), { login: "bob", waiting: 1, started: 1, total: 2 });
});

test("a review begun counts whether or not anyone asked for it", () => {
  // carol was never requested on #100; she commented anyway, and it is still hers to finish.
  assert.deepEqual(who("carol"), { login: "carol", waiting: 0, started: 1, total: 1 });
});

test("someone who approved everything reads as zero -- present, and free", () => {
  assert.deepEqual(who("dave"), { login: "dave", waiting: 0, started: 0, total: 0 });
});

test("the gap numbers measure different things", () => {
  const s = data.open.stats;
  // #102 and #105 have nobody on them: dave's approval on #102 finished the job, and #105 has
  // no reviewer at all. Only #105 counts as unassigned.
  assert.equal(s.noOneOnHook, 2);
  assert.equal(s.unassigned, 1);
  // #107 is the one this used to get wrong: bob commented without approving, which deleted
  // his request, and the PR then read as one nobody was handling.
  assert.equal(s.inProgress, 1);
});

test("a review underway does not count as awaiting a first look", () => {
  // #100 has carol's comment AND alice and bob still to look: pending wins, because the
  // first review is the more urgent thing missing.
  assert.equal(pr(100).reviewers.find((r) => r.login === "carol").state, "COMMENTED");
  assert.ok(data.open.prs.some((p) => p.number === 100 && p.reviewers.some((r) => r.state === "PENDING")));
  assert.equal(data.open.stats.pending, 5);
});

test("the headline counts are PRs, and the three groups partition the open queue", () => {
  // A PR with two pending reviewers is still one PR waiting, so these must add up.
  const s = data.open.stats;
  assert.equal(s.pending + s.inProgress + s.noOneOnHook, s.prs);
  assert.ok(s.pendingMine <= s.pending);
  assert.ok(s.unassigned <= s.noOneOnHook);
});

test("a deleted account does not crash the build", () => {
  assert.equal(pr(105).author, "(ghost)");
});

/* ------------------------------- start date ---------------------------------- */

test("without a start date, every request I ever made is a task force selection", () => {
  assert.equal(rev(103, "alice").origin, "mine"); // requested 2026-06-11
});

test("a request I made before the task force began is not one of its selections", () => {
  // Same PR, same requester, same data -- only the cutoff differs. It must fall out of
  // `mine`, or the task force claims credit for years of ordinary maintainer work.
  const alice = cut.open.prs.find((p) => p.number === 103).reviewers.find((r) => r.login === "alice");
  assert.equal(alice.origin, "other");
  assert.equal(alice.assignedBy, "me"); // still truthfully attributed
  assert.equal(alice.assignedAt, "2026-06-11T00:00:00Z");
});

test("a request made on the start date itself counts", () => {
  const onTheDay = reconcile({ ...raw, since: "2026-04-15", months: 3 }, { ...opts, start: "2026-07-02" });
  const alice = onTheDay.open.prs.find((p) => p.number === 100).reviewers.find((r) => r.login === "alice");
  assert.equal(alice.origin, "mine"); // requested 2026-07-02T00:00:00Z
});

test("the cutoff moves nothing in the workload -- it counts what is owed, not who asked", () => {
  // Everywhere else the cutoff re-attributes work. Here it must not: for spreading load, a
  // review alice owes is one she owes whoever requested it and whenever they did.
  assert.deepEqual(cut.open.workload, data.open.workload);
});

/* -------------------------------- merged tab --------------------------------- */

test("merged PRs are listed newest merge first", () => {
  assert.deepEqual(
    data.merged.prs.map((p) => p.number),
    [203, 200, 202, 201],
  );
});

test("merged window metadata is carried through", () => {
  assert.equal(data.merged.since, "2026-04-15");
  assert.equal(data.merged.months, 3);
  assert.equal(cut.taskForceStart, "2026-07-01");
});

test("approvals are counted per reviewer", () => {
  assert.equal(appr(data, "alice").approved, 1);
  assert.equal(appr(data, "bob").approved, 1);
});

test("only approvals from a task force selection count as its output", () => {
  // bob's approval on #201 came from a request I made in May, before the task force.
  assert.equal(appr(data, "bob").mine, 1); // no cutoff: counted
  assert.equal(appr(cut, "bob").mine, 0); // cutoff: not counted
  assert.equal(appr(cut, "bob").approved, 1); // the approval itself is untouched
  assert.equal(appr(cut, "alice").mine, 1); // requested in July -- genuinely the task force
});

test("the task force stat counts merged PRs, not approvals", () => {
  assert.equal(data.merged.stats.taskForce, 2); // #200 and #201, without a cutoff
  assert.equal(cut.merged.stats.taskForce, 1); // only #200 once May is excluded
});

test("a merged PR with no approval is counted as such", () => {
  assert.equal(data.merged.stats.prs, 4);
  assert.equal(data.merged.stats.approved, 2);
  assert.equal(data.merged.stats.unapproved, 2); // #202 (no reviews) and #203 (only a comment)
});

test("a request still outstanding when the PR merged means they never reviewed it", () => {
  assert.equal(mpr(203).reviewers.find((r) => r.login === "carol").state, "PENDING");
});

test("reviewers who only commented are listed with zero approvals, not dropped", () => {
  assert.equal(appr(data, "dave").approved, 0);
});

/* -------------------------------- wait times --------------------------------- */

test("a PR's wait runs from its oldest outstanding pick, measured against the snapshot", () => {
  const tf = data.open.taskForce;
  assert.equal(tf.waiting, 5);
  // #101's request (2026-06-04) is the oldest still unanswered, 41 days before generatedAt.
  assert.equal(tf.oldestDays, 41);
  assert.equal(tf.medianDays, 24); // waits of 11, 13, 24, 34 and 41 days
  assert.equal(tf.prs, tf.waiting + tf.answered);
});

test("the age bands partition the waiting queue, and the last band is the stalled count", () => {
  const tf = data.open.taskForce;
  assert.deepEqual(
    tf.bands.map((b) => b.n),
    [0, 2, 1, 2],
  );
  assert.equal(tf.bands.reduce((n, b) => n + b.n, 0), tf.waiting);
  // Exactly one band is flagged, and it is the >30d one the stalled figure counts.
  assert.deepEqual(tf.bands.filter((b) => b.stalled).map((b) => b.n), [tf.stalled]);
});

test("the cutoff pulls waits out of the task force queue, as it does everything else", () => {
  // #101 and #103 were requested before the task force began, so their long waits are
  // somebody else's history -- not a queue this effort is sitting on.
  assert.equal(cut.open.taskForce.waiting, 2);
  assert.equal(cut.open.taskForce.stalled, 0);
});

test("assignment -> merge is measured from the request, not from the PR opening", () => {
  const m = data.merged.taskForce;
  assert.deepEqual(m.durations, [
    { number: 200, days: 6 },
    { number: 203, days: 6 },
    { number: 201, days: 18 },
  ]);
  // #201 opened 2026-05-01 and merged 2026-05-20: 19 days on the calendar, but the task
  // force only had it for 18 of them, and the day it sat unassigned is not its to answer for.
  assert.equal(mpr(201).createdAt, "2026-05-01T00:00:00Z");
  assert.equal(m.medianDays, 6);
  assert.equal(m.withinTwoWeeks, 2);
});

test("a PR the reviewer never got to is still in the distribution", () => {
  // #203 merged with carol's request outstanding. It belongs in the durations anyway:
  // restricting them to PRs a requested reviewer actually reviewed would quietly measure
  // only the ones that went well.
  assert.ok(data.merged.taskForce.durations.some((d) => d.number === 203));
  assert.equal(mpr(203).reviewers.find((r) => r.login === "carol").state, "PENDING");
});

test("submittedAt is null while pending, even for someone who reviewed an earlier round", () => {
  // alice reviewed #103 and was then re-requested; that old review predates the new request.
  assert.equal(rev(103, "alice").state, "PENDING");
  assert.equal(rev(103, "alice").submittedAt, null);
  assert.equal(rev(100, "carol").submittedAt, "2026-07-09T00:00:00Z");
});

test("response rate is request-level, and the two tabs sum to the whole", () => {
  const rq = data.taskForce.requests;
  assert.equal(rq.total, 8);
  assert.equal(rq.answered, 2);
  assert.equal(rq.open.total + rq.merged.total, rq.total);
  assert.equal(rq.open.answered + rq.merged.answered, rq.answered);
  assert.equal(rq.medianResponseDays, 11); // alice answered in 5 days, bob in 17
});

test("a review stamped before its own request contributes no response time", () => {
  const backwards = JSON.parse(JSON.stringify(raw));
  backwards.merged.find((p) => p.number === 200).latestReviews.nodes[0].submittedAt =
    "2026-01-01T00:00:00Z";
  const d = reconcile({ ...backwards, since: "2026-04-15", months: 3 }, opts);
  // Still an answered request -- they did review -- but not a negative latency.
  assert.equal(d.taskForce.requests.answered, 2);
  assert.equal(d.taskForce.requests.responded, 1);
  assert.equal(d.taskForce.requests.medianResponseDays, 17);
});

test("the ceiling on every duration is the age of the effort, and needs a start date", () => {
  assert.equal(data.taskForce.ageDays, null); // no start configured
  assert.equal(cut.taskForce.ageDays, 14); // 2026-07-01 -> the 2026-07-15 snapshot
});

/* --------------------------------- internals --------------------------------- */

test("replayAssignments is order-independent and records when", () => {
  const events = [
    { __typename: "ReviewRequestedEvent", createdAt: "2026-01-03T00:00:00Z", actor: { login: "b" }, requestedReviewer: { login: "x" } },
    { __typename: "ReviewRequestedEvent", createdAt: "2026-01-01T00:00:00Z", actor: { login: "a" }, requestedReviewer: { login: "x" } },
  ];
  // The API returns events chronologically, but attribution must not depend on that.
  assert.deepEqual(replayAssignments(events).get("x"), { actor: "b", at: "2026-01-03T00:00:00Z" });
  assert.deepEqual(replayAssignments([...events].reverse()).get("x"), { actor: "b", at: "2026-01-03T00:00:00Z" });
});
