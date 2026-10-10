import { toast } from 'sonner'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  normalizeGitHubReviewerLogins,
  parseGitHubReviewerInputLogins
} from '@/components/github-pr-reviewer-display'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { buildRequestedReviewUsers } from '@/components/github/work-item-state-presentation'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import { translate } from '@/i18n/i18n'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'

const MAX_REQUESTED_REVIEWERS = 15

type ReviewerRequestActionsArgs = {
  // Why: a ref, not the render-time `submitting` value, so two clicks in one tick can't both pass the guard.
  submittingRef: { current: boolean }
  setSubmitting: (value: boolean) => void
  reviewerInput: string
  setReviewerInput: (value: string) => void
  selectedReviewerLogins: Set<string>
  localReviewRequests: GitHubAssignableUser[]
  setLocalReviewRequests: (value: GitHubAssignableUser[]) => void
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  item: GitHubWorkItem
  reviewRepo: GitHubOwnerRepo | null
  reviewerPanelMountedRef: { current: boolean }
  reviewerCandidates: GitHubAssignableUser[]
  patchWorkItem: (
    id: string,
    patch: Partial<GitHubWorkItem>,
    repoId?: string | null,
    options?: { sourceContext?: TaskSourceContext | null }
  ) => void
  onReviewersRequested: (reviewRequests: GitHubAssignableUser[]) => void
  scheduleReviewerInputFocus: () => void
}

