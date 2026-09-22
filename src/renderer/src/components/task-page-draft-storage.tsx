import type { TaskPageRepoSourceState } from '@/components/task-page-cache-selectors'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import {
  type NewLinearProjectDraft,
  isTaskCreationDraftContentful,
  type NewLinearIssueDraft,
  type NewJiraIssueDraft
} from '@/store/slices/task-creation-drafts'
import { useAppStore } from '@/store'
// Why: hoisted so the type-guard predicate isn't re-allocated on every render.
export const hasDivergentSources = (
  s: TaskPageRepoSourceState
): s is TaskPageRepoSourceState & {
  sources: {
    issues: GitHubOwnerRepo
    prs: GitHubOwnerRepo
  }
} => !!s.sources?.issues && !!s.sources.prs && !sameGitHubOwnerRepo(s.sources.issues, s.sources.prs)

// Why: raw candidate divergence keeps the toggle visible after selecting upstream.
export const hasUpstreamCandidateDivergence = (
  s: TaskPageRepoSourceState
): s is TaskPageRepoSourceState & {
  sources: {
    originCandidate: GitHubOwnerRepo
    upstreamCandidate: GitHubOwnerRepo
  }
} =>
  !!s.sources?.originCandidate &&
  !!s.sources.upstreamCandidate &&
  !sameGitHubOwnerRepo(s.sources.originCandidate, s.sources.upstreamCandidate)
export function writeNewLinearProjectDraft(draft: NewLinearProjectDraft | null): void {
  const state = useAppStore.getState()
  if (draft && isTaskCreationDraftContentful(draft)) {
    state.setNewLinearProjectDraft(draft)
  } else {
    state.clearNewLinearProjectDraft()
  }
}
export function writeNewLinearIssueDraft(draft: NewLinearIssueDraft | null): void {
  const state = useAppStore.getState()
  if (draft && isTaskCreationDraftContentful(draft)) {
    state.setNewLinearIssueDraft(draft)
  } else {
    state.clearNewLinearIssueDraft()
  }
}
export function writeNewJiraIssueDraft(draft: NewJiraIssueDraft | null): void {
  const state = useAppStore.getState()
  if (draft && isTaskCreationDraftContentful(draft)) {
    state.setNewJiraIssueDraft(draft)
  } else {
    state.clearNewJiraIssueDraft()
  }
}
