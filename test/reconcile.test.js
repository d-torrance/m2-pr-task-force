import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reconcile, replayAssignments } from "../src/reconcile.js";

const raw = JSON.parse(await readFile(new URL("./fixture.json", import.meta.url), "utf8"));
const data = reconcile(raw, { me: "me", repo: "acme/widgets", generatedAt: "2026-07-15T00:00:00Z" });

const pr = (n) => data.prs.find((p) => p.number === n);
const rev = (n, login) => pr(n).reviewers.find((r) => r.login === login);
const who = (login) => data.workload.find((w) => w.login === login);

test("drafts are excluded", () => {
  assert.equal(pr(900), undefined);
  assert.equal(data.stats.prs, 6);
});

test("PRs are listed newest first", () => {
  assert.deepEqual(
    data.prs.map((p) => p.number),
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

test("reviewers sort with my selections first", () => {
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
  // carol volunteered once; dave's single review was unrequested. Nobody may be dropped
  // from the table just because they have nothing outstanding.
  assert.equal(who("carol").volunteer, 1);
  assert.equal(who("carol").mine, 0);
});

test("workload ranks by my queue first", () => {
  assert.equal(data.workload[0].login, "alice");
});

test("the two gap numbers measure different things", () => {
  // Only #105 has nobody at all. #102 also has nobody on the hook -- dave's approval was
  // unrequested, so no one owes it a review -- but #104's team request is still outstanding.
  assert.equal(data.stats.unassigned, 1);
  assert.equal(data.stats.noOneOnHook, 2);
});

test("pending totals split by origin", () => {
  assert.equal(data.stats.pending, 5);
  assert.equal(data.stats.pendingMine, 4);
});

test("a deleted account does not crash the build", () => {
  assert.equal(pr(105).author, "(ghost)");
});

test("replayAssignments is order-independent", () => {
  const events = [
    { __typename: "ReviewRequestedEvent", createdAt: "2026-01-03T00:00:00Z", actor: { login: "b" }, requestedReviewer: { login: "x" } },
    { __typename: "ReviewRequestedEvent", createdAt: "2026-01-01T00:00:00Z", actor: { login: "a" }, requestedReviewer: { login: "x" } },
  ];
  // The API returns events chronologically, but attribution must not depend on that.
  assert.equal(replayAssignments(events).get("x"), "b");
  assert.equal(replayAssignments([...events].reverse()).get("x"), "b");
});
