import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useRepoAssignees } from '@/hooks/useIssueMetadata'
import { useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import { getTaskSourceRuntimeSettings } from '../../../../../shared/task-source-context'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { getGitHubPRReviewerRows } from '@/components/github-pr-reviewer-display'
import { mergeReviewerSuggestions } from '@/components/github/work-item-state-presentation'
import {
  filterGitHubPRReviewerCandidates,
  getGitHubPRReviewerQueryState
} from '@/components/github/github-pr-reviewer-candidate-filter'
import { translate } from '@/i18n/i18n'
import type { PullRequestPageProjectOrigin } from '../page-types'
import { createReviewerRequestActions } from './request-actions'
import { ReviewerPicker } from './picker'
import { ReviewerRequestedList } from './requested-list'

export function PRReviewersPanel({
  item,
  loading,
  repoPath,
  sourceContext,
  projectOrigin,
  onReviewersRequested
}: {
  item: GitHubWorkItem
  loading: boolean
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: PullRequestPageProjectOrigin
  onReviewersRequested: (reviewRequests: GitHubAssignableUser[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [reviewerInput, setReviewerInput] = useState('')
  const [activeReviewerCursor, setActiveReviewerCursor] = useState({
    resetKey: '',
    index: 0
  })
  const [submitting, setSubmitting] = useState(false)
  const [localReviewRequests, setLocalReviewRequests] = useState<GitHubAssignableUser[]>(
    () => item.reviewRequests ?? []
  )
  const [reviewRequestsSource, setReviewRequestsSource] = useState(() => ({
    itemId: item.id,
    repoId: item.repoId,
    reviewRequests: item.reviewRequests
  }))
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, item.repoId ?? null))
  )
  const sourceSettings = useMemo(
    () =>
      sourceContext?.provider === 'github'
        ? ({
            ...repoOwnerSettings,
            ...getTaskSourceRuntimeSettings(sourceContext)
          } as typeof repoOwnerSettings)
        : repoOwnerSettings,
    [repoOwnerSettings, sourceContext]
  )
  const submittingRef = useRef(false)
  const reviewerInputRef = useRef<HTMLInputElement | null>(null)
  const reviewerInputFocusFrameRef = useRef<number | null>(null)
  const reviewerPanelMountedRef = useRef(true)

  const cancelReviewerInputFocusFrame = useCallback((): void => {
    if (reviewerInputFocusFrameRef.current !== null) {
      cancelAnimationFrame(reviewerInputFocusFrameRef.current)
      reviewerInputFocusFrameRef.current = null
    }
  }, [])

  const scheduleReviewerInputFocus = useCallback((): void => {
    if (!reviewerPanelMountedRef.current) {
      return
    }
    cancelReviewerInputFocusFrame()
    reviewerInputFocusFrameRef.current = requestAnimationFrame(() => {
      reviewerInputFocusFrameRef.current = null
      reviewerInputRef.current?.focus()
    })
  }, [cancelReviewerInputFocusFrame])

  useEffect(() => {
    reviewerPanelMountedRef.current = true
    return () => {
      reviewerPanelMountedRef.current = false
      cancelReviewerInputFocusFrame()
    }
  }, [cancelReviewerInputFocusFrame])

  // Why: clear stale optimistic review requests before paint on item switch/refetch (a passive Effect leaves one stale render).
  if (
    reviewRequestsSource.itemId !== item.id ||
    reviewRequestsSource.repoId !== item.repoId ||
    reviewRequestsSource.reviewRequests !== item.reviewRequests
  ) {
    setReviewRequestsSource({
      itemId: item.id,
      repoId: item.repoId,
      reviewRequests: item.reviewRequests
    })
    setLocalReviewRequests(item.reviewRequests ?? [])
  }

  const reviewerSeedUsers = useMemo<GitHubAssignableUser[]>(() => {
    const byLogin = new Map<string, GitHubAssignableUser>()
    const add = (user: GitHubAssignableUser): void => {
      if (!user.login) {
        return
      }
      byLogin.set(user.login.toLowerCase(), user)
    }
    for (const user of localReviewRequests) {
      add(user)
    }
    for (const review of item.latestReviews ?? []) {
      add({
        login: review.login,
        name: null,
        avatarUrl: review.avatarUrl ?? ''
      })
    }
    if (item.author) {
      add({ login: item.author, name: null, avatarUrl: '' })
    }
    return Array.from(byLogin.values())
  }, [item.author, item.latestReviews, localReviewRequests])

  const reviewRepo = useMemo(
    () => resolvePullRequestRepo(item, projectOrigin),
    [item, projectOrigin]
  )
  const reviewerMetadataBySlug = useRepoAssigneesBySlug(
    open && reviewRepo ? reviewRepo.owner : null,
    open && reviewRepo ? reviewRepo.repo : null,
    reviewerSeedUsers.map((user) => user.login),
    sourceSettings,
    reviewRepo?.host
  )
  const reviewerMetadataByPath = useRepoAssignees(
    open && !reviewRepo ? repoPath : null,
    open && !reviewRepo ? item.repoId : null,
    sourceSettings
  )
  const reviewerMetadata = reviewRepo ? reviewerMetadataBySlug : reviewerMetadataByPath
  const displayItem = { ...item, reviewRequests: localReviewRequests }
  const reviewers = getGitHubPRReviewerRows(displayItem)
  const authorLogin = item.author?.toLowerCase() ?? null
  const reviewerCandidates = useMemo(
    () =>
      mergeReviewerSuggestions(reviewerMetadata.data, reviewerSeedUsers).filter(
        (user) => user.login.toLowerCase() !== authorLogin
      ),
    [authorLogin, reviewerMetadata.data, reviewerSeedUsers]
  )
  const reviewerCandidatesByLogin = useMemo(
    () => new Map(reviewerCandidates.map((user) => [user.login.toLowerCase(), user])),
    [reviewerCandidates]
  )
  const selectedReviewerLogins = useMemo(
    () =>
      new Set(
        localReviewRequests.map((reviewer) => reviewer.login.trim().toLowerCase()).filter(Boolean)
      ),
    [localReviewRequests]
  )
  const reviewerQueryState = useMemo(
    () => getGitHubPRReviewerQueryState(reviewerInput),
    [reviewerInput]
  )
  const reviewerQuery = reviewerQueryState.query
  const filteredReviewerCandidates = useMemo(
    () =>
      filterGitHubPRReviewerCandidates({
        candidates: reviewerCandidates,
        queryState: reviewerQueryState
      }),
    [reviewerCandidates, reviewerQueryState]
  )
  const suggestedReviewerRows = useMemo(
    () =>
      reviewerQuery.length === 0 && !reviewerQueryState.isTooLarge
        ? reviewerSeedUsers
            .filter((user) => !selectedReviewerLogins.has(user.login.toLowerCase()))
            .filter((user) => user.login.toLowerCase() !== authorLogin)
            .map((user) => reviewerCandidatesByLogin.get(user.login.toLowerCase()) ?? user)
            .slice(0, 1)
        : [],
    [
      authorLogin,
      reviewerCandidatesByLogin,
      reviewerQuery.length,
      reviewerQueryState.isTooLarge,
      reviewerSeedUsers,
      selectedReviewerLogins
    ]
  )
  const everyoneElseReviewerRows = useMemo(() => {
    const suggestedLogins = new Set(suggestedReviewerRows.map((user) => user.login.toLowerCase()))
    return filteredReviewerCandidates.filter(
      (user) => !suggestedLogins.has(user.login.toLowerCase())
    )
  }, [filteredReviewerCandidates, suggestedReviewerRows])
  const actionableReviewerRows = useMemo(
    () => [...suggestedReviewerRows, ...everyoneElseReviewerRows],
    [everyoneElseReviewerRows, suggestedReviewerRows]
  )

  const reviewerCursorResetKey = `${reviewerQuery}\u0000${actionableReviewerRows.length}`
  if (activeReviewerCursor.resetKey !== reviewerCursorResetKey) {
    setActiveReviewerCursor({ resetKey: reviewerCursorResetKey, index: 0 })
  }
  const activeReviewerIndex =
    activeReviewerCursor.resetKey === reviewerCursorResetKey ? activeReviewerCursor.index : 0
  const setActiveReviewerIndex = useCallback(
    (nextIndex: number | ((current: number) => number)): void => {
      setActiveReviewerCursor((current) => {
        const currentIndex = current.resetKey === reviewerCursorResetKey ? current.index : 0
        return {
          resetKey: reviewerCursorResetKey,
          index: typeof nextIndex === 'function' ? nextIndex(currentIndex) : nextIndex
        }
      })
    },
    [reviewerCursorResetKey]
  )

  const hasReviewerMetadata =
    item.reviewDecision !== undefined ||
    localReviewRequests.length > 0 ||
    item.reviewRequests !== undefined ||
    item.latestReviews !== undefined
  const canRequestReview =
    !!repoPath || getActiveRuntimeTarget(sourceSettings).kind === 'environment'

  const { handleRequestReview, handleRemoveReviewers, requestReviewer } =
    createReviewerRequestActions({
      submittingRef,
      setSubmitting,
      reviewerInput,
      setReviewerInput,
      selectedReviewerLogins,
      localReviewRequests,
      setLocalReviewRequests,
      sourceSettings,
      repoPath,
      sourceContext,
      item,
      reviewRepo,
      reviewerPanelMountedRef,
      reviewerCandidates,
      patchWorkItem,
      onReviewersRequested,
      scheduleReviewerInputFocus
    })

  const handleReviewerPickerOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (nextOpen) {
      scheduleReviewerInputFocus()
      return
    }
    setReviewerInput('')
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <span>{translate('auto.components.PullRequestPage.00d3be6bcd', 'Reviewers')}</span>
        <ReviewerPicker
          open={open}
          submitting={submitting}
          canRequestReview={canRequestReview}
          reviewerInput={reviewerInput}
          reviewerInputRef={reviewerInputRef}
          reviewerMetadataLoading={reviewerMetadata.loading}
          reviewerMetadataError={reviewerMetadata.error}
          hasReviewerMetadata={hasReviewerMetadata}
          filteredReviewerCandidates={filteredReviewerCandidates}
          suggestedReviewerRows={suggestedReviewerRows}
          everyoneElseReviewerRows={everyoneElseReviewerRows}
          actionableReviewerRows={actionableReviewerRows}
          activeReviewerIndex={activeReviewerIndex}
          selectedReviewerLogins={selectedReviewerLogins}
          onOpenChange={handleReviewerPickerOpenChange}
          onInputChange={setReviewerInput}
          onActiveIndexChange={setActiveReviewerIndex}
          onEnter={() => {
            const activeReviewer = actionableReviewerRows[activeReviewerIndex]
            if (activeReviewer) {
              void requestReviewer(activeReviewer)
              return
            }
            void handleRequestReview()
          }}
          onRequestReviewer={(reviewer) => {
            void requestReviewer(reviewer)
          }}
        />
      </div>
      <ReviewerRequestedList
        reviewers={reviewers}
        loading={loading}
        hasReviewerMetadata={hasReviewerMetadata}
        selectedReviewerLogins={selectedReviewerLogins}
        submitting={submitting}
        canRequestReview={canRequestReview}
        onRemove={(login) => {
          void handleRemoveReviewers([login])
        }}
      />
    </section>
  )
}
