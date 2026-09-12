import { isPathInsideOrEqual, normalizeRuntimePathForComparison } from './cross-platform-path'
import type { WorkspaceTrustEntry } from './workspace-trust-types'

export type WorkspaceTrustMatch = {
  entry: WorkspaceTrustEntry
  /** 'exact' = the queried path's own entry; 'ancestor' = inherited from a containing entry. */
  matchKind: 'exact' | 'ancestor'
}

/**
 * Longest-prefix (most specific) stored entry among the path's ancestors, textual only (no I/O).
 * A closer decline always outranks a farther grant — that is what makes decision persistence
 * (a decline is never silently overridden by later trusting an ancestor) expressible.
 */
export function resolveWorkspaceTrustMatch(
  path: string,
  entries: readonly WorkspaceTrustEntry[]
): WorkspaceTrustMatch | null {
  const normalizedQuery = normalizeRuntimePathForComparison(path)
  let best: WorkspaceTrustMatch | null = null
  let bestSpecificity = -1
  for (const entry of entries) {
    if (!isPathInsideOrEqual(entry.path, path)) {
      continue
    }
    const normalizedEntry = normalizeRuntimePathForComparison(entry.path)
    if (normalizedEntry.length <= bestSpecificity) {
      continue
    }
    bestSpecificity = normalizedEntry.length
    best = { entry, matchKind: normalizedEntry === normalizedQuery ? 'exact' : 'ancestor' }
  }
  return best
}
