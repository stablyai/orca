import type { AppState } from '@/store/types'
import { findIndexedWorktreeOwner } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { isUnattributedTwinWorktree } from '@/lib/workspace/ownership/terminal-worktree-route'
import { selectEphemeralVmWorkspaceRuntime } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import {
  resolveExplicitWorktreeOperationRouteResult,
  resolveUnstampedRecordHost
} from '@/lib/workspace/ownership/worktree-operation-catalog-route'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'

/**
 * Whether sleeping the workspace, instead of closing this tab, keeps every busy agent resumable.
 * Mirrors main's sleep capture (worktree-sleep-resume-records): a hook row naming a resumable
 * agent with a provider session. Only local and SSH workspaces are offered: a paired server keeps
 * its own records and a VM workspace suspends, neither of which this window can vouch for.
 */
export function canSleepInsteadOfClosingTab(
  state: AppState,
  args: { worktreeId: string; terminalTabId: string; busyPtyIds: readonly string[] }
): boolean {
  const worktree = findIndexedWorktreeOwner(selectWorktreesByRepo(state), args.worktreeId)
  if (
    !worktree ||
    isPairedWebClientWindow() ||
    isUnattributedTwinWorktree(state, args.worktreeId)
  ) {
    return false
  }
  const owner = resolveExplicitWorktreeOperationRouteResult(state, args.worktreeId)
  if (
    owner.kind === 'ambiguous' ||
    (owner.kind === 'resolved' && owner.route.runtimeEnvironmentId) ||
    (owner.kind === 'missing' && (worktree.hostId || worktree.runtimeOwnerEnvironmentId))
  ) {
    return false
  }
  const host = parseExecutionHostId(
    owner.kind === 'resolved'
      ? owner.route.executionHostId
      : resolveUnstampedRecordHost(state, worktree)
  )
  if (host?.kind !== 'local' && host?.kind !== 'ssh') {
    return false
  }
  if (selectEphemeralVmWorkspaceRuntime(state, args.worktreeId)) {
    return false
  }
  const ptyIdsByLeafId = state.terminalLayoutsByTabId?.[args.terminalTabId]?.ptyIdsByLeafId ?? {}
  const busyLeafIds = Object.entries(ptyIdsByLeafId)
    .filter(([, ptyId]) => typeof ptyId === 'string' && args.busyPtyIds.includes(ptyId))
    .map(([leafId]) => leafId)
  const mappedPtyIds = new Set(Object.values(ptyIdsByLeafId))
  if (busyLeafIds.length === 0 || args.busyPtyIds.some((ptyId) => !mappedPtyIds.has(ptyId))) {
    return false
  }
  // Why every busy pane: sleep stops them all, so one unresumable process would still be lost.
  return busyLeafIds.every((leafId) => {
    if (!isTerminalLeafId(leafId) || args.terminalTabId.includes(':')) {
      return false
    }
    const entry = state.agentStatusByPaneKey.get(makePaneKey(args.terminalTabId, leafId))
    return (
      isResumableTuiAgent(entry?.agentType) &&
      normalizeAgentProviderSession(entry?.providerSession) !== null
    )
  })
}
