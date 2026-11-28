import { getTaskPresetQuery } from './task-preset-query'
import { hasExplicitTaskScope, parseTaskQuery } from './task-query'
import type { TaskResumeState, TaskViewPresetId } from '../ui-chrome/ui-chrome-types'
export type GitHubTaskKind = 'issues' | 'prs'

export function isPRFocusedTaskView(preset: TaskViewPresetId | null, query: string): boolean {
  const parsed = parseTaskQuery(query)
  if (parsed.scope === 'issue') {
    return false
  }
  if (preset === 'prs' || preset === 'my-prs' || preset === 'review') {
    return true
  }
  return (
    parsed.scope === 'pr' ||
    parsed.state === 'merged' ||
    parsed.draft ||
    parsed.reviewRequested !== null ||
    parsed.reviewedBy !== null
  )
}

export function normalizeGitHubTaskPreset(
  preset: TaskViewPresetId | null | undefined
): TaskViewPresetId {
  // 'all' is the untouched settings default; with no chosen default the page lands on PRs.
  return !preset || preset === 'all' ? 'prs' : preset
}

/** The saved last tab wins over the default setting. */
export function resolveGitHubLandingPreset(
  savedPreset: TaskViewPresetId | null | undefined,
  defaultPreset: TaskViewPresetId | null | undefined
): TaskViewPresetId {
  if (savedPreset) {
    // A saved legacy mixed view kept opening Issues.
    return savedPreset === 'all' ? 'issues' : savedPreset
  }
  return normalizeGitHubTaskPreset(defaultPreset)
}

/** The query the GitHub Tasks list opens with; prefetchers must match it so the warm cache key hits. */
export function getGitHubLandingQuery(
  resume: Pick<TaskResumeState, 'githubItemsPreset' | 'githubItemsQuery'> | undefined,
  defaultPreset: TaskViewPresetId | null | undefined
): string {
  if (resume?.githubItemsPreset === null) {
    return (resume.githubItemsQuery ?? '').trim()
  }
  return getTaskPresetQuery(resolveGitHubLandingPreset(resume?.githubItemsPreset, defaultPreset))
}

export function getGitHubTaskKind(preset: TaskViewPresetId | null, query: string): GitHubTaskKind {
  return isPRFocusedTaskView(preset, query) ? 'prs' : 'issues'
}

export function getDefaultPresetForGitHubTaskKind(kind: GitHubTaskKind): TaskViewPresetId {
  return kind === 'prs' ? 'prs' : 'issues'
}

export function scopeGitHubTaskSearch(query: string, kind: GitHubTaskKind): string {
  const trimmed = query.trim()
  if (!trimmed) {
    return getTaskPresetQuery(getDefaultPresetForGitHubTaskKind(kind))
  }
  if (hasExplicitTaskScope(trimmed)) {
    return trimmed
  }
  const parsed = parseTaskQuery(trimmed)
  const inferredKind = parsed.scope === 'pr' ? 'prs' : parsed.scope === 'issue' ? 'issues' : kind
  return `${inferredKind === 'prs' ? 'is:pr' : 'is:issue'} ${trimmed}`
}
