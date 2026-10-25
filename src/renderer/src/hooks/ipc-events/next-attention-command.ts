import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  getAttentionOrderWorkspaceTargets,
  type AttentionOrderWorkspace
} from '@/components/sidebar/attention-order-workspaces'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { buildAttentionQueue, type AttentionTarget } from '@/lib/next-attention-queue'
import { pickNextAttentionTarget, type AttentionPosition } from '@/lib/next-attention-target'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

function currentAttentionPosition(
  state: AppState,
  orderedWorkspaces: readonly AttentionOrderWorkspace[]
): AttentionPosition {
  const worktreeId = state.activeWorktreeId
  // Off the terminal view the user sees no workspace, so even the active one is a fresh destination.
  if (!worktreeId || state.activeView !== 'terminal') {
    return { workspaceIdentity: null, unifiedTabId: null, terminalTabId: null, leafId: null }
  }
  // Host-unqualified activation names no host; the sidebar row it landed on does.
  const hostId =
    state.activeWorkspaceExecutionHostId ??
    orderedWorkspaces.find((workspace) => workspace.id === worktreeId)?.identityHostId
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

type NavigationOutcome = 'reached' | 'workspace-unreachable' | 'tab-gone'

function navigateToAttentionTarget(target: AttentionTarget): NavigationOutcome {
  const { worktreeId } = target
  const activated = activateAndRevealWorkspace(worktreeId, {
    navigationIntent: 'user-open',
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {})
  })
  if (activated === false) {
    return 'workspace-unreachable'
  }
  if (target.tabKind === 'agent-session' && target.unifiedTabId) {
    return activateStructuredAgentSessionTab({ worktreeId, tabId: target.unifiedTabId })
      ? 'reached'
      : 'tab-gone'
  }
  if (target.tabKind === 'terminal' && target.terminalTabId) {
    const terminalTabId = target.terminalTabId
    const state = useAppStore.getState()
    // The tab may have closed between building the queue and activating its workspace.
    if (!(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === terminalTabId)) {
      return 'tab-gone'
    }
    const leafId = target.leafId ?? null
    // No ack here: the on-screen scan reads the pane once it is actually visible.
    activateTabAndFocusPane(terminalTabId, leafId)
    // Why after: setActiveTab by entity id picks the first split copy; the unified id restores the exact one.
    if (target.unifiedTabId) {
      state.activateTab(target.unifiedTabId, { worktreeId })
    }
    activateTerminalTabOnOwner(worktreeId, terminalTabId, leafId)
    return 'reached'
  }
  const owner = target.ownerPaneKey ? parsePaneKey(target.ownerPaneKey) : null
  if (owner) {
    activateTerminalTabOnOwner(worktreeId, owner.tabId, owner.leafId)
  }
  return 'reached'
}

export function jumpToNextAttentionFromShortcut(state: AppState, now: number): void {
  // Why: never switch workspaces behind the open Cmd+J overlay.
  if (state.activeModal === 'worktree-palette') {
    return
  }
  const orderedWorkspaces = getAttentionOrderWorkspaceTargets()
  const queue = buildAttentionQueue(state, orderedWorkspaces, now)
  const target = pickNextAttentionTarget(queue, currentAttentionPosition(state, orderedWorkspaces))
  if (!target) {
    toast.info(
      translate('auto.hooks.ipcEvents.nextAttention.none', 'No workspaces need attention'),
      { id: 'next-attention-none' }
    )
    return
  }
  // Why walk on: a stateless pick would otherwise return to an unreachable target on every press.
  const start = queue.indexOf(target)
  // Why: a workspace that failed to open already told the user why; retrying its other targets repeats that.
  const unreachableWorkspaces = new Set<string>()
  for (let offset = 0; offset < queue.length; offset += 1) {
    const candidate = queue[(start + offset) % queue.length]
    if (unreachableWorkspaces.has(candidate.workspaceIdentity)) {
      continue
    }
    const outcome = navigateToAttentionTarget(candidate)
    if (outcome === 'reached') {
      return
    }
    if (outcome === 'workspace-unreachable') {
      unreachableWorkspaces.add(candidate.workspaceIdentity)
    }
    console.warn('[next-attention] could not reach target', candidate.workspaceIdentity)
  }
}
