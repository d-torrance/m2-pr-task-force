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

test("drafts are excluded", () => {
  assert.equal(pr(900), undefined);
  assert.equal(data.open.stats.prs, 6);
});

test("PRs are listed newest first", () => {
  assert.deepEqual(
    data.open.prs.map((p) => p.number),
    [105, 104, 103, 102, 101, 100],
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
  assert.equal(who("dave").volunteer, 1);
  assert.equal(who("dave").mine, 0);
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
  assert.equal(who("reviewers-team").mine, 1);
});

test("workload counts only outstanding requests, split by who made them", () => {
  // alice is outstanding on #100, #101 and #103 -- including #103, where she already left
  // CHANGES_REQUESTED and was then re-requested.
  assert.deepEqual(who("alice"), { login: "alice", mine: 3, other: 0, volunteer: 0 });
  assert.deepEqual(who("bob"), { login: "bob", mine: 0, other: 1, volunteer: 0 });
});

test("someone who answered every request reads as zero -- present, and free", () => {
  assert.equal(who("carol").volunteer, 1);
  assert.equal(who("carol").mine, 0);
});

test("the two gap numbers measure different things", () => {
  // Only #105 has nobody at all. #102 also has nobody on the hook -- dave's approval was
  // unrequested, so no one owes it a review -- but #104's team request is still outstanding.
  assert.equal(data.open.stats.unassigned, 1);
  assert.equal(data.open.stats.noOneOnHook, 2);
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

test("the cutoff moves work out of the task force column, not off the page", () => {
  const a = cut.open.workload.find((w) => w.login === "alice");
  assert.equal(a.mine + a.other, 3); // still three outstanding requests
  assert.equal(a.mine, 1); // only #100, requested in July
  assert.equal(a.other, 2); // #101 and #103 predate the task force
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
