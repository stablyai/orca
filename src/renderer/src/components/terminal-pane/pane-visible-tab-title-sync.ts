import type { AcceptedTerminalTabTitle } from '../../../../shared/terminal-tab-title-reducer'

type PaneVisibleTitleState = {
  acceptedPaneTabTitlesByTabId: Record<string, Record<number, AcceptedTerminalTabTitle>>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
}

export type PaneVisibleTabTitle = {
  title: string
  source: AcceptedTerminalTabTitle['source']
}

export function resolvePaneVisibleTabTitle(
  state: PaneVisibleTitleState,
  tabId: string,
  paneId: number
): PaneVisibleTabTitle | null {
  const acceptedTitle = state.acceptedPaneTabTitlesByTabId[tabId]?.[paneId]
  if (acceptedTitle?.title.trim()) {
    return acceptedTitle
  }

  const runtimeTitle = state.runtimePaneTitlesByTabId[tabId]?.[paneId]
  if (!runtimeTitle?.trim()) {
    return null
  }

  return {
    title: runtimeTitle,
    source: 'legacy-window-fallback'
  }
}

export function syncPaneVisibleTabTitle(args: {
  state: PaneVisibleTitleState
  tabId: string
  paneId: number
  updateTabTitle: (tabId: string, title: string, source: AcceptedTerminalTabTitle['source']) => void
}): void {
  const title = resolvePaneVisibleTabTitle(args.state, args.tabId, args.paneId)
  if (!title) {
    return
  }
  args.updateTabTitle(args.tabId, title.title, title.source)
}
