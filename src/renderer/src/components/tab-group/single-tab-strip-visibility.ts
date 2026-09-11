export type SingleTabStripVisibility = {
  /** The strip leaves the flow and hands its height to the pane body. */
  autoHidden: boolean
  /** The collapsed strip is currently sliding back over the pane. */
  revealed: boolean
}

/**
 * Whether no group in the worktree keeps a strip in the flow, which leaves the drag band above the
 * split layout with no 32px row to pair into one titlebar-height top band.
 */
export function areAllTabStripsAutoHidden({
  autoHideEnabled,
  groupTabCounts,
  clientHostedRowCount
}: {
  autoHideEnabled: boolean
  groupTabCounts: readonly number[]
  clientHostedRowCount: number
}): boolean {
  return (
    groupTabCounts.length > 0 &&
    groupTabCounts.every(
      (groupTabCount) =>
        resolveSingleTabStripVisibility({
          autoHideEnabled,
          groupTabCount,
          clientHostedRowCount,
          stripHovered: false,
          tabDragActive: false
        }).autoHidden
    )
  )
}

export function resolveSingleTabStripVisibility({
  autoHideEnabled,
  groupTabCount,
  clientHostedRowCount,
  stripHovered,
  tabDragActive
}: {
  autoHideEnabled: boolean
  groupTabCount: number
  clientHostedRowCount: number
  stripHovered: boolean
  tabDragActive: boolean
}): SingleTabStripVisibility {
  // Why: client-hosted browser rows share the strip, so a lone tab beside a row is not a lone row.
  const autoHidden = autoHideEnabled && groupTabCount <= 1 && clientHostedRowCount === 0
  return {
    autoHidden,
    // Why: a tab drag needs the strip on screen in every group, or there is nothing to drop onto.
    revealed: autoHidden && (stripHovered || tabDragActive)
  }
}
