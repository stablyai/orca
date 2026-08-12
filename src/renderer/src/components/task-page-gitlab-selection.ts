import { getGitLabTaskEligibleRepos } from '../../../shared/gitlab-task-eligibility'
import type { Repo } from '../../../shared/types'
import type { GitLabProjectFetchResult } from './task-page-gitlab-multi-project'

/** GitLab picker/query candidates: baseline-eligible minus proven not_found peers. */
export function getGitLabTaskDisplayRepos<T extends Repo>(
  repos: readonly T[],
  notFoundRepoIds: ReadonlySet<string> = new Set()
): T[] {
  return getGitLabTaskEligibleRepos(repos).filter((repo) => !notFoundRepoIds.has(repo.id))
}

/**
 * Merge a provider-scoped picker change into the full selection without dropping
 * repos hidden by the current provider filter (e.g. GitHub rows while on GitLab).
 */
export function mergeProviderScopedPickerSelection(args: {
  fullSelection: ReadonlySet<string>
  pickerRepoIds: ReadonlySet<string>
  nextPickerSelection: ReadonlySet<string>
}): Set<string> {
  const preserved = [...args.fullSelection].filter((id) => !args.pickerRepoIds.has(id))
  return new Set([...preserved, ...args.nextPickerSelection])
}

/** Update proven not_found repo ids from per-repo backend list results. */
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
    // Why: a later success/hard-error means the project is still a GitLab target.
    if (!result.error || result.items.length > 0) {
      next.delete(result.repoId)
    }
  }
  return next
}

/** Prune selection to still-present eligible repos only — never provider-filter. */
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
