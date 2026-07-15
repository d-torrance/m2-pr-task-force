import { execFileSync } from "node:child_process";

const API = "https://api.github.com/graphql";

// Every field the dashboard needs, for one page of PRs.
//
// timelineItems is filtered to the two review-request events; its `nodes` list is the
// complete filtered set. (Its `totalCount` is NOT filtered -- it counts the entire
// timeline -- so it must never be used to detect truncation.) Real per-PR
// review-request counts run to a couple of dozen at most, well inside `first: 100`.
const QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        isDraft
        createdAt
        updatedAt
        author { login }
        labels(first: 50) { nodes { name color } }
        reviewRequests(first: 50) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Bot { login }
              ... on Team { name }
            }
          }
        }
        latestReviews(first: 50) {
          nodes {
            state
            submittedAt
            author { __typename login }
          }
        }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT], first: 100) {
          nodes {
            __typename
            ... on ReviewRequestedEvent {
              createdAt
              actor { login }
              requestedReviewer {
                __typename
                ... on User { login }
                ... on Bot { login }
                ... on Team { name }
              }
            }
            ... on ReviewRequestRemovedEvent {
              createdAt
              actor { login }
              requestedReviewer {
                __typename
                ... on User { login }
                ... on Bot { login }
                ... on Team { name }
              }
            }
          }
        }
      }
    }
  }
}`;

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

async function post(token, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "m2-pr-task-force",
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data.repository.pullRequests;
}

/** Fetch every open PR, following cursors. Returns raw API nodes, drafts included. */
export async function fetchOpenPullRequests({ owner, name, token }) {
  const all = [];
  let cursor = null;
  do {
    const page = await post(token, { owner, name, cursor });
    all.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}
