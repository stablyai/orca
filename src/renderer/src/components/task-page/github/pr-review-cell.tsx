import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  normalizeGitHubReviewerLogins,
  parseGitHubReviewerInputLogins
} from '@/components/github-pr-reviewer-display'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import {
  buildRequestedReviewUsers,
  mergeReviewerSuggestions,
  resolveTaskPullRequestRepo
} from './github-reviewer-suggestions'
import type { TaskPageGitHubWorkItemMutationRunner } from './github-work-item-mutation-runner'
import { PRReviewPicker } from './pr-review-picker'

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
  const [reviewRequestsSource, setReviewRequestsSource] = useState(() => ({
    itemId: item.id,
    repoId: item.repoId,
    reviewRequests: item.reviewRequests
  }))
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
      add({ login: item.author, name: null, avatarUrl: '' })
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
  const selectedReviewerLogins = useMemo(
    () =>
      new Set(
        localReviewRequests.map((reviewer) => reviewer.login.trim().toLowerCase()).filter(Boolean)
      ),
    [localReviewRequests]
  )

  if (item.type !== 'pr') {
    return (
      <span className="text-[11px] text-muted-foreground">
        {translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}
      </span>
    )
  }

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
    if (workItemMutation.isIntentPending({ item, intent, sourceContext })) {
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
            ? callRuntimeRpc<{ ok: boolean; error?: string }>(
                target,
                'github.requestPRReviewers',
                {
                  repo: runtimeRepoId,
                  prNumber: item.number,
                  reviewers: logins,
                  prRepo: reviewRepo
                },
                { timeoutMs: 30_000 }
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
    const intent = { type: 'removeReviewers' as const, logins }
    if (workItemMutation.isIntentPending({ item, intent, sourceContext })) {
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
            ? callRuntimeRpc<{ ok: boolean; error?: string }>(
                target,
                'github.removePRReviewers',
                {
                  repo: runtimeRepoId,
                  prNumber: item.number,
                  reviewers: logins,
                  prRepo: reviewRepo
                },
                { timeoutMs: 30_000 }
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

  return (
    <PRReviewPicker
      item={item}
      repo={repo}
      sourceContext={sourceContext}
      workItemMutation={workItemMutation}
      open={open}
      setOpen={setOpen}
      reviewerInput={reviewerInput}
      setReviewerInput={setReviewerInput}
      reviewRepo={reviewRepo}
      submitting={submitting}
      localReviewRequests={localReviewRequests}
      reviewerSeedUsers={reviewerSeedUsers}
      reviewerCandidates={reviewerCandidates}
      selectedReviewerLogins={selectedReviewerLogins}
      reviewerMetadata={reviewerMetadata}
      authorLogin={authorLogin}
      handleRequestReview={handleRequestReview}
      handleRemoveReviewers={handleRemoveReviewers}
    />
  )
}
