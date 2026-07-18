#!/usr/bin/env node
// Fetch -> reconcile -> render. Re-run this to refresh the dashboard; the page itself
// does no fetching, so the output opens straight from disk with no server.

import { mkdir, writeFile } from "node:fs/promises";
import { fetchMergedPullRequests, fetchOpenPullRequests, resolveToken } from "./src/query.js";
import { reconcile } from "./src/reconcile.js";
import { render } from "./src/render.js";

const OWNER = process.env.TASK_FORCE_OWNER || "Macaulay2";
const NAME = process.env.TASK_FORCE_REPO || "M2";
// Whose assignments count as task force selections. Deliberately NOT the token's identity:
// the CI build runs as github-actions[bot] but must still attribute to a real person.
const ME = process.env.TASK_FORCE_ASSIGNER || "d-torrance";
const MONTHS = Number(process.env.TASK_FORCE_MONTHS || 3);
// When the task force began. The assigner has requested reviews as ordinary maintainer work for
// years; without this cutoff that history is indistinguishable from the task force's own output.
const START = process.env.TASK_FORCE_START || "2026-07-06";
const OUT = new URL("./dist/", import.meta.url);

// Calendar months, not 90 days, so the window means what the page says it means.
const sinceDate = new Date();
sinceDate.setUTCMonth(sinceDate.getUTCMonth() - MONTHS);
const since = sinceDate.toISOString().slice(0, 10);

const repo = `${OWNER}/${NAME}`;
const token = resolveToken();

console.log(`Fetching ${repo}…`);
const [open, merged] = await Promise.all([
  fetchOpenPullRequests({ owner: OWNER, name: NAME, token }),
  fetchMergedPullRequests({ owner: OWNER, name: NAME, token, since }),
]);

const data = reconcile({ open, merged, since, months: MONTHS }, { me: ME, repo, start: START });

const o = data.open.stats;
console.log(`\nopen:`);
console.log(`  ${open.length} open (${open.length - o.prs} draft, ${o.prs} shown)`);
console.log(`  ${o.pending} PRs awaiting review — ${o.pendingMine} with a task force pick (by ${ME} since ${START}), ${o.pending - o.pendingMine} assigned only by others`);
console.log(`  ${o.noOneOnHook} PRs with nobody on the hook (${o.unassigned} with no reviewer at all)`);
console.log(`  ${data.open.workload.length} reviewers`);

const m = data.merged.stats;
console.log(`\nmerged since ${since} (${MONTHS} months):`);
console.log(`  ${m.prs} merged — ${m.approved} carried an approval, ${m.unapproved} none`);
console.log(`  ${m.taskForce} merged with an approval from a task force pick`);
console.log(`  ${data.merged.approvals.length} reviewers`);

await mkdir(OUT, { recursive: true });
await writeFile(new URL("index.html", OUT), render(data));
await writeFile(new URL("data.json", OUT), JSON.stringify(data, null, 2) + "\n");
console.log(`\nWrote dist/index.html and dist/data.json`);
