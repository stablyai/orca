import type { TerminalTab } from '../../../../shared/types'

export function shouldClearLaunchAgentForClosedPane(
  tab: Pick<TerminalTab, 'launchAgent' | 'ptyId'> | null | undefined,
  closedPtyId: string | null | undefined
): boolean {
  // Why: launchAgent describes the tab's original PTY only. Closing that PTY
  // must not transfer its bootstrap identity to a surviving shell sibling.
  return Boolean(tab?.launchAgent && closedPtyId && tab.ptyId === closedPtyId)
}

export function resolveTabTitleAfterPaneClose(
  runtimePaneTitlesByPaneId: Readonly<Record<number, string>>,
  activePaneId: number | null | undefined
): string {
  // Why: an empty update resets the tab to its stable fallback instead of
  // leaving the closed pane's agent title attached to an untitled survivor.
  return activePaneId == null ? '' : (runtimePaneTitlesByPaneId[activePaneId] ?? '')
}
