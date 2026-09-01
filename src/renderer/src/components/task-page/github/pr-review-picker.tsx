import React, { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Popover, PopoverTrigger } from '@/components/ui/popover'
import {
  getGitHubPRPrimaryReviewer,
  getGitHubPRReviewerRows,
  getGitHubPRReviewLabel
} from '@/components/github-pr-reviewer-display'
import {
  filterGitHubPRReviewerCandidates,
  getGitHubPRReviewerQueryState
} from '@/components/github/github-pr-reviewer-candidate-filter'
import type { TaskPageGitHubMutationIntent } from '@/components/task-page-github-work-item-mutation-patches'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { ReviewChipAvatar } from './github-assignee-avatars'
import type { TaskPageGitHubWorkItemMutationRunner } from './github-work-item-mutation-runner'
import { PRReviewPickerPanel } from './pr-review-picker-panel'

export function PRReviewPicker({
  item,
  repo,
  sourceContext,
  workItemMutation,
  open,
  setOpen,
  reviewerInput,
  setReviewerInput,
  reviewRepo,
  submitting,
  localReviewRequests,
  reviewerSeedUsers,
  reviewerCandidates,
  selectedReviewerLogins,
  reviewerMetadata,
  authorLogin,
  handleRequestReview,
  handleRemoveReviewers
}: {
  item: GitHubWorkItem
  repo: Repo | null
  sourceContext?: TaskSourceContext | null
  workItemMutation: TaskPageGitHubWorkItemMutationRunner
  open: boolean
  setOpen: (open: boolean) => void
  reviewerInput: string
  setReviewerInput: (value: string) => void
  reviewRepo: GitHubOwnerRepo | null
  submitting: boolean
  localReviewRequests: GitHubAssignableUser[]
  reviewerSeedUsers: GitHubAssignableUser[]
  reviewerCandidates: GitHubAssignableUser[]
  selectedReviewerLogins: Set<string>
  reviewerMetadata: { data: GitHubAssignableUser[]; loading: boolean; error: string | null }
  authorLogin: string | null
  handleRequestReview: (requestedLogins?: string[]) => Promise<void>
  handleRemoveReviewers: (reviewersToRemove: string[]) => Promise<void>
}): React.JSX.Element {
  const [reviewerPickerSide, setReviewerPickerSide] = useState<'top' | 'bottom'>('bottom')
  const [reviewerPickerMaxHeight, setReviewerPickerMaxHeight] = useState<number | null>(null)
  const [activeReviewerCursor, setActiveReviewerCursor] = useState({ resetKey: '', index: 0 })
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

  const reviewerCandidatesByLogin = useMemo(
    () => new Map(reviewerCandidates.map((user) => [user.login.toLowerCase(), user])),
    [reviewerCandidates]
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

  const itemWithLocalReviewRequests = { ...item, reviewRequests: localReviewRequests }
  const primaryReviewer = getGitHubPRPrimaryReviewer(itemWithLocalReviewRequests)
  const reviewerRows = getGitHubPRReviewerRows(itemWithLocalReviewRequests)
  const extraReviewerCount = Math.max(0, reviewerRows.length - 1)
  const hasReviewerMetadata =
    item.reviewDecision !== undefined ||
    localReviewRequests.length > 0 ||
    item.reviewRequests !== undefined ||
    item.latestReviews !== undefined

  const requestReviewer = async (reviewer: GitHubAssignableUser): Promise<void> => {
    const intent: TaskPageGitHubMutationIntent = selectedReviewerLogins.has(
      reviewer.login.toLowerCase()
    )
      ? { type: 'removeReviewers', logins: [reviewer.login] }
      : { type: 'addReviewers', logins: [reviewer.login], candidates: reviewerCandidates }
    if (workItemMutation.isIntentPending({ item, intent, sourceContext })) {
      return
    }
    // Close the popover immediately for responsiveness; the GitHub request/remove runs in the background and toasts on completion.
    setOpen(false)
    setReviewerInput('')
    await (selectedReviewerLogins.has(reviewer.login.toLowerCase())
      ? handleRemoveReviewers([reviewer.login])
      : handleRequestReview([reviewer.login]))
  }

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
            { value0: getGitHubPRReviewLabel(itemWithLocalReviewRequests) }
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
      <PRReviewPickerPanel
        reviewerPickerSide={reviewerPickerSide}
        reviewerPickerMaxHeight={reviewerPickerMaxHeight}
        setReviewerInputNode={setReviewerInputNode}
        reviewerInput={reviewerInput}
        setReviewerInput={setReviewerInput}
        repoAvailable={!!repo}
        submitting={submitting}
        actionableReviewerRows={actionableReviewerRows}
        activeReviewerIndex={activeReviewerIndex}
        setActiveReviewerIndex={setActiveReviewerIndex}
        requestReviewer={requestReviewer}
        handleRequestReview={handleRequestReview}
        handleReviewerPickerOpenChange={handleReviewerPickerOpenChange}
        reviewerMetadataLoading={reviewerMetadata.loading}
        reviewerMetadataError={reviewerMetadata.error}
        filteredReviewerCandidates={filteredReviewerCandidates}
        suggestedReviewerRows={suggestedReviewerRows}
        everyoneElseReviewerRows={everyoneElseReviewerRows}
        selectedReviewerLogins={selectedReviewerLogins}
        hasReviewerMetadata={hasReviewerMetadata}
      />
    </Popover>
  )
}
