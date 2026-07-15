#!/usr/bin/env node
// Fetch -> reconcile -> render. Re-run this to refresh the dashboard; the page itself
// does no fetching, so the output opens straight from disk with no server.

import { mkdir, writeFile } from "node:fs/promises";
import { fetchOpenPullRequests, resolveToken } from "./src/query.js";
import { reconcile } from "./src/reconcile.js";
import { render } from "./src/render.js";

const OWNER = process.env.TASK_FORCE_OWNER || "Macaulay2";
const NAME = process.env.TASK_FORCE_REPO || "M2";
// Whose assignments count as task force selections. Deliberately NOT the token's identity:
// the CI build runs as github-actions[bot] but must still attribute to a real person.
const ME = process.env.TASK_FORCE_ASSIGNER || "d-torrance";
const OUT = new URL("./dist/", import.meta.url);

const repo = `${OWNER}/${NAME}`;
console.log(`Fetching open pull requests for ${repo}…`);

const raw = await fetchOpenPullRequests({ owner: OWNER, name: NAME, token: resolveToken() });
const data = reconcile(raw, { me: ME, repo });

const { prs, pending, pendingMine, unassigned, noOneOnHook } = data.stats;
console.log(`  ${raw.length} open (${raw.length - prs} draft, ${prs} shown)`);
console.log(`  ${pending} pending review requests — ${pendingMine} assigned by ${ME}, ${pending - pendingMine} by others`);
console.log(`  ${noOneOnHook} PRs with nobody on the hook (${unassigned} with no reviewer at all)`);
console.log(`  ${data.workload.length} reviewers`);

await mkdir(OUT, { recursive: true });
await writeFile(new URL("index.html", OUT), render(data));
await writeFile(new URL("data.json", OUT), JSON.stringify(data, null, 2) + "\n");
console.log(`\nWrote dist/index.html and dist/data.json`);
