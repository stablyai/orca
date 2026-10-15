import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getAttentionOrderWorkspaceTargets } from '@/components/sidebar/attention-order-workspaces'
import type { VisibleWorktreeShortcutTarget } from '@/components/sidebar/visible-worktrees'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { buildAttentionQueue, type AttentionTarget } from '@/lib/next-attention-queue'
import { pickNextAttentionTarget, type AttentionPosition } from '@/lib/next-attention-target'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

function currentAttentionPosition(
  state: AppState,
  orderedWorkspaces: readonly VisibleWorktreeShortcutTarget[]
): AttentionPosition {
  const worktreeId = state.activeWorktreeId
  // Off the terminal view the user sees no workspace, so even the active one is a fresh destination.
  if (!worktreeId || state.activeView !== 'terminal') {
    return { workspaceIdentity: null, unifiedTabId: null, terminalTabId: null, leafId: null }
  }
  // Host-unqualified activation names no host; the sidebar row it landed on does.
  const hostId =
    state.activeWorkspaceExecutionHostId ??
    orderedWorkspaces.find((workspace) => workspace.id === worktreeId)?.executionHostId
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const activeGroup = (state.groupsByWorktree[worktreeId] ?? []).find(
    (group) => group.id === activeGroupId
  )
  const terminalTabId = state.activeTabType === 'terminal' ? state.activeTabId : null
  return {
    workspaceIdentity: composeWorktreeHostIdentity(hostId, worktreeId),
    unifiedTabId: activeGroup?.activeTabId ?? null,
    terminalTabId,
    leafId: terminalTabId
      ? (state.terminalLayoutsByTabId[terminalTabId]?.activeLeafId ?? null)
      : null
  }
}

function navigateToAttentionTarget(target: AttentionTarget): void {
  const { worktreeId } = target
  const activated = activateAndRevealWorkspace(worktreeId, {
    navigationIntent: 'user-open',
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {})
  })
  if (activated === false) {
    return
  }
  if (target.tabKind === 'agent-session' && target.unifiedTabId) {
    activateStructuredAgentSessionTab({ worktreeId, tabId: target.unifiedTabId })
    return
  }
  if (target.tabKind === 'terminal' && target.terminalTabId) {
    const terminalTabId = target.terminalTabId
    const state = useAppStore.getState()
    // The tab may have closed between building the queue and activating its workspace.
    if (!(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === terminalTabId)) {
      return
    }
    const leafId = target.leafId ?? null
    // No ack here: the on-screen scan reads the pane once it is actually visible.
    activateTabAndFocusPane(terminalTabId, leafId)
    // Why after: setActiveTab by entity id picks the first split copy; the unified id restores the exact one.
    if (target.unifiedTabId) {
      state.activateTab(target.unifiedTabId, { worktreeId })
    }
    activateTerminalTabOnOwner(worktreeId, terminalTabId, leafId)
    return
  }
  const owner = target.ownerPaneKey ? parsePaneKey(target.ownerPaneKey) : null
  if (owner) {
    activateTerminalTabOnOwner(worktreeId, owner.tabId, owner.leafId)
  }
}

export function jumpToNextAttentionFromShortcut(state: AppState, now: number): void {
  // Why: never switch workspaces behind the open Cmd+J overlay.
  if (state.activeModal === 'worktree-palette') {
    return
  }
  const orderedWorkspaces = getAttentionOrderWorkspaceTargets()
  const target = pickNextAttentionTarget(
    buildAttentionQueue(state, orderedWorkspaces, now),
    currentAttentionPosition(state, orderedWorkspaces)
  )
  if (!target) {
    toast.info(
      translate('auto.hooks.ipcEvents.nextAttention.none', 'No workspaces need attention'),
      { id: 'next-attention-none' }
    )
    return
  }
  navigateToAttentionTarget(target)
}
