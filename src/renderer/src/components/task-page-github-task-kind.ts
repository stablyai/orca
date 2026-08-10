import { getTaskPresetQuery } from '../../../shared/task-preset-query'
import { parseTaskQuery } from '../../../shared/task-query'
import type { TaskViewPresetId } from '../../../shared/types'
import type { GitHubTaskKind } from '@/components/task-page-localized-options'

export function isPRFocusedTaskView(preset: TaskViewPresetId | null, query: string): boolean {
  if (preset === 'prs' || preset === 'my-prs' || preset === 'review') {
    return true
  }
  const parsed = parseTaskQuery(query)
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
  if (/\bis:(?:issue|pr|pull-request)\b/i.test(trimmed)) {
    return trimmed
  }
  const parsed = parseTaskQuery(trimmed)
  // Why: the issue arm still fires for quoted forms like is:"issue" that the literal regex above misses.
  const inferredKind = parsed.scope === 'pr' ? 'prs' : parsed.scope === 'issue' ? 'issues' : kind
  return `${inferredKind === 'prs' ? 'is:pr' : 'is:issue'} ${trimmed}`
}
