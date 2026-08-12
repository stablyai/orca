import { getGitLabTaskEligibleRepos } from '../../../shared/gitlab-task-eligibility'
import type { Repo } from '../../../shared/types'
import type { GitLabProjectFetchResult } from './task-page-gitlab-multi-project'

// Why: hide peers the backend already proved are not GitLab (#13817).
export function getGitLabTaskDisplayRepos<T extends Repo>(
  repos: readonly T[],
  notFoundRepoIds: ReadonlySet<string> = new Set()
): T[] {
  return getGitLabTaskEligibleRepos(repos).filter((repo) => !notFoundRepoIds.has(repo.id))
}

// Why: provider-scoped picker edits must not drop hidden ids (e.g. GitHub while on GitLab).
export function mergeProviderScopedPickerSelection(args: {
  fullSelection: ReadonlySet<string>
  pickerRepoIds: ReadonlySet<string>
  nextPickerSelection: ReadonlySet<string>
}): Set<string> {
  const preserved = [...args.fullSelection].filter((id) => !args.pickerRepoIds.has(id))
  return new Set([...preserved, ...args.nextPickerSelection])
}

// Why: not_found is host-correct proof; success/hard-error means still a GitLab target.
export function collectGitLabNotFoundRepoIds(
  previous: ReadonlySet<string>,
  results: readonly GitLabProjectFetchResult[]
): Set<string> {
  const next = new Set(previous)
  for (const result of results) {
    if (result.repoId === 'unknown') {
      continue
    }
    if (result.error?.type === 'not_found') {
      next.add(result.repoId)
      continue
    }
    if (!result.error || result.items.length > 0) {
      next.delete(result.repoId)
    }
  }
  return next
}

// Why: prune only deleted workspace repos — never provider-filter selection.
export function pruneRepoSelectionToEligible(
  selection: ReadonlySet<string>,
  eligibleRepos: readonly Pick<Repo, 'id'>[]
): Set<string> {
  const eligibleIds = new Set(eligibleRepos.map((repo) => repo.id))
  const pruned = new Set<string>()
  for (const id of selection) {
    if (eligibleIds.has(id)) {
      pruned.add(id)
    }
  }
  return pruned
}
