import {
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceKey, WorkspaceLineage, WorktreeLineage } from '../../../../shared/types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveLiveAgentStatusExecutionHostId } from '@/lib/agent-status-connection-ownership'

export type OrchestrationStatusSelection =
  | { kind: 'none' }
  | { kind: 'ambiguous'; runIds: string[] }
  | { kind: 'selected'; runId: string; source: 'live' | 'lineage' }

type SelectionInput = {
  activeWorkspaceKey: WorkspaceKey | null
  activeWorktreeId: string | null
  activeWorktreeInstanceId: string | null
  activeExecutionHostId: ExecutionHostId | null
  now?: number
  agentStatuses: readonly AgentStatusEntry[]
  terminalLayoutsByTabId: Parameters<
    typeof resolveLiveAgentStatusExecutionHostId
  >[0]['terminalLayoutsByTabId']
  ptyIdsByTabId: Parameters<typeof resolveLiveAgentStatusExecutionHostId>[0]['ptyIdsByTabId']
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
}

function statusBelongsToHost(
  status: AgentStatusEntry,
  executionHostId: ExecutionHostId | null,
  input: SelectionInput
): boolean {
  const host = parseExecutionHostId(executionHostId)
  if (!host || resolveLiveAgentStatusExecutionHostId(input, status.paneKey) !== executionHostId) {
    return false
  }
  if (host?.kind === 'ssh') {
    return status.connectionId === host.targetId
  }
  return status.connectionId === null
}

function activeWorkspaceIds(input: SelectionInput): Set<string> {
  const ids = new Set<string>()
  if (input.activeWorktreeId) {
    ids.add(input.activeWorktreeId)
  }
  if (input.activeWorkspaceKey) {
    ids.add(input.activeWorkspaceKey)
    const scope = parseWorkspaceKey(input.activeWorkspaceKey)
    if (scope?.type === 'worktree') {
      ids.add(scope.worktreeId)
    }
  }
  return ids
}

function liveRunIds(input: SelectionInput): string[] {
  const workspaceIds = activeWorkspaceIds(input)
  if (workspaceIds.size === 0) {
    return []
  }
  const ids = new Set<string>()
  for (const status of input.agentStatuses) {
    const runId = status.orchestration?.orchestrationRunId?.trim()
    if (
      runId &&
      isFreshNonDoneAgentStatus(status, input.now) &&
      status.worktreeId &&
      workspaceIds.has(status.worktreeId) &&
      statusBelongsToHost(status, input.activeExecutionHostId, input)
    ) {
      ids.add(runId)
    }
  }
  return [...ids].sort()
}

function exactWorktreeLineageRunId(input: SelectionInput): string | null {
  const scope = input.activeWorkspaceKey ? parseWorkspaceKey(input.activeWorkspaceKey) : null
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : input.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const workspaceKey = worktreeWorkspaceKey(worktreeId)
  const workspaceLineage = input.workspaceLineageByChildKey[workspaceKey]
  const worktreeLineage = input.worktreeLineageById[worktreeId]
  const activeInstanceId = input.activeWorktreeInstanceId

  const workspaceRunId =
    workspaceLineage?.childWorkspaceKey === workspaceKey &&
    activeInstanceId &&
    workspaceLineage.childInstanceId === activeInstanceId
      ? workspaceLineage.orchestrationRunId?.trim() || null
      : null
  const worktreeRunId =
    worktreeLineage?.worktreeId === worktreeId &&
    activeInstanceId &&
    worktreeLineage.worktreeInstanceId === activeInstanceId
      ? worktreeLineage.orchestrationRunId?.trim() || null
      : null

  if (workspaceRunId && worktreeRunId && workspaceRunId !== worktreeRunId) {
    return null
  }
  return workspaceRunId ?? worktreeRunId
}

export function selectOrchestrationStatusRun(input: SelectionInput): OrchestrationStatusSelection {
  const liveIds = liveRunIds(input)
  if (liveIds.length > 1) {
    return { kind: 'ambiguous', runIds: liveIds }
  }
  if (liveIds.length === 1) {
    return { kind: 'selected', runId: liveIds[0], source: 'live' }
  }
  const lineageRunId = exactWorktreeLineageRunId(input)
  return lineageRunId
    ? { kind: 'selected', runId: lineageRunId, source: 'lineage' }
    : { kind: 'none' }
}
