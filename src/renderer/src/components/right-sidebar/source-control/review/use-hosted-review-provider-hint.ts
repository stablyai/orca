import { useEffect, useMemo } from 'react'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo
} from '../../../../../../shared/hosted-review'
import {
  buildLoadingHostedReviewCreationEligibility,
  resolveHostedReviewCreationProviderForTarget
} from './hosted-review-creation-eligibility-snapshot'
import { resolveProvisionalHostedReviewProvider } from './primary-create-pr-intent-action'
import { parseRemoteRepo } from './remote-repo'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import type { SourceControlLinkedReviews } from './use-linked-reviews'

/**
 * Decides which provider the Create Review affordance should speak for before eligibility resolves,
 * remembering the last concrete answer per repo/worktree/branch so a refetch never flashes the
 * GitHub default at a GitLab (etc.) repo.
 */
export function useSourceControlHostedReviewProviderHint({
  activeRepo,
  activeRepoId,
  activeWorktreeId,
  branchName,
  fallbackGitHubPRNumber,
  hostedReview,
  hostedReviewCreation,
  hostedReviewCreationProviderHintRef,
  hostedReviewCreationRequestState,
  isBranchVisible,
  isFolder,
  linkedAzureDevOpsPR,
  linkedBitbucketPR,
  linkedGitHubPR,
  linkedGitLabMR,
  linkedGiteaPR
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeRepoId: string | null
  activeWorktreeId: string | null
  branchName: string
  fallbackGitHubPRNumber: SourceControlLinkedReviews['fallbackGitHubPRNumber']
  hostedReview: HostedReviewInfo | null
  hostedReviewCreation: HostedReviewCreationEligibility | null
  hostedReviewCreationProviderHintRef: SourceControlHostedReviewState['hostedReviewCreationProviderHintRef']
  hostedReviewCreationRequestState: SourceControlHostedReviewState['hostedReviewCreationRequestState']
  isBranchVisible: boolean
  isFolder: boolean
  linkedAzureDevOpsPR: SourceControlLinkedReviews['linkedAzureDevOpsPR']
  linkedBitbucketPR: SourceControlLinkedReviews['linkedBitbucketPR']
  linkedGitHubPR: SourceControlLinkedReviews['linkedGitHubPR']
  linkedGitLabMR: SourceControlLinkedReviews['linkedGitLabMR']
  linkedGiteaPR: SourceControlLinkedReviews['linkedGiteaPR']
}) {
  const shouldResolveHostedReviewCreation =
    isBranchVisible &&
    Boolean(activeRepo) &&
    !isFolder &&
    Boolean(branchName) &&
    branchName !== 'HEAD' &&
    Boolean(activeWorktreeId)
  const hostedReviewCreationRequestMatchesCurrent =
    hostedReviewCreationRequestState !== null &&
    activeRepo?.id === hostedReviewCreationRequestState.repoId &&
    activeWorktreeId === hostedReviewCreationRequestState.worktreeId &&
    branchName === hostedReviewCreationRequestState.branch
  const isHostedReviewCreationLoading =
    shouldResolveHostedReviewCreation &&
    hostedReviewCreationRequestMatchesCurrent &&
    hostedReviewCreationRequestState.status === 'loading' &&
    hostedReview === null
  // Why: infer provider from the remote host when unknown, so a GitLab (etc.) repo shows its own review copy instead of the GitHub default.
  const remoteInferredHostedReviewProvider = useMemo(
    () => parseRemoteRepo(activeRepo?.gitRemoteIdentity?.remoteUrl ?? '')?.provider ?? null,
    [activeRepo?.gitRemoteIdentity?.remoteUrl]
  )
  const provisionalHostedReviewProvider = useMemo(
    () =>
      resolveProvisionalHostedReviewProvider({
        hostedReview,
        hostedReviewCreationState: hostedReviewCreation
          ? {
              repoId: activeRepo?.id ?? '',
              data: hostedReviewCreation
            }
          : null,
        activeRepoId: activeRepo?.id ?? null,
        linkedGitHubPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR,
        remoteInferredProvider: remoteInferredHostedReviewProvider
      }),
    [
      activeRepo?.id,
      fallbackGitHubPRNumber,
      hostedReview,
      hostedReviewCreation,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGitHubPR,
      linkedGitLabMR,
      linkedGiteaPR,
      remoteInferredHostedReviewProvider
    ]
  )
  useEffect(() => {
    const hasConcreteProviderHint =
      hostedReview !== null ||
      hostedReviewCreation !== null ||
      linkedGitHubPR !== null ||
      fallbackGitHubPRNumber !== null ||
      linkedGitLabMR !== null ||
      linkedAzureDevOpsPR !== null ||
      linkedGiteaPR !== null

    if (!hasConcreteProviderHint) {
      return
    }

    hostedReviewCreationProviderHintRef.current = {
      repoId: activeRepo?.id ?? null,
      worktreeId: activeWorktreeId ?? null,
      branch: branchName,
      provider: provisionalHostedReviewProvider
    }
  }, [
    activeRepo?.id,
    activeWorktreeId,
    branchName,
    fallbackGitHubPRNumber,
    hostedReview,
    hostedReviewCreation,
    hostedReviewCreationProviderHintRef,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    linkedGitHubPR,
    linkedGitLabMR,
    provisionalHostedReviewProvider
  ])
  const hostedReviewCreationForHeader = useMemo(() => {
    // Why: during a fresh preflight, disable stale Create PR eligibility while state reconciles, but preserve provider copy from the last snapshot.
    if (isHostedReviewCreationLoading) {
      const provider = resolveHostedReviewCreationProviderForTarget(
        hostedReviewCreationProviderHintRef.current,
        { repoId: activeRepoId, worktreeId: activeWorktreeId ?? null, branch: branchName },
        provisionalHostedReviewProvider
      )
      return buildLoadingHostedReviewCreationEligibility(provider)
    }
    return hostedReviewCreation
  }, [
    activeRepoId,
    activeWorktreeId,
    branchName,
    hostedReviewCreation,
    hostedReviewCreationProviderHintRef,
    isHostedReviewCreationLoading,
    provisionalHostedReviewProvider
  ])

  return {
    hostedReviewCreationForHeader,
    hostedReviewCreationRequestMatchesCurrent,
    isHostedReviewCreationLoading,
    provisionalHostedReviewProvider,
    shouldResolveHostedReviewCreation
  }
}

export type SourceControlHostedReviewProviderHint = ReturnType<
  typeof useSourceControlHostedReviewProviderHint
>
