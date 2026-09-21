import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { HostedReviewInfo, HostedReviewProvider } from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { isGitHubPRSuppressed } from '../../../../shared/worktree/github-pr-suppression'
import { getWorkspaceCleanupCandidateHostId } from './workspace-cleanup-host-identity'

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

export type WorkspaceCleanupReviewLookup = {
  reposById: ReadonlyMap<string, readonly Repo[]>
  worktreesByRepoAndId: ReadonlyMap<string, readonly Worktree[]>
}

export {
  filterWorkspaceCleanupCandidates,
  getWorkspaceCleanupGitLabel,
  getWorkspaceCleanupSearchText,
  hasWorkspaceCleanupLocalContext,
  sortWorkspaceCleanupCandidates
} from './workspace-cleanup-filter-sort'

export function getWorkspaceCleanupReviewInfo(
  candidate: WorkspaceCleanupCandidate,
  state: WorkspaceCleanupRendererStateInputs,
  lookup: WorkspaceCleanupReviewLookup = buildWorkspaceCleanupReviewLookup(state)
): WorkspaceCleanupReviewInfo {
  const repo = findCandidateRepo(candidate, lookup)
  const worktree = findCandidateWorktree(candidate, repo, lookup)
  const cachedHostedReview = getCachedHostedReview(candidate, worktree, repo, state)
  const hostedReview =
    cachedHostedReview?.provider === 'github' &&
    worktree &&
    isGitHubPRSuppressed(worktree, cachedHostedReview.number)
      ? null
      : cachedHostedReview
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

export function buildWorkspaceCleanupReviewLookup(
  state: Pick<WorkspaceCleanupRendererStateInputs, 'repos' | 'worktreesByRepo'>
): WorkspaceCleanupReviewLookup {
  const reposById = new Map<string, Repo[]>()
  for (const repo of state.repos) {
    const matches = reposById.get(repo.id) ?? []
    matches.push(repo)
    reposById.set(repo.id, matches)
  }
  const worktreesByRepoAndId = new Map<string, Worktree[]>()
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      const key = `${repoId}\0${worktree.id}`
      const matches = worktreesByRepoAndId.get(key) ?? []
      matches.push(worktree)
      worktreesByRepoAndId.set(key, matches)
    }
  }
  return { reposById, worktreesByRepoAndId }
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
    repo.connectionId,
    repo.executionHostId,
    true
  )
  return state.hostedReviewCache[cacheKey]?.data ?? null
}

function findCandidateRepo(
  candidate: WorkspaceCleanupCandidate,
  lookup: WorkspaceCleanupReviewLookup
): Repo | null {
  const matches = lookup.reposById.get(candidate.repoId) ?? []
  if (!candidate.executionHostId && !candidate.connectionId) {
    return matches.length === 1 ? matches[0] : null
  }
  const hostId = getWorkspaceCleanupCandidateHostId(candidate)
  const hostMatches = matches.filter((repo) => getRepoExecutionHostId(repo) === hostId)
  return hostMatches.length === 1 ? hostMatches[0] : null
}

function findCandidateWorktree(
  candidate: WorkspaceCleanupCandidate,
  repo: Repo | null,
  lookup: WorkspaceCleanupReviewLookup
): Worktree | null {
  const matches =
    lookup.worktreesByRepoAndId.get(`${candidate.repoId}\0${candidate.worktreeId}`) ?? []
  const hostId = getWorkspaceCleanupCandidateHostId(candidate)
  const hostMatches = matches.filter((worktree) => worktree.hostId === hostId)
  if (hostMatches.length === 1) {
    return hostMatches[0]
  }
  const legacyMatches = matches.filter((worktree) => !worktree.hostId)
  const repoMatches = lookup.reposById.get(candidate.repoId) ?? []
  return legacyMatches.length === 1 && repo && repoMatches.length === 1 ? legacyMatches[0] : null
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
      label: translate(
        'components.workspace.cleanup.presentation.gitlabMergeRequestNumber',
        'MR #{{value0}}',
        { value0: worktree.linkedGitLabMR }
      ),
      provider: 'gitlab'
    }
  }
  if (worktree.linkedPR != null) {
    return {
      label: translate(
        'components.workspace.cleanup.presentation.githubPullRequestNumber',
        'PR #{{value0}}',
        { value0: worktree.linkedPR }
      ),
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
