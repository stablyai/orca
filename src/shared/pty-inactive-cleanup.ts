export const MAX_PTY_INACTIVE_CLEANUP_IDS = 500

export type PtyCleanupSafety = 'inactive' | 'active' | 'unknown' | 'gone'

export type PtyCleanupInspection = {
  id: string
  safety: PtyCleanupSafety
}

export type PtyInactiveCleanupOutcome =
  | 'killed'
  | 'protected-active'
  | 'protected-unknown'
  | 'gone'
  | 'failed'

export type PtyInactiveCleanupResult = {
  id: string
  outcome: PtyInactiveCleanupOutcome
}

export function normalizePtyInactiveCleanupIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const ids: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0 || seen.has(candidate)) {
      continue
    }
    seen.add(candidate)
    ids.push(candidate)
    if (ids.length === MAX_PTY_INACTIVE_CLEANUP_IDS) {
      break
    }
  }
  return ids
}
