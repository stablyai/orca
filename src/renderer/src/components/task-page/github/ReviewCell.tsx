import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../../shared/repo-types'
import {
  type TaskSourceContext,
  getTaskSourceRuntimeSettings
} from '../../../../../shared/task-source-context'
import React, { useState, useMemo, useRef, useCallback } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import {
  getGitHubPRReviewerQueryState,
  filterGitHubPRReviewerCandidates
} from '@/components/github/github-pr-reviewer-candidate-filter'
import { translate } from '@/i18n/i18n'
import {
  getGitHubPRPrimaryReviewer,
  getGitHubPRReviewerRows,
  getGitHubPRReviewLabel
} from '@/components/github-pr-reviewer-display'
import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import type { TaskPageGitHubWorkItemMutationRunner } from '../../task-page-linear-jira-list-model'
import {
  mergeReviewerSuggestions,
  resolveTaskPullRequestRepo
} from '../../task-page-github-review-model'
import { ReviewChipAvatar } from './Avatars'
import { createTaskPageGitHubReviewerActions } from '../../task-page-github-reviewer-actions'
import { TaskPageGitHubReviewerPicker } from './ReviewerPicker'
export function PRReviewCell({
  item,
  repo,
  sourceContext,
  workItemMutation
}: {
  item: GitHubWorkItem
  repo: Repo | null
  sourceContext?: TaskSourceContext | null
  workItemMutation: TaskPageGitHubWorkItemMutationRunner
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [reviewerInput, setReviewerInput] = useState('')
  const [localReviewRequests, setLocalReviewRequests] = useState<GitHubAssignableUser[]>(
    () => item.reviewRequests ?? []
  )
  const [reviewerPickerSide, setReviewerPickerSide] = useState<'top' | 'bottom'>('bottom')
  const [reviewerPickerMaxHeight, setReviewerPickerMaxHeight] = useState<number | null>(null)
  const [reviewRequestsSource, setReviewRequestsSource] = useState(() => ({
    itemId: item.id,
    repoId: item.repoId,
    reviewRequests: item.reviewRequests
  }))
  const [activeReviewerCursor, setActiveReviewerCursor] = useState({
    resetKey: '',
    index: 0
  })
  const [submitting, setSubmitting] = useState(false)
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, repo?.id ?? null))
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
  const reviewerInputRef = useRef<HTMLInputElement | null>(null)
  const reviewerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const reviewerInputFocusFrameRef = useRef<number | null>(null)
  const cancelReviewerInputFocusFrame = useCallback((): void => {
    if (reviewerInputFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(reviewerInputFocusFrameRef.current)
    reviewerInputFocusFrameRef.current = null
  }, [])
  const setReviewerInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      // Why: the queued picker focus is only valid while this input is mounted.
      if (!node) {
        cancelReviewerInputFocusFrame()
      }
      reviewerInputRef.current = node
    },
    [cancelReviewerInputFocusFrame]
  )

  // Why: reviewer edits are optimistic, but item switches/refetches must clear stale local requests before paint (a passive Effect leaves one stale frame).
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
      add({
        login: item.author,
        name: null,
        avatarUrl: ''
      })
    }
    return Array.from(byLogin.values())
  }, [item.author, item.latestReviews, localReviewRequests])
  const reviewRepo = useMemo(() => resolveTaskPullRequestRepo(item), [item])
  const reviewerMetadata = useRepoAssigneesBySlug(
    open && reviewRepo ? reviewRepo.owner : null,
    open && reviewRepo ? reviewRepo.repo : null,
    reviewerSeedUsers.map((user) => user.login),
    sourceSettings,
    reviewRepo?.host
  )
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
    setActiveReviewerCursor({
      resetKey: reviewerCursorResetKey,
      index: 0
    })
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
  if (item.type !== 'pr') {
    return (
      <span className="text-[11px] text-muted-foreground">
        {translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}
      </span>
    )
  }
  const itemWithLocalReviewRequests = {
    ...item,
    reviewRequests: localReviewRequests
  }
  const primaryReviewer = getGitHubPRPrimaryReviewer(itemWithLocalReviewRequests)
  const reviewerRows = getGitHubPRReviewerRows(itemWithLocalReviewRequests)
  const extraReviewerCount = Math.max(0, reviewerRows.length - 1)
  const hasReviewerMetadata =
    item.reviewDecision !== undefined ||
    localReviewRequests.length > 0 ||
    item.reviewRequests !== undefined ||
    item.latestReviews !== undefined
  const { handleRequestReview, requestReviewer } = createTaskPageGitHubReviewerActions({
    item,
    localReviewRequests,
    repo,
    reviewRepo,
    reviewerCandidates,
    reviewerInput,
    selectedReviewerLogins,
    setLocalReviewRequests,
    setOpen,
    setReviewerInput,
    setSubmitting,
    sourceContext,
    sourceSettings,
    submitting,
    workItemMutation
  })
  const handleReviewerPickerOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      const rect = reviewerTriggerRef.current?.getBoundingClientRect()
      const gap = 8
      const availableBelow = rect ? window.innerHeight - rect.bottom - gap : 0
      const availableAbove = rect ? rect.top - gap : 0
      const nextSide = availableBelow < 240 && availableAbove > availableBelow ? 'top' : 'bottom'
      const available = nextSide === 'top' ? availableAbove : availableBelow
      setReviewerPickerSide(nextSide)
      setReviewerPickerMaxHeight(Math.max(180, Math.min(360, available || 360)))
    }
    setOpen(nextOpen)
    if (nextOpen) {
      cancelReviewerInputFocusFrame()
      reviewerInputFocusFrameRef.current = requestAnimationFrame(() => {
        reviewerInputFocusFrameRef.current = null
        reviewerInputRef.current?.focus()
      })
      return
    }
    cancelReviewerInputFocusFrame()
    setReviewerInput('')
  }
  return (
    <Popover open={open} onOpenChange={handleReviewerPickerOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={reviewerTriggerRef}
          type="button"
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex h-7 max-w-full items-center justify-center text-[12px] font-medium transition hover:brightness-110',
            primaryReviewer
              ? 'gap-1 rounded-full border border-border/40 bg-background/70 px-1.5 text-muted-foreground hover:text-foreground'
              : 'min-w-7 text-muted-foreground hover:text-foreground'
          )}
          aria-label={translate(
            'auto.components.TaskPage.editReviewersWithCurrent',
            'Edit reviewers: {{value0}}',
            {
              value0: getGitHubPRReviewLabel(itemWithLocalReviewRequests)
            }
          )}
          title={getGitHubPRReviewLabel(itemWithLocalReviewRequests)}
        >
          {primaryReviewer ? (
            <>
              <ReviewChipAvatar reviewer={primaryReviewer} avatarHost={reviewRepo?.host} />
              {extraReviewerCount > 0 ? (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  +{extraReviewerCount}
                </span>
              ) : null}
              <ChevronDown className="size-3 text-muted-foreground" />
            </>
          ) : (
            <span aria-hidden="true">-</span>
          )}
        </button>
      </PopoverTrigger>
      <TaskPageGitHubReviewerPicker
        actionableReviewerRows={actionableReviewerRows}
        activeReviewerIndex={activeReviewerIndex}
        everyoneElseReviewerRows={everyoneElseReviewerRows}
        filteredReviewerCandidates={filteredReviewerCandidates}
        handleRequestReview={handleRequestReview}
        handleReviewerPickerOpenChange={handleReviewerPickerOpenChange}
        hasReviewerMetadata={hasReviewerMetadata}
        repo={repo}
        requestReviewer={requestReviewer}
        reviewerInput={reviewerInput}
        reviewerMetadataError={reviewerMetadata.error}
        reviewerMetadataLoading={reviewerMetadata.loading}
        reviewerPickerMaxHeight={reviewerPickerMaxHeight}
        reviewerPickerSide={reviewerPickerSide}
        selectedReviewerLogins={selectedReviewerLogins}
        setActiveReviewerIndex={setActiveReviewerIndex}
        setReviewerInput={setReviewerInput}
        setReviewerInputNode={setReviewerInputNode}
        submitting={submitting}
        suggestedReviewerRows={suggestedReviewerRows}
      />
    </Popover>
  )
}
