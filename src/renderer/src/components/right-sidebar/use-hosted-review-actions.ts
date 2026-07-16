import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import type { GitHubPRAutoMergeAction } from '@/components/github-pr-merge-state'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo, Repo } from '../../../../shared/types'
import type { GitHubPRMergeMethod } from '../../../../shared/types'
import {
  mergeGitHubHostedReview,
  setGitHubHostedReviewAutoMerge,
  updateGitHubHostedReviewState
} from './hosted-review-github-actions'
import { translate } from '@/i18n/i18n'

export type HostedReviewActionInfo = Pick<
  HostedReviewInfo,
  'provider' | 'number' | 'state' | 'status' | 'mergeable'
> &
  Partial<
    Pick<
      HostedReviewInfo,
      | 'reviewDecision'
      | 'autoMergeEnabled'
      | 'autoMergeAllowed'
      | 'mergeQueueRequired'
      | 'mergeStateStatus'
    >
  >

export function buildHostedReviewStateConfirmation(args: {
  nextState: 'open' | 'closed'
  shortLabel: string
  isGitLab: boolean
  reviewNumber: number
}): {
  title: string
  description: string
  confirmLabel: string
  confirmVariant: 'default' | 'destructive'
} {
  const isClosing = args.nextState === 'closed'
  const reviewReference = `${args.shortLabel} ${args.isGitLab ? '!' : '#'}${args.reviewNumber}`
  const localizedReviewLabel = args.isGitLab
    ? translate(
        'auto.components.right.sidebar.HostedReviewActions.mergeRequestLabel',
        'merge request'
      )
    : translate(
        'auto.components.right.sidebar.HostedReviewActions.pullRequestLabel',
        'pull request'
      )
  // Why: Close/Reopen are sentence grammar, while the localized PR/MR
  // reference is data that translators can position within the full title.
  return {
    title: isClosing
      ? translate(
          'auto.components.right.sidebar.HostedReviewActions.57fb10cfe7',
          'Close {{value0}}?',
          { value0: reviewReference }
        )
      : translate(
          'auto.components.right.sidebar.HostedReviewActions.b982b128c0',
          'Reopen {{value0}}?',
          { value0: reviewReference }
        ),
    description: isClosing
      ? translate(
          'auto.components.right.sidebar.HostedReviewActions.a3d572a4de',
          'This will close the {{value0}}.',
          { value0: localizedReviewLabel }
        )
      : translate(
          'auto.components.right.sidebar.HostedReviewActions.78f5ff294c',
          'This will reopen the {{value0}}.',
          { value0: localizedReviewLabel }
        ),
    confirmLabel: isClosing
      ? translate('auto.components.right.sidebar.HostedReviewActions.73e5cc9c99', 'Close')
      : translate('auto.components.right.sidebar.HostedReviewActions.641c8ec02a', 'Reopen'),
    confirmVariant: isClosing ? 'destructive' : 'default'
  }
}

export function formatHostedReviewStateChangeFailure(
  nextState: 'open' | 'closed',
  isGitLab: boolean
): string {
  const localizedReviewLabel = isGitLab
    ? translate(
        'auto.components.right.sidebar.HostedReviewActions.mergeRequestLabel',
        'merge request'
      )
    : translate(
        'auto.components.right.sidebar.HostedReviewActions.pullRequestLabel',
        'pull request'
      )
  return nextState === 'closed'
    ? translate(
        'auto.components.right.sidebar.HostedReviewActions.72c9a274a7',
        'Failed to close the {{value0}}.',
        { value0: localizedReviewLabel }
      )
    : translate(
        'auto.components.right.sidebar.HostedReviewActions.93afca5395',
        'Failed to reopen the {{value0}}.',
        { value0: localizedReviewLabel }
      )
}

