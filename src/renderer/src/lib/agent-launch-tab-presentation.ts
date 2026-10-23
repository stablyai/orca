import type { AgentLaunchTabViewerRule } from '../../../shared/agent-launch-tab-publication'
import { focusTerminalInitiatedTab } from '../hooks/ipc-events/terminal-command-state'
import { useAppStore } from '../store'
import { revealWorkspaceSurface } from './workspace-surface-reveal'

/** Early publication and host reveal move the same viewer, under the same policy. */
export function presentAgentLaunchTab(
  viewer: AgentLaunchTabViewerRule,
  worktreeId: string,
  tabId: string,
  leafId?: string
): void {
  if (viewer === 'focus-window') {
    revealWorkspaceSurface(useAppStore.getState(), worktreeId, [tabId])
  }
  const current = useAppStore.getState()
  const windowShowsTab =
    viewer === 'focus-window' ||
    (viewer === 'focus-in-workspace' && current.activeWorktreeId === worktreeId)
  if (windowShowsTab) {
    current.setActiveTabType('terminal', worktreeId)
    current.setActiveTab(tabId)
  }
  if (windowShowsTab || viewer === 'reveal-owner') {
    // focus-window revealed its owner above; focus-in-workspace stays where the user is.
    if (viewer === 'reveal-owner') {
      current.revealWorktreeInSidebar(worktreeId)
    }
    focusTerminalInitiatedTab(tabId, leafId, worktreeId)
  }
}
