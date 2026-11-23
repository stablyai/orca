import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { hasAwakeStructuredChat } from '@/store/slices/agent-status/structured-sessions/structured-chat-slept-at'
import { resolveWorktreeStatus } from '@/lib/workspace/activity/worktree-status'
import type { WorktreeStatus } from '../../../../../../shared/worktree/row-display/worktree-status-rollup'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './worktree-card-empty-inputs'
import {
  selectLivePtyIdsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { selectStoppedWslDistro } from '@/runtime/hosts/wsl/wsl-host-stopped-status'
import { selectWorkspaceRuntimeEnvironmentId } from '../../../../lib/workspace/ownership/workspace-runtime-environment'
import { parseRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

/** The Start card's rule: a pane with no server yet, or on the stopped one, ended with its distro. */
function withoutStoppedHostPtys(
  ptyIdsByTabId: Record<string, string[]>,
  stoppedEnvironmentId: string
): Record<string, string[]> {
  const live: Record<string, string[]> = {}
  for (const [tabId, ptyIds] of Object.entries(ptyIdsByTabId)) {
    const kept = ptyIds.filter((ptyId) => {
      const environmentId = parseRemoteRuntimePtyId(ptyId)?.environmentId
      return environmentId != null && environmentId !== stoppedEnvironmentId
    })
    if (kept.length > 0) {
      live[tabId] = kept.length === ptyIds.length ? ptyIds : kept
    }
  }
  return live
}

// Why the cheap check first: every card's selector runs on each store update, and few hosts stop.
function hasStoppedWslHost(state: {
  wslHostStatuses?: Record<string, { state: string }>
}): boolean {
  for (const id in state.wslHostStatuses) {
    if (state.wslHostStatuses[id]?.state === 'distro-stopped') {
      return true
    }
  }
  return false
}

function selectStoppedWorktreeEnvironmentId(state: AppState, worktreeId: string): string | null {
  if (!hasStoppedWslHost(state)) {
    return null
  }
  const owner = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  return owner && selectStoppedWslDistro(state, owner) !== null ? owner : null
}

type StatusMemo = { inputs: readonly unknown[]; status: WorktreeStatus }

// Carry only the workspaces read in the previous snapshot, regardless of how many were visible.
let generation: {
  state: AppState
  byWorktreeId: Map<string, StatusMemo>
  carried: ReadonlyMap<string, StatusMemo> | undefined
} | null = null

export function selectWorktreeActivityStatus(
  statusInputs: AppState,
  worktreeId: string
): WorktreeStatus {
  if (generation?.state !== statusInputs) {
    generation = {
      state: statusInputs,
      byWorktreeId: new Map(),
      carried: generation?.byWorktreeId
    }
  }
  const { byWorktreeId, carried } = generation
  let memo = byWorktreeId.get(worktreeId)
  if (memo === undefined) {
    memo = resolveMemoizedStatus(statusInputs, worktreeId, carried?.get(worktreeId))
    byWorktreeId.set(worktreeId, memo)
  }
  return memo.status
}

function resolveMemoizedStatus(
  statusInputs: AppState,
  worktreeId: string,
  memo: StatusMemo | undefined
): StatusMemo {
  const summary = selectWorktreeAgentActivitySummary(statusInputs, worktreeId)
  const inputs = [
    statusInputs.tabsByWorktree[worktreeId] ?? EMPTY_TABS,
    statusInputs.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
    hasAwakeStructuredChat(
      statusInputs.unifiedTabsByWorktree[worktreeId],
      statusInputs.structuredChatSleptAtByPaneKey
    ),
    selectLivePtyIdsForWorktree(statusInputs, worktreeId),
    selectStoppedWorktreeEnvironmentId(statusInputs, worktreeId),
    selectRuntimePaneTitlesForWorktree(statusInputs, worktreeId),
    selectTerminalLayoutRootsForWorktree(statusInputs, worktreeId),
    summary
  ] as const
  if (memo && inputs.every((input, index) => input === memo.inputs[index])) {
    return memo
  }
  const [
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId,
    stoppedEnvironmentId,
    runtimePaneTitlesByTabId,
    terminalLayoutRootsByTabId
  ] = inputs
  const status = resolveWorktreeStatus({
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId: stoppedEnvironmentId
      ? withoutStoppedHostPtys(ptyIdsByTabId, stoppedEnvironmentId)
      : ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    agentStatusPaneIdsByTabId: summary.agentStatusPaneIdsByTabId,
    stalePaneIdsByTabId: summary.stalePaneIdsByTabId,
    terminalLayoutRootsByTabId,
    hasPermission: summary.hasPermission,
    hasLiveWorking: summary.hasLiveWorking,
    hasLiveMonitoring: summary.hasLiveMonitoring,
    hasFailed: summary.hasFailed,
    hasInterrupted: summary.hasInterrupted,
    hasUnconfirmed: summary.hasUnconfirmed,
    hasLiveDone: summary.hasLiveDone
  })
  return { inputs, status }
}

export function useWorktreeActivityStatus(worktreeId: string): WorktreeStatus {
  return useAppStore((state) => selectWorktreeActivityStatus(state, worktreeId))
}
