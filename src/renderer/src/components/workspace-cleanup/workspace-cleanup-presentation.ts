import { getWorktreeMapFromState } from '@/store/selectors'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import type { HostedReviewInfo, HostedReviewProvider } from '../../../../shared/hosted-review'
import type { Repo, Worktree } from '../../../../shared/types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'

export type WorkspaceCleanupSortKey = 'activity' | 'name' | 'repo' | 'review' | 'git'
export type WorkspaceCleanupSortDirection = 'asc' | 'desc'
export type WorkspaceCleanupTimeFilter = 'all' | '30d' | '90d' | 'archived'
export type WorkspaceCleanupReviewFilter =
  | 'all'
  | 'no-review'
  | 'has-review'
  | 'open-review'
  | 'closed-review'
export type WorkspaceCleanupGitFilter = 'all' | 'clean' | 'dirty' | 'unpushed' | 'unknown'
export type WorkspaceCleanupContextFilter = 'all' | 'has-context' | 'no-context'

export type WorkspaceCleanupFilters = {
  query: string
  time: WorkspaceCleanupTimeFilter
  review: WorkspaceCleanupReviewFilter
  git: WorkspaceCleanupGitFilter
  context: WorkspaceCleanupContextFilter
}

export type WorkspaceCleanupReviewInfo = {
  hasReview: boolean
  label: string | null
  state: 'open' | 'closed' | 'merged' | 'draft' | 'unknown' | null
  provider: HostedReviewProvider | null
  title: string | null
}

export type WorkspaceCleanupRendererStateInputs = Pick<
  AppState,
  'worktreesByRepo' | 'hostedReviewCache' | 'repos' | 'settings'
>

export {
  filterWorkspaceCleanupCandidates,
  getWorkspaceCleanupGitLabel,
  getWorkspaceCleanupSearchText,
  hasWorkspaceCleanupLocalContext,
  sortWorkspaceCleanupCandidates
} from './workspace-cleanup-filter-sort'

export function getWorkspaceCleanupReviewInfo(
  candidate: WorkspaceCleanupCandidate,
  state: WorkspaceCleanupRendererStateInputs
): WorkspaceCleanupReviewInfo {
  const worktree = getWorktreeMapFromState(state).get(candidate.worktreeId) ?? null
  const repo = state.repos.find((entry) => entry.id === candidate.repoId) ?? null
  const hostedReview = getCachedHostedReview(candidate, worktree, repo, state)
  if (hostedReview) {
    return {
      hasReview: true,
      label: `${getReviewShortLabel(hostedReview.provider)} #${hostedReview.number}`,
      state: hostedReview.state,
      provider: hostedReview.provider,
      title: hostedReview.title
    }
  }

  const linkedReview = getLinkedReviewFallback(worktree)
  if (linkedReview) {
    return {
      hasReview: true,
      label: linkedReview.label,
      state: 'unknown',
      provider: linkedReview.provider,
      title: null
    }
  }

  return {
    hasReview: false,
    label: null,
    state: null,
    provider: null,
    title: null
  }
}

function getCachedHostedReview(
  candidate: WorkspaceCleanupCandidate,
  worktree: Worktree | null,
  repo: Repo | null,
  state: WorkspaceCleanupRendererStateInputs
): HostedReviewInfo | null {
  if (!repo) {
    return null
  }
  const cacheKey = getHostedReviewCacheKey(
    repo.path,
    getBranchDisplayName(worktree?.branch ?? candidate.branch),
    state.settings,
    repo.id,
    repo.connectionId
  )
  return state.hostedReviewCache[cacheKey]?.data ?? null
}

function getLinkedReviewFallback(worktree: Worktree | null): {
  label: string
  provider: HostedReviewProvider
} | null {
  if (!worktree) {
    return null
  }
  if (worktree.linkedGitLabMR != null) {
    return {
      label: `${translate(
        'auto.components.workspace.cleanup.presentation.0bb8d1aa02',
        'MR #'
      )}${worktree.linkedGitLabMR}`,
      provider: 'gitlab'
    }
  }
  if (worktree.linkedPR != null) {
    return {
      label: `${translate(
        'auto.components.workspace.cleanup.presentation.b1f1a02943',
        'PR #'
      )}${worktree.linkedPR}`,
      provider: 'github'
    }
  }
  return null
}

function getReviewShortLabel(provider: HostedReviewProvider): string {
  return provider === 'gitlab' ? 'MR' : 'PR'
}

function getBranchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '') || 'HEAD'
}
