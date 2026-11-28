/** A tab kept beside the workspace area whichever workspace is selected. The tab stays in its own workspace. */
export type CrossWorkspacePane = {
  worktreeId: string
  /** The tab-bar id (`Tab.id`). */
  tabId: string
  /** Share of the workbench width the pane takes. */
  fraction: number
}

export const DEFAULT_CROSS_WORKSPACE_PANE_FRACTION = 0.4

// The divider's own drag limits; this guards saved values.
const MIN_FRACTION = 0.15
const MAX_FRACTION = 0.85

export function normalizeCrossWorkspacePane(value: unknown): CrossWorkspacePane | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const worktreeId = 'worktreeId' in value ? value.worktreeId : undefined
  const tabId = 'tabId' in value ? value.tabId : undefined
  if (typeof worktreeId !== 'string' || !worktreeId || typeof tabId !== 'string' || !tabId) {
    return null
  }
  const fraction = 'fraction' in value ? value.fraction : undefined
  return {
    worktreeId,
    tabId,
    fraction:
      typeof fraction === 'number' && Number.isFinite(fraction)
        ? Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction))
        : DEFAULT_CROSS_WORKSPACE_PANE_FRACTION
  }
}
