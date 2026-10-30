import { useCallback } from 'react'

import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'

type ChecksPanelBranchActionsInput = Pick<
  ChecksPanelControllerState,
  | 'activeConnectionId'
  | 'activeWorktree'
  | 'activeWorktreeId'
  | 'fetchUpstreamStatus'
  | 'isPublishingBranch'
  | 'isRemoteOperationActive'
  | 'isSyncingBranch'
  | 'ownerTarget'
  | 'pushBranch'
  | 'setGitStatusRefreshNonce'
  | 'setIsPublishingBranch'
  | 'setIsSyncingBranch'
  | 'syncBranch'
>

export function useChecksPanelBranchActions(model: ChecksPanelBranchActionsInput) {
  const {
    activeConnectionId,
    activeWorktree,
    activeWorktreeId,
    fetchUpstreamStatus,
    isPublishingBranch,
    isRemoteOperationActive,
    isSyncingBranch,
    ownerTarget,
    pushBranch,
    setGitStatusRefreshNonce,
    setIsPublishingBranch,
    setIsSyncingBranch,
    syncBranch
  } = model
  const pushBeforeCreatePullRequest = useCallback(async (): Promise<boolean> => {
    if (!activeWorktreeId || !activeWorktree?.path) {
      return false
    }
    const connectionId = activeConnectionId ?? undefined
    try {
      await pushBranch(
        activeWorktreeId,
        activeWorktree.path,
        false,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTarget: ownerTarget }
      )
      await fetchUpstreamStatus(activeWorktreeId, activeWorktree.path, connectionId, undefined, {
        runtimeTarget: ownerTarget
      })
      return true
    } catch {
      return false
    }
  }, [
    activeConnectionId,
    activeWorktree,
    activeWorktreeId,
    fetchUpstreamStatus,
    ownerTarget,
    pushBranch
  ])

  const handlePublishBranch = useCallback(async (): Promise<void> => {
    if (
      !activeWorktreeId ||
      !activeWorktree?.path ||
      isPublishingBranch ||
      isRemoteOperationActive
    ) {
      return
    }
    const connectionId = activeConnectionId ?? undefined
    setIsPublishingBranch(true)
    try {
      await pushBranch(
        activeWorktreeId,
        activeWorktree.path,
        true,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTarget: ownerTarget }
      )
      await fetchUpstreamStatus(
        activeWorktreeId,
        activeWorktree.path,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTarget: ownerTarget }
      )
    } catch {
      // Store remote actions already surface the publish failure toast.
    } finally {
      // Publishing changes the upstream boundary used to choose Publish/Create/Push & Create.
      setGitStatusRefreshNonce((value) => value + 1)
      setIsPublishingBranch(false)
    }
  }, [
    activeWorktree,
    activeWorktreeId,
    activeConnectionId,
    fetchUpstreamStatus,
    isPublishingBranch,
    isRemoteOperationActive,
    ownerTarget,
    pushBranch,
    setIsPublishingBranch,
    setGitStatusRefreshNonce
  ])

  // Reuse Source Control's runtime-scoped sync and push target to satisfy needs_sync blockers.
  const handleSyncBranch = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId || !activeWorktree?.path || isSyncingBranch || isRemoteOperationActive) {
      return
    }
    const connectionId = activeConnectionId ?? undefined
    setIsSyncingBranch(true)
    try {
      await syncBranch(
        activeWorktreeId,
        activeWorktree.path,
        connectionId,
        activeWorktree.pushTarget,
        {
          runtimeTarget: ownerTarget
        }
      )
      await fetchUpstreamStatus(
        activeWorktreeId,
        activeWorktree.path,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTarget: ownerTarget }
      )
    } catch {
      // Store remote actions already surface the sync failure toast.
    } finally {
      // Sync changes ahead/behind and therefore the available review-creation action.
      setGitStatusRefreshNonce((value) => value + 1)
      setIsSyncingBranch(false)
    }
  }, [
    activeWorktree,
    activeWorktreeId,
    activeConnectionId,
    fetchUpstreamStatus,
    isSyncingBranch,
    isRemoteOperationActive,
    ownerTarget,
    syncBranch,
    setIsSyncingBranch,
    setGitStatusRefreshNonce
  ])
  return { pushBeforeCreatePullRequest, handlePublishBranch, handleSyncBranch }
}

export type ChecksPanelBranchActionsState = ReturnType<typeof useChecksPanelBranchActions>
