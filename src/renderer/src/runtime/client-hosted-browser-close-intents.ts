import {
  CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS,
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  type ClientHostedBrowserCloseIntent
} from '../../../shared/client-hosted-browser-close-intent'
import type { AppState } from '@/store/types'

export type ClientHostedBrowserCloseIntentsByEnvironment = Record<
  string,
  ClientHostedBrowserCloseIntent[]
>

type CloseIntentState = Pick<
  AppState,
  'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'
>

export type PendingClientHostedBrowserClose = {
  environmentId: string
  browserPageId: string
  worktreeId: string
}

/**
 * The client-hosted pages a workspace close leaves unaccounted for on their host.
 *
 * Only client-hosted pages qualify: a server-placed page dies with the runtime that ran it, so
 * there is nothing left to resurrect and nothing to tell the host about. A client-hosted page is
 * the opposite -- the runtime persists its record precisely so it survives, which is what makes an
 * unheard close a resurrection rather than a lost message.
 */
export function collectPendingClientHostedBrowserCloses(
  state: CloseIntentState,
  args: { workspaceId: string; worktreeId: string; environmentIds: readonly string[] }
): PendingClientHostedBrowserClose[] {
  const environmentIds = new Set(args.environmentIds.filter((id) => id.length > 0))
  if (environmentIds.size === 0) {
    return []
  }
  return (state.browserPagesByWorkspace[args.workspaceId] ?? []).flatMap((page) => {
    const handle = state.remoteBrowserPageHandlesByPageId[page.id]
    const environmentId = handle?.environmentId?.trim()
    if (
      !handle ||
      !environmentId ||
      !environmentIds.has(environmentId) ||
      // Why staged is excluded: the host was never told the page exists, so it has nothing to
      // forget, and replaying a close at an id it never minted would be answered as unknown forever.
      handle.staged === true ||
      !(handle.placement?.kind === 'client' || handle.restoredClientHosted === true)
    ) {
      return []
    }
    return [{ environmentId, browserPageId: handle.remotePageId, worktreeId: args.worktreeId }]
  })
}

/** Adds closes to the durable map, newest last, bounded per environment. Returns null if unchanged. */
export function recordClientHostedBrowserCloseIntents(
  current: ClientHostedBrowserCloseIntentsByEnvironment,
  closes: readonly PendingClientHostedBrowserClose[],
  now: number
): ClientHostedBrowserCloseIntentsByEnvironment | null {
  if (closes.length === 0) {
    return null
  }
  const next = { ...current }
  let changed = false
  for (const close of closes) {
    const existing = next[close.environmentId] ?? []
    if (existing.some((intent) => intent.browserPageId === close.browserPageId)) {
      continue
    }
    next[close.environmentId] = [
      ...existing,
      { browserPageId: close.browserPageId, worktreeId: close.worktreeId, closedAt: now }
    ].slice(-MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS)
    changed = true
  }
  return changed ? next : null
}

/** Drops the named pages plus anything older than the give-up bound. Returns null if unchanged. */
export function clearClientHostedBrowserCloseIntents(
  current: ClientHostedBrowserCloseIntentsByEnvironment,
  args: { environmentId: string; browserPageIds: readonly string[]; now: number }
): ClientHostedBrowserCloseIntentsByEnvironment | null {
  const existing = current[args.environmentId]
  if (!existing) {
    return null
  }
  const cleared = new Set(args.browserPageIds)
  const remaining = existing.filter(
    (intent) =>
      !cleared.has(intent.browserPageId) &&
      args.now - intent.closedAt <= CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS
  )
  if (remaining.length === existing.length) {
    return null
  }
  const next = { ...current }
  if (remaining.length === 0) {
    delete next[args.environmentId]
  } else {
    next[args.environmentId] = remaining
  }
  return next
}

export function listClientHostedBrowserCloseIntents(
  // Why undefined-tolerant: replay fires and forgets from a status refresh, so a store that
  // has not materialized the map yet must read as "no intents", not an unhandled rejection.
  current: ClientHostedBrowserCloseIntentsByEnvironment | undefined,
  environmentId: string
): readonly ClientHostedBrowserCloseIntent[] {
  return current?.[environmentId] ?? []
}
