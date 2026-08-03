import type { Dispatch, SetStateAction } from 'react'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { ProjectGroupImportResult } from '../../../../shared/types'
import type { WorktreeFetchOptions } from '@/store/slices/worktree-helpers'
import { useAddRepoNestedImportFlow } from './useAddRepoNestedImportFlow'
import { useAddRepoNestedReviewState } from './useAddRepoNestedReviewState'
import { useAddRepoRemoteNestedScan } from './use-add-repo-remote-nested-scan'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function useAddRepoNestedReviewController({
  activeRuntimeEnvironmentId,
  cancelNestedRepoScan,
  closeModal,
  fetchWorktrees,
  importNestedRepos,
  onGitRepoReady,
  setIsAdding,
  setStep,
  reviewRuntimeEnvironmentId
}: {
  activeRuntimeEnvironmentId: string | null | undefined
  reviewRuntimeEnvironmentId: string | null | undefined
  cancelNestedRepoScan: (
    scanId: string,
    options?: { runtimeEnvironmentId?: string | null }
  ) => Promise<unknown>
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: WorktreeFetchOptions) => Promise<unknown>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    runtimeEnvironmentId?: string | null
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  onGitRepoReady: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
  setIsAdding: (isAdding: boolean) => void
  setStep: Dispatch<SetStateAction<AddRepoDialogStep>>
}): ReturnType<typeof useAddRepoNestedReviewState> &
  Pick<
    ReturnType<typeof useAddRepoNestedImportFlow>,
    | 'handleImportNestedRepos'
    | 'handleOpenNestedRootFolder'
    | 'resetNestedImportFlow'
    | 'trackNestedBackAction'
  > &
  ReturnType<typeof useAddRepoRemoteNestedScan> {
  const review = useAddRepoNestedReviewState({
    activeRuntimeEnvironmentId: reviewRuntimeEnvironmentId,
    cancelNestedRepoScan,
    setStep
  })
  const remote = useAddRepoRemoteNestedScan({
    setActiveNestedScanId: review.setActiveNestedScanId,
    showNestedRepoReview: review.showNestedRepoReview
  })
  const imports = useAddRepoNestedImportFlow({
    activeRuntimeEnvironmentId,
    closeModal,
    fetchWorktrees,
    importNestedRepos,
    onGitRepoReady,
    setIsAdding,
    nestedAttemptId: review.nestedAttemptId,
    nestedScan: review.nestedScan,
    nestedSelectedPaths: review.nestedSelectedPaths,
    nestedRuntimeKind: review.nestedRuntimeKind,
    nestedConnectionId: review.nestedConnectionId,
    nestedGroupName: review.nestedGroupName,
    nestedImportScanId: review.nestedImportScanId,
    nestedRuntimeEnvironmentId: review.nestedRuntimeEnvironmentId,
    getNestedRepoRuntimeKind: review.getNestedRepoRuntimeKind
  })
  return { ...review, ...remote, ...imports }
}
