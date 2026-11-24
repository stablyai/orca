// Which cached Linear read, if any, may supply a bot item link's title and state. Cache-only: it never
// starts a read. A record qualifies only with full proof that it is this link's issue, read through
// the renderer's own default Linear scope on the current runtime:
// - source: the key belongs to the default scope (task-source keys carry a `linear::` prefix and belong
//   to a project's own account), written as `<workspace>::<id>` or a legacy bare `<id>`, where `<id>`
//   is the issue's identifier or UUID;
// - account: a key naming a specific Linear workspace matches the record's own workspace;
// - issue and organization: the record's identifier and its URL's host, organization and issue path
//   match the link's.
// Anything else (no read, two different issues, a newer read that found nothing) leaves the identifier
// alone, without a title or state.
import type { LinearIssue } from '../../../../../shared/linear/issue-types'

type CacheEntry = { data: LinearIssue | null; fetchedAt: number }

export type BotItemLinearRead = { title: string; state: string | null }

/** Host, organization and issue segments of a Linear issue URL, or null when it is not one. */
function issueIdentity(value: string): string | null {
  try {
    const parsed = new URL(value)
    const [, organization, kind, issue] = parsed.pathname.split('/')
    if (!organization || kind !== 'issue' || !issue) {
      return null
    }
    return `${parsed.hostname}/${organization}/${kind}/${issue}`.toLowerCase()
  } catch {
    return null
  }
}

/** The key's workspace segment and issue id, or null when the key is not the default scope's. */
function defaultScopeKey(key: string): { workspace: string | null; id: string } | null {
  if (key.startsWith('linear:')) {
    return null
  }
  const cut = key.indexOf('::')
  if (cut === -1) {
    return { workspace: null, id: key }
  }
  const id = key.slice(cut + 2)
  return id && !id.includes('::') ? { workspace: key.slice(0, cut), id } : null
}

function specificWorkspace(workspace: string | null): string | null {
  return workspace && workspace !== 'selected' && workspace !== 'all' ? workspace : null
}

export function selectBotItemLinearRead(
  cache: Record<string, CacheEntry | undefined>,
  identifier: string | null,
  url: string,
  currentRuntime: boolean
): BotItemLinearRead | null {
  const identity = identifier && currentRuntime ? issueIdentity(url) : null
  if (!identifier || !identity) {
    return null
  }
  const wanted = identifier.toUpperCase()
  let match: { issue: LinearIssue; fetchedAt: number } | null = null
  let notFoundAt = -Infinity
  for (const [key, entry] of Object.entries(cache)) {
    const parsed = entry ? defaultScopeKey(key) : null
    if (!entry || !parsed) {
      continue
    }
    const issue = entry.data
    if (!issue) {
      // A read of this identifier that found nothing: the issue is gone or out of reach.
      if (parsed.id.toUpperCase() === wanted) {
        notFoundAt = Math.max(notFoundAt, entry.fetchedAt)
      }
      continue
    }
    if (
      issue.identifier.toUpperCase() !== wanted ||
      (parsed.id !== issue.id && parsed.id.toUpperCase() !== wanted) ||
      issueIdentity(issue.url) !== identity
    ) {
      continue
    }
    const keyed = specificWorkspace(parsed.workspace)
    if (keyed && keyed !== issue.workspaceId) {
      continue
    }
    if (match && match.issue.id !== issue.id) {
      // The same link matches two different issues: no single record can be trusted.
      return null
    }
    if (!match || entry.fetchedAt > match.fetchedAt) {
      match = { issue, fetchedAt: entry.fetchedAt }
    }
  }
  if (!match || notFoundAt >= match.fetchedAt) {
    return null
  }
  return { title: match.issue.title, state: match.issue.state?.name ?? null }
}
