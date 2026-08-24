#!/bin/bash
set -euo pipefail

if [ $# -gt 1 ]; then
  echo "usage: $(basename "$0") [username]" >&2
  exit 1
fi

viewer_login=${1:-$(gh api user --jq '.login')}

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
