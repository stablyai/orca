import { useEffect, useEffectEvent } from 'react'
import {
  buildLocalBlockerHostedReviewCreationEligibility,
  resolveHostedReviewCreationProviderForTarget
} from './hosted-review-creation-eligibility-snapshot'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import type { SourceControlLinkedReviews } from './use-linked-reviews'
import type { SourceControlHostedReviewProviderHint } from './use-hosted-review-provider-hint'

export function useSourceControlHostedReviewEligibility({
  activeRepoConnectionId,
  activeRepoExecutionHostId,
  activeRepoId,
  activeRepoPath,
  activeWorktreeId,
  branchName,
  effectiveBaseRef,
  fallbackGitHubPRNumber,
  getHostedReviewCreationEligibility,
  hasUncommittedEntries,
  isBranchVisible,
  isCreatePrIntentInFlight,
  isCreatingPr,
  isFolder,
  linkedAzureDevOpsPR,
  linkedBitbucketPR,
  linkedGitHubPR,
  linkedGitLabMR,
  linkedGiteaPR,
  prGenerating,
  provisionalHostedReviewProvider,
  remoteStatus,
  hostedReviewCreationProviderHintRef,
  setHostedReviewCreationRequestState,
  setHostedReviewCreationState,
  worktreePath
}: {
  activeRepoConnectionId: SourceControlWorktreeContext['activeRepoConnectionId']
  activeRepoExecutionHostId: SourceControlWorktreeContext['activeRepoExecutionHostId']
  activeRepoId: SourceControlWorktreeContext['activeRepoId']
  activeRepoPath: SourceControlWorktreeContext['activeRepoPath']
  activeWorktreeId: string | null
  branchName: string
  effectiveBaseRef: string | null
  fallbackGitHubPRNumber: SourceControlLinkedReviews['fallbackGitHubPRNumber']
  getHostedReviewCreationEligibility: SourceControlStoreActions['getHostedReviewCreationEligibility']
  hasUncommittedEntries: boolean
  isBranchVisible: boolean
  isCreatePrIntentInFlight: boolean
  isCreatingPr: boolean
  isFolder: boolean
  linkedAzureDevOpsPR: SourceControlLinkedReviews['linkedAzureDevOpsPR']
  linkedBitbucketPR: SourceControlLinkedReviews['linkedBitbucketPR']
  linkedGitHubPR: SourceControlLinkedReviews['linkedGitHubPR']
  linkedGitLabMR: SourceControlLinkedReviews['linkedGitLabMR']
  linkedGiteaPR: SourceControlLinkedReviews['linkedGiteaPR']
  prGenerating: boolean
  provisionalHostedReviewProvider: SourceControlHostedReviewProviderHint['provisionalHostedReviewProvider']
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
  hostedReviewCreationProviderHintRef: SourceControlHostedReviewState['hostedReviewCreationProviderHintRef']
  setHostedReviewCreationRequestState: SourceControlHostedReviewState['setHostedReviewCreationRequestState']
  setHostedReviewCreationState: SourceControlHostedReviewState['setHostedReviewCreationState']
  worktreePath: string | null
}): void {
  const resolveCurrentHostedReviewCreationProvider = useEffectEvent(() =>
    resolveHostedReviewCreationProviderForTarget(
      hostedReviewCreationProviderHintRef.current,
      { repoId: activeRepoId, worktreeId: activeWorktreeId ?? null, branch: branchName },
      // Preserve the inferred provider during loading rather than falling back to unsupported.
      provisionalHostedReviewProvider
    )
  )

  useEffect(() => {
    if (
      !isBranchVisible ||
      !activeRepoId ||
      !activeRepoPath ||
      isFolder ||
      !branchName ||
      !activeWorktreeId
    ) {
      setHostedReviewCreationState(null)
      setHostedReviewCreationRequestState(null)
      return
    }
    // Mid-flight refetches can tear down the composer before the final refresh restores truth.
    if (prGenerating || isCreatingPr || isCreatePrIntentInFlight) {
      setHostedReviewCreationRequestState(null)
      return
    }
    let stale = false
    setHostedReviewCreationRequestState({
      repoId: activeRepoId,
      worktreeId: activeWorktreeId,
      branch: branchName,
      status: 'loading'
    })
    // Invalidate old eligibility immediately; changed upstream/status may make it unsafe to click.
    setHostedReviewCreationState(null)
    void getHostedReviewCreationEligibility({
      repoPath: activeRepoPath,
      repoId: activeRepoId,
      ...(worktreePath ? { worktreePath } : {}),
      branch: branchName,
      base: effectiveBaseRef ?? null,
      hasUncommittedChanges: hasUncommittedEntries,
      hasUpstream: remoteStatus?.hasUpstream,
      ahead: remoteStatus?.ahead,
      behind: remoteStatus?.behind,
      linkedGitHubPR,
      fallbackGitHubPR: fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR
    })
      .then((result) => {
        if (!stale) {
          setHostedReviewCreationState({
            repoId: activeRepoId,
            worktreeId: activeWorktreeId,
            branch: branchName,
            data: result
          })
          setHostedReviewCreationRequestState(null)
        }
      })
      .catch((error) => {
        console.warn('[SourceControl] hosted review creation eligibility failed', error)
        if (stale) {
          return
        }
        // Remote failure permits local guidance, never hosted-review creation.
        const localBlocker = buildLocalBlockerHostedReviewCreationEligibility(
          resolveCurrentHostedReviewCreationProvider(),
          {
            branch: branchName,
            baseRef: effectiveBaseRef,
            hasUncommittedChanges: hasUncommittedEntries,
            hasUpstream: remoteStatus?.hasUpstream,
            ahead: remoteStatus?.ahead,
            behind: remoteStatus?.behind
          }
        )
        if (localBlocker) {
          setHostedReviewCreationState({
            repoId: activeRepoId,
            worktreeId: activeWorktreeId,
            branch: branchName,
            data: localBlocker
          })
          setHostedReviewCreationRequestState(null)
          return
        }
        setHostedReviewCreationState(null)
        setHostedReviewCreationRequestState({
          repoId: activeRepoId,
          worktreeId: activeWorktreeId,
          branch: branchName,
          status: 'failed'
        })
      })
    return () => {
      stale = true
    }
  }, [
    // Metadata replacement must not restart a hung probe’s timeout.
    activeRepoConnectionId,
    activeRepoExecutionHostId,
    activeRepoId,
    activeRepoPath,
    branchName,
    effectiveBaseRef,
    getHostedReviewCreationEligibility,
    hasUncommittedEntries,
    setHostedReviewCreationRequestState,
    setHostedReviewCreationState,
    isBranchVisible,
    isCreatingPr,
    isCreatePrIntentInFlight,
    isFolder,
    linkedGitHubPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    prGenerating,
    remoteStatus?.ahead,
    remoteStatus?.behind,
    remoteStatus?.hasUpstream,
    activeWorktreeId,
    worktreePath
  ])
}
