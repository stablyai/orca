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
  | 'ownerSettings'
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
    ownerSettings,
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
        { runtimeTargetSettings: ownerSettings }
      )
      await fetchUpstreamStatus(activeWorktreeId, activeWorktree.path, connectionId, undefined, {
        runtimeTargetSettings: ownerSettings
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
    ownerSettings,
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
        { runtimeTargetSettings: ownerSettings }
      )
      await fetchUpstreamStatus(
        activeWorktreeId,
        activeWorktree.path,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTargetSettings: ownerSettings }
      )
    } catch {
      // Store remote actions already surface the publish failure toast.
    } finally {
      // Why: publishing changes the upstream boundary the panel uses to decide between Publish, Create PR, and Push & Create PR.
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
    ownerSettings,
    pushBranch,
    setIsPublishingBranch,
    setGitStatusRefreshNonce
  ])

  // Sync via the same runtime-scoped operation and push target as Source Control so a `needs_sync` create blocker is actionable here.
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
          runtimeTargetSettings: ownerSettings
        }
      )
      await fetchUpstreamStatus(
        activeWorktreeId,
        activeWorktree.path,
        connectionId,
        activeWorktree.pushTarget,
        { runtimeTargetSettings: ownerSettings }
      )
    } catch {
      // Store remote actions already surface the sync failure toast.
    } finally {
      // Why: syncing changes ahead/behind, which the panel uses to choose between Sync, Create PR, and Push & Create PR.
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
    ownerSettings,
    syncBranch,
    setIsSyncingBranch,
    setGitStatusRefreshNonce
  ])
  return { pushBeforeCreatePullRequest, handlePublishBranch, handleSyncBranch }
}

export type ChecksPanelBranchActionsState = ReturnType<typeof useChecksPanelBranchActions>
