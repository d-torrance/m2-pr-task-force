#!/bin/bash
set -euo pipefail

usage() {
  cat <<EOF
usage: $(basename "$0") [--summary | --all] [--days N] [username]

Report on a reviewer's Macaulay2/M2 task force queue: the open PRs the task force has
picked them for and not yet had their approval on, and whose move each one is -- the same
PRs, and the same statuses, as their row in the website's reviewer workload table.

  --summary   plain-text list of the picks that have been waiting on the reviewer the
              longest, for pasting into an email, instead of the table
  --all       also list the reviewer's other open reviews (requested by somebody else,
              volunteered, or a draft) and every other PR they have reviewed
  --days N    how long a wait counts as long (default 21, --summary only)
  username    whose queue to report on (default: the authenticated user)
  -h, --help  show this help and exit

A task force pick is a review request made by the task force, set by the environment:

  TASK_FORCE_ASSIGNER  whose review requests count (default d-torrance)
  TASK_FORCE_START     ignore requests before this date (default 2026-07-06)

Needs the GitHub CLI, gh, installed and authenticated.
EOF
}

summary=false
all=false
days=21
arg_login=""

while [ $# -gt 0 ]; do
  case $1 in
    --summary) summary=true ;;
    --all) all=true ;;
    --days) shift; days=${1:-} ;;
    --days=*) days=${1#*=} ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      if [ -n "$arg_login" ]; then
        echo "too many arguments" >&2
        usage >&2
        exit 1
      fi
      arg_login=$1
      ;;
  esac
  shift
done

case $days in
  "" | *[!0-9]*) echo "--days takes a whole number of days" >&2; exit 1 ;;
esac

if $summary && $all; then
  echo "--all adds tables, and --summary has none: use one or the other" >&2
  exit 1
fi

viewer_login=${arg_login:-$(gh api user --jq '.login')}

# Who the task force is, matching build.js: whose requests count as its selections, and when it
# began. The assigner has requested reviews as ordinary maintainer work for years, so without
# the cutoff that history is indistinguishable from the task force.
assigner=${TASK_FORCE_ASSIGNER:-d-torrance}
start=${TASK_FORCE_START:-2026-07-06}

# Color for a terminal, none for a pipe or a file, and none for anybody who asked for none.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then color=true; else color=false; fi

# Everything the jq programs below need from the shell, as jq definitions.
defs="def me: \"$viewer_login\";
def days: $days;
def assigner: \"$assigner\";
def start: \"$start\";
def use_color: $color;"

# Shared by every jq program here.
common=$(cat <<'JQ'
def date: fromdateiso8601 | strftime("%Y-%m-%d");
def plural(n; unit): "\(n) \(unit)" + (if n == 1 then "" else "s" end);
def age: (now - fromdateiso8601) / 86400 | floor;
# How long ago, as the website prints it.
def ago: age | if . == 0 then "today" elif . < 30 then "\(.)d" elif . < 365 then "\(. / 30 | floor)mo"
  else "\(. / 365 * 10 | floor / 10)y" end;
def cut($n): if length > $n then .[0:$n - 1] + "…" else . end;
def pad($w): . + ([range($w - length)] | map(" ") | join(""));
def paint($code): if use_color and $code != null then "\u001b[\($code)m\(.)\u001b[0m" else . end;
# A table with a bold title. Each row is {cells, color}: the color goes on the first two
# cells, the ID and the status, as it always has. Padded before it is painted, since the
# escape codes would otherwise count toward the width.
def table($title; $head; $rows):
  ([$head] + [$rows[].cells]) as $all
  | [range($head | length) as $i | [$all[][$i] | length] | max] as $w
  | ($title | paint("1")) + "\n\n"
    + ([range($head | length) as $i | $head[$i] | pad($w[$i]) | paint("4")] | join("  ")) + "\n"
    + ([$rows[] | . as $row
        | [range(.cells | length) as $i
           | .cells[$i] | pad($w[$i]) | paint(if $i < 2 then $row.color else null end)]
        | join("  ") | sub(" +$"; "")] | join("\n"));
# Open, and up for review: any non-draft, plus a draft labelled JSAG, which the review policy
# opens as a draft on purpose. The website tracks the same set.
def reviewable: (.isDraft | not) or any(.labels.nodes[]; .name | ascii_downcase == "jsag");
JQ
)

