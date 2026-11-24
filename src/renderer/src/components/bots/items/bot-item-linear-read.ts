// Which cached Linear read, if any, may supply a bot item link's title and state. Cache-only: it never
// starts a read. A record qualifies only with full proof that it is this link's issue:
// - source and host: either the app's own Linear account (the default scope, written `<workspace>::<id>`
//   or a legacy bare `<id>`), or a project's Linear source on the bot's own host (`linear:<host>:…::
//   <workspace>::<id>`); a source on any other host is never read. `<id>` is the issue's identifier or
//   UUID;
// - account: a key naming a specific Linear workspace matches the record's own workspace;
// - issue and organization: the record's identifier and its URL's host, organization and issue path
//   match the link's.
// Anything else (no read, two different issues, a newer read that found nothing) leaves the identifier
// alone, without a title or state.
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { taskSourceCacheScopeHostId } from '../../../../../shared/work-items/task-source-context'

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

/** The key's workspace segment and issue id, or null when the key belongs to a source on another
 *  host (or is not an issue key). */
function ownedKey(key: string, hostId: string): { workspace: string | null; id: string } | null {
  let local = key
  if (key.startsWith('linear:')) {
    // A project source's scope holds empty parts (`::`) of its own: find where the whole scope ends.
    let cut = key.indexOf('::')
    let host = null
    while (cut !== -1 && !host) {
      host = taskSourceCacheScopeHostId(key.slice(0, cut))
      local = key.slice(cut + 2)
      cut = host ? cut : key.indexOf('::', cut + 1)
    }
    if (host !== hostId) {
      return null
    }
  }
  const cut = local.indexOf('::')
  if (cut === -1) {
    return local ? { workspace: null, id: local } : null
  }
  const id = local.slice(cut + 2)
  return id && !id.includes('::') ? { workspace: local.slice(0, cut), id } : null
}

function specificWorkspace(workspace: string | null): string | null {
  return workspace && workspace !== 'selected' && workspace !== 'all' ? workspace : null
}

export function selectBotItemLinearRead(
  cache: Record<string, CacheEntry | undefined>,
  identifier: string | null,
  url: string,
  /** The bot's host: the owner whose sources may answer. */
  hostId: string
): BotItemLinearRead | null {
  const identity = identifier ? issueIdentity(url) : null
  if (!identifier || !identity) {
    return null
  }
  const wanted = identifier.toUpperCase()
  let match: { issue: LinearIssue; fetchedAt: number } | null = null
  let notFoundAt = -Infinity
  for (const [key, entry] of Object.entries(cache)) {
    const parsed = entry ? ownedKey(key, hostId) : null
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
