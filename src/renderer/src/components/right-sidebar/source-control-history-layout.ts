/** Session + durable defaults for Source Control COMMITS section layout. */

export const DEFAULT_SOURCE_CONTROL_HISTORY_HEIGHT = 256
export const MIN_SOURCE_CONTROL_HISTORY_HEIGHT = 96
export const MAX_SOURCE_CONTROL_HISTORY_HEIGHT = 520

// Why: Source Control resets section state on worktree switch and unmounts on
// tab changes; keep the last user-chosen COMMITS expand/height for the session
// so project switching does not force re-expand and re-drag every time.
let sessionHistoryExpanded = false
let sessionHistoryHeight = DEFAULT_SOURCE_CONTROL_HISTORY_HEIGHT

export function clampSourceControlHistoryHeight(height: number): number {
  if (!Number.isFinite(height)) {
    return DEFAULT_SOURCE_CONTROL_HISTORY_HEIGHT
  }
  return Math.min(
    MAX_SOURCE_CONTROL_HISTORY_HEIGHT,
    Math.max(MIN_SOURCE_CONTROL_HISTORY_HEIGHT, Math.round(height))
  )
}

export function getSessionSourceControlHistoryExpanded(): boolean {
  return sessionHistoryExpanded
}

export function setSessionSourceControlHistoryExpanded(expanded: boolean): void {
  sessionHistoryExpanded = expanded
}

export function getSessionSourceControlHistoryHeight(): number {
  return sessionHistoryHeight
}

export function setSessionSourceControlHistoryHeight(height: number): void {
  sessionHistoryHeight = clampSourceControlHistoryHeight(height)
}

/** Test-only reset. */
export function _resetSessionSourceControlHistoryLayoutForTests(): void {
  sessionHistoryExpanded = false
  sessionHistoryHeight = DEFAULT_SOURCE_CONTROL_HISTORY_HEIGHT
}
