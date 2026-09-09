import { useMemo, useRef, useState } from 'react'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import type { HostedReviewInfo } from '../../../../../../shared/hosted-review'
import { isGitHubPRSuppressed } from '../../../../../../shared/worktree/github-pr-suppression'
import { resolveHostedReviewCreationProvider } from '../../../../../../shared/hosted-review-creation-providers'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type {
  HostedReviewCreationProviderHint,
  HostedReviewCreationRequestState,
  HostedReviewCreationState
} from './hosted-review-creation-state'

/**
 * Owns the hosted-review snapshot for the active repo/worktree/branch: the cached review itself plus
 * the creation-eligibility state, both scoped so a response for a previous target is ignored.
 */
export function useSourceControlHostedReviewState({
  activePrFromQueue,
  activeRepoId,
  activeWorktreeId,
  branchName,
  hostedReviewCacheKey,
  hostedReviewEntryData,
  linkedPR,
  suppressedGitHubPR
}: {
  activePrFromQueue: SourceControlWorktreeContext['activePrFromQueue']
  activeRepoId: string | null
  activeWorktreeId: string | null
  branchName: string
  hostedReviewCacheKey: string | null
  hostedReviewEntryData: SourceControlWorktreeContext['hostedReviewEntryData']
  linkedPR: number | null
  suppressedGitHubPR: number | null
}) {
  const [hostedReviewCreationState, setHostedReviewCreationState] =
    useState<HostedReviewCreationState | null>(null)
  const [hostedReviewCreationRequestState, setHostedReviewCreationRequestState] =
    useState<HostedReviewCreationRequestState | null>(null)
  const hostedReviewCreationProviderHintRef = useRef<HostedReviewCreationProviderHint>({
    repoId: null,
    worktreeId: null,
    branch: '',
    provider: 'github'
  })

  const scopedHostedReviewCreation =
    hostedReviewCreationState &&
    activeRepoId === hostedReviewCreationState.repoId &&
    activeWorktreeId === hostedReviewCreationState.worktreeId &&
    branchName === hostedReviewCreationState.branch
      ? hostedReviewCreationState.data
      : null
  const rawHostedReview: HostedReviewInfo | null = useMemo(() => {
    if (!hostedReviewCacheKey) {
      return null
    }
    if (activePrFromQueue) {
      return { provider: 'github', ...activePrFromQueue, status: activePrFromQueue.checksStatus }
    }
    return hostedReviewEntryData
  }, [activePrFromQueue, hostedReviewCacheKey, hostedReviewEntryData])
  const hasSuppressedGitHubPR =
    rawHostedReview?.provider === 'github' &&
    isGitHubPRSuppressed({ linkedPR, suppressedGitHubPR }, rawHostedReview.number)
  const hostedReview = hasSuppressedGitHubPR ? null : rawHostedReview
  const hostedReviewCreation =
    hasSuppressedGitHubPR && rawHostedReview
      ? {
          provider: 'github' as const,
          review: { number: rawHostedReview.number, url: rawHostedReview.url },
          canCreate: false,
          blockedReason: 'existing_review' as const,
          nextAction: 'open_existing_review' as const,
          reviewLookupOutcome: 'found' as const
        }
      : scopedHostedReviewCreation
  const hostedReviewCreateProvider = resolveHostedReviewCreationProvider(
    hostedReviewCreation?.provider
  )
  const hostedReviewCreateCopy = localizedHostedReviewCopy(hostedReviewCreateProvider)

  return {
    hasSuppressedGitHubPR,
    hostedReview,
    hostedReviewCreateCopy,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    hostedReviewCreationProviderHintRef,
    hostedReviewCreationRequestState,
    setHostedReviewCreationRequestState,
    setHostedReviewCreationState
  }
}

export type SourceControlHostedReviewState = ReturnType<typeof useSourceControlHostedReviewState>
