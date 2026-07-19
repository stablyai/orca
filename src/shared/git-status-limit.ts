// Why: git status is capped at this many changed-file entries. A repo with an
// enormous un-ignored folder can otherwise freeze the renderer while it builds
// the source-control projections. When the cap is hit the view shows a "too many
// changes" state instead of the full list. Shared so native, WSL, SSH, and the
// renderer agree on the same responsive threshold.
export const DEFAULT_GIT_STATUS_LIMIT = 1_000
