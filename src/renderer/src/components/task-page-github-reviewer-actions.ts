import type { Dispatch, SetStateAction } from 'react'

import { translate } from '@/i18n/i18n'
import { getActiveRuntimeTarget, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { TaskPageGitHubMutationIntent } from '@/components/task-page-github-work-item-mutation-patches'
import {
  normalizeGitHubReviewerLogins,
  parseGitHubReviewerInputLogins
} from '@/components/github-pr-reviewer-display'
import { toast } from 'sonner'

import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { TaskPageGitHubWorkItemMutationRunner } from './task-page-linear-jira-list-model'
import { buildRequestedReviewUsers } from './task-page-github-review-model'

type ReviewerActionsInput = {
  item: GitHubWorkItem
  localReviewRequests: GitHubAssignableUser[]
  repo: Repo | null
  reviewRepo: GitHubOwnerRepo | null
  reviewerCandidates: GitHubAssignableUser[]
  reviewerInput: string
  selectedReviewerLogins: ReadonlySet<string>
  setLocalReviewRequests: Dispatch<SetStateAction<GitHubAssignableUser[]>>
  setOpen: Dispatch<SetStateAction<boolean>>
  setReviewerInput: Dispatch<SetStateAction<string>>
  setSubmitting: Dispatch<SetStateAction<boolean>>
  sourceContext?: TaskSourceContext | null
  sourceSettings: Parameters<typeof getActiveRuntimeTarget>[0]
  submitting: boolean
  workItemMutation: TaskPageGitHubWorkItemMutationRunner
}

export function createTaskPageGitHubReviewerActions({
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
}: ReviewerActionsInput): {
  handleRequestReview: (requestedLogins?: string[]) => Promise<void>
  requestReviewer: (reviewer: GitHubAssignableUser) => Promise<void>
} {
  const handleRequestReview = async (requestedLogins?: string[]): Promise<void> => {
    if (!repo || submitting) {
      return
    }
    const logins = normalizeGitHubReviewerLogins(
      requestedLogins ?? parseGitHubReviewerInputLogins(reviewerInput),
      selectedReviewerLogins
    )
    if (logins.length === 0) {
      toast.error(translate('auto.components.TaskPage.d00571d9b1', 'Enter a reviewer'))
      return
    }
    if (localReviewRequests.length + logins.length > 15) {
      toast.error(
        translate('auto.components.TaskPage.969e26577c', 'You can request up to 15 reviewers')
      )
      return
    }
    // Why: pre-network optimistic update via coordinator; local display follows
    // item.reviewRequests once patchWorkItem + reconcile land.
    const optimistic = buildRequestedReviewUsers(logins, reviewerCandidates, localReviewRequests)
    const intent = {
      type: 'addReviewers' as const,
      logins,
      candidates: reviewerCandidates
    }
    if (
      workItemMutation.isIntentPending({
        item,
        intent,
        sourceContext
      })
    ) {
      return
    }
    setLocalReviewRequests(optimistic)
    setSubmitting(true)
    try {
      const outcome = await workItemMutation.run({
        item,
        intent,
        sourceContext,
        successToast: translate('auto.components.TaskPage.8f06dbb9e5', 'Reviewer requested'),
        errorToast: translate('auto.components.TaskPage.dc67f69962', 'Failed to request reviewer'),
        mutate: async () => {
          const target = getActiveRuntimeTarget(sourceSettings)
          const runtimeRepoId =
            sourceContext?.provider === 'github' ? (sourceContext.repoId ?? repo.id) : repo.id
          return target.kind === 'environment'
            ? callRuntimeRpc<{
                ok: boolean
                error?: string
              }>(
                target,
                'github.requestPRReviewers',
                {
                  repo: runtimeRepoId,
                  prNumber: item.number,
                  reviewers: logins,
                  prRepo: reviewRepo
                },
                {
                  timeoutMs: 30_000
                }
              )
            : window.api.gh.requestPRReviewers({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext,
                prNumber: item.number,
                reviewers: logins,
                prRepo: reviewRepo
              })
        }
      })
      // Why: only clear the typed reviewer on success — a failed request rolls
      // back, so keep the user's input instead of forcing a retype.
      if (outcome === 'confirmed') {
        setReviewerInput('')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemoveReviewers = async (reviewersToRemove: string[]): Promise<void> => {
    if (!repo || submitting) {
      return
    }
    const selected = new Set(localReviewRequests.map((reviewer) => reviewer.login.toLowerCase()))
    const logins = reviewersToRemove
      .map((reviewer) => reviewer.trim().replace(/^@/, ''))
      .filter((reviewer) => reviewer.length > 0 && selected.has(reviewer.toLowerCase()))
    if (logins.length === 0) {
      return
    }
    const intent = {
      type: 'removeReviewers' as const,
      logins
    }
    if (
      workItemMutation.isIntentPending({
        item,
        intent,
        sourceContext
      })
    ) {
      return
    }
    const removed = new Set(logins.map((login) => login.toLowerCase()))
    setLocalReviewRequests((current) =>
      current.filter((reviewer) => !removed.has(reviewer.login.toLowerCase()))
    )
    setSubmitting(true)
    try {
      const outcome = await workItemMutation.run({
        item,
        intent,
        sourceContext,
        successToast:
          logins.length === 1
            ? translate('auto.components.TaskPage.f9191d1714', 'Reviewer removed')
            : translate('auto.components.TaskPage.837bb901ec', 'Reviewers removed'),
        errorToast: translate('auto.components.TaskPage.ed1daeb49a', 'Failed to remove reviewer'),
        mutate: async () => {
          const target = getActiveRuntimeTarget(sourceSettings)
          const runtimeRepoId =
            sourceContext?.provider === 'github' ? (sourceContext.repoId ?? repo.id) : repo.id
          return target.kind === 'environment'
            ? callRuntimeRpc<{
                ok: boolean
                error?: string
              }>(
                target,
                'github.removePRReviewers',
                {
                  repo: runtimeRepoId,
                  prNumber: item.number,
                  reviewers: logins,
                  prRepo: reviewRepo
                },
                {
                  timeoutMs: 30_000
                }
              )
            : window.api.gh.removePRReviewers({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext,
                prNumber: item.number,
                reviewers: logins,
                prRepo: reviewRepo
              })
        }
      })
      if (outcome === 'confirmed') {
        setReviewerInput('')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const requestReviewer = async (reviewer: GitHubAssignableUser): Promise<void> => {
    const intent: TaskPageGitHubMutationIntent = selectedReviewerLogins.has(
      reviewer.login.toLowerCase()
    )
      ? {
          type: 'removeReviewers',
          logins: [reviewer.login]
        }
      : {
          type: 'addReviewers',
          logins: [reviewer.login],
          candidates: reviewerCandidates
        }
    if (
      workItemMutation.isIntentPending({
        item,
        intent,
        sourceContext
      })
    ) {
      return
    }
    // Close the popover immediately for responsiveness; the GitHub request/remove runs in the background and toasts on completion.
    setOpen(false)
    setReviewerInput('')
    await (selectedReviewerLogins.has(reviewer.login.toLowerCase())
      ? handleRemoveReviewers([reviewer.login])
      : handleRequestReview([reviewer.login]))
  }

  return { handleRequestReview, requestReviewer }
}
