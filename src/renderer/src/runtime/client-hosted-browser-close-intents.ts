import {
  CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS,
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  type ClientHostedBrowserCloseIntent
} from '../../../shared/client-hosted-browser-close-intent'
import type { AppState } from '@/store/types'
import {
  appendEnvironmentCloseIntents,
  removeEnvironmentCloseIntents,
  type EnvironmentCloseIntentList
} from './environment-close-intent-list'

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
 * Whether an unheard close of this page would resurrect it — the qualification for a durable
 * intent. Only client-hosted pages qualify: a server-placed page dies with the runtime that ran
 * it, so there is nothing left to resurrect; a staged handle names a page the host never minted,
 * so replaying a close at it would be answered as unknown forever.
 */
export function isDurableClientHostedBrowserHandle(handle: {
  environmentId?: string
  staged?: boolean
  placement?: { kind?: string } | null
  restoredClientHosted?: boolean
}): boolean {
  return (
    (handle.environmentId?.trim().length ?? 0) > 0 &&
    handle.staged !== true &&
    (handle.placement?.kind === 'client' || handle.restoredClientHosted === true)
  )
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
      !isDurableClientHostedBrowserHandle(handle)
    ) {
      return []
    }
    return [{ environmentId, browserPageId: handle.remotePageId, worktreeId: args.worktreeId }]
  })
}

const BROWSER_CLOSE_INTENT_LIST: EnvironmentCloseIntentList<ClientHostedBrowserCloseIntent> = {
  keyOf: (intent) => intent.browserPageId,
  maxPerEnvironment: MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  maxAgeMs: CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS
}

/** Adds closes to the durable map, newest last, bounded per environment. Returns null if unchanged. */
export function recordClientHostedBrowserCloseIntents(
  current: ClientHostedBrowserCloseIntentsByEnvironment,
  closes: readonly PendingClientHostedBrowserClose[],
  now: number
): ClientHostedBrowserCloseIntentsByEnvironment | null {
  return appendEnvironmentCloseIntents(
    BROWSER_CLOSE_INTENT_LIST,
    current,
    closes.map((close) => ({
      environmentId: close.environmentId,
      intent: { browserPageId: close.browserPageId, worktreeId: close.worktreeId, closedAt: now }
    }))
  )
}

/** Drops the named pages plus anything older than the give-up bound. Returns null if unchanged. */
export function clearClientHostedBrowserCloseIntents(
  current: ClientHostedBrowserCloseIntentsByEnvironment,
  args: { environmentId: string; browserPageIds: readonly string[]; now: number }
): ClientHostedBrowserCloseIntentsByEnvironment | null {
  return removeEnvironmentCloseIntents(BROWSER_CLOSE_INTENT_LIST, current, {
    environmentId: args.environmentId,
    keys: args.browserPageIds,
    now: args.now
  })
}

export function listClientHostedBrowserCloseIntents(
  // Status refresh replays fire-and-forget; unmaterialized maps must mean no intents, not an unhandled rejection.
  current: ClientHostedBrowserCloseIntentsByEnvironment | undefined,
  environmentId: string
): readonly ClientHostedBrowserCloseIntent[] {
  return current?.[environmentId] ?? []
}