export function createReviewerRequestActions(args: ReviewerRequestActionsArgs): {
  handleRequestReview: (requestedLogins?: string[]) => Promise<void>
  handleRemoveReviewers: (reviewersToRemove: string[]) => Promise<void>
  requestReviewer: (reviewer: GitHubAssignableUser) => Promise<void>
} {
  const handleRequestReview = async (requestedLogins?: string[]): Promise<void> => {
    if (args.submittingRef.current) {
      return
    }
    const logins = normalizeGitHubReviewerLogins(
      requestedLogins ?? parseGitHubReviewerInputLogins(args.reviewerInput),
      args.selectedReviewerLogins
    )
    if (logins.length === 0) {
      toast.error(translate('auto.components.PullRequestPage.dace0d1a9f', 'Enter a reviewer'))
      return
    }
    if (args.localReviewRequests.length + logins.length > MAX_REQUESTED_REVIEWERS) {
      toast.error(
        translate(
          'auto.components.PullRequestPage.8f369a6b6b',
          'You can request up to 15 reviewers'
        )
      )
      return
    }
    const target = getActiveRuntimeTarget(args.sourceSettings)
    if (target.kind !== 'environment' && !args.repoPath) {
      toast.error(
        translate(
          'auto.components.PullRequestPage.1ae11c905c',
          'No repo context available for this pull request.'
        )
      )
      return
    }
    args.submittingRef.current = true
    args.setSubmitting(true)
    try {
      const runtimeRepo = getGitHubRuntimeRepoId(args.sourceContext, args.item.repoId)
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
              target,
              'github.requestPRReviewers',
              {
                repo: runtimeRepo,
                prNumber: args.item.number,
                reviewers: logins,
                prRepo: args.reviewRepo
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.requestPRReviewers({
              repoPath: args.repoPath ?? '',
              repoId: args.item.repoId,
              sourceContext: args.sourceContext,
              prNumber: args.item.number,
              reviewers: logins,
              prRepo: args.reviewRepo
            })
      if (!args.reviewerPanelMountedRef.current) {
        return
      }
      if (!result.ok) {
        toast.error(
          result.error ??
            translate('auto.components.PullRequestPage.2560588245', 'Failed to request reviewer')
        )
        return
      }
      const nextReviewRequests = buildRequestedReviewUsers(
        logins,
        args.reviewerCandidates,
        args.localReviewRequests
      )
      args.setLocalReviewRequests(nextReviewRequests)
      args.patchWorkItem(args.item.id, { reviewRequests: nextReviewRequests }, args.item.repoId, {
        sourceContext: args.sourceContext
      })
      args.onReviewersRequested(nextReviewRequests)
      if (target.kind === 'environment') {
        notifyWorkItemDetailsMutation(
          {
            repoPath: args.repoPath ?? '',
            repoId: args.item.repoId,
            sourceContext: args.sourceContext,
            type: 'pr',
            number: args.item.number
          },
          { local: false }
        )
      }
      args.setReviewerInput('')
      toast.success(
        logins.length === 1
          ? translate('auto.components.PullRequestPage.03282ff3b9', 'Reviewer requested')
          : translate('auto.components.PullRequestPage.102d3d177f', 'Reviewers requested')
      )
    } catch (err) {
      console.error('Failed to request pull request reviewer', err)
      if (args.reviewerPanelMountedRef.current) {
        toast.error(
          translate('auto.components.PullRequestPage.2560588245', 'Failed to request reviewer')
        )
      }
    } finally {
      args.submittingRef.current = false
      if (args.reviewerPanelMountedRef.current) {
        args.setSubmitting(false)
      }
    }
  }

  const handleRemoveReviewers = async (reviewersToRemove: string[]): Promise<void> => {
    if (args.submittingRef.current) {
      return
    }
    const selected = new Set(
      args.localReviewRequests.map((reviewer) => reviewer.login.toLowerCase())
    )
    const logins = reviewersToRemove
      .map((reviewer) => reviewer.trim().replace(/^@/, ''))
      .filter((reviewer) => reviewer.length > 0 && selected.has(reviewer.toLowerCase()))
    if (logins.length === 0) {
      return
    }
    const target = getActiveRuntimeTarget(args.sourceSettings)
    if (target.kind !== 'environment' && !args.repoPath) {
      toast.error(
        translate(
          'auto.components.PullRequestPage.1ae11c905c',
          'No repo context available for this pull request.'
        )
      )
      return
    }
    args.submittingRef.current = true
    args.setSubmitting(true)
    try {
      const runtimeRepo = getGitHubRuntimeRepoId(args.sourceContext, args.item.repoId)
      const result =
        target.kind === 'environment'
          ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
              target,
              'github.removePRReviewers',
              {
                repo: runtimeRepo,
                prNumber: args.item.number,
                reviewers: logins,
                prRepo: args.reviewRepo
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.removePRReviewers({
              repoPath: args.repoPath ?? '',
              repoId: args.item.repoId,
              sourceContext: args.sourceContext,
              prNumber: args.item.number,
              reviewers: logins,
              prRepo: args.reviewRepo
            })
      if (!args.reviewerPanelMountedRef.current) {
        return
      }
      if (!result.ok) {
        toast.error(
          result.error ??
            translate('auto.components.PullRequestPage.c798fa0ec7', 'Failed to remove reviewer')
        )
        return
      }
      const removed = new Set(logins.map((login) => login.toLowerCase()))
      const nextReviewRequests = args.localReviewRequests.filter(
        (reviewer) => !removed.has(reviewer.login.toLowerCase())
      )
      args.setLocalReviewRequests(nextReviewRequests)
      args.patchWorkItem(args.item.id, { reviewRequests: nextReviewRequests }, args.item.repoId, {
        sourceContext: args.sourceContext
      })
      args.onReviewersRequested(nextReviewRequests)
      if (target.kind === 'environment') {
        notifyWorkItemDetailsMutation(
          {
            repoPath: args.repoPath ?? '',
            repoId: args.item.repoId,
            sourceContext: args.sourceContext,
            type: 'pr',
            number: args.item.number
          },
          { local: false }
        )
      }
      args.setReviewerInput('')
      toast.success(
        logins.length === 1
          ? translate('auto.components.PullRequestPage.2c1d93da43', 'Reviewer removed')
          : translate('auto.components.PullRequestPage.1e6d089420', 'Reviewers removed')
      )
    } catch (err) {
      console.error('Failed to remove pull request reviewer', err)
      if (args.reviewerPanelMountedRef.current) {
        toast.error(
          translate('auto.components.PullRequestPage.c798fa0ec7', 'Failed to remove reviewer')
        )
      }
    } finally {
      args.submittingRef.current = false
      if (args.reviewerPanelMountedRef.current) {
        args.setSubmitting(false)
      }
    }
  }

  const requestReviewer = async (reviewer: GitHubAssignableUser): Promise<void> => {
    await (args.selectedReviewerLogins.has(reviewer.login.toLowerCase())
      ? handleRemoveReviewers([reviewer.login])
      : handleRequestReview([reviewer.login]))
    args.scheduleReviewerInputFocus()
  }

  return { handleRequestReview, handleRemoveReviewers, requestReviewer }
}
