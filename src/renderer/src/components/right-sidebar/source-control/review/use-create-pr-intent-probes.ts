import { useCallback } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitBranchCompare } from '@/runtime/runtime-git-client'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/hosted-review'
import { refreshGitStatusForWorktreeStrict } from '../../git-status-refresh'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'
import { buildCreatePrIntentUnavailableEligibility } from './hosted-review-creation-eligibility-snapshot'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import type { SourceControlHostedReviewState } from './use-hosted-review-state'
import type { SourceControlLinkedReviews } from './use-linked-reviews'

/**
 * The three reads the Create-PR intent takes between steps. Each is pinned to the run token's
 * worktree/host so a worktree switch mid-run cannot make the intent read the wrong repo.
 */
export function useSourceControlCreatePrIntentProbes({
  activeRepo,
  activeRepoSettings,
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
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
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
          // Why: intent may continue after a worktree switch; use the token's original host target, not whatever is focused later.
          settings: activeRepoSettings,
          worktreeId: token.worktreeId,
          worktreePath: token.worktreePath,
          connectionId: getConnectionId(token.worktreeId) ?? undefined
        },
        baseRef
      )
      setGitBranchCompareResult(token.worktreeId, requestKey, result)
      return result.summary.status === 'ready' ? (result.summary.commitsAhead ?? 0) : undefined
    },
    [activeRepoSettings, beginGitBranchCompareRequest, setGitBranchCompareResult]
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
        // Why: when local status still yields a prep step (dirty/push/sync), keep the intent
        // moving. If nothing actionable can be synthesized, rethrow so the outer intent
        // catch surfaces a retry notice instead of leaving "Preparing…" stuck forever.
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
        // Why: intent can finish in the background after navigation; branch-safety checks must inspect the worktree that started it.
        settings: target.settings,
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
