import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { SessionGridItem } from '../../../../shared/session-grid-types'

/**
 * Take a card to the tabs view, by the same road the sidebar's agent rows and Activity's
 * threads take: activate the workspace on the host that actually runs it, then focus the
 * exact pane the card was previewing — which acknowledges its turn on the way in.
 *
 * The host matters, and it is the CARD's, not the workspace's: the builder reads it off the
 * live pty id, which embeds its owner and outranks a workspace catalog that may name another
 * host or none at all. Re-deriving it from `worktreeId` marks the activation local (or the
 * ambient runtime) for an SSH pty, and every later operation routes to that machine — the
 * silent substitution docs/reference/ssh-execution-boundary.md forbids.
 * `activateAndRevealWorkspace`, not `setActiveWorktree` alone, because the grid is the one
 * surface that lists every repo and every folder workspace at once — crossing repos has to
 * move `activeRepoId` with it, and a folder workspace takes a different activation path.
 */
export function maximizeSessionGridCard(item: SessionGridItem): void {
  if (
    activateAndRevealWorkspace(item.worktreeId, { executionHostId: item.executionHostId }) === false
  ) {
    // The workspace is gone from under the card; half-activating would strand the user.
    return
  }
  const leafId = item.paneKey ? (parsePaneKey(item.paneKey)?.leafId ?? null) : null
  activateTabAndFocusPane(item.tabId, leafId, {
    flashFocusedPane: true,
    ...(item.paneKey ? { ackPaneKeyOnSuccess: item.paneKey } : {})
  })
}
