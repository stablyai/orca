import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import {
  normalizeGitHubReviewerLogins,
  parseGitHubReviewerInputLogins
} from '@/components/github-pr-reviewer-display'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { buildRequestedReviewUsers } from '@/components/github/work-item-state-presentation'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'

type ReviewerRequestArgs = {
  submitting: boolean
  selectedReviewerLogins: Set<string>
  localReviewRequests: GitHubAssignableUser[]
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  item: GitHubWorkItem
  reviewRepo: GitHubOwnerRepo | null
  reviewerPanelMountedRef: { current: boolean }
  reviewerCandidates: GitHubAssignableUser[]
  setSubmitting: (value: boolean) => void
  setLocalReviewRequests: (value: GitHubAssignableUser[]) => void
  setReviewerInput: (value: string) => void
  patchWorkItem: (
    id: string,
    patch: { reviewRequests: GitHubAssignableUser[] },
    repoId: string | undefined,
    options: { sourceContext?: TaskSourceContext | null }
  ) => void
  onReviewersRequested: (reviewRequests: GitHubAssignableUser[]) => void
}

export async function requestPRReviewers({
  submitting,
  requestedLogins,
  reviewerInput,
  selectedReviewerLogins,
  localReviewRequests,
  sourceSettings,
  repoPath,
  sourceContext,
  item,
  reviewRepo,
  reviewerPanelMountedRef,
  reviewerCandidates,
  setSubmitting,
  setLocalReviewRequests,
  setReviewerInput,
  patchWorkItem,
  onReviewersRequested
}: ReviewerRequestArgs & {
  requestedLogins?: string[]
  reviewerInput: string
}): Promise<void> {
  if (submitting) {
    return
  }
  const logins = normalizeGitHubReviewerLogins(
    requestedLogins ?? parseGitHubReviewerInputLogins(reviewerInput),
    selectedReviewerLogins
  )
  if (logins.length === 0) {
    toast.error(translate('auto.components.GitHubItemDialog.94ab23a9f9', 'Enter a reviewer'))
    return
  }
  if (localReviewRequests.length + logins.length > 15) {
    toast.error(
      translate('auto.components.GitHubItemDialog.12e761610e', 'You can request up to 15 reviewers')
    )
    return
  }
  const target = getActiveRuntimeTarget(sourceSettings)
  if (target.kind !== 'environment' && !repoPath) {
    toast.error(
      translate(
        'auto.components.GitHubItemDialog.b4af16bf43',
        'No repo context available for this pull request.'
      )
    )
    return
  }
  setSubmitting(true)
  try {
    const runtimeRepo = getGitHubRuntimeRepoId(sourceContext, item.repoId)
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
            target,
            'github.requestPRReviewers',
            {
              repo: runtimeRepo,
              prNumber: item.number,
              reviewers: logins,
              prRepo: reviewRepo
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.requestPRReviewers({
            repoPath: repoPath ?? '',
            repoId: item.repoId,
            sourceContext,
            prNumber: item.number,
            reviewers: logins,
            prRepo: reviewRepo
          })
    if (!reviewerPanelMountedRef.current) {
      return
    }
    if (!result.ok) {
      toast.error(
        result.error ??
          translate('auto.components.GitHubItemDialog.c42d942b75', 'Failed to request reviewer')
      )
      return
    }
    const nextReviewRequests = buildRequestedReviewUsers(
      logins,
      reviewerCandidates,
      localReviewRequests
    )
    setLocalReviewRequests(nextReviewRequests)
    patchWorkItem(item.id, { reviewRequests: nextReviewRequests }, item.repoId, {
      sourceContext
    })
    onReviewersRequested(nextReviewRequests)
    if (target.kind === 'environment') {
      notifyWorkItemDetailsMutation(
        {
          repoPath: repoPath ?? '',
          repoId: item.repoId,
          sourceContext,
          type: 'pr',
          number: item.number
        },
        { local: false }
      )
    }
    setReviewerInput('')
    useAppStore.getState().recordFeatureInteraction('github-tasks')
    toast.success(
      logins.length === 1
        ? translate('auto.components.GitHubItemDialog.ea985e657f', 'Reviewer requested')
        : translate('auto.components.GitHubItemDialog.c016e4bac3', 'Reviewers requested')
    )
  } catch {
    if (reviewerPanelMountedRef.current) {
      toast.error(
        translate('auto.components.GitHubItemDialog.c42d942b75', 'Failed to request reviewer')
      )
    }
  } finally {
    if (reviewerPanelMountedRef.current) {
      setSubmitting(false)
    }
  }
}

export async function removePRReviewers({
  submitting,
  reviewersToRemove,
  localReviewRequests,
  sourceSettings,
  repoPath,
  sourceContext,
  item,
  reviewRepo,
  reviewerPanelMountedRef,
  setSubmitting,
  setLocalReviewRequests,
  setReviewerInput,
  patchWorkItem,
  onReviewersRequested
}: ReviewerRequestArgs & {
  reviewersToRemove: string[]
}): Promise<void> {
  if (submitting) {
    return
  }
  const selected = new Set(localReviewRequests.map((reviewer) => reviewer.login.toLowerCase()))
  const logins = reviewersToRemove
    .map((reviewer) => reviewer.trim().replace(/^@/, ''))
    .filter((reviewer) => reviewer.length > 0 && selected.has(reviewer.toLowerCase()))
  if (logins.length === 0) {
    return
  }
  const target = getActiveRuntimeTarget(sourceSettings)
  if (target.kind !== 'environment' && !repoPath) {
    toast.error(
      translate(
        'auto.components.GitHubItemDialog.b4af16bf43',
        'No repo context available for this pull request.'
      )
    )
    return
  }
  setSubmitting(true)
  try {
    const runtimeRepo = getGitHubRuntimeRepoId(sourceContext, item.repoId)
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<{ ok: boolean; error?: string }>(
            target,
            'github.removePRReviewers',
            {
              repo: runtimeRepo,
              prNumber: item.number,
              reviewers: logins,
              prRepo: reviewRepo
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.removePRReviewers({
            repoPath: repoPath ?? '',
            repoId: item.repoId,
            sourceContext,
            prNumber: item.number,
            reviewers: logins,
            prRepo: reviewRepo
          })
    if (!reviewerPanelMountedRef.current) {
      return
    }
    if (!result.ok) {
      toast.error(
        result.error ??
          translate('auto.components.GitHubItemDialog.73487fb975', 'Failed to remove reviewer')
      )
      return
    }
    const removed = new Set(logins.map((login) => login.toLowerCase()))
    const nextReviewRequests = localReviewRequests.filter(
      (reviewer) => !removed.has(reviewer.login.toLowerCase())
    )
    setLocalReviewRequests(nextReviewRequests)
    patchWorkItem(item.id, { reviewRequests: nextReviewRequests }, item.repoId, {
      sourceContext
    })
    onReviewersRequested(nextReviewRequests)
    if (target.kind === 'environment') {
      notifyWorkItemDetailsMutation(
        {
          repoPath: repoPath ?? '',
          repoId: item.repoId,
          sourceContext,
          type: 'pr',
          number: item.number
        },
        { local: false }
      )
    }
    setReviewerInput('')
    useAppStore.getState().recordFeatureInteraction('github-tasks')
    toast.success(
      logins.length === 1
        ? translate('auto.components.GitHubItemDialog.69515bff81', 'Reviewer removed')
        : translate('auto.components.GitHubItemDialog.2e69540652', 'Reviewers removed')
    )
  } catch {
    if (reviewerPanelMountedRef.current) {
      toast.error(
        translate('auto.components.GitHubItemDialog.73487fb975', 'Failed to remove reviewer')
      )
    }
  } finally {
    if (reviewerPanelMountedRef.current) {
      setSubmitting(false)
    }
  }
}