# The task force picks on open PRs that this reviewer has not signed off on, with whose move
# each one is and the story of how it got there -- the rules the website uses, which were
# worked out here first.
#
# The move belongs to a side, not a person: reviewers confer, and two of them who look at a PR
# together post once between them, so one going quiet after a colleague reviewed is not a
# stall. A review that asks the author for something (anything but an approval) and that the
# author has not answered is therefore the author's move whoever wrote it. Once the author
# answers -- pushing, commenting, or reviewing their own PR -- the move is back with the
# reviewers, and the wait runs from that first answer. Later comments do not restart it, or an
# author pinging for news would make the wait look fresh; a later push does, since until it
# lands there may be nothing new to review. Bot reviews do not count.
#
# An approval by somebody else asks the author for nothing, so it leaves the move where it
# was: if this reviewer has not been back since one landed, their sign-off is what the PR is
# still waiting on.
#
# A pick who has reviewed since being asked owes a follow-up review, not a first one --
# including one the author re-requested, whom GitHub lists as pending like somebody never
# asked.
#
# GraphQL rather than `gh pr list --json commits`, which asks for every commit of every PR and
# blows the server's node limit; here one PR needs only its last commit.
query=$(cat <<'GRAPHQL'
query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number url title createdAt updatedAt isDraft
        author { login }
        labels(first: 50) { nodes { name } }
        commits(last: 1) { nodes { commit { committedDate } } }
        comments(last: 100) { nodes { author { login } createdAt } }
        reviewRequests(first: 30) {
          nodes { requestedReviewer { __typename ... on User { login } } }
        }
        reviews(first: 100) { nodes { author { __typename login } state submittedAt } }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT], first: 100) {
          nodes {
            __typename
            ... on ReviewRequestedEvent {
              createdAt actor { login } requestedReviewer { __typename ... on User { login } }
            }
            ... on ReviewRequestRemovedEvent {
              createdAt actor { login } requestedReviewer { __typename ... on User { login } }
            }
          }
        }
      }
    }
  }
}
GRAPHQL
)

