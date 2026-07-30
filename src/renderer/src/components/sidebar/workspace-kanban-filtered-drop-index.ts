// Why: worktree ids embed repo paths, so commas, colons and newlines are all
// unusable as a separator in the `data-workspace-lane-full-ids` channel — a
// POSIX path may contain any byte but NUL and '/', and a Windows path carries
// a drive colon. NUL is the one character no path can hold, so it cannot split
// an id into phantom lane members. Verified to round-trip through setAttribute
// and dataset in Chromium — but HTML *parsing* rewrites NUL to U+FFFD, so this
// channel must stay setAttribute-only and never pass through innerHTML.
export const WORKSPACE_LANE_FULL_IDS_DELIMITER = '\0'

/**
 * Returns `null` when the lane cannot be represented on this channel. Defence
 * only: no real worktree id can contain the NUL delimiter. Dropping the channel
 * is the wrong fallback under an active query — the reader would then scan the
 * DOM and see only the matched cards — so this must stay unreachable.
 */
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

/**
 * Translates a drop index derived from the *rendered* cards of a lane onto the
 * lane's full membership. Board search hides non-matching cards, but manual-order
 * math runs against the full lane, so the two sides must be reconciled.
 *
 * Both id lists still contain the dragged ids — `getCardDropTarget` counts the
 * dragged card and `buildManualOrderUpdatesForGroupDrop` computes
 * `removedBeforeDrop` against the pre-removal group. Keep it that way.
 */
export function resolveFullLaneDropIndex(args: {
  fullLaneIds: readonly string[]
  renderedIds: readonly string[]
  filteredDropIndex: number
}): number {
  const { fullLaneIds, renderedIds, filteredDropIndex } = args
  // Why: equal lengths alone would take this branch for a stale DOM lane that
  // holds the same card count but different membership, skipping translation.
  if (isSameLane(fullLaneIds, renderedIds)) {
    return filteredDropIndex
  }
  // Why: a lane filtered down to nothing reports drop index 0 for every pointer
  // position, so honouring it would silently prepend. Append instead, matching
  // dropWorktreesAtEndOfStatus for the same gesture on the document-drop path.
  if (renderedIds.length === 0) {
    return fullLaneIds.length
  }

  if (filteredDropIndex <= 0) {
    // Why: the head branch means "above the first match", so an unresolvable id
    // falls back to the lane head. Using the tail would invert the gesture.
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

// Why: a rendered id missing from the full lane is a stale-DOM race, so the
// caller supplies the end of the lane its branch was aiming at — a raw -1 would
// clamp to 0 downstream and teleport a tail drop to the top.
function indexInFullLane(
  fullLaneIds: readonly string[],
  worktreeId: string,
  fallbackIndex: number
): number {
  const index = fullLaneIds.indexOf(worktreeId)
  return index === -1 ? fallbackIndex : index
}
