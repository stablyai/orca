// Share native/WSL/SSH/renderer entry caps: enormous unignored folders otherwise freeze projections; capped views show too many changes.
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
