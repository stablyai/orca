import { parsePaneKey } from '../../../../shared/stable-pane-id'

type TabLookup = Record<string, { id: string }[]>

export type ResourceSessionNavigationDeps = {
  tabsByWorktree: TabLookup
  setActiveView: (view: 'terminal') => void
  activateAndRevealWorktree: (worktreeId: string) => unknown
  activateTabAndFocusPane: (
    tabId: string,
    leafId: string | null,
    opts: { flashFocusedPane: true; scrollToBottomIfOutputSinceLastView: true }
  ) => void
}

export function isResourceSessionActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' '
}

export function navigateResourceSessionToTab(
  tabId: string,
  paneKey: string | null,
  deps: ResourceSessionNavigationDeps
): void {
  for (const [worktreeId, tabs] of Object.entries(deps.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      deps.activateAndRevealWorktree(worktreeId)
      break
    }
  }

  // Always reveal terminal view because stale tab mappings can bypass the workspace navigation that normally switches it.
  deps.setActiveView('terminal')

  // Stable leaf UUIDs identify panes; legacy numeric keys fall back to tab activation instead of guessing.
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  deps.activateTabAndFocusPane(tabId, parsed?.tabId === tabId ? parsed.leafId : null, {
    flashFocusedPane: true,
    scrollToBottomIfOutputSinceLastView: true
  })
}
