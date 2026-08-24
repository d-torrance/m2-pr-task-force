#!/bin/bash
set -euo pipefail

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") [--summary] [--days N] [username]

  --summary   plain-text list of the reviews that have gone unanswered the
              longest, for pasting into an email, instead of the tables
  --days N    how long unanswered counts as stalled (default 21, --summary only)
  username    whose queue to report on (default: the authenticated user)
EOF
}

summary=false
days=21
arg_login=""

while [ $# -gt 0 ]; do
  case $1 in
    --summary) summary=true ;;
    --days) shift; days=${1:-} ;;
    --days=*) days=${1#*=} ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage; exit 1 ;;
    *)
      if [ -n "$arg_login" ]; then
        echo "too many arguments" >&2
        usage
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

viewer_login=${arg_login:-$(gh api user --jq '.login')}

# Who the task force is, matching build.js: whose requests count as its selections, and when it
# began. The assigner has requested reviews as ordinary maintainer work for years, so without
# the cutoff that history is indistinguishable from the task force.
assigner=${TASK_FORCE_ASSIGNER:-d-torrance}
start=${TASK_FORCE_START:-2026-07-06}

if $summary; then
  # The stalled queue as prose, for an email. Plain text and no color: the tables below are
  # for a terminal, this is for somebody who will read it in a mail client.
  #
  # "Unanswered" is about whose move it is, and the move belongs to a side rather than to a
  # person: reviewers confer, and two of them who look at a PR together post once between
  # them, so one going quiet after a colleague reviewed is not a stall. A review that is in
  # and unanswered is therefore the author's move whoever wrote it, and the wait is measured
  # from the last thing the author did -- opening the PR, pushing, commenting, or reviewing
  # their own PR.
  #
  # The exception is an approval by somebody else, which asks the author for nothing: if this
  # reviewer has not been back since one landed, their sign-off is what the PR is still
  # waiting on, and the wait runs from that approval.
  #
  # An outstanding re-request is deliberately not a reason on its own. GitHub does not date a
  # request, so a stale one is indistinguishable from a fresh one, and the review side has
  # already answered whatever it followed.
  #
  # GraphQL rather than `gh pr list --json commits`, which asks for every commit of every PR
  # and blows the server's node limit; here one PR needs only its last commit.
  #
  # Replies inside a review thread are not comments on the PR, so an author who only ever
  # answers inline can read as quieter than they are. That errs toward listing a PR, which is
  # the safe direction for a nudge list.
  gh api graphql \
    -F q="repo:Macaulay2/M2 is:pr is:open review-involves:$viewer_login" \
    -f query='
      query($q: String!) {
        search(query: $q, type: ISSUE, first: 100) {
          nodes {
            ... on PullRequest {
              number url title createdAt
              author { login }
              commits(last: 1) { nodes { commit { committedDate } } }
              comments(last: 30) { nodes { author { login } createdAt } }
              reviewRequests(first: 30) {
                nodes { requestedReviewer { __typename ... on User { login } } }
              }
              reviews(first: 100) { nodes { author { login } state submittedAt } }
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
      }' \
    --jq 'def me: "'"$viewer_login"'";
      def days: '"$days"';
      def assigner: "'"$assigner"'";
      def start: "'"$start"'";
      def date: fromdateiso8601 | strftime("%Y-%m-%d");
      def plural(n; unit): "\(n) \(unit)" + (if n == 1 then "" else "s" end);

      [ .data.search.nodes[]
        | . as $pr
        | ([.reviews.nodes[] | select(.author.login != $pr.author.login)] | sort_by(.submittedAt)) as $reviews
        | ([$reviews[] | select(.author.login == me)] | sort_by(.submittedAt)) as $mine
        | ([$mine[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED")]
            | last | .state // "") as $decision
        | ([.reviewRequests.nodes[].requestedReviewer
            | select(.__typename == "User" and .login == me)] | length > 0) as $requested
        | select($requested or $decision != "APPROVED")
        # The task force queue, not every review this person has ever been near: the request has
        # to be one the assigner made, on or after the day the effort started. Replayed off the
        # timeline because the request list does not say who asked, and a removal wipes the asks
        # before it. Every ask still standing is kept, and the assigner own one wins over a later
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
        # Everything the author has done, review comments of their own included: the PR goes
        # back to them whenever one of these is the last thing that happened.
        | ([ .createdAt,
             (.commits.nodes[].commit.committedDate),
             (.comments.nodes[] | select(.author.login == $pr.author.login) | .createdAt),
             (.reviews.nodes[] | select(.author.login == $pr.author.login) | .submittedAt) ] | max) as $author_at
        | ($reviews | last) as $last_review
        | ($mine | last | .submittedAt // "") as $mine_at
        | ([$reviews[] | select(.state == "APPROVED" and .author.login != me)] | last) as $other_ok
        # Whose move it is, judged on the whole review side rather than one reviewer, because
        # reviewers do not work in isolation: two people can look at a PR together and post
        # once, and one of them going quiet after a colleague reviewed is not a stall.
        | (if $last_review == null then
             # Nobody has looked at all -- the wait is on everyone asked, this reviewer included.
             { since: $author_at,
               why: "no review yet, opened \($pr.createdAt | date)"
                 + (if $author_at > $pr.createdAt then ", author last active \($author_at | date)" else "" end) }
           elif $author_at > $last_review.submittedAt then
             # Reviewed, answered, and nobody has been back since: the ball is on the review side.
             { since: $author_at,
               why: "\($last_review.author.login) reviewed \($last_review.submittedAt | date),"
                 + " author responded \($author_at | date), no review since" }
           elif $pick.at > $last_review.submittedAt and $mine_at < $pick.at then
             # Asked after the last review had already been written, and not back since. The
             # earlier round is not an answer this reviewer is waiting on -- it is the state of
             # the PR they were asked to look at -- so the wait runs from the ask.
             { since: $pick.at,
               why: "picked \($pick.at | date), after the last review, nothing from \(me) since" }
           elif $other_ok != null and $other_ok.submittedAt > $mine_at then
             # A colleague has signed off and this reviewer has not been back since. The author
             # has nothing to answer, so the only thing still outstanding is this sign-off.
             { since: $other_ok.submittedAt,
               why: "\($other_ok.author.login) approved \($other_ok.submittedAt | date),"
                 + " nothing from \(me) since" }
           else
             # A review is in and unanswered: the author has the move, however long it has been.
             null end) as $wait
        | select($wait != null)
        # Never older than the ask itself. A PR can have been sitting since long before the task
        # force existed, but what this reviewer is late on starts the day they were picked, and
        # a nudge that claims otherwise is one the reader can rightly ignore.
        | ([$wait.since, $pick.at] | max) as $since
        | ((now - ($since | fromdateiso8601)) / 86400 | floor) as $waited
        | select($waited >= days)
        | { number, url, title, waited: $waited, why: $wait.why }
      ]
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

gh pr list -R Macaulay2/M2 \
  --state=all \
  --search "review-involves:$viewer_login" \
  --limit 100 \
  --json number,title,state,labels,updatedAt,reviewRequests,reviews \
  --template '{{- $viewer := "'"$viewer_login"'" -}}
{{- $repo := "Macaulay2/M2" -}}
{{autocolor "white+b" "Reviews needing attention"}}{{"\n\n"}}
{{- tablerow
    (autocolor "white+du" "REPO")
    (autocolor "white+du" "ID")
    (autocolor "white+du" "STATUS")
    (autocolor "white+du" "TITLE")
    (autocolor "white+du" "LABELS")
    (autocolor "white+du" "UPDATED")
-}}
{{- range . -}}
  {{- $requested := false -}}
  {{- range .reviewRequests -}}
    {{- if and (eq .__typename "User") (eq .login $viewer) -}}
      {{- $requested = true -}}
    {{- end -}}
  {{- end -}}
  {{- $reviewed := false -}}
  {{- $decision := "" -}}
  {{- range .reviews -}}
    {{- if eq .author.login $viewer -}}
      {{- $reviewed = true -}}
      {{- if or (eq .state "APPROVED") (eq .state "CHANGES_REQUESTED") (eq .state "DISMISSED") -}}
        {{- $decision = .state -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- if and (eq .state "OPEN") (or $requested (ne $decision "APPROVED")) -}}
    {{- /* The stage of the review, the same split the workload table on the website makes:
           an open request is a look still owed, and anything else here is a review already
           underway that has not been signed off. A re-request after a review is a look owed
           too, so it stays on the waiting side of the split, named for what it is. */ -}}
    {{- $status := "review begun" -}}
    {{- $style := "cyan" -}}
    {{- if $requested -}}
      {{- $status = "awaiting first review" -}}
      {{- if $reviewed -}}
        {{- $status = "awaiting re-review" -}}
      {{- end -}}
      {{- $style = "blue" -}}
    {{- end -}}
    {{- tablerow
        $repo
        (autocolor $style (printf "#%v" .number))
        (autocolor $style $status)
        .title
        (join ", " (pluck "name" .labels))
        (timeago .updatedAt)
    -}}
  {{- end -}}
{{- end -}}
{{- tablerender -}}
{{"\n"}}
{{autocolor "white+b" "Other reviewed PRs"}}{{"\n\n"}}
{{- tablerow
    (autocolor "white+du" "REPO")
    (autocolor "white+du" "ID")
    (autocolor "white+du" "STATUS")
    (autocolor "white+du" "TITLE")
    (autocolor "white+du" "LABELS")
    (autocolor "white+du" "UPDATED")
-}}
{{- range . -}}
  {{- $requested := false -}}
  {{- range .reviewRequests -}}
    {{- if and (eq .__typename "User") (eq .login $viewer) -}}
      {{- $requested = true -}}
    {{- end -}}
  {{- end -}}
  {{- $decision := "" -}}
  {{- range .reviews -}}
    {{- if and
        (eq .author.login $viewer)
        (or (eq .state "APPROVED") (eq .state "CHANGES_REQUESTED") (eq .state "DISMISSED"))
    -}}
      {{- $decision = .state -}}
    {{- end -}}
  {{- end -}}
  {{- $actionable := and (eq .state "OPEN") (or $requested (ne $decision "APPROVED")) -}}
  {{- if not $actionable -}}
    {{- $status := "reviewed" -}}
    {{- $style := "cyan" -}}
    {{- if eq .state "MERGED" -}}
      {{- $status = "merged" -}}
      {{- $style = "magenta" -}}
    {{- else if eq .state "CLOSED" -}}
      {{- $status = "closed" -}}
      {{- $style = "red" -}}
    {{- else if eq $decision "APPROVED" -}}
      {{- $status = "approved" -}}
      {{- $style = "green" -}}
    {{- else if eq $decision "CHANGES_REQUESTED" -}}
      {{- $status = "changes requested" -}}
      {{- $style = "yellow" -}}
    {{- end -}}
    {{- tablerow
        $repo
        (autocolor $style (printf "#%v" .number))
        (autocolor $style $status)
        .title
        (join ", " (pluck "name" .labels))
        (timeago .updatedAt)
    -}}
  {{- end -}}
{{- end -}}
{{- tablerender -}}
'
