// Why: git status is capped at this many changed-file entries. A repo with an
// enormous un-ignored folder can otherwise freeze the renderer while it builds
// the source-control projections. When the cap is hit the view shows a "too many
// changes" state instead of the full list. Shared so native, WSL, SSH, and the
// renderer agree on the same responsive threshold.
export const DEFAULT_GIT_STATUS_LIMIT = 1_000

export function resolveGitStatusLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_GIT_STATUS_LIMIT
}

export function capGitStatusEntries<T>(
  entries: T[],
  limit: number,
  previous: { didHitLimit?: boolean; statusLength?: number } = {}
): { entries: T[]; didHitLimit?: true; statusLength?: number } {
  const exceededLimit = limit > 0 && entries.length > limit
  if (!exceededLimit && previous.didHitLimit !== true) {
    return { entries }
  }
  return {
    entries: exceededLimit ? entries.slice(0, limit) : entries,
    didHitLimit: true,
    statusLength: Math.max(previous.statusLength ?? 0, entries.length)
  }
}
