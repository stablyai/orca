import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import type { TerminalPaneRevealTarget } from '../../../shared/terminal-pane-reveal'

/**
 * Shows a terminal pane on whichever host owns it: a local, SSH or paired-server workspace, or the
 * floating panel. Returns false when this window does not know the workspace.
 *
 * Why the workspace dispatcher rather than a bare `setActiveWorktree`: only the shared
 * sequence switches the view back to terminal, resumes sleeping agent sessions, and seeds a
 * terminal surface. A parked SSH workspace has no resident tab until those run, so the bare
 * call revealed a workspace with nothing in it (#16731).
 */
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
