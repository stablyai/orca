import { useCallback } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitBranchCompare } from '@/runtime/runtime-git-diff-client'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/hosted-review'
import { refreshGitStatusForWorktreeStrict } from '../../git-status-refresh'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'
import { buildCreatePrIntentUnavailableEligibility } from './hosted-review-creation-eligibility-snapshot'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import type { SourceControlLinkedReviews } from './use-linked-reviews'

/** Pin between-step probes to the run’s worktree/host so navigation cannot retarget them. */
export function useSourceControlCreatePrIntentProbes({
  activeRepo,
  activeRepoTarget,
  beginGitBranchCompareRequest,
  fallbackGitHubPRNumber,
  getCreatePrIntentOperationTarget,
  getHostedReviewCreationEligibility,
  isFolder,
  linkedAzureDevOpsPR,
  linkedBitbucketPR,
  linkedGitHubPR,
  linkedGitLabMR,
  linkedGiteaPR,
  setGitBranchCompareResult,
  setGitStatus,
  setHostedReviewCreationState,
  setUpstreamStatus,
  updateWorktreeGitIdentity
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  beginGitBranchCompareRequest: SourceControlStoreActions['beginGitBranchCompareRequest']
  fallbackGitHubPRNumber: SourceControlLinkedReviews['fallbackGitHubPRNumber']
  getCreatePrIntentOperationTarget: SourceControlCreatePrIntentTarget['getCreatePrIntentOperationTarget']
  getHostedReviewCreationEligibility: SourceControlStoreActions['getHostedReviewCreationEligibility']
  isFolder: boolean
  linkedAzureDevOpsPR: SourceControlLinkedReviews['linkedAzureDevOpsPR']
  linkedBitbucketPR: SourceControlLinkedReviews['linkedBitbucketPR']
  linkedGitHubPR: SourceControlLinkedReviews['linkedGitHubPR']
  linkedGitLabMR: SourceControlLinkedReviews['linkedGitLabMR']
  linkedGiteaPR: SourceControlLinkedReviews['linkedGiteaPR']
  setGitBranchCompareResult: SourceControlStoreActions['setGitBranchCompareResult']
  setGitStatus: SourceControlStoreActions['setGitStatus']
  setHostedReviewCreationState: SourceControlHostedReviewState['setHostedReviewCreationState']
  setUpstreamStatus: SourceControlStoreActions['setUpstreamStatus']
  updateWorktreeGitIdentity: SourceControlStoreActions['updateWorktreeGitIdentity']
}) {
  const refreshBranchCompareForCreatePrIntent = useCallback(
    async (token: CreatePrIntentRunToken): Promise<number | undefined> => {
      const baseRef = token.baseRef?.trim()
      if (!baseRef) {
        return undefined
      }
      const requestKey = `${token.worktreeId}:${baseRef}:${Date.now()}:create-pr-intent`
      beginGitBranchCompareRequest(token.worktreeId, requestKey, baseRef)
      const result = await getRuntimeGitBranchCompare(
        {
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: token.worktreeId,
          worktreePath: token.worktreePath,
          connectionId: getConnectionId(token.worktreeId) ?? undefined
        },
        baseRef
      )
      setGitBranchCompareResult(token.worktreeId, requestKey, result)
      return result.summary.status === 'ready' ? (result.summary.commitsAhead ?? 0) : undefined
    },
    [activeRepoTarget, beginGitBranchCompareRequest, setGitBranchCompareResult]
  )

  const readHostedReviewCreationEligibilityForIntent = useCallback(
    async ({
      token,
      hasUncommittedChanges,
      upstreamStatus
    }: {
      token: CreatePrIntentRunToken
      hasUncommittedChanges: boolean
      upstreamStatus?: NonNullable<SourceControlWorktreeContext['remoteStatus']>
    }): Promise<HostedReviewCreationEligibility | null> => {
      if (!activeRepo || !token.branch) {
        return null
      }
      let result: HostedReviewCreationEligibility
      try {
        result = await getHostedReviewCreationEligibility({
          repoPath: activeRepo.path,
          repoId: activeRepo.id,
          worktreePath: token.worktreePath,
          branch: token.branch,
          base: token.baseRef ?? null,
          hasUncommittedChanges,
          hasUpstream: upstreamStatus?.hasUpstream,
          ahead: upstreamStatus?.ahead,
          behind: upstreamStatus?.behind,
          linkedGitHubPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR
        })
      } catch (error) {
        console.warn('[SourceControl] Create PR intent eligibility failed', error)
        // Continue with actionable local blockers; otherwise rethrow so the outer handler replaces Preparing with retry guidance.
        const fallback = buildCreatePrIntentUnavailableEligibility(token.provider, {
          branch: token.branch,
          baseRef: token.baseRef,
          hasUncommittedChanges,
          hasUpstream: upstreamStatus?.hasUpstream,
          ahead: upstreamStatus?.ahead,
          behind: upstreamStatus?.behind
        })
        if (!fallback) {
          throw error
        }
        result = fallback
      }
      setHostedReviewCreationState({
        repoId: activeRepo.id,
        worktreeId: token.worktreeId,
        branch: token.branch,
        data: result
      })
      return result
    },
    [
      activeRepo,
      fallbackGitHubPRNumber,
      getHostedReviewCreationEligibility,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitHubPR,
      linkedGitLabMR,
      setHostedReviewCreationState
    ]
  )

  const refreshGitStatusForCreatePrIntent = useCallback(
    async (token: CreatePrIntentRunToken) => {
      if (isFolder) {
        return null
      }
      const target = getCreatePrIntentOperationTarget(token)
      return await refreshGitStatusForWorktreeStrict({
        // Background completion must check the worktree that started the intent.
        target: requireGitOwnerTarget(target.target),
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        connectionId: target.connectionId,
        pushTarget: target.pushTarget,
        deps: {
          setGitStatus,
          updateWorktreeGitIdentity,
          setUpstreamStatus
        }
      })
    },
    [
      getCreatePrIntentOperationTarget,
      isFolder,
      setGitStatus,
      setUpstreamStatus,
      updateWorktreeGitIdentity
    ]
  )

  return {
    readHostedReviewCreationEligibilityForIntent,
    refreshBranchCompareForCreatePrIntent,
    refreshGitStatusForCreatePrIntent
  }
}

export type SourceControlCreatePrIntentProbes = ReturnType<
  typeof useSourceControlCreatePrIntentProbes
>
