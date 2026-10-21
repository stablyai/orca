import { getTaskPresetQuery } from './task-preset-query'
import { hasExplicitTaskScope, parseTaskQuery } from './task-query'
import type { TaskViewPresetId } from './ui-chrome-types'
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
  // Why: the split Issues/PRs tabs dropped the mixed "All" view, so legacy saved defaults land on the first tab instead of mixing rows.
  return !preset || preset === 'all' ? 'issues' : preset
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