picks=$(cat <<'JQ'
def picks:
  [ .data.search.nodes[]
    | select(reviewable)
    | . as $pr
    | ([.reviews.nodes[] | select(.submittedAt != null and .author.login != $pr.author.login
                                  and .author.__typename != "Bot")]
       | sort_by(.submittedAt)) as $reviews
    | ([$reviews[] | select(.author.login == me)] | sort_by(.submittedAt)) as $mine
    | ([$mine[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED")]
        | last | .state // "") as $decision
    | ([.reviewRequests.nodes[].requestedReviewer
        | select(.__typename == "User" and .login == me)] | length > 0) as $requested
    | select($requested or $decision != "APPROVED")
    # The task force queue, not every review this person has ever been near: the request has
    # to be one the assigner made, on or after the day the effort started. Replayed off the
    # timeline because the request list does not say who asked, and a removal wipes the asks
    # before it. Every ask still standing is kept, and the assigner's own wins over a later
    # nudge from anybody else -- GitHub files a re-request as a fresh event, so last-one-wins
    # would hand the pick to whoever chased the reviewer last.
    | (reduce (.timelineItems.nodes | sort_by(.createdAt))[] as $e ({};
         ($e.requestedReviewer.login) as $who
         | if $who == null then .
           elif $e.__typename == "ReviewRequestedEvent" then
             .[$who] += [{ actor: $e.actor.login, at: $e.createdAt }]
           else del(.[$who]) end)) as $asked
    | ([($asked[me] // [])[] | select(.actor == assigner and .at >= start)] | first) as $pick
    | select($pick != null)
    # Everybody the task force picked for this PR, this reviewer included.
    | [$asked | to_entries[] | select(any(.value[]; .actor == assigner and .at >= start)) | .key]
        as $picked
    # Everything the author has done, review comments of their own included.
    | [ .createdAt,
        (.commits.nodes[].commit.committedDate),
        (.comments.nodes[] | select(.author.login == $pr.author.login) | .createdAt),
        (.reviews.nodes[] | select(.author.login == $pr.author.login) | .submittedAt) ] as $author_acts
    | ($author_acts | max) as $author_at
    # Opening the PR counts as its first push.
    | ([.createdAt, (.commits.nodes[].commit.committedDate)] | max) as $last_push
    # The story names the last review by a task force pick. A review from outside helps the
    # PR, but it is not what the pick is following up.
    | [$reviews[] | select(.author.login as $who | any($picked[]; . == $who))] as $tf_reviews
    | ($tf_reviews | last) as $last_review
    # The pick review the author was asked to answer, and any pick approval that came after.
    | ([$tf_reviews[] | select(.state != "APPROVED")] | last) as $tf_demand
    | ([$tf_reviews[] | select(.state == "APPROVED"
                               and .submittedAt > ($tf_demand.submittedAt // ""))] | last)
        as $tf_approval
    # A review that asks the author for something -- a comment, changes requested, a
    # dismissal. An approval is not one: it leaves the author nothing to answer.
    | ([$reviews[] | select(.state != "APPROVED")] | last) as $last_demand
    | { at: $pick.at, text: "picked \($pick.at | date)" } as $picked_event
    | { number, url, title, updatedAt, labels: [.labels.nodes[].name] }
      + if $last_demand != null
           and $last_demand.submittedAt > $author_at
           and $last_demand.submittedAt > $pick.at then
          # Somebody asked the author for something after this reviewer was picked, and the
          # author has not answered.
          { turn: "author",
            since: $last_demand.submittedAt,
            why: ([ ([$picked_event,
                      { at: $last_demand.submittedAt,
                        text: "\($last_demand.author.login) reviewed \($last_demand.submittedAt | date)" }]
                     | sort_by(.at)[] | .text), "author has not responded" ] | join(", ")) }
        else
          # The ball is on the review side, since the author first answered the last review
          # that asked for something, or since their last push -- and never earlier than the
          # ask: what a reviewer is late on starts the day they were picked.
          (if $last_demand == null then null
           else [$author_acts[] | select(. > $last_demand.submittedAt)] | min end) as $answered
          | ([$pick.at, $answered, $last_push] | max) as $since
          # A push only earns a mention when it is what started the clock.
          | [if $since == $last_push and $last_push > $pr.createdAt
             then { at: $last_push, text: "last pushed \($last_push | date)" } else empty end]
              as $pushed
          | [$tf_approval | select(. != null and .author.login != me)
             | { at: .submittedAt, text: "\(.author.login) approved \(.submittedAt | date)" }]
              as $approved
          | (if $tf_demand != null and $author_at > $tf_demand.submittedAt then
               ([$author_acts[] | select(. > $tf_demand.submittedAt)] | min) as $responded
               | { events: [ { at: $tf_demand.submittedAt,
                               text: "\($tf_demand.author.login) reviewed \($tf_demand.submittedAt | date)" },
                             { at: $responded, text: "author responded \($responded | date)" },
                             # Said once is enough when the push came the same day.
                             ($pushed[] | select((.at | date) != ($responded | date))),
                             $approved[], $picked_event ],
                   tail: (if $approved == [] then "no review since" else "nothing from \(me) since" end) }
             elif $tf_demand == null and $approved != [] then
               { events: [$approved[], $pushed[], $picked_event], tail: "nothing from \(me) since" }
             elif $last_review == null then
               { events: [ { at: $pr.createdAt, text: "opened \($pr.createdAt | date)" },
                           $pushed[], $picked_event ],
                 tail: "no task force review since" }
             else
               { events: [ { at: $last_review.submittedAt,
                             text: "\($last_review.author.login) reviewed \($last_review.submittedAt | date)" },
                           $pushed[], $picked_event ],
                 tail: "nothing from \(me) since" }
             end) as $story
          | { turn: (if any($mine[]; .submittedAt >= $pick.at) then "followup" else "first" end),
              since: $since,
              # The story in the order it happened, the ask included, so a reader can see why
              # the count is what it is -- an old PR freshly picked is not an old wait.
              why: ([$story.events | sort_by(.at)[] | .text] + [$story.tail] | join(", ")) }
        end
    | . + { waited: (.since | age) } ];
JQ
)

task_force() {
  gh api graphql \
    -F q="repo:Macaulay2/M2 is:pr is:open review-involves:$viewer_login" \
    -f query="$query" \
    --jq "$defs $common $picks $1"
}

if $summary; then
  # The long waits as prose, for an email. Plain text and no color: the table is for a
  # terminal, this is for somebody who will read it in a mail client. Only the reviewer's own
  # move counts here -- nudging somebody about a PR that is waiting on its author helps nobody.
  task_force '
    [ picks[] | select(.turn != "author" and .waited >= days) ]
    | sort_by(-.waited)
    | if length == 0 then
        "Nothing in the review queue for \(me) has been waiting \(plural(days; "day")) or more."
      else
        "Macaulay2/M2 reviews waiting on \(me) for \(plural(days; "day")) or more"
        + " -- \(length) of them, as of \(now | strftime("%Y-%m-%d")):\n\n"
        + ([ .[] | "* #\(.number) \(.title)\n  \(.url)\n  Waiting \(plural(.waited; "day")): \(.why)." ]
           | join("\n\n"))
      end'
  exit 0
fi

# The table, in the website's order of stages: the reviewer's move first -- a first review,
# then a follow-up -- and the author's last, longest wait first within each. The first line
# out is the PR numbers, for --all to leave out of its tables; it is not printed.
out=$(task_force '
  (picks | sort_by(({first: 0, followup: 1, author: 2}[.turn]), -.waited)) as $rows
  | ([$rows[].number] | join(" ")),
    table("Task force reviews for \(me)";
          ["ID", "STATUS", "WAITING", "TITLE", "LABELS", "UPDATED"];
          [ $rows[]
            | { cells: [ "#\(.number)",
                         {first: "awaiting first review",
                          followup: "awaiting follow-up review",
                          author: "waiting on author"}[.turn],
                         "\(.waited)d",
                         (.title | cut(50)),
                         (.labels | join(", ") | cut(40)),
                         (.updatedAt | ago) ],
                color: {first: "34", followup: "36", author: "90"}[.turn] } ])
    + (if $rows == [] then "\n(none)" else "" end)')
pick_numbers=$(head -n 1 <<<"$out")
tail -n +2 <<<"$out"

$all || exit 0

# Everything else: the reviewer's open reviews the task force did not ask for, then the rest
# of what they have reviewed. Not whose-turn statuses, which only the timeline and the author
# activity above can give: GitHub's request list and the reviewer's own last verdict.
#
# `gh pr list` rather than GraphQL, since a long-serving reviewer is involved in hundreds of
# PRs and it paginates; the limit is set well past that, so old open PRs do not fall off the
# end of the list.
echo
gh pr list -R Macaulay2/M2 \
  --state=all \
  --search "review-involves:$viewer_login" \
  --limit 2000 \
  --json number,title,state,isDraft,labels,updatedAt,reviewRequests,reviews \
  --jq "$defs $common def picks: [$(sed 's/ /, /g' <<<"$pick_numbers")];"'
    [ .[]
      | select(.number as $n | any(picks[]; . == $n) | not)
      | ([.reviewRequests[] | select(.__typename == "User" and .login == me)] | length > 0) as $requested
      | ([.reviews[] | select(.author.login == me)]) as $mine
      | ([$mine[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED")]
          | last | .state // "") as $decision
      | . + { requested: $requested, reviewed: ($mine != []), decision: $decision,
              open: (.state == "OPEN" and ($requested or $decision != "APPROVED")) } ] as $prs
    | def row($status; $color):
        { cells: [ "#\(.number)", $status, (.title | cut(50)),
                   ([.labels[].name] | join(", ") | cut(40)), (.updatedAt | ago) ],
          color: $color };
      table("Other open reviews";
            ["ID", "STATUS", "TITLE", "LABELS", "UPDATED"];
            [ $prs[] | select(.open)
              | (if .requested and .reviewed then "re-requested"
                 elif .requested then "requested"
                 else "review begun" end
                 + (if .isDraft then ", draft" else "" end)) as $status
              | row($status; if .requested then "34" else "36" end) ])
      + "\n\n"
      + table("Other reviewed PRs";
              ["ID", "STATUS", "TITLE", "LABELS", "UPDATED"];
              [ $prs[] | select(.open | not)
                | if .state == "MERGED" then row("merged"; "35")
                  elif .state == "CLOSED" then row("closed"; "31")
                  elif .decision == "APPROVED" then row("approved"; "32")
                  elif .decision == "CHANGES_REQUESTED" then row("changes requested"; "33")
                  else row("reviewed"; "36") end ])'
