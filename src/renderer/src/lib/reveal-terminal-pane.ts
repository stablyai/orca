import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { activateTerminalTabOnOwner } from '@/lib/workspace/tabs/terminal-tab-owner-activation'
import type { TerminalPaneRevealTarget } from '../../../shared/workspace-layout/terminal-pane-reveal'

/** Reveal through the workspace dispatcher on local/SSH/server/floating owners. Bare setActiveWorktree skips terminal view, sleeping resume and surface seeding, leaving parked SSH workspaces empty (#16731). Return false for unknown workspaces. */
export function revealTerminalPane(target: TerminalPaneRevealTarget): boolean {
  const activated = activateAndRevealWorkspace(
    target.worktreeId,
    target.executionHostId ? { executionHostId: target.executionHostId } : undefined
  )
  if (activated === false) {
    return false
  }
  activateTabAndFocusPane(target.tabId, target.leafId, { flashFocusedPane: true })
  activateTerminalTabOnOwner(target.worktreeId, target.tabId, target.leafId)
  return true
}
