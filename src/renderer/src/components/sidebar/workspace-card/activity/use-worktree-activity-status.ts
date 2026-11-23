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

export function selectWorktreeActivityPtyIds(
  state: AppState,
  worktreeId: string
): Record<string, string[]> {
  const ptyIds = selectLivePtyIdsForWorktree(state, worktreeId)
  if (!hasStoppedWslHost(state)) {
    return ptyIds
  }
  const owner = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  return owner && selectStoppedWslDistro(state, owner) !== null
    ? withoutStoppedHostPtys(ptyIds, owner)
    : ptyIds
}

type StatusMemo = { inputs: readonly unknown[]; status: WorktreeStatus }

// Every caller (sidebar cards, Bots rows, pickers) resolves the same ids on each store write; each
// id re-resolves only when one of its own inputs changes.
const statusMemoByWorktreeId = new Map<string, StatusMemo>()
const STATUS_MEMO_LIMIT = 2000
// One store write runs every mounted selector against one state; each id is checked once per write.
let generation: { state: AppState; statusById: Map<string, WorktreeStatus> } | null = null

export function selectWorktreeActivityStatus(
  statusInputs: AppState,
  worktreeId: string
): WorktreeStatus {
  if (generation?.state !== statusInputs) {
    generation = { state: statusInputs, statusById: new Map() }
  }
  let status = generation.statusById.get(worktreeId)
  if (status === undefined) {
    status = resolveMemoizedStatus(statusInputs, worktreeId)
    generation.statusById.set(worktreeId, status)
  }
  return status
}

function resolveMemoizedStatus(statusInputs: AppState, worktreeId: string): WorktreeStatus {
  const summary = selectWorktreeAgentActivitySummary(statusInputs, worktreeId)
  const inputs = [
    statusInputs.tabsByWorktree[worktreeId] ?? EMPTY_TABS,
    statusInputs.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
    hasAwakeStructuredChat(
      statusInputs.unifiedTabsByWorktree[worktreeId],
      statusInputs.structuredChatSleptAtByPaneKey
    ),
    selectWorktreeActivityPtyIds(statusInputs, worktreeId),
    selectRuntimePaneTitlesForWorktree(statusInputs, worktreeId),
    selectTerminalLayoutRootsForWorktree(statusInputs, worktreeId),
    summary
  ] as const
  const memo = statusMemoByWorktreeId.get(worktreeId)
  if (memo && inputs.every((input, index) => input === memo.inputs[index])) {
    return memo.status
  }
  const [
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    terminalLayoutRootsByTabId
  ] = inputs
  const status = resolveWorktreeStatus({
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId,
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
  if (!memo && statusMemoByWorktreeId.size >= STATUS_MEMO_LIMIT) {
    statusMemoByWorktreeId.clear()
  }
  statusMemoByWorktreeId.set(worktreeId, { inputs, status })
  return status
}

export function useWorktreeActivityStatus(worktreeId: string): WorktreeStatus {
  return useAppStore((state) => selectWorktreeActivityStatus(state, worktreeId))
}
