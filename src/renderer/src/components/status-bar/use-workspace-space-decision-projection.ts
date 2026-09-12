import { useCallback, useMemo } from 'react'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import {
  getWorkspaceDecisionDetails,
  type WorkspaceDecisionDetails
} from './workspace-space-decision-details'
import { getWorkspaceSpaceDeleteState } from './workspace-space-state-resolution'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import type { useWorkspaceSpaceManagerBindings } from './use-workspace-space-manager-bindings'

type WorkspaceSpaceManagerBindings = ReturnType<typeof useWorkspaceSpaceManagerBindings>

export function useWorkspaceSpaceDecisionProjection(bindings: WorkspaceSpaceManagerBindings) {
  const {
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    agentStatusEpoch,
    agentStatusByPaneKey,
    analysis,
    browserTabsByWorktree,
    deleteStateByWorktreeId,
    editorDrafts,
    gitStatusByWorktree,
    gitStatusByWorktreeIdentity,
    hostedReviewCache,
    issueCache,
    linearIssueCache,
    migrationUnsupportedByPtyId,
    openFiles,
    ptyIdsByTabId,
    remoteStatusesByWorktree,
    repoMap,
    repos,
    retainedAgentsByPaneKey,
    runtimePaneTitlesByTabId,
    settings,
    tabsByWorktree,
    worktreeMap
  } = bindings

  const sourceRows = useMemo(() => analysis?.worktrees ?? [], [analysis?.worktrees])
  const worktreeIdCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of sourceRows) {
      counts.set(row.worktreeId, (counts.get(row.worktreeId) ?? 0) + 1)
    }
    return counts
  }, [sourceRows])
  const decisionDetailsByWorktreeId = useMemo(() => {
    // Why: the epoch bumps when fresh hook entries cross the stale boundary so
    // delete readiness recomputes with the same wall-clock sample as the store.
    const agentStatusNow = getAgentStatusEpochNow(agentStatusEpoch)
    const details = new Map<string, WorkspaceDecisionDetails>()
    for (const worktree of sourceRows) {
      details.set(
        getWorkspaceSpaceWorktreeIdentity(worktree),
        getWorkspaceDecisionDetails(worktree, {
          repoMap,
          worktreeMap,
          repos,
          tabsByWorktree,
          ptyIdsByTabId,
          agentStatusByPaneKey,
          migrationUnsupportedByPtyId,
          runtimePaneTitlesByTabId,
          retainedAgentsByPaneKey,
          openFiles,
          editorDrafts,
          browserTabsByWorktree,
          gitStatusByWorktree,
          gitStatusByWorktreeIdentity,
          remoteStatusesByWorktree,
          hostedReviewCache,
          issueCache,
          linearIssueCache,
          settings,
          activeWorktreeId,
          activeWorkspaceExecutionHostId,
          now: agentStatusNow
        })
      )
    }
    return details
  }, [
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    agentStatusEpoch,
    agentStatusByPaneKey,
    browserTabsByWorktree,
    editorDrafts,
    gitStatusByWorktree,
    gitStatusByWorktreeIdentity,
    hostedReviewCache,
    issueCache,
    linearIssueCache,
    openFiles,
    ptyIdsByTabId,
    repoMap,
    repos,
    remoteStatusesByWorktree,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId,
    runtimePaneTitlesByTabId,
    settings,
    sourceRows,
    tabsByWorktree,
    worktreeMap
  ])
  const getDeleteStateForWorktree = useCallback(
    (worktree: WorkspaceSpaceWorktree) =>
      getWorkspaceSpaceDeleteState(
        worktree,
        deleteStateByWorktreeId,
        (worktreeIdCounts.get(worktree.worktreeId) ?? 0) > 1
      ),
    [deleteStateByWorktreeId, worktreeIdCounts]
  )
  const isWorktreeDeleting = useCallback(
    (worktree: WorkspaceSpaceWorktree): boolean =>
      getDeleteStateForWorktree(worktree)?.isDeleting ?? false,
    [getDeleteStateForWorktree]
  )

  return {
    sourceRows,
    decisionDetailsByWorktreeId,
    getDeleteStateForWorktree,
    isWorktreeDeleting
  }
}
