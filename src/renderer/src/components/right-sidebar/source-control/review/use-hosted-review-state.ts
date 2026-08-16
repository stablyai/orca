import { useMemo, useRef, useState } from 'react'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import type { HostedReviewInfo } from '../../../../../../shared/hosted-review'
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
  hostedReviewEntryData
}: {
  activePrFromQueue: SourceControlWorktreeContext['activePrFromQueue']
  activeRepoId: string | null
  activeWorktreeId: string | null
  branchName: string
  hostedReviewCacheKey: string | null
  hostedReviewEntryData: SourceControlWorktreeContext['hostedReviewEntryData']
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

  const hostedReviewCreation =
    hostedReviewCreationState &&
    activeRepoId === hostedReviewCreationState.repoId &&
    activeWorktreeId === hostedReviewCreationState.worktreeId &&
    branchName === hostedReviewCreationState.branch
      ? hostedReviewCreationState.data
      : null
  const hostedReviewCreateProvider = resolveHostedReviewCreationProvider(
    hostedReviewCreation?.provider
  )
  const hostedReviewCreateCopy = localizedHostedReviewCopy(hostedReviewCreateProvider)
  const hostedReview: HostedReviewInfo | null = useMemo(() => {
    if (!hostedReviewCacheKey) {
      return null
    }
    if (activePrFromQueue) {
      return { provider: 'github', ...activePrFromQueue, status: activePrFromQueue.checksStatus }
    }
    return hostedReviewEntryData
  }, [activePrFromQueue, hostedReviewCacheKey, hostedReviewEntryData])

  return {
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
