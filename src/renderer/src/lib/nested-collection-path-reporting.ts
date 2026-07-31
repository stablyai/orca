import { isApprovedPathFieldName } from './nested-container-shape'
import type { NestedCollectionFrame } from './nested-collection-level-sampling'

export type NestedCollectionPathTotalsState = {
  totals: Map<string, number>
  truncated: boolean
}

export function createNestedCollectionChildPath(
  frame: NestedCollectionFrame,
  key: string | null,
  maxPathLength: number
): string | null {
  // Root keys are source-owned Zustand fields already emitted by the top-level contributor.
  if (frame.depth === 0) {
    return key !== null && key.length <= maxPathLength ? key : null
  }
  const named = !frame.keysAreData && key !== null && isApprovedPathFieldName(key)
  const path = named ? `${frame.path}.${key}` : `${frame.path}[]`
  return path.length <= maxPathLength ? path : null
}

export function addNestedCollectionPathTotal(
  state: NestedCollectionPathTotalsState,
  path: string,
  value: number,
  maxPaths: number
): void {
  const existing = state.totals.get(path)
  if (existing !== undefined) {
    state.totals.set(path, existing + value)
    return
  }
  if (state.totals.size >= maxPaths) {
    state.truncated = true
    return
  }
  state.totals.set(path, value)
}

export function largestNestedCollectionPaths(
  totals: Map<string, number>,
  limit: number
): Record<string, number> {
  if (limit <= 0 || totals.size === 0) {
    return {}
  }
  const counts: Record<string, number> = {}
  for (const [path, value] of [...totals].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    counts[path] = Math.round(value)
  }
  return counts
}