export function useHostedReviewActions({
  review,
  githubPR,
  repo,
  isGitLab,
  shortLabel,
  reviewLabel,
  defaultMergeMethod,
  autoMergeAction,
  onRefreshReview
}: {
  review: HostedReviewActionInfo
  githubPR?: PRInfo | null
  repo: Repo
  isGitLab: boolean
  shortLabel: string
  reviewLabel: string
  defaultMergeMethod: GitHubPRMergeMethod
  autoMergeAction: GitHubPRAutoMergeAction | null
  onRefreshReview: () => Promise<void>
}): {
  merging: boolean
  stateUpdating: 'open' | 'closed' | null
  actionError: string | null
  handleMerge: (method?: GitHubPRMergeMethod) => Promise<void>
  handleAutoMerge: () => Promise<void>
  handleCloseReview: () => Promise<void>
  handleReopenReview: () => Promise<void>
} {
  const confirm = useConfirmationDialog()
  const [merging, setMerging] = useState(false)
  const [stateUpdating, setStateUpdating] = useState<'open' | 'closed' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const handleMerge = useCallback(
    async (method: GitHubPRMergeMethod = defaultMergeMethod) => {
      setMerging(true)
      setActionError(null)
      try {
        const result = isGitLab
          ? await window.api.gl.mergeMR({
              repoPath: repo.path,
              repoId: repo.id,
              iid: review.number,
              method
            })
          : await mergeGitHubHostedReview({
              repo,
              prNumber: review.number,
              method,
              prRepo: githubPR?.prRepo ?? null
            })
        if (!result.ok) {
          setActionError(result.error)
        } else {
          await onRefreshReview()
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Merge failed')
      } finally {
        setMerging(false)
      }
    },
    [githubPR?.prRepo, isGitLab, defaultMergeMethod, onRefreshReview, repo, review.number]
  )

  const handleAutoMerge = useCallback(async () => {
    if (isGitLab || !autoMergeAction) {
      return
    }
    const enabled = autoMergeAction.kind === 'enable'
    setMerging(true)
    setActionError(null)
    try {
      const result = await setGitHubHostedReviewAutoMerge({
        repo,
        prNumber: review.number,
        enabled,
        method: enabled ? defaultMergeMethod : undefined,
        prRepo: githubPR?.prRepo ?? null
      })
      if (!result.ok) {
        setActionError(result.error)
      } else {
        await onRefreshReview()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Auto-merge update failed')
    } finally {
      setMerging(false)
    }
  }, [
    githubPR?.prRepo,
    isGitLab,
    autoMergeAction,
    defaultMergeMethod,
    onRefreshReview,
    repo,
    review.number
  ])

  const handleReviewStateChange = useCallback(
    async (nextState: 'open' | 'closed') => {
      if (stateUpdating) {
        return
      }
      const isClosing = nextState === 'closed'
      const confirmed = await confirm(
        buildHostedReviewStateConfirmation({
          nextState,
          shortLabel,
          isGitLab,
          reviewNumber: review.number
        })
      )
      if (!confirmed) {
        return
      }
      setStateUpdating(nextState)
      setActionError(null)
      try {
        const result = isGitLab
          ? isClosing
            ? await window.api.gl.closeMR({
                repoPath: repo.path,
                repoId: repo.id,
                iid: review.number
              })
            : await window.api.gl.reopenMR({
                repoPath: repo.path,
                repoId: repo.id,
                iid: review.number
              })
          : await updateGitHubHostedReviewState({
              repo,
              prNumber: review.number,
              nextState
            })
        if (!result.ok) {
          setActionError(result.error)
          toast.error(result.error)
        } else {
          toast.success(
            isClosing
              ? translate(
                  'auto.components.right.sidebar.HostedReviewActions.reviewClosedToast',
                  '{{value0}} closed',
                  { value0: shortLabel }
                )
              : translate(
                  'auto.components.right.sidebar.HostedReviewActions.377269db6f',
                  '{{value0}} reopened',
                  { value0: shortLabel }
                )
          )
          await onRefreshReview()
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : formatHostedReviewStateChangeFailure(nextState, isGitLab)
        setActionError(message)
        toast.error(message)
      } finally {
        setStateUpdating(null)
      }
    },
    [
      confirm,
      isGitLab,
      onRefreshReview,
      repo,
      review.number,
      reviewLabel,
      shortLabel,
      stateUpdating
    ]
  )

  const handleCloseReview = useCallback(async () => {
    await handleReviewStateChange('closed')
  }, [handleReviewStateChange])

  const handleReopenReview = useCallback(async () => {
    await handleReviewStateChange('open')
  }, [handleReviewStateChange])

  return {
    merging,
    stateUpdating,
    actionError,
    handleMerge,
    handleAutoMerge,
    handleCloseReview,
    handleReopenReview
  }
}
