# M2 PR Task Force

A dashboard of open, non-draft pull requests on [Macaulay2/M2][m2] — who wrote them, what
they're labelled, and **who the task force put on them** — plus a reviewer workload table for spreading
review load around.

Published daily to GitHub Pages. Run `npm start` any time to regenerate it locally.

## Why the timeline, and not `requested_reviewers`

GitHub **deletes a review request the moment that person submits a review**. So "pending
requests" and "has reviewed" are disjoint sets, and neither remembers who did the assigning.
Counting `requested_reviewers` alone ranks the project's most active reviewer as idle.

This app therefore replays each PR's `ReviewRequestedEvent` / `ReviewRequestRemovedEvent`
timeline to recover who assigned whom, and sorts every (PR, reviewer) pair into one of three
origins:

| Origin | Meaning | Can it be pending? |
|---|---|---|
| **mine** | the assigner requested this review — a task force selection | yes |
| **other** | somebody else requested it | yes |
| **volunteer** | nobody ever requested them; they reviewed anyway | no — nothing was ever asked |

The PR table shows **two** visual states, because triage only asks one question: **bold** is a
task force selection, grey is anyone else's (hover any name for who requested it). Bots are
never bold whoever requested them — emphasis is for the humans carrying load. The workload
table keeps all three origins apart, because load-balancing needs the detail.

The page is public, so it names the assigner throughout rather than addressing a "you" that
most readers aren't.

## The two gap numbers

They measure different things and the difference matters:

- **no reviewer at all** — nobody has touched the PR.
- **nobody on the hook** — nobody owes it a review. Larger, because it also catches the PR
  whose only reviewer left an unrequested drive-by comment and owes nothing further.

The second is the queue of work to hand out.

## Usage

Requires Node 18+ (for built-in `fetch`) and nothing else — no dependencies, no lockfile.

```sh
npm start          # fetch, reconcile, render -> dist/
npm test           # attribution logic
```

Open `dist/index.html` directly — it needs no server. The data is baked into the page, so it
never calls the API from the browser, and no token is ever exposed to one.

**A token is required to build.** Attribution needs the timeline, and the GraphQL API rejects
unauthenticated requests outright (403) — there is no anonymous fallback that gets this right.
The build uses `GITHUB_TOKEN` if set, otherwise `gh auth token`, so a local run with the
[`gh` CLI][gh] authenticated needs no setup.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TASK_FORCE_OWNER` | `Macaulay2` | repo owner |
| `TASK_FORCE_REPO` | `M2` | repo name |
| `TASK_FORCE_ASSIGNER` | `d-torrance` | whose requests count as task force selections |

`TASK_FORCE_ASSIGNER` is deliberately independent of the token's identity: CI builds run as
`github-actions[bot]` but must still attribute to a real person.

## Deployment

`.github/workflows/build.yml` rebuilds daily (07:00 UTC) and on demand via **Run workflow**.
It publishes through `upload-pages-artifact`/`deploy-pages` rather than committing `dist/`,
so there's no daily junk commit. Set the repo's **Settings → Pages → Source** to
**GitHub Actions**.

GitHub's cron is best-effort and drifts under load; the page footer prints its real
generation time and flags a snapshot older than two days.

## Layout

| Path | |
|---|---|
| `build.js` | fetch → reconcile → render |
| `src/query.js` | GraphQL document, pagination, token resolution |
| `src/reconcile.js` | timeline replay, origins, workload |
| `src/render.js` | HTML + CSS shell |
| `src/page.js` | client-side sort/filter, inlined into the page |
| `test/` | attribution tests over a synthetic fixture |

[m2]: https://github.com/Macaulay2/M2
[gh]: https://cli.github.com/
