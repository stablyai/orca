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

/**
 * Probes whether a hosted review can be created for the visible branch and parks the answer in the
 * creation state, degrading to a local-only blocker when the remote probe fails.
 */
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
      // Why: provisional already infers the remote host and defaults to github; never fall back to unsupported mid-load.
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
    // Why: skip refetches while a PR flow is mid-flight — recomputing eligibility then can tear down the composer before the final refresh restores truth.
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
    // Why: upstream/status changes can make the previous eligibility unsafe to click while the new preflight resolves.
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
        // Why: a failed remote probe can give branch guidance but cannot authorize hosted-review creation.
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
    // Why: unrelated repo metadata replacement must not restart a hung probe's timeout.
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
