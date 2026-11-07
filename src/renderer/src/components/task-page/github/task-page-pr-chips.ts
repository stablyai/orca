import type { PRFilterChange } from '@/components/github/PRFilterSections'
import { parseTaskQuery, serializeTaskQuery, withQualifier } from '../../../../../shared/task-query'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import { getTaskPresetQuery } from '../../../../../shared/task-preset-query'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'

export type GitHubPRStateChip = 'open' | 'merged' | 'closed' | 'all'
export type GitHubPRWhoChip = 'everyone' | 'mine' | 'reviewing'

// Why: saved PR presets are the open-state rows of the state × who grid.
const PR_PRESET_BY_WHO: Record<GitHubPRWhoChip, TaskViewPresetId> = {
  everyone: 'prs',
  mine: 'my-prs',
  reviewing: 'review'
}

/** Patch the query's qualifiers, keeping every other filter and free text. */
export function patchGitHubTaskQuery(query: string, change: PRFilterChange): string {
  let next = query
  if ('author' in change) {
    next = withQualifier(next, 'author', change.author ?? null)
  }
  if ('assignee' in change) {
    next = withQualifier(next, 'assignee', change.assignee ?? null)
  }
  if ('labels' in change) {
    next = withQualifier(next, 'labels', change.labels ?? [])
  }
  if ('state' in change && change.state) {
    next = withQualifier(next, 'state', change.state)
    if (change.state !== 'open') {
      next = withQualifier(next, 'draft', null)
    }
  }
  if ('draft' in change) {
    next = withQualifier(next, 'draft', change.draft ? 'true' : 'false')
  }
  if ('reviewer' in change) {
    // Why: the two reviewer qualifiers are mutually exclusive — clear the other whenever one is set so the chip matches the query.
    const reviewer = change.reviewer ?? null
    if (reviewer === null) {
      next = withQualifier(next, 'reviewRequested', null)
      next = withQualifier(next, 'reviewedBy', null)
    } else if (reviewer.kind === 'requested') {
      next = withQualifier(next, 'reviewedBy', null)
      next = withQualifier(next, 'reviewRequested', reviewer.login)
    } else {
      next = withQualifier(next, 'reviewRequested', null)
      next = withQualifier(next, 'reviewedBy', reviewer.login)
    }
  }
  return next
}

/** The saved PR preset this exact query is, so restore, prefetch keys and the phone see today's preset strings. */
export function matchGitHubPRPreset(query: string): TaskViewPresetId | null {
  const normalized = serializeTaskQuery(parseTaskQuery(query))
  for (const preset of Object.values(PR_PRESET_BY_WHO)) {
    if (serializeTaskQuery(parseTaskQuery(getTaskPresetQuery(preset))) === normalized) {
      return preset
    }
  }
  return null
}

export function deriveGitHubPRStateChip(query: ParsedTaskQuery): GitHubPRStateChip {
  // Why: a PR search with no state qualifier lists every state.
  return query.state === null ? 'all' : query.state
}

/** Who means author or reviewer, independent of assignee, labels and text; other people light no chip. */
export function deriveGitHubPRWhoChip(query: ParsedTaskQuery): GitHubPRWhoChip | null {
  const isMe = (login: string | null): boolean => login?.toLowerCase() === '@me'
  if (query.reviewedBy !== null) {
    return null
  }
  if (query.author === null) {
    if (query.reviewRequested === null) {
      return 'everyone'
    }
    return isMe(query.reviewRequested) ? 'reviewing' : null
  }
  return query.reviewRequested === null && isMe(query.author) ? 'mine' : null
}

export function gitHubPRWhoChange(who: GitHubPRWhoChip): PRFilterChange {
  if (who === 'mine') {
    return { author: '@me', reviewer: null }
  }
  if (who === 'reviewing') {
    return { author: null, reviewer: { kind: 'requested', login: '@me' } }
  }
  return { author: null, reviewer: null }
}

export function gitHubPRWhoPreset(who: GitHubPRWhoChip): TaskViewPresetId {
  return PR_PRESET_BY_WHO[who]
}
