import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import type { TaskPageRepoSourceState } from '@/components/task-page-cache-selectors'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'

// Why: hoisted to module scope so the type-guard predicate isn't re-allocated on every TaskPage render.
export const hasDivergentSources = (
  s: TaskPageRepoSourceState
): s is TaskPageRepoSourceState & {
  sources: { issues: GitHubOwnerRepo; prs: GitHubOwnerRepo }
} => !!s.sources?.issues && !!s.sources.prs && !sameGitHubOwnerRepo(s.sources.issues, s.sources.prs)

// Why: gate on raw origin/upstream candidate divergence, not effective sources, so the toggle keeps rendering after the user picks 'upstream'.
export const hasUpstreamCandidateDivergence = (
  s: TaskPageRepoSourceState
): s is TaskPageRepoSourceState & {
  sources: { originCandidate: GitHubOwnerRepo; upstreamCandidate: GitHubOwnerRepo }
} =>
  !!s.sources?.originCandidate &&
  !!s.sources.upstreamCandidate &&
  !sameGitHubOwnerRepo(s.sources.originCandidate, s.sources.upstreamCandidate)
