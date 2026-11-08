// NUL cannot occur in paths; use setAttribute/dataset only, because HTML parsing replaces it with U+FFFD.
export const WORKSPACE_LANE_FULL_IDS_DELIMITER = '\0'

/** NUL in an ID is invalid; returning null would lose hidden lane members under search and must stay unreachable. */
export function serializeWorkspaceLaneFullIds(worktreeIds: readonly string[]): string | null {
  if (worktreeIds.some((worktreeId) => worktreeId.includes(WORKSPACE_LANE_FULL_IDS_DELIMITER))) {
    return null
  }
  return worktreeIds.join(WORKSPACE_LANE_FULL_IDS_DELIMITER)
}

/** Returns `null` when the lane never published the attribute. */
export function parseWorkspaceLaneFullIds(value: string | undefined): string[] | null {
  if (value === undefined) {
    return null
  }
  return value === '' ? [] : value.split(WORKSPACE_LANE_FULL_IDS_DELIMITER)
}

/** Translate rendered to full-lane indexes; both lists must retain dragged IDs for removedBeforeDrop accounting. */
export function resolveFullLaneDropIndex(args: {
  fullLaneIds: readonly string[]
  renderedIds: readonly string[]
  filteredDropIndex: number
}): number {
  const { fullLaneIds, renderedIds, filteredDropIndex } = args
  // Equal counts can hide stale membership; only an identical lane needs no translation.
  if (isSameLane(fullLaneIds, renderedIds)) {
    return filteredDropIndex
  }
  // An empty search result always reports zero; append to match document-drop behavior.
  if (renderedIds.length === 0) {
    return fullLaneIds.length
  }

  if (filteredDropIndex <= 0) {
    // An unresolved head target must stay at the head rather than invert the gesture.
    return indexInFullLane(fullLaneIds, renderedIds[0]!, 0)
  }
  if (filteredDropIndex >= renderedIds.length) {
    const lastIndex = indexInFullLane(fullLaneIds, renderedIds.at(-1)!, fullLaneIds.length - 1)
    return Math.min(fullLaneIds.length, lastIndex + 1)
  }
  return indexInFullLane(fullLaneIds, renderedIds[filteredDropIndex]!, fullLaneIds.length)
}

function isSameLane(fullLaneIds: readonly string[], renderedIds: readonly string[]): boolean {
  return (
    renderedIds.length === fullLaneIds.length &&
    renderedIds.every((worktreeId, index) => worktreeId === fullLaneIds[index])
  )
}

// Stale DOM IDs fall back to the intended end; raw -1 would clamp a tail drop to the head.
function indexInFullLane(
  fullLaneIds: readonly string[],
  worktreeId: string,
  fallbackIndex: number
): number {
  const index = fullLaneIds.indexOf(worktreeId)
  return index === -1 ? fallbackIndex : index
}
