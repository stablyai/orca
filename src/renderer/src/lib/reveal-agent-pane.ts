import { useAppStore } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import type { ExecutionHostId } from '../../../shared/execution-host'

export type RevealAgentPaneTarget = {
  /** Plain worktree id or a `folder:` workspace key — both dispatch correctly. */
  worktreeId: string
  tabId: string
  leafId: string | null
  /** Exact retained card to resume when its completed pane no longer exists. */
  paneKey?: string
  executionHostId?: ExecutionHostId
}

export type RevealAgentPaneOptions = {
  ackPaneKeyOnSuccess?: string
  flashFocusedPane?: boolean
  scrollToBottomIfOutputSinceLastView?: boolean
  /** Runs when the pane could not be focused — the workspace refused to
   *  activate, or it activated but the target tab is gone. */
  onTargetUnavailable?: () => void
}

/**
 * Focuses one agent's pane from a surface that lists agents across workspaces
 * (sidebar rows, the dashboard board, the agent map).
 *
 * Why this exists: activation must go through worktree-activation, not a raw
 * setActiveWorktree. That is where resumeSleepingAgentSessionsForWorktree runs,
 * so it is the difference between a slept agent waking on the way in and the
 * caller landing on a dead pane.
 *
 * Returns true when the pane was focused.
 */
export function revealAgentPane(
  target: RevealAgentPaneTarget,
  options?: RevealAgentPaneOptions
): boolean {
  const activated = activateAndRevealWorkspace(target.worktreeId, {
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    ...(target.paneKey ? { resumeCompletedPaneKey: target.paneKey } : {})
  })
  if (!activated) {
    options?.onTargetUnavailable?.()
    return false
  }
  // Why: read tabs AFTER activation — waking a slept agent can add its `--resume`
  // tab, and a husk tab can be replaced rather than revived.
  const tabs = useAppStore.getState().tabsByWorktree[target.worktreeId] ?? []
  const targetTabExists = tabs.some((tab) => tab.id === target.tabId)
  const focusTabId = activated.resumedAgentTabId ?? (targetTabExists ? target.tabId : undefined)
  if (!focusTabId || !tabs.some((tab) => tab.id === focusTabId)) {
    // Why: the wake already focused the replacement tab; re-activating the dead
    // id would yank the user back to a tab that no longer renders.
    options?.onTargetUnavailable?.()
    return false
  }
  activateTabAndFocusPane(focusTabId, activated.resumedAgentTabId ? null : target.leafId, {
    ...(options?.ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess: options.ackPaneKeyOnSuccess } : {}),
    ...(options?.flashFocusedPane ? { flashFocusedPane: true } : {}),
    ...(options?.scrollToBottomIfOutputSinceLastView
      ? { scrollToBottomIfOutputSinceLastView: true }
      : {})
  })
  return true
}
