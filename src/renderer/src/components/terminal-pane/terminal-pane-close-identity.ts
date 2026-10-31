import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export function shouldClearLaunchAgentForClosedPane(
  tab: Pick<TerminalTab, 'launchAgent' | 'ptyId'> | null | undefined,
  closedPtyId: string | null | undefined
): boolean {
  // launchAgent belongs to the original PTY; closing it cannot transfer bootstrap identity to a surviving shell.
  return Boolean(tab?.launchAgent && closedPtyId && tab.ptyId === closedPtyId)
}

export function resolveTabTitleAfterPaneClose(
  runtimePaneTitlesByPaneId: Readonly<Record<number, string>>,
  activePaneId: number | null | undefined
): string {
  // An empty update restores stable fallback title instead of keeping the closed agent’s name.
  return activePaneId == null ? '' : (runtimePaneTitlesByPaneId[activePaneId] ?? '')
}
