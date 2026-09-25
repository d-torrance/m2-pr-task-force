import { execFileSync } from "node:child_process";

const API = "https://api.github.com/graphql";

// Every field the dashboard needs from a PR, shared by the open and merged queries.
//
// timelineItems is filtered to the two review-request events; its `nodes` list is the
// complete filtered set. (Its `totalCount` is NOT filtered -- it counts the entire
// timeline -- so it must never be used to detect truncation.) Real per-PR
// review-request counts run to a couple of dozen at most, well inside `first: 100`.
const FRAGMENTS = `
fragment Reviewer on RequestedReviewer {
  __typename
  ... on User { login }
  ... on Bot { login }
  ... on Team { name }
}
fragment PRFields on PullRequest {
  number
  title
  url
  isDraft
  createdAt
  updatedAt
  mergedAt
  author { login }
  labels(first: 50) { nodes { name color } }
  reviewRequests(first: 50) { nodes { requestedReviewer { ...Reviewer } } }
  latestReviews(first: 50) { nodes { state submittedAt author { __typename login } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT], first: 100) {
    nodes {
      __typename
      ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ...Reviewer } }
      ... on ReviewRequestRemovedEvent { createdAt actor { login } requestedReviewer { ...Reviewer } }
    }
  }
}`;

const OPEN_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ...PRFields }
    }
  }
}${FRAGMENTS}`;

// The pullRequests connection cannot filter by merge date, so merged PRs come from search,
// whose `merged:>=` qualifier can. Search returns an Issue|PullRequest union, so non-PR
// nodes arrive as empty objects and are dropped by the caller.
const MERGED_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ...PRFields }
  }
}${FRAGMENTS}`;

// The second fetch: what the author has done and every review round, which is what whose turn
// it is depends on. Asked only for the PRs the task force has a pick on (reconcile.js
// pickedNumbers) rather than for every open PR, so the first query stays as light as it was.
//
// `last: 100` comments and `first: 100` reviews are not paginated. What falls outside them is
// a PR with more than 100 comments since the author's first answer, which can only make a wait
// read shorter -- the safe direction for a list of stalls.
const ACTIVITY_FRAGMENT = `
fragment Activity on PullRequest {
  commits(last: 1) { nodes { commit { committedDate } } }
  comments(last: 100) { nodes { author { login } createdAt } }
  reviews(first: 100) { nodes { state submittedAt author { __typename login } } }
}`;
// PRs per query, each under its own alias. Small enough to stay well inside the node limit.
const ACTIVITY_BATCH = 20;

/** Author activity for the given open PR numbers, keyed by number. */
export async function fetchActivity({ owner, name, token, numbers }) {
  const out = {};
  for (let i = 0; i < numbers.length; i += ACTIVITY_BATCH) {
    const batch = numbers.slice(i, i + ACTIVITY_BATCH);
    // The numbers come from the API as integers, so interpolating them is safe.
    const fields = batch.map((n) => `p${n}: pullRequest(number: ${Number(n)}) { ...Activity }`).join("\n    ");
    const query = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}${ACTIVITY_FRAGMENT}`;
    const data = await post(token, query, { owner, name });
    for (const n of batch) out[n] = data.repository[`p${n}`];
  }
  return out;
}

// GITHUB_TOKEN in CI; the gh CLI's token locally, so a local run needs no setup.
// Attribution is impossible without a token: unauthenticated GraphQL is a hard 403.
export function resolveToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.\n" +
        "A token is required: the GraphQL API rejects unauthenticated requests.",
    );
  }
}

async function post(token, query, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "m2-pr-task-force",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

/** Follow cursors until a connection is exhausted. `pick` returns the connection. */
async function paginate(token, query, variables, pick) {
  const all = [];
  let cursor = null;
  do {
    const conn = pick(await post(token, query, { ...variables, cursor }));
    all.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

/** Every open PR, drafts included -- the caller filters. */
export function fetchOpenPullRequests({ owner, name, token }) {
  return paginate(token, OPEN_QUERY, { owner, name }, (d) => d.repository.pullRequests);
}

/** PRs merged on or after `since` (a YYYY-MM-DD string). */
export async function fetchMergedPullRequests({ owner, name, token, since }) {
  const q = `repo:${owner}/${name} is:pr is:merged merged:>=${since}`;
  const nodes = await paginate(token, MERGED_QUERY, { q }, (d) => d.search);
  // Search's union yields `{}` for anything that isn't a PullRequest.
  return nodes.filter((n) => n && n.number);
}
