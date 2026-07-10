import {
  buildFixBrokenChecksPrompt,
  getBrokenChecks,
  getCheckDetailsPromptKey
} from '@/components/pr-checks-fix-prompt'
import { gitHubPRToChecksPanelReview } from '@/components/right-sidebar/checks-panel-review'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { useAppStore } from '@/store'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRCheckDetail, PRCheckRunDetails, Repo } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export function resolveCheckRunDetailsFixCheck(
  check: PRCheckDetail,
  details: PRCheckRunDetails | null
): PRCheckDetail {
  if (!details) {
    return check
  }
  return {
    ...check,
    status: (details.status as PRCheckDetail['status'] | undefined) ?? check.status,
    conclusion: (details.conclusion as PRCheckDetail['conclusion'] | undefined) ?? check.conclusion
  }
}

export function isCheckRunDetailsFixCandidate(
  check: PRCheckDetail,
  details: PRCheckRunDetails | null = null
): boolean {
  return getBrokenChecks([resolveCheckRunDetailsFixCheck(check, details)]).length > 0
}

export function resolveHostedReviewForCheckRunDetailsFix(
  worktreeId: string
): HostedReviewInfo | null {
  const store = useAppStore.getState()
  const worktree = findWorktreeById(store.worktreesByRepo, worktreeId)
  if (!worktree) {
    return null
  }
  const repo = store.repos.find((candidate) => candidate.id === worktree.repoId) ?? null
  if (!repo) {
    return null
  }
  const identity = getWorktreeGitIdentityDisplay(worktree)
  const branch = identity?.kind === 'branch' ? identity.branchName : null
  if (!branch) {
    return null
  }
  const settings = store.settings
  const prCacheKey = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    branch,
    settings,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    repo.path,
    branch,
    settings,
    repo.id,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const pr = prCacheKey ? (store.prCache[prCacheKey]?.data ?? null) : null
  const hostedReview = hostedReviewCacheKey
    ? (store.hostedReviewCache[hostedReviewCacheKey]?.data ?? null)
    : null
  const gitLabHostedReview = hostedReview?.provider === 'gitlab' ? hostedReview : null
  const linkedGitLabMR = worktree.linkedGitLabMR ?? null
  if (gitLabHostedReview) {
    return gitLabHostedReview
  }
  if (linkedGitLabMR !== null) {
    return null
  }
  return pr ? gitHubPRToChecksPanelReview(pr) : null
}

export function buildCheckRunDetailsFixBasePrompt(args: {
  worktreeId: string
  check: PRCheckDetail
  details: PRCheckRunDetails | null
}): string | null {
  const review = resolveHostedReviewForCheckRunDetailsFix(args.worktreeId)
  if (!review) {
    return null
  }
  const resolvedCheck = resolveCheckRunDetailsFixCheck(args.check, args.details)
  if (!isCheckRunDetailsFixCandidate(resolvedCheck)) {
    return null
  }
  const checkRunDetailsByCheckKey = args.details
    ? { [getCheckDetailsPromptKey(resolvedCheck, 0)]: args.details }
    : undefined
  return buildFixBrokenChecksPrompt({
    reviewKind: review.provider === 'gitlab' ? 'MR' : 'PR',
    reviewNumber: review.number,
    reviewTitle: review.title,
    reviewUrl: review.url,
    checks: [resolvedCheck],
    checkRunDetailsByCheckKey
  })
}

export function getCheckRunDetailsFixDisabledReason(worktreeId: string | null): string | undefined {
  if (!worktreeId) {
    return translate(
      'auto.components.editor.check.run.details.fix.with.ai.1a8c4e2b90',
      'Select a workspace before launching an AI action.'
    )
  }
  const store = useAppStore.getState()
  const worktree = findWorktreeById(store.worktreesByRepo, worktreeId)
  if (!worktree) {
    return translate(
      'auto.components.editor.check.run.details.fix.with.ai.1a8c4e2b90',
      'Select a workspace before launching an AI action.'
    )
  }
  const repo = store.repos.find((candidate) => candidate.id === worktree.repoId) ?? null
  if (!repo) {
    return translate(
      'auto.components.editor.check.run.details.fix.with.ai.4f2d9a8c17',
      'Select a repository before launching an AI action.'
    )
  }
  if (!resolveHostedReviewForCheckRunDetailsFix(worktreeId)) {
    return translate(
      'auto.components.editor.check.run.details.fix.with.ai.7c3e1b5d42',
      'Open a PR or MR before launching an AI fix.'
    )
  }
  return undefined
}

export function resolveCheckRunDetailsFixRepo(worktreeId: string | null): Repo | null {
  if (!worktreeId) {
    return null
  }
  const store = useAppStore.getState()
  const worktree = findWorktreeById(store.worktreesByRepo, worktreeId)
  if (!worktree) {
    return null
  }
  return store.repos.find((candidate) => candidate.id === worktree.repoId) ?? null
}
