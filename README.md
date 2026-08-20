# M2 PR Task Force

A dashboard of pull requests on [Macaulay2/M2][m2] — who wrote them, what they're labelled, and
**who the task force put on them**. Two tabs:

- **Open** — every open PR that is up for review, plus a reviewer workload table for spreading
  review load. That means all non-drafts, and drafts labelled `JSAG` — those are opened as drafts
  by policy but are still meant to be reviewed. Other drafts are left out.
- **Merged** — everything merged in the last 3 months, plus how many each reviewer approved.

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
| **mine** | a task force selection: the assigner requested it, on or after the start date | yes |
| **other** | somebody else requested it — or the assigner did, before the task force began | yes |
| **volunteer** | nobody ever requested them; they reviewed anyway | no — nothing was ever asked |

### Why a start date

The assigner has been requesting reviews as ordinary maintainer work for years, and the API
cannot tell that apart from the task force. Without `TASK_FORCE_START` the merged view claimed
**8** PRs for an effort that had actually produced **2** — the other six were assignments from
April and May, months before the task force existed. Requests made before the cutoff are still
attributed truthfully (the tooltip names the requester and the date); they simply aren't the
task force's own output.

The PR table shows **two** visual states, because triage only asks one question: **bold** is a
task force selection, grey is anyone else's (hover any name for who requested it). Bots are
never bold whoever requested them — emphasis is for the humans carrying load. The workload
table keeps all three origins apart, because load-balancing needs the detail.

The page is public, so it names the assigner throughout rather than addressing a "you" that
most readers aren't.

## The triage number

The open tab leads with **PRs opened since the start date that the assigner has not put anybody
on** — the task force's own inbox, and the one queue that can be kept at zero. Dated from the
start deliberately: M2 has open PRs going back four years, and mixing that backlog in buries the
handful of new arrivals that actually need a decision this week.

`data.json` still carries the wider gap numbers (`unassigned`, `noOneOnHook`, and the
`pending` / `pendingMine` split), and the PR table can filter on them, but the headline row
stays on the number that implies an action.

## How long things take

Both tabs carry timing stats, scoped to the task force's own requests. Three deliberate choices:

- **Median, never mean.** The waits are severely right-skewed — a request from this morning
  shares the queue with one from 2024 — and a mean would describe no actual PR.
- **Age bands, not just the median.** The median wait can read as five weeks while two thirds
  of the queue sits in a single `31d+` pile. Only the bands show that, and the last band is the
  one the page flags.
- **Assignment → merge, not opened → merged.** PRs are picked up long after they were opened,
  so opened → merged charges the task force for neglect that predates it: measured that way its
  PRs look ~13× *slower* than a typical merge, purely because it targets stale ones.

Two caveats the page states outright, rather than leaving a reader to infer:

- **Every duration is capped by the age of the effort.** A request cannot have gone unanswered
  for longer than the task force has existed, so the medians keep climbing while that ceiling
  lifts. A rising median is not by itself a worsening queue.
- **The merged-only response rate is not a success rate.** A PR reaching "merged" has largely
  been reviewed already, so that subset is selected for having been answered — it will always
  look better than the open queue. The page leads with the combined figure.

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
| `TASK_FORCE_START` | `2026-07-06` | requests before this date aren't task force selections |
| `TASK_FORCE_MONTHS` | `3` | how far back the merged tab looks |

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
| `src/reconcile.js` | timeline replay, origins, workload, wait times |
| `src/render.js` | HTML + CSS shell |
| `src/page.js` | client-side sort/filter, inlined into the page |
| `test/` | attribution and timing tests over a synthetic fixture |

[m2]: https://github.com/Macaulay2/M2
[gh]: https://cli.github.com/
