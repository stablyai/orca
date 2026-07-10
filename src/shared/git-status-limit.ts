// Why: git status is capped at this many changed-file entries. A repo with an
// enormous un-ignored folder can otherwise emit a listing large enough to crash
// the process when buffered. When the cap is hit the source-control view shows a
// "too many changes" state instead of the full list. Shared so the local path,
// the relay/SSH path, and the renderer agree on the same threshold.
export const DEFAULT_GIT_STATUS_LIMIT = 10_000
