import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { TaskViewPresetId } from '../../../shared/types'
import type { GitHubTaskKind } from './task-page-localized-options'

function matchesViewer(qualifier: string | null, viewerLogin: string | null): boolean {
  if (!qualifier) {
    return false
  }
  const normalized = qualifier.toLowerCase()
  return normalized === '@me' || (!!viewerLogin && normalized === viewerLogin.toLowerCase())
}

function hasIdentityQualifier(query: ParsedTaskQuery): boolean {
  return (
    query.author !== null ||
    query.assignee !== null ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
  )
}

export function requiresGitHubViewerLogin(kind: GitHubTaskKind, query: ParsedTaskQuery): boolean {
  if (query.state !== null && query.state !== 'open') {
    return false
  }
  const qualifier = kind === 'prs' ? (query.author ?? query.reviewRequested) : query.assignee
  return qualifier !== null && qualifier.toLowerCase() !== '@me'
}

export function deriveGitHubTaskPreset(
  kind: GitHubTaskKind,
  query: ParsedTaskQuery,
  viewerLogin: string | null
): TaskViewPresetId | null {
  if (query.state !== null && query.state !== 'open') {
    return null
  }
  if (kind === 'prs') {
    if (matchesViewer(query.author, viewerLogin)) {
      return 'my-prs'
    }
    if (matchesViewer(query.reviewRequested, viewerLogin)) {
      return 'review'
    }
    return hasIdentityQualifier(query) ? null : 'prs'
  }
  if (matchesViewer(query.assignee, viewerLogin)) {
    return 'my-issues'
  }
  return hasIdentityQualifier(query) ? null : 'issues'
}
